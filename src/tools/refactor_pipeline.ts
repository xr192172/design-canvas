/**
 * refactor_pipeline —— 确定性重构管线（把零散执行器串成一条自动执行链）
 *
 * 背景：remove_dead_imports / removeDeadStatements / renameSymbol 等执行器各自
 * 内嵌 applyWithVerify（每步自己跑一次"基线+改后"两个全量 build）。若管线直接
 * 嵌套它们会双重验证、浪费构建时间。故本模块把"编排 + 增量验证 + 绿点回滚"
 * 上提为管线职责，各执行器只提供"纯计算"，由管线统一闭环。
 *
 * 增量验证（性能关键）：入口只跑一次基线。其后每步的改动都是基于"上一步已
 * 绿"的盘上内容算出来的，所以每步只需跑一次"改后"验证——上一步的绿点天然
 * 即当前基线的"下一个"起点。
 *
 * 绿点回滚（正确性关键）：每步 compute 时预读"当前盘上内容"存 originals（这套
 * 内容 = 上个绿点已应用），apply 写盘；改后验证失败则按 originals 还原，恰好
 * 回到上一步的绿点。串行步的 originals 自然后退一步，无需全局快照回溯。
 *
 * 步骤模型：
 *   - 内置可见步骤：dead_imports（未给 dead 清单时自动调 detectDeadImports 文件级
 *     检测 → 一键真相源）、dead_statements（自动扫全目录）。
 *   - 步骤可插拔：传入自定 compute 即扩展；当前未接入 rename（需人工候选）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultVerifyCommands, runVerification, type VerifyCommand, type VerificationOutcome } from './verify_refactor.js';
import { flagDeadStatements, applyReachabilityRuns } from './dead_statements.js';
import { removeImportsFromSource } from './remove_dead_imports.js';
import { detectDeadImports } from './detect_dead_imports.js';
import { computeMigrationPlan } from './package_migration.js';
import {
  RefactorLangRegistry,
  manifestPresent,
  type RunningChangePlan,
  type LanguageRefactorExecutor,
  type RefactorStageExecutor,
  type RefactorStageKind,
  type RefactorStepsCfg,
  type DeadImportsStepCfg,
  type DeadStatementsStepCfg,
  type PackageMigrationStepCfg,
  type PackageMigrationSpec,
} from './refactor_langs.js';
import { pythonExecutor } from './python_refactor/index.js';

// re-export 契约类型（向后兼容：外部可从本模块取用）
export type {
  RunningChangePlan,
  LanguageRefactorExecutor,
  RefactorStageExecutor,
  RefactorStageKind,
  RefactorStepsCfg,
} from './refactor_langs.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────
export type StageId = RefactorStageKind | 'renames';

export type StageOutcome =
  | 'applied'
  | 'no_change'
  | 'skipped'
  | 'baseline_fail'
  | 'rolled_back'
  | 'not_verifiable';

export interface StageResult {
  id: StageId | string;
  label: string;
  /** 顺序中的第几步（1-based） */
  index: number;
  outcome: StageOutcome;
  files_changed: number;
  /** 删除的单位数（死语句行数 / dead import 语句数）；改名/无意义时 0 */
  units_removed: number;
  detail?: string;
  baseline?: VerificationOutcome | null;
  after?: VerificationOutcome | null;
}

export interface PipelineOptions {
  project_dir: string;
  /** 工程根；用于解析相对路径 */
  cwd?: string;
  /** 是否启用各步骤（false = 该步整体跳过）。缺省 false，须显式开 */
  steps: {
    /** 死语句自动删除（flagDeadStatements 自动扫目录）。可选 files 收敛范围 */
    dead_statements?: { enabled?: boolean; files?: string[] };
    /** 死 import 移除：未给 dead 清单时自动文件级检测（一键）；给了则用给定清单 */
    dead_imports?: {
      enabled?: boolean;
      dead?: Array<{ source: string; files: string[] }>;
    };
    /** 包改名/提级：给 migrate 参数即启用；未给 enabled 且给了 migrate 也视为启用 */
    package_migration?: {
      enabled?: boolean;
      migrate?: PackageMigrationSpec;
    };
  };
  /** true = 自动探测验证命令；{commands} = 自定义命令组；false/缺省 = 不验证仅落盘 */
  verify?: boolean | { commands?: VerifyCommand[] };
  /** 单测注入的验证执行器（默认跑真命令） */
  verifyImpl?: (o: { cwd: string; commands: VerifyCommand[] }) => VerificationOutcome;
  /** 多语言执行器注册表；缺省用内置 DEFAULT_LANGS（TS/Go）。新语言调用
   *  registerRefactorLanguage 后自动被拾取，无需传此参数。 */
  langs?: RefactorLangRegistry;
}

export interface PipelineResult {
  ok: boolean;
  stages: StageResult[];
  total_files_changed: number;
  total_units_removed: number;
  baseline: VerificationOutcome | null;
  /** 初始开启的步骤数（含后续 skipped） */
  planned_steps: number;
}

// ─────────────────────────────────────────────
// 死语句步骤：纯计算（不落盘）
// langFilter：'go' | 'ts' 只处理该语言的报告（多语言执行器各自只动自己的文件）
// ─────────────────────────────────────────────
async function computeDeadStatementsPlan(
  proj: string,
  files: string[] | undefined,
  langFilter?: 'go' | 'ts',
): Promise<RunningChangePlan> {
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  const reports = await flagDeadStatements({ project_dir: proj, files });
  for (const rep of reports) {
    if (langFilter && rep.lang !== langFilter) continue; // 只处理本执行器语言
    if (!rep.runs || rep.runs.length === 0) continue;
    const abs = path.isAbsolute(rep.file) ? path.resolve(rep.file) : path.resolve(proj, rep.file);
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const res = applyReachabilityRuns(src, rep.runs);
    if (res.changed) {
      absToNew.set(abs, res.output);
      originals.set(abs, src);
    }
  }
  return { absToNew, originals };
}

// ─────────────────────────────────────────────
// 死 import 步骤：纯计算（复用 removeImportsFromSource）
// 未提供 dead 清单时自动调用 detectDeadImports —— 一键（无需先跑检测）。
// langFilter：只移除该语言源文件里的死 source（自动检测虽跨语言扫，落刀时按语言收敛）
// ─────────────────────────────────────────────
function computeDeadImportsPlan(
  proj: string,
  dead: Array<{ source: string; files: string[] }>,
  langFilter?: 'go' | 'ts',
): RunningChangePlan {
  // 一键：未显式给出清单 → 自动文件级检测（同 dead_statements 的"自动扫"语义）
  let resolved = dead ?? [];
  if (resolved.length === 0) {
    const det = detectDeadImports({ project_dir: proj });
    resolved = det.dead.map((c) => ({ source: c.source, files: c.files }));
  }

  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  const fileEntry = new Map<string, { lang: 'go' | 'ts'; sources: string[] }>();
  const langOfFile = (rel: string): 'go' | 'ts' | null => {
    if (rel.endsWith('.go')) return 'go';
    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel)) return 'ts';
    return null;
  };
  for (const d of resolved) {
    for (const f of d.files ?? []) {
      const lang = langOfFile(f);
      if (!lang) continue;
      if (langFilter && lang !== langFilter) continue; // 只落刀本执行器语言
      const abs = path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f);
      let en = fileEntry.get(abs);
      if (!en) {
        en = { lang, sources: [] };
        fileEntry.set(abs, en);
      }
      if (!en.sources.includes(d.source)) en.sources.push(d.source);
    }
  }

  const sources = new Map<string, string>();
  for (const abs of fileEntry.keys()) {
    try {
      sources.set(abs, fs.readFileSync(abs, 'utf-8'));
    } catch {
      continue;
    }
  }
  let units = 0;
  for (const [abs, en] of fileEntry) {
    let src = sources.get(abs)!;
    let changed = false;
    for (const source of en.sources) {
      const res = removeImportsFromSource(src, source, en.lang);
      if (res.changed) changed = true;
      units += res.removed;
      src = res.output;
    }
    if (changed) {
      absToNew.set(abs, src);
      originals.set(abs, sources.get(abs)!);
    }
  }
  return { absToNew, originals, units };
}

// ─────────────────────────────────────────────
// 内置多语言执行器注册（TS / Go 各自一个执行器）——"新语言新路径"的落点
// TS/Go 共享以下可复用内核（如同 tree-sitter 共享解析根基）：
//   computeDeadImportsPlan（复用 removeImportsFromSource / detectDeadImports）、
//   computeDeadStatementsPlan（复用 flagDeadStatements/applyReachabilityRuns）。
// 每个执行器只处理自己语言的源文件，验证命令各自按项目形态探测。
// ─────────────────────────────────────────────
function buildDefaultLangs(): RefactorLangRegistry {
  const reg = new RefactorLangRegistry();

  // TS 家族（含 JS/JSX/MJS/CJS）。manifest：package.json
  reg.register({
    lang: 'ts',
    isSourceFile: (rel) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(rel),
    detectVerifyCommands: (cwd) => defaultVerifyCommands(cwd),
    manifestFiles: ['package.json'],
    manifestPriority: 50,
    stages: [
      {
        kind: 'dead_imports',
        label: '[ts] dead import 移除',
        compute: (a) => computeDeadImportsPlan(a.project_dir, a.dead ?? [], 'ts'),
        limitations: [
          'TS 保守：副作用导入 / re-export / 语法不认识恒活（import 即执行副作用），绝不误删',
          '文件内零引用即报死，未做跨文件可达性——保守漏报多于误报；删除前请过验证闭环',
        ],
      },
      {
        kind: 'dead_statements',
        label: '[ts] 死语句删除',
        compute: (a) => computeDeadStatementsPlan(a.project_dir, a.files, 'ts'),
        limitations: [
          'TS 提升（function/class/let/const/var）：return/throw 后不可达子树若含声明，需名字引用校验才删',
        ],
      },
    ],
  });

  // Go。manifest：go.mod
  reg.register({
    lang: 'go',
    isSourceFile: (rel) => rel.endsWith('.go'),
    detectVerifyCommands: (cwd) => defaultVerifyCommands(cwd),
    manifestFiles: ['go.mod'],
    manifestPriority: 60,
    stages: [
      {
        kind: 'dead_imports',
        label: '[go] dead import 移除',
        compute: (a) => computeDeadImportsPlan(a.project_dir, a.dead ?? [], 'go'),
        limitations: [
          'Go 保守：空导入 _ / 点导入 . 恒活（import 即执行副作用），绝不误删',
          '文件内零引用即报死，未做跨文件可达性——保守漏报多于误报；删除前请过验证闭环',
        ],
      },
      {
        kind: 'dead_statements',
        label: '[go] 死语句删除',
        compute: (a) => computeDeadStatementsPlan(a.project_dir, a.files, 'go'),
        limitations: [
          'Go 终止后兄弟语句可删；唯一禁删"被可达 goto 指向"的带标签语句，遇即停',
        ],
      },
      {
        kind: 'package_migration',
        label: '[go] 包改名/提级',
        compute: (a) => {
          if (!a.migrate) return { absToNew: new Map(), originals: new Map() };
          return computeMigrationPlan({ project_dir: a.project_dir, migrate: a.migrate });
        },
        limitations: [
          '迁移语义以 Go 为契约（package 声明 / module 路径 / 别名清洗）；TS 改名走 renameSymbol',
          '目录移动仅当"旧逻辑目录真实存在且目标不同"才执行；已物理到位则只改内容',
          '撞名即抛错、不落盘——改前请过验证闭环；别名清洗按包别名用法保守替换',
        ],
      },
    ],
  });

  // Python。manifest：pyproject.toml / requirements.txt / setup.py|cfg
  reg.register({
    ...pythonExecutor,
    manifestFiles: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'],
    // 主导判定：python 工程常兼具 JS 工具脚本，若按"文件数"会让 JS 误判成主导；
    // 故 python 作为"应用主体"manifest 的优先级高于 node，验证链归 python，
    // 但 JS 脚本的重构步骤仍各司其职并行执行。
    manifestPriority: 70,
  });

  return reg;
}

/** 默认注册表（模块级单例）。内置 TS/Go；后续语言执行器经注册入口并入。 */
export const DEFAULT_LANGS = buildDefaultLangs();

/** 多语言执行器注册入口：给"下一个接力 AI"的新语言路径挂到全局注册表，
 *  runRefactorPipeline 每次按项目探测自动拾取，无需改管线主流程。 */
export function registerRefactorLanguage(ex: LanguageRefactorExecutor): void {
  DEFAULT_LANGS.register(ex);
}

// ─────────────────────────────────────────────
// 步骤聚合 + 验证命令合并（多语言可插拔核心）
// ─────────────────────────────────────────────

export interface ScheduledStep {
  stage: RefactorStageExecutor;
  enabled: boolean;
  files?: string[];
  dead?: Array<{ source: string; files: string[] }>;
  migrate?: PackageMigrationSpec;
}

/**
 * 聚合命中的多语言执行器各自的 steps（保序）→ 与用户 steps 配置对齐。
 * 同一 kind 的步骤（如 multiple 语言都有 dead_imports）会各保留自己的
 * compute（各自处理自己的语言），管线按顺序逐个执行。
 */
export function collectSteps(
  executors: LanguageRefactorExecutor[],
  steps: RefactorStepsCfg,
): ScheduledStep[] {
  const out: ScheduledStep[] = [];
  for (const ex of executors) {
    for (const stage of ex.stages) {
      const cfg = steps[stage.kind];
      out.push({
        stage,
        enabled: !!cfg?.enabled,
        files:
          stage.kind === 'dead_statements'
            ? (cfg as DeadStatementsStepCfg | undefined)?.files
            : undefined,
        dead:
          stage.kind === 'dead_imports'
            ? (cfg as DeadImportsStepCfg | undefined)?.dead
            : undefined,
        migrate:
          stage.kind === 'package_migration'
            ? (cfg as PackageMigrationStepCfg | undefined)?.migrate
            : undefined,
      });
    }
  }
  return out;
}

/** 在命中的语言执行器中挑出"主导"的那个（manifest 定主导工具链）：
 *   - 优先取 manifest 存在于项目根的执行器；同候选则取 manifestPriority 最大者；
 *   - 都无 manifest（纯源码，无 package.json/go.mod/pyproject 等）→ undefined，
 *     由调用方降级（不验证 / 回退 mergeVerifyCommands 全量探测）。
 */
export function dominantExecutor(
  executors: LanguageRefactorExecutor[],
  cwd: string,
): LanguageRefactorExecutor | undefined {
  const withManifest = executors.filter((e) => manifestPresent(cwd, e.manifestFiles));
  if (withManifest.length === 0) return undefined;
  return [...withManifest].sort((a, b) => (b.manifestPriority ?? 0) - (a.manifestPriority ?? 0))[0];
}

/** 主导语言执行器的验证命令组；无主导 → 空数组。 */
export function dominantVerifyCommands(
  executors: LanguageRefactorExecutor[],
  cwd: string,
): VerifyCommand[] {
  const dom = dominantExecutor(executors, cwd);
  return dom ? dom.detectVerifyCommands(cwd) : [];
}

/** 合并多语言执行器各自探测出的验证命令（按 cmd+args 去重，保序）。
 *  兼容旧行为/极端场景（无主导 manifest 时兜底全量探测）；通常管线用主导单源。 */
export function mergeVerifyCommands(executors: LanguageRefactorExecutor[], cwd: string): VerifyCommand[] {
  const out: VerifyCommand[] = [];
  const seen = new Set<string>();
  for (const ex of executors) {
    for (const c of ex.detectVerifyCommands(cwd)) {
      const key = `${c.cmd} ${c.args.join(' ')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// 管线编排
// ─────────────────────────────────────────────
export async function runRefactorPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const proj = path.resolve(opts.project_dir);
  const cwd = path.resolve(opts.cwd ?? proj);
  // 显式启用验证（true 或 {commands}）才算可验证；false/缺省 = 不验证仅落盘。
  // 命令组本由调用方 commands 或按"命中语言"探测给出；空命令组在真 runVerification
  // 下安全返回 pass（测试注入 spy 时命令组常为空、不影响调用计数）。
  const verifyEnabled = opts.verify === true || (typeof opts.verify === 'object' && opts.verify !== null);
  const run = opts.verifyImpl ?? runVerification;

  // 可插拔核心：按项目探测命中的语言执行器（允许多门并存，如 TS+Go 混项目），
  // 聚合它们的 steps（保序）→ 统一走基线/改后验证/绿点回滚。
  const langs = opts.langs ?? DEFAULT_LANGS;
  const executors = langs.forProject(cwd);
  const stepList = collectSteps(executors, opts.steps);
  const planned = stepList.filter((s) => s.enabled).length;

  const commands: VerifyCommand[] =
    (typeof opts.verify === 'object' && opts.verify.commands) ||
    (opts.verify === true ? dominantVerifyCommands(executors, cwd) : []);

  const baseline = verifyEnabled ? run({ cwd, commands }) : null;

  const stages: StageResult[] = [];

  // 基线失败：一个文件都不改
  if (baseline && baseline.status === 'fail') {
    return {
      ok: false,
      stages: [],
      total_files_changed: 0,
      total_units_removed: 0,
      baseline,
      planned_steps: planned,
    };
  }

  const r: PipelineResult = {
    ok: true,
    stages,
    total_files_changed: 0,
    total_units_removed: 0,
    baseline,
    planned_steps: planned,
  };

  for (const [i, s] of stepList.entries()) {
    await runStage(i + 1, s.stage.kind, s.stage.label, s.enabled, () =>
      s.stage.compute({ project_dir: proj, cwd, files: s.files, dead: s.dead, migrate: s.migrate }),
    );
  }

  return r;

  async function runStage(
    index: number,
    id: StageId,
    label: string,
    enabled: boolean,
    compute: () => Promise<RunningChangePlan> | RunningChangePlan,
  ): Promise<void> {
    // 未启用 → 跳过
    if (!enabled) {
      r.stages.push({ id, label, index, outcome: 'skipped', files_changed: 0, units_removed: 0 });
      return;
    }

    const plan = await compute();
    const moves = plan.moves ?? [];
    // 无改动判定：既没内容改写、也没文件移动，才算 no_change
    if (plan.absToNew.size === 0 && moves.length === 0) {
      r.stages.push({ id, label, index, outcome: 'no_change', files_changed: 0, units_removed: 0 });
      return;
    }

    // ── 落盘（基于当前盘上内容——上一步已绿）──
    // 1) 先移动文件（先移动，absToNew 里移动后文件的 key 是其 to 路径，随后写覆盖）
    for (const m of moves) {
      const toDir = path.dirname(m.to);
      if (!fs.existsSync(toDir)) fs.mkdirSync(toDir, { recursive: true });
      if (fs.existsSync(m.to)) {
        throw new Error(`重构撞名：移动目标已存在 ${m.to}`);
      }
      fs.renameSync(m.from, m.to);
    }
    // 2) 再写内容（含移动后文件的 to 路径）
    for (const abs of plan.absToNew.keys()) {
      const dir = path.dirname(abs);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(abs, plan.absToNew.get(abs)!, 'utf-8');
    }
    const units = plan.units ?? (id === 'dead_statements' ? plan.absToNew.size : 0);

    r.total_files_changed += Math.max(plan.absToNew.size, moves.length);
    r.total_units_removed += units;

    // 不可验证：仍已落盘，但如实标注
    if (!verifyEnabled) {
      r.stages.push({
        id, label, index, outcome: 'not_verifiable',
        files_changed: Math.max(plan.absToNew.size, moves.length), units_removed: units,
      });
      return;
    }

    const after = run({ cwd, commands });
    if (after.status === 'fail') {
      // ── 回滚此步：先逆向移动（to→from），再按原始内容还原 → 回到上一步绿点 ──
      for (const m of [...moves].reverse()) {
        if (fs.existsSync(m.to) && !fs.existsSync(m.from)) {
          const fromDir = path.dirname(m.from);
          if (!fs.existsSync(fromDir)) fs.mkdirSync(fromDir, { recursive: true });
          fs.renameSync(m.to, m.from);
        }
      }
      for (const [abs, orig] of plan.originals) fs.writeFileSync(abs, orig, 'utf-8');
      r.total_files_changed -= Math.max(plan.absToNew.size, moves.length);
      r.total_units_removed -= units;
      r.ok = false;
      r.stages.push({
        id, label, index, outcome: 'rolled_back',
        files_changed: Math.max(plan.absToNew.size, moves.length), units_removed: units,
        detail: after.detail, baseline, after,
      });
      return;
    }

    r.stages.push({
      id, label, index, outcome: 'applied',
      files_changed: Math.max(plan.absToNew.size, moves.length), units_removed: units,
      baseline, after,
    });
  }
}

function countPlanned(opts: PipelineOptions): number {
  let n = 0;
  if (opts.steps.dead_imports?.enabled) n++;
  if (opts.steps.dead_statements?.enabled) n++;
  if (opts.steps.package_migration?.enabled) n++;
  return n;
}

export const buildStepCount = countPlanned;