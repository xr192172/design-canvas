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
 *
 * --files 作用域约定（重要）：
 *   - `--files` 会同时收窄【候选判定】与【remainingImporters 物理删硬闸门】的扫描视野。
 *     若 scope 漏掉"仍在活跃消费该模块"的文件，硬闸门可能计数为 0（视觉盲区）。
 *   - 但**验证命令是整项目形态的**（tsc / go build），不受 --files 限制——scope 盲区一旦导致
 *     物理删除后全项目编译回归，会被编译级重验兜底拦下并自动回滚（见回滚路径演示夹具
 *     death-source-fixture-rollback）。
 *   - 因此 --files 只建议用于"精确定位候选"的 dry-run 收敛；需要真物理下线时请**省略 --files**，
 *     让硬闸门覆盖全库，避免盲区依赖兜底来擦屁股。
 */

import path from 'node:path';
import fs from 'node:fs';
import { detectDeadImports, scanProjectSourceFiles } from './detect_dead_imports.js';
import { removeDeadImportsWithVerify } from './remove_dead_imports.js';
import { parseTsImportQualifiers, parseGoImportQualifiers, stripTsImportLines, qualifierLines, type DeadDepCandidate } from './dead_deps.js';
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
  | 'candidate' // dry-run 预览：无活跃消费、真可下线的候选
  | 'has_active_consumer' // 有活跃消费（被使用）：非下线候选，仅可清理其死引用
  | 'offlined' // 死 import 已移除且编译通过（无活跃消费）
  | 'pruned' // 仅清理了死引用，但模块仍有活跃消费（保留，不物理下线）
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

/** 读 go.mod 的 module 名（首行 `module <path>`），无则 null。Go 包路径→项目内解析的唯一锚。 */
export function goModulePrefix(project_dir: string): string | null {
  try {
    const goMod = fs.readFileSync(path.join(project_dir, 'go.mod'), 'utf-8');
    const m = goMod.match(/^\s*module\s+(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Go 包目录 `sub`（相对 project_dir、posix）→ 目录内首选 .go 文件（代表该包源码）；无返回 null。 */
function resolveGoPackageFile(project_dir: string, sub: string): string | null {
  const dir = sub ? path.join(project_dir, ...sub.split('/')) : project_dir;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const go = names.filter((n) => /\.go$/.test(n)).sort();
  if (go.length === 0) return null;
  return path.relative(project_dir, path.join(dir, go[0])).split(path.sep).join('/');
}

/** 目标模块文件（相对 project_dir）所属 Go 包路径（module 前缀 + 其目录）；非 Go 或读不到 go.mod 返回 null。 */
export function goPackageOfFile(project_dir: string, moduleRel: string): string | null {
  const mod = goModulePrefix(project_dir);
  if (!mod) return null;
  const dir = path.posix.dirname(moduleRel.replace(/\\/g, '/'));
  return dir === '.' || dir === '' ? mod : `${mod}/${dir}`;
}

/** 把 import 说明符（相对某消费者文件）resolve 为项目内源文件；返回相对 project_dir 的 posix 路径，失败 null。
 *  相对 source 按消费者目录解析；非相对 source 走 Go 包路径（命中 go.mod module 前缀才视为自研）。 */
export function resolveConsumerSource(project_dir: string, consumerRel: string, source: string): string | null {
  if (!source.startsWith('.')) {
    // Go 包路径 / node 内置 / 三方包：仅当命中当前 module 前缀才是项目内自研包。
    const mod = goModulePrefix(project_dir);
    if (mod && (source === mod || source.startsWith(mod + '/'))) {
      const sub = source === mod ? '' : source.slice(mod.length + 1);
      return resolveGoPackageFile(project_dir, sub);
    }
    return null;
  }
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
  for (const raw of scannedFiles) {
    // scannedFiles 可能来自 scanProjectSourceFiles（无 files 时返回绝对路径）——
    // 归一化为相对 proj 后再拼读，否则 path.join(proj, 绝对路径) 拼出无效路径读不到文件，
    // 让护栏退化为恒 0（硬闸门失效）。相对入参原样保留。
    const rel = path.isAbsolute(raw) ? path.relative(proj, raw) : raw;
    if (rel.replace(/\\/g, '/') === mod) continue; // 自身不算
    let src: string;
    try {
      src = fs.readFileSync(path.join(proj, rel), 'utf-8');
    } catch {
      continue;
    }
    // Go：按目标模块所属包路径匹配（Go 包级 import；命中即视为该 .go 文件仍引用目标包）。
    if (/\.go$/.test(rel)) {
      const tgt = goPackageOfFile(proj, mod);
      if (tgt && parseGoImportQualifiers(src).has(tgt)) {
        n++;
        break;
      }
      continue;
    }
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

/**
 * 模块是否在项目内存在"活跃消费引用"——任意文件对它有被真正使用（活 import）的引用。
 * 候选框架的关键闸门：detectDeadImports 只报"死引用"，但一个模块可能既有死引用又有
 * 活跃消费（被广泛使用、仅个别文件忘用）。后者绝不是"可下线积木"，必须排除出候选——
 * 否则会把 pet 系渲染器这类核心模块误标为下线候选（肉眼不可信）。
 * 判定独立于 detectDeadImports：直接对每个引用该模块的文件做"该 import 是否被使用"的
 * 文件级判定（parseTsImportQualifiers + qualifierLines）。Go：保守视为有活跃引用
 * （与 remainingImporters 的 Go 策略一致，不判可下线）。返回 true = 有活跃消费。
 */
export function hasActiveReference(project_dir: string, moduleRel: string, scannedFiles: string[]): boolean {
  const proj = path.resolve(project_dir);
  const mod = moduleRel.replace(/\\/g, '/');
  for (const raw of scannedFiles) {
    // scannedFiles 可能来自 scanProjectSourceFiles（无 files 时返回绝对路径），而
    // path.join 对绝对路径不重置（不同于 path.resolve），直接拼接会死亡路径读不到文件，
    // 让本闸门退化为恒 false（活跃消费判不出 → 候选清单不可信）。须先归一化为相对 proj。
    const rel = path.isAbsolute(raw) ? path.relative(proj, raw) : raw;
    if (rel.replace(/\\/g, '/') === mod) continue; // 自身不算
    let src: string;
    try {
      src = fs.readFileSync(path.join(proj, rel), 'utf-8');
    } catch {
      continue;
    }
    // Go：按"目标模块所属包路径"匹配 .go 消费者的 import（Go 是包级 import，非相对文件路径）。
    if (/\.go$/.test(rel)) {
      const tgt = goPackageOfFile(proj, mod);
      if (!tgt) continue;
      for (const [source, quals] of parseGoImportQualifiers(src)) {
        if (source !== tgt) continue;
        // 空/点导入 = 副作用恒活；任一限定符有 `Q.` 成员访问 → 活跃引用
        if (quals.some((q) => q === '_' || q === '.')) return true;
        if (quals.some((q) => qualifierLines(src, q, 'go').length > 0)) return true;
      }
      continue;
    }
    const scan = stripTsImportLines(src);
    for (const source of enumerateDeriveSources(src).keys()) {
      if (!source.startsWith('.')) continue;
      if (resolveConsumerSource(proj, rel, source) !== mod) continue;
      const quals = parseTsImportQualifiers(src, source);
      if (quals === null) return true; // 副作用导入/语法不认识 → 保守当活跃
      if (quals.some((q) => qualifierLines(scan, q, 'ts').length > 0)) return true; // 有活跃引用
    }
  }
  return false;
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

  // 活跃消费确认：候选清单必须肉眼可信——只把"无活跃消费"的模块列为可下线候选；
  // 被别处仍在使用的模块（即便有死引用）标为 has_active_consumer，绝不冒充下线候选。
  const scannedFiles = scanProjectSourceFiles(proj, opts.files);
  const items: DeprecateOfflineItem[] = [];
  for (const [source, { moduleFile }] of candidates) {
    const consumers = projectSources.get(source)!.consumers;
    const offlineable = moduleFile !== null && !hasActiveReference(proj, moduleFile, scannedFiles);
    items.push({
      source,
      module_file: moduleFile,
      consumers,
      status: offlineable ? 'candidate' : 'has_active_consumer',
      note: offlineable
        ? '候选待执行（无活跃消费）'
        : '存在活跃消费：非下线候选（仅可清理该处死引用）',
    });
  }

  if (dryRun) {
    // 仅预览候选，不落盘、不验证
    const offlineable = items.filter((i) => i.status === 'candidate').length;
    const lines: string[] = [
      `deprecate_offline（dry-run，均未落盘）：扫描 ${detect.scanned} 文件 → ${detect.dead.length} 个死源 → ${offlineable} 个可下线自研积木候选（${items.length - offlineable} 个有活跃消费，已排除）`,
      '以下将被"移除各消费者死 import"' + (removeFile ? ' + 物理删除源码文件' : '（--remove-file 才删文件）') + '：',
      '',
    ];
    for (const it of items) {
      if (it.status === 'candidate') {
        lines.push(`  [下线候选] ${it.source} / 模块 ${it.module_file} / ${it.consumers} 处死引用`);
      } else {
        lines.push(`  [活跃消费·非下线] ${it.source} / 模块 ${it.module_file} / ${it.consumers} 处死引用 → ${it.note}`);
      }
    }
    lines.push('', '确认后以 --apply（+ --remove-file 如需删文件）执行。');
    return { ok: true, dry_run: true, remove_file: removeFile, candidates: offlineable, offlined: 0, items, message: lines.join('\n') };
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
    const nCandidates = items.filter((i) => i.status === 'candidate').length;
    return { ok: false, dry_run: false, remove_file: removeFile, candidates: nCandidates, offlined: 0, items, message: 'deprecate_offline：基线编译失败，未执行任何改动。' };
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
      // 有活跃消费的活模块：死引用被清掉，但模块必须保留（pruned），不冒充下线成功。
      const live = it.status === 'has_active_consumer';
      it.status = live ? 'pruned' : 'offlined';
      it.note = live
        ? '已清理死引用；模块仍有活跃消费（保留）'
        : '死 import 已移除，编译通过（无活跃消费）';
      if (!live) offlined += 1;
      if (removeFile && !live) removableFiles.add(it.module_file!);
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