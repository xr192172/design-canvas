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
import { detectDeadImports, type DeadImportCandidate } from './detect_dead_imports.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────
export type StageId = 'renames' | 'dead_imports' | 'dead_statements';

export interface RunningChangePlan {
  /** 待落盘的绝对路径 → 新源码 */
  absToNew: Map<string, string>;
  /** 预读的原始内容（apply 前盘上内容；non-plan 阶段为空） */
  originals: Map<string, string>;
  /** 删除的单位数（死 import 语句条数 / 死语句文件数）；缺省由 runStage 按步退化 */
  units?: number;
}

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
  };
  /** true = 自动探测验证命令；{commands} = 自定义命令组；false/缺省 = 不验证仅落盘 */
  verify?: boolean | { commands?: VerifyCommand[] };
  /** 单测注入的验证执行器（默认跑真命令） */
  verifyImpl?: (o: { cwd: string; commands: VerifyCommand[] }) => VerificationOutcome;
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
// ─────────────────────────────────────────────
async function computeDeadStatementsPlan(proj: string, files?: string[]): Promise<RunningChangePlan> {
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();
  const reports = await flagDeadStatements({ project_dir: proj, files });
  for (const rep of reports) {
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
// ─────────────────────────────────────────────
function computeDeadImportsPlan(proj: string, dead: Array<{ source: string; files: string[] }>): RunningChangePlan {
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
// 管线编排
// ─────────────────────────────────────────────
export async function runRefactorPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const proj = path.resolve(opts.project_dir);
  const cwd = path.resolve(opts.cwd ?? proj);
  // 显式启用验证（true 或 {commands}）才算可验证；false/缺省 = 不验证仅落盘。
  // 命令组本由 opts.commands 或按项目形态探测给出；空命令组在真 runVerification 下
  // 安全返回 pass（测试注入 spy 时命令组常为空、不影响调用计数）。
  const verifyEnabled = opts.verify === true || (typeof opts.verify === 'object' && opts.verify !== null);
  const commands: VerifyCommand[] =
    (typeof opts.verify === 'object' && opts.verify.commands) ||
    (opts.verify === true ? defaultVerifyCommands(cwd) : []);
  const run = opts.verifyImpl ?? runVerification;

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
      planned_steps: countPlanned(opts),
    };
  }

  const r: PipelineResult = {
    ok: true,
    stages,
    total_files_changed: 0,
    total_units_removed: 0,
    baseline,
    planned_steps: countPlanned(opts),
  };

  await runStage(1, 'dead_imports', 'dead import 移除', opts.steps.dead_imports, () =>
    computeDeadImportsPlan(proj, opts.steps.dead_imports?.dead ?? []),
  );
  await runStage(2, 'dead_statements', '死语句删除', opts.steps.dead_statements, () =>
    computeDeadStatementsPlan(proj, opts.steps.dead_statements?.files),
  );

  return r;

  async function runStage(
    index: number,
    id: StageId,
    label: string,
    cfg: { enabled?: boolean } | undefined,
    compute: () => Promise<RunningChangePlan> | RunningChangePlan,
  ): Promise<void> {
    // 未启用 → 跳过
    if (!cfg?.enabled) {
      r.stages.push({ id, label, index, outcome: 'skipped', files_changed: 0, units_removed: 0 });
      return;
    }

    const plan = await compute();
    if (plan.absToNew.size === 0) {
      r.stages.push({ id, label, index, outcome: 'no_change', files_changed: 0, units_removed: 0 });
      return;
    }

    // 落盘（基于当前盘上内容——上一步已绿）
    for (const abs of plan.absToNew.keys()) {
      fs.writeFileSync(abs, plan.absToNew.get(abs)!, 'utf-8');
    }
    const units = plan.units ?? (id === 'dead_statements' ? plan.absToNew.size : 0);

    r.total_files_changed += plan.absToNew.size;
    r.total_units_removed += units;

    // 不可验证：仍已落盘，但如实标注
    if (!verifyEnabled) {
      r.stages.push({
        id, label, index, outcome: 'not_verifiable',
        files_changed: plan.absToNew.size, units_removed: units,
      });
      return;
    }

    const after = run({ cwd, commands });
    if (after.status === 'fail') {
      // 回滚此步：还原本步预读的原始内容 → 回到上一步绿点
      for (const [abs, orig] of plan.originals) fs.writeFileSync(abs, orig, 'utf-8');
      r.total_files_changed -= plan.absToNew.size;
      r.total_units_removed -= units;
      r.ok = false;
      r.stages.push({
        id, label, index, outcome: 'rolled_back',
        files_changed: plan.absToNew.size, units_removed: units,
        detail: after.detail, baseline, after,
      });
      return;
    }

    r.stages.push({
      id, label, index, outcome: 'applied',
      files_changed: plan.absToNew.size, units_removed: units,
      baseline, after,
    });
  }
}

function countPlanned(opts: PipelineOptions): number {
  let n = 0;
  if (opts.steps.dead_imports?.enabled) n++;
  if (opts.steps.dead_statements?.enabled) n++;
  return n;
}

export const buildStepCount = countPlanned;