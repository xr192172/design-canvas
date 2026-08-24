/**
 * deprecate_offline —— 废弃积木下线链（C 链，P2）
 *
 * 承接 brickify / feature_map 的废弃证据（DeprecationEvidence.deadSources：某 source
 * 仅被"导入但未使用"的文件引用），把**项目内自研源码模块**真正下线。
 *
 * 三问式判据（对应"无活跃消费 + 人工确认"）：
 *   1. 是自研积木吗？        —— source 相对路径能 resolve 为项目内源文件（.ts/.go 实体），
 *                              三方包/内置模块不参与（那是清依赖，非下线积木）。
 *   2. 无活跃消费吗？        —— 全部消费者对该 source 都是死 import。交给
 *                              removeDeadImportsWithVerify：移除所有死 import 后跑编译级验收，
 *                              若移除后无人再用、编译仍绿 ⇒ 证明无活跃消费者（**编译级可达性确认**，
 *                              比静态扫描更可信）；若移除导致编译回归 ⇒ 自动回滚并判定"有活跃消费"。
 *   3. 真删 / 仅清引用？     —— `--remove-file` 才物理删除模块文件本体（其它动作只清各处死 import）。
 *
 * 复用（零重复造轮子）：
 *   - detectDeadImports      ：候选生成（source → 死消费者文件）
 *   - removeDeadImportsWithVerify：死 import 移除 + 基线/改后编译验收 + 失败自动回滚
 *   - defaultVerifyCommands  ：项目形态探测（go/package.json）产出验收命令组
 *
 * 安全默认：dry_run=true 只出候选报告；--apply 落盘，`--remove-file` 是唯一物理删文件开关（需人拍板）。
 */

import path from 'node:path';
import fs from 'node:fs';
import { detectDeadImports, scanProjectSourceFiles } from './detect_dead_imports.js';
import { removeDeadImportsWithVerify } from './remove_dead_imports.js';
import type { DeadDepCandidate } from './dead_deps.js';
import { defaultVerifyCommands, runVerification } from './verify_refactor.js';

const SOURCE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go'];

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

export interface DeprecateOfflinePlan {
  /** 废弃模块说明符（与 detectDeadImports 的 source 同口径，如 ./legacy/old） */
  source: string;
  /** 可选：预留人工判定注记（当前仅透传报告） */
  note?: string;
}

export interface DeprecateOfflineOptions {
  project_dir: string;
  /** 显式下线清单；缺省 = detectDeadImports 全量里筛"项目内自研源" */
  plans?: DeprecateOfflinePlan[];
  /** 扫描范围（相对/绝对文件清单）；缺省整库递归扫描 */
  files?: string[];
  /** true=出候选报告不落盘（默认） */
  dry_run?: boolean;
  /** 是否物理删除模块文件本体（仅对"无活跃消费"者生效；需人确认） */
  remove_file?: boolean;
  /** 编译级验收；默认 = !dry_run */
  verify?: boolean;
}

export type DeprecateOutcome =
  | 'candidate' // dry-run 预览：未落盘的候选
  | 'offlined' // 死 import 已移除且编译通过（无活跃消费）
  | 'file_removed' // 且源文件本体已物理删除（remove_file 且通过删后验收）
  | 'rolled_back' // 移除死 import 触发编译回归 → 已回滚（判定有活跃消费）
  | 'baseline_fail' // 地基黄：一个都不动
  | 'no_change' // 无死引用可清
  | 'not_verified' // 项目形态不可自动验证：仅执行不判定
  | 'skipped_not_project'; // 非项目内自研源：不参与下线

export interface DeprecateOfflineItem {
  source: string;
  module_file: string | null;
  consumers: number;
  status: DeprecateOutcome;
  note: string;
}

export interface DeprecateOfflineResult {
  ok: boolean;
  dry_run: boolean;
  remove_file: boolean;
  candidates: number;
  offlined: number;
  items: DeprecateOfflineItem[];
  message: string;
}

// ─────────────────────────────────────────────
// 项目内源解析（source 相对"每个消费者文件"，非项目根）
// ─────────────────────────────────────────────

/** 把 import 说明符（相对某消费者文件）resolve 为项目内源文件；返回相对 project_dir 的 posix 路径，失败 null。 */
export function resolveConsumerSource(project_dir: string, consumerRel: string, source: string): string | null {
  if (!source.startsWith('.')) return null; // 三方包 / node 内置
  const absConsumer = path.resolve(project_dir, consumerRel);
  const base = path.resolve(path.dirname(absConsumer), source.replace(/\\/g, '/'));
  const cands = [base, ...SOURCE_EXTS.map((e) => base + e), ...SOURCE_EXTS.map((e) => path.join(base, 'index' + e))];
  for (const c of cands) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return path.relative(project_dir, c).split(path.sep).join('/');
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 聚合每个死 source 的全部消费者，统一 resolve；仅当"全是项目内同一文件"才视为自研积木。 */
export function aggregateProjectSources(
  project_dir: string,
  dead: DeadDepCandidate[],
): Map<string, { moduleFile: string; consumers: number }> {
  const out = new Map<string, { moduleFile: string; consumers: number }>();
  for (const d of dead) {
    const hits = new Set<string>();
    let allResolve = true;
    for (const f of d.files) {
      const rf = resolveConsumerSource(project_dir, f, d.source);
      if (rf === null) {
        allResolve = false;
        break;
      }
      hits.add(rf);
    }
    if (!allResolve || hits.size !== 1) continue; // 非自研 / 多实体歧义 → 保守跳过
    out.set(d.source, { moduleFile: hits.values().next().value as string, consumers: d.files.length });
  }
  return out;
}

/** 全项目扫描：是否存在**任意**文件 import 到该模块文件（含活跃消费）。
 *  物理删文件前必须为 0（"移除死 import 后编译绿"只证明死引用可清，证明不了模块无活跃消费）。
 *  仅覆盖 TS/JS（Go 侧保守视为有引用 → 不自动删）。返回命中文件数。 */
export function remainingImporters(
  project_dir: string,
  moduleRel: string,
  scannedFiles: string[],
): number {
  const proj = path.resolve(project_dir);
  const mod = moduleRel.replace(/\\/g, '/');
  let n = 0;
  for (const rel of scannedFiles) {
    if (rel.replace(/\\/g, '/') === mod) continue; // 自身不算
    let src: string;
    try {
      src = fs.readFileSync(path.join(proj, rel), 'utf-8');
    } catch {
      continue;
    }
    if (/\.go$/.test(rel)) continue; // Go：保守跳过（不删）
    for (const source of enumerateDeriveSources(src).keys()) {
      if (!source.startsWith('.')) continue;
      if (resolveConsumerSource(proj, rel, source) === mod) {
        n++;
        break;
      }
    }
  }
  return n;
}

// 轻量 TS import 枚举（仅取模块说明符；detect_dead_imports.enumerateTsSources 即可）
function enumerateDeriveSources(src: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:from\s*|import\s*)(["'])([^"']+)\1/g;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[2]);
  return out;
}

// ─────────────────────────────────────────────
// 下线执行
// ─────────────────────────────────────────────

export async function runDeprecateOffline(opts: DeprecateOfflineOptions): Promise<DeprecateOfflineResult> {
  const proj = path.resolve(opts.project_dir);
  const dryRun = opts.dry_run ?? true;
  const removeFile = opts.remove_file ?? false;

  const detect = detectDeadImports({ project_dir: proj, files: opts.files });
  const projectSources = aggregateProjectSources(proj, detect.dead);

  // 候选集：显式 plans 限定，否则全量自研源
  const want = new Set<string>(
    opts.plans && opts.plans.length > 0 ? opts.plans.map((pl) => pl.source) : [...projectSources.keys()],
  );
  const candidates = [...projectSources.entries()].filter(([s]) => want.has(s));

  const items: DeprecateOfflineItem[] = [];
  for (const [source, { moduleFile }] of candidates) {
    const consumers = projectSources.get(source)!.consumers;
    items.push({
      source,
      module_file: moduleFile,
      consumers,
      status: 'candidate',
      note: '候选待执行',
    });
  }

  if (dryRun) {
    // 仅预览候选，不落盘、不验证
    const lines: string[] = [
      `deprecate_offline（dry-run，均未落盘）：扫描 ${detect.scanned} 文件 → ${detect.dead.length} 个死源 → ${candidates.length} 个自研积木候选可下线`,
      '以下将被"移除各消费者死 import"' + (removeFile ? ' + 物理删除源码文件' : '（--remove-file 才删文件）') + '：',
      '',
    ];
    for (const it of items) {
      lines.push(`  [下线候选] ${it.source} / 模块 ${it.module_file} / ${it.consumers} 处死引用`);
    }
    lines.push('', '确认后以 --apply（+ --remove-file 如需删文件）执行。');
    return { ok: true, dry_run: true, remove_file: removeFile, candidates: items.length, offlined: 0, items, message: lines.join('\n') };
  }

  // ── apply：只把"自研候选源"的死 import 交给复用执行器（改前/改后编译验收 + 回滚） ──
  const targeted = detect.dead.filter((d) => projectSources.has(d.source) && want.has(d.source));
  const verify = opts.verify ?? true;
  const rem = removeDeadImportsWithVerify({ project_dir: proj, dead: targeted, verify });
  const v = rem.verification;
  const bySource = new Map(items.map((i) => [i.source, i] as const));

  if (v.outcome === 'baseline_fail') {
    for (const it of items) {
      it.status = 'baseline_fail';
      it.note = '地基黄（基线编译失败），一个未动'.concat(v.detail ? `：${v.detail}` : '');
    }
    return { ok: false, dry_run: false, remove_file: removeFile, candidates: items.length, offlined: 0, items, message: 'deprecate_offline：基线编译失败，未执行任何改动。' };
  }

  // 编译级可达性：移除死 import 后编译仍绿 ⇒ 无活跃消费（否则回滚并判定有活跃消费）
  let offlined = 0;
  const removableFiles = new Set<string>();
  for (const d of targeted) {
    const it = bySource.get(d.source);
    if (!it) continue;
    if (v.outcome === 'regression_rolled_back') {
      it.status = 'rolled_back';
      it.note = '移除死 import 触发编译回归已回滚（判定存在活跃消费，不建议下线）';
    } else if (v.outcome === 'not_verifiable') {
      it.status = 'not_verified';
      it.note = '项目形态不可自动验证：已移除死 import，未做编译级消费确认';
    } else {
      it.status = 'offlined';
      offlined += 1;
      it.note = '死 import 已移除，编译通过（无活跃消费）';
      if (removeFile) removableFiles.add(it.module_file!);
    }
  }
  // 未在 targeted 中落盘的候选（如无变更/no_change）如实标注
  for (const it of items) {
    if (it.status === 'no_change' || it.status === 'skipped_not_project') {
      const hasDead = targeted.some((d) => d.source === it.source);
      it.status = hasDead ? 'no_change' : 'skipped_not_project';
      it.note = hasDead ? '无死 import 可移除（或已清理）' : it.note;
    }
  }

  // 可选物理下线：删除"无活跃消费"的模块文件本体，删后再编译，失败即恢复
  if (removeFile && removableFiles.size > 0) {
    const commands = defaultVerifyCommands(proj);
    // 硬闸门：物理删除前必须"全项目已无任何 import 命中该模块"（含活跃消费），否则仅清死 import、保留文件。
    const scannedFiles = scanProjectSourceFiles(proj, opts.files);
    const trulyRemovable = new Set<string>();
    for (const f of removableFiles) {
      const n = remainingImporters(proj, f, scannedFiles);
      const it = items.find((i) => i.module_file === f);
      if (n === 0) {
        trulyRemovable.add(f);
      } else if (it && it.status === 'offlined') {
        it.note = '仍有 ' + n + ' 处活跃引用：仅清死 import，未物理下线文件';
      }
    }
    if (commands.length > 0 && trulyRemovable.size > 0) {
      const backups = new Map<string, string>();
      for (const f of trulyRemovable) backups.set(f, fs.readFileSync(path.join(proj, f), 'utf-8'));
      for (const f of trulyRemovable) fs.rmSync(path.join(proj, f), { force: true });
      const after = runVerification({ cwd: proj, commands });
      if (after.status === 'pass') {
        for (const it of items) if (trulyRemovable.has(it.module_file!)) it.status = 'file_removed';
      } else {
        for (const [f, src] of backups) fs.writeFileSync(path.join(proj, f), src, 'utf-8');
        for (const it of items)
          if (trulyRemovable.has(it.module_file!)) {
            it.status = 'rolled_back';
            it.note = '物理删文件后编译回归 → 已恢复源文件';
          }
      }
    } else if (commands.length === 0) {
      for (const it of items)
        if (trulyRemovable.has(it.module_file!)) it.note = '项目不可自动验证：仅移除死 import，未物理删文件';
    }
  }

  const lines: string[] = [
    `deprecate_offline（已 apply）：${candidates.length} 候选 → 下线 ${offlined}，回滚 ${items.filter((i) => i.status === 'rolled_back').length}，跳过 ${items.filter((i) => i.status === 'skipped_not_project').length}`,
    '',
  ];
  for (const it of items) {
    lines.push(`  [${it.status.toUpperCase()}] ${it.source} / ${it.module_file}：${it.note}`);
  }
  const anyRolledBack = items.some((i) => i.status === 'rolled_back');
  return { ok: !anyRolledBack, dry_run: false, remove_file: removeFile, candidates: items.length, offlined, items, message: lines.join('\n') };
}