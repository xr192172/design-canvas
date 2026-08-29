/**
 * Camera 全自动插桩器（AST 源码级插桩，直接改写原文件，git 兜底）
 *
 * 设计意图（2026-08-14，狗食插桩纠偏·全量无脑插桩）：
 *   原始需求是「全函数插桩 + 监控函数内数据流动」。早期实现只插 catch + IO
 *   两类"关键点"，是交接时遗漏需求导致的局部插桩。此处改为**全量无脑插桩**：
 *   对所有函数出入口、return、参数、返回值、catch 块、IO 写盘调用全插探针，
 *   不挑点。DSL 做筛选——探针产出全量事件，装配层用 DesignDSL 声明匹配判定，
 *   没命中的即 undesigned 噪音。全量采集与判定筛选解耦，适配任何项目/阶段。
 *
 * 事件分级标签（level 字段随事件产出，LLM/判定层按需选择性读取）：
 *   - core  ：函数入口(enter)/出口(exit) 参数与返回值 —— 发现数据/逻辑错误
 *   - event ：catch 静默丢错 + IO 写盘 —— 发现落盘/异常吞错问题
 *   - deep  ：函数内部关键变量/分支（可选放大，本次不默认开启）
 *
 * 插桩点（四类）：
 *   1. 函数入口（function_declaration/method_definition/arrow_function/
 *      function_expression）：在函数体开头注入
 *      captureProbe('<mod>.<fn>.enter', { args: { <param>: <param>, ... }, level: 'core' })。
 *   2. 函数出口（return 语句）：把 `return <expr>;` 改写为
 *      `const __cam_ret = <expr>; captureProbe('<mod>.<fn>.exit', { ret: __cam_ret, level: 'core' }); return __cam_ret;`
 *      —— 语义等价（expr 仅求值一次）。无返回值 return 仅记录返回路径。
 *      无显式 return 的函数在函数体末尾补一个末尾出口探针。
 *   3. catch 块（catch_clause）：在 catch 体开头注入
 *      captureProbe('<mod>.<fn>.catch', { err: <e>?.message, level: 'event' })。
 *   4. IO 写盘调用（writeFileSync/mkdirSync/...）：在调用后注入
 *      captureProbe('<mod>.<fn>.<op>', { op, level: 'event' })。
 *
 * 注入方式：基于 tree-sitter 节点的字节偏移，从后往前替换/插入（避免偏移漂移），
 * 最后在文件顶部补 import。幂等：已注入过探针的文件跳过（检测探针标记）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseAstRoot } from '../tools/ts_kernel/kernel.js';

/**
 * 强类型节点接口：tree-sitter 节点原生携带 startIndex/endIndex（字符偏移），
 * kernel 的 SyntaxNodeLike 只标了可选，这里断言为必填以支持文本注入。
 */
interface InstrNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  childCount: number;
  child(i: number): InstrNode | null;
  childForFieldName?(name: string): InstrNode | null;
}

/** 将 kernel 节点断言为强类型节点（tree-sitter 保证字段齐全） */
function asInstr(n: unknown): InstrNode {
  return n as InstrNode;
}

/** 事件分级标签（详见文件头注释） */
export type ProbeLevel = 'core' | 'event' | 'deep';

/** 单个插桩点 */
export interface InstrumentedSite {
  file: string;
  line: number;
  kind: 'enter' | 'exit' | 'catch' | 'io' | 'deep';
  level: ProbeLevel;
  // 注入的探针源码（用于报告）
  injected: string;
}

/** 单文件插桩结果 */
export interface InstrumentFileResult {
  file: string;
  sites: InstrumentedSite[];
  error?: string;
}

/** 插桩配置 */
export interface InstrumentOptions {
  /** 探针 import 的模块路径（相对被插桩文件，默认相对 src/camera/probe.js 计算） */
  probeImport?: string;
  /** 项目根，用于计算 probe import 相对路径（默认从 src/camera/probe.ts 向上推断） */
  projectRoot?: string;
  /** 备份根：写盘前把原文件备份到 <backupRoot>/.design-canvas/camera-backup/<rel>，
   *  供 --uninstrument 还原。默认等于 projectRoot（被插桩项目根）。 */
  backupRoot?: string;
  /** 是否实际写盘；false 只做 dry-run 报告（默认 true） */
  write?: boolean;
  /** 是否启用 deep 级插桩（函数内部变量赋值/条件分支捕获）。默认 false——
   *  deep 事件量很大，按需放大。core/event 不受此开关影响。 */
  enableDeep?: boolean;
  /** 契约模式探针列表：非 undefined 时只注入其中声明的探针点（精确匹配
   *  `<mod>.<fn>.<suffix>`），并做模块级过滤；undefined 时全量无脑插桩（探索模式）。
   *  与 Go 侧 instrument.Options.ContractProbes 语义对齐。 */
  contractProbes?: string[];
}

/**
 * 契约门：探针名是否命中契约列表。
 *   - probes === undefined → 探索模式，恒 true（全量无脑插桩）
 *   - probes 非 undefined → 精确匹配（契约模式）
 */
function matchContract(probeName: string, probes?: string[]): boolean {
  if (probes === undefined) return true;
  return probes.includes(probeName);
}

/** 探针调用标记：已插桩文件里若含此标记则跳过（幂等） */
const PROBE_MARKER = 'camera:instrumented';

/** deep 级插桩独立标记：deep 是可选放大（enableDeep），可与 core/event 分次施加。
 *  文件含此标记说明 deep 探针已注入，避免重复。 */
const DEEP_MARKER = 'camera:deep';

/** 备份目录名（相对被插桩项目根，位于 .design-canvas 下，collectTsFiles 会跳过） */
const BACKUP_DIR = '.design-canvas/camera-backup';

/** 探针台账文件名（相对被插桩项目根，位于 .design-canvas 下） */
const LEDGER_FILE = '.design-canvas/camera-ledger.json';

/** 备份文件名：把原文件相对项目根（backupRoot）的路径映射为备份目录下的镜像路径 */
function backupPathFor(backupRoot: string, file: string): string {
  const rel = path.relative(backupRoot, file).replaceAll('\\', '/');
  return path.join(backupRoot, BACKUP_DIR, rel);
}

/** 原文件写盘前，若尚无备份则把当前内容备份到 .design-canvas/camera-backup */
function backupOriginal(backupRoot: string, file: string, content: string): void {
  const dest = backupPathFor(backupRoot, file);
  if (fs.existsSync(dest)) return; // 已备份过则保留最早的原版
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf-8');
}

/** 从备份镜像 path 还原: 把备份文件拷回原位置 */
function restoreOne(backupRoot: string, backupFile: string): string | null {
  const rel = path.relative(path.join(backupRoot, BACKUP_DIR), backupFile);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const target = path.join(backupRoot, rel);
  fs.writeFileSync(target, fs.readFileSync(backupFile, 'utf-8'), 'utf-8');
  return target;
}

/** 列出备份目录下所有已备份文件（递归） */
function listBackups(backupRoot: string): string[] {
  const dir = path.join(backupRoot, BACKUP_DIR);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 还原被插桩项目的所有文件：从 .design-canvas/camera-backup 拷回原版，然后删除备份目录。
 * 返回已还原的文件绝对路径列表。
 */
export function restoreInstrumented(root: string): string[] {
  const backups = listBackups(root);
  const restored: string[] = [];
  for (const b of backups) {
    const t = restoreOne(root, b);
    if (t) restored.push(t);
  }
  if (backups.length > 0) {
    fs.rmSync(path.join(root, BACKUP_DIR), { recursive: true, force: true });
  }
  return restored;
}

// ─────────────────────────────────────────────────────────────
// 探针台账（ledger）：把「单文件插拔」记账成台账 + 统计，
// 支撑 一键插所有文件 / 一键拔所有文件 / 查看统计 的联动。
// 台账持久化在 <被插桩项目根>/.design-canvas/camera-ledger.json，
// 与 camera-backup 备份目录同处，collectTsFiles 自动跳过。
// ─────────────────────────────────────────────────────────────

/** 探针台账：记录一次插桩的全部探针点 + 统计（供查看/统计/精确还原/一键全拔） */
export interface ProbeLedger {
  projectRoot: string;
  instrumentedAt: string;
  sites: InstrumentedSite[];
  stats: {
    /** 探针点总数 */
    total: number;
    /** 涉及文件数 */
    files: number;
    /** 按插桩类型统计（enter/exit/catch/io/deep） */
    perKind: Record<string, number>;
    /** 按事件级别统计（core/event/deep） */
    perLevel: Record<string, number>;
  };
}

/** 台账文件路径（相对被插桩项目根） */
export function ledgerPath(root: string): string {
  return path.join(root, LEDGER_FILE);
}

/** 从插桩结果构建台账 */
export function buildProbeLedger(results: InstrumentFileResult[], projectRoot: string): ProbeLedger {
  const sites: InstrumentedSite[] = [];
  const files = new Set<string>();
  for (const r of results) {
    if (r.error || r.sites.length === 0) continue;
    files.add(r.file);
    sites.push(...r.sites);
  }
  const perKind: Record<string, number> = {};
  const perLevel: Record<string, number> = {};
  for (const s of sites) {
    perKind[s.kind] = (perKind[s.kind] || 0) + 1;
    perLevel[s.level] = (perLevel[s.level] || 0) + 1;
  }
  return {
    projectRoot,
    instrumentedAt: new Date().toISOString(),
    sites,
    stats: { total: sites.length, files: files.size, perKind, perLevel },
  };
}

/** 保存台账到 <root>/.design-canvas/camera-ledger.json，返回台账文件路径 */
export function saveProbeLedger(root: string, ledger: ProbeLedger): string {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2), 'utf-8');
  return file;
}

/** 加载台账；不存在或解析失败返回 null */
export function loadProbeLedger(root: string): ProbeLedger | null {
  const file = ledgerPath(root);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as ProbeLedger;
  } catch {
    return null;
  }
}

/** 清理台账（--uninstrument 一键全拔时联动删除）；存在并删除返回 true */
export function clearProbeLedger(root: string): boolean {
  const file = ledgerPath(root);
  if (fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
    return true;
  }
  return false;
}

/** 台账统计单行摘要（供 CLI / MCP 展示）：如 `18 探针点 · 3 文件 · enter:6 exit:8 catch:2 io:2 · core:16 event:4` */
export function ledgerSummary(ledger: ProbeLedger): string {
  const kind = Object.entries(ledger.stats.perKind).map(([k, v]) => `${k}:${v}`).join(' ');
  const level = Object.entries(ledger.stats.perLevel).map(([k, v]) => `${k}:${v}`).join(' ');
  return `${ledger.stats.total} 探针点 · ${ledger.stats.files} 文件 · ${kind} · ${level}`;
}

/** 函数类节点类型 → 插桩函数出入口 */
const FN_TYPES = new Set([
  'function_declaration',
  'method_definition',
  'arrow_function',
  'function_expression',
  'generator_function_declaration',
  'generator_function',
]);

/** IO 写盘调用名 → 探针 op 名 */
const IO_CALLS: Record<string, string> = {
  writeFileSync: 'writefile',
  writeFile: 'writefile',
  mkdirSync: 'mkdirall',
  mkdir: 'mkdirall',
  appendFileSync: 'appendfile',
  appendFile: 'appendfile',
  copyFileSync: 'copyfile',
  copyFile: 'copyfile',
  renameSync: 'rename',
  rename: 'rename',
  unlinkSync: 'remove',
  unlink: 'remove',
  rmSync: 'remove',
  rm: 'remove',
};

/** 递归收集项目下所有 .ts 源文件（跳过 node_modules / dist / .git / .design-canvas） */
export function collectTsFiles(root: string): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', '.git', '.design-canvas', 'coverage', '.agent']);
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** 计算相对模块路径的 import 语句 */
function buildImportStmt(probeImport: string): string {
  return `import { captureProbe } from '${probeImport}';\n`;
}

/** 计算 import 相对路径：从 file 目录到编译后的探针实现 dist/src/camera/probe.js
 * （被插桩代码运行时解析的是编译产物，而非 TS 源） */
function relativeProbeImport(file: string, projectRoot: string): string {
  const cameraProbe = path.join(projectRoot, 'dist', 'src', 'camera', 'probe.js');
  let rel = path.relative(path.dirname(file), cameraProbe).replaceAll('\\', '/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/** 从文件路径向上找含 src/camera/probe.ts 的项目根；找不到退回文件所在目录 */
function inferProjectRoot(file: string): string {
  let dir = path.dirname(file);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'camera', 'probe.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(file);
}

/** 从文件内容推导当前函数/方法名（用于探针 probe 命名，取最近一级函数定义） */
function detectEnclosingFunction(root: InstrNode, insertIndex: number): string {
  let fnName = '';
  const walk = (n: InstrNode): void => {
    if (n.startIndex > insertIndex) return;
    if (FN_TYPES.has(n.type)) {
      const nameChild = n.childForFieldName?.('name');
      if (nameChild && nameChild.text) fnName = nameChild.text;
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c && c.startIndex <= insertIndex && c.endIndex >= insertIndex) walk(c);
    }
  };
  walk(root);
  return fnName || 'module';
}

/** 提取函数参数名列表（用于入口探针捕获参数值） */
function extractParamNames(fn: InstrNode): string[] {
  const params = fn.childForFieldName?.('parameters');
  if (!params) return [];
  const names: string[] = [];
  for (let i = 0; i < params.childCount; i++) {
    const p = params.child(i);
    if (!p) continue;
    const nameNode = p.childForFieldName?.('name') ?? firstIdentifier(p);
    if (nameNode && nameNode.text) names.push(nameNode.text);
  }
  return names;
}

/** 从节点里找第一个 identifier/property_identifier 子节点（含嵌套，深度受限） */
function firstIdentifier(n: InstrNode, depth = 0): InstrNode | null {
  if (n.type === 'identifier' || n.type === 'property_identifier') return n;
  if (depth > 4) return null;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    const found = firstIdentifier(c, depth + 1);
    if (found) return found;
  }
  return null;
}

/** 判断函数体是否为块体（statement_block）；箭头表达式体不做插桩 */
function isBlockBody(fn: InstrNode): boolean {
  const body = fn.childForFieldName?.('body');
  return !!body && body.type === 'statement_block';
}

/** 收集某函数体内所有 return 语句（不进入嵌套函数，避免把内层 return 算到外层） */
function collectReturns(node: InstrNode, out: InstrNode[]): void {
  const walk = (n: InstrNode): void => {
    if (n.type === 'return_statement') {
      out.push(n);
      return;
    }
    if (FN_TYPES.has(n.type)) return; // 嵌套函数跳过
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) walk(c);
  }
}

/** 提取 return 语句的返回值表达式（无则 null） */
function returnExpr(n: InstrNode): InstrNode | null {
  for (const target of ['value', 'expression']) {
    const e = n.childForFieldName?.(target) ?? null;
    if (e) return e;
  }
  // 兜底：查找 return 关键字后的第一个命名子节点（排除分号）
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    if (c.type === ';' || c.text === 'return') continue;
    return c;
  }
  return null;
}

/** 判断表达式是否「简单」（无调用、无副作用）——仅此类 return 才做值捕获替换，避免双求值/冲突 */
function isSimpleExpr(n: InstrNode): boolean {
  if (n.type === 'call_expression' || n.type === 'import_expression' || n.type === 'new_expression') return false;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c && !isSimpleExpr(c)) return false;
  }
  return true;
}

/**
 * 判断 return 是否处于「无大括号控制语句的单语句体」中（如 `if (x) return null;`）。
 * 此时 return 是其父控制语句的 consequent，且父节点没有 statement_block 包裹。
 * 这种位置不能做值捕获替换（会破坏语法），只能降级为返回标记。
 */
function isBracelessGuardReturn(parent: InstrNode | undefined): boolean {
  if (!parent) return false;
  const guardTypes = new Set(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'labeled_statement']);
  if (!guardTypes.has(parent.type)) return false;
  // 若父控制语句有 statement_block 子节点（即花括号体），说明 return 在块内，安全。
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i);
    if (c && c.type === 'statement_block') return false;
  }
  return true;
}

/**
 * 对单个 TS 文件插桩。返回注入的探针点（dry-run 不写盘）。
 * level 分级：enter/exit=core，catch=event，io=event。
 */
export async function instrumentFile(file: string, opts: InstrumentOptions = {}): Promise<InstrumentFileResult> {
  const applyWrite = opts.write ?? true;
  const enableDeep = opts.enableDeep ?? false;
  const result: InstrumentFileResult = { file, sites: [] };
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  // 幂等：按标记判断该文件已注入哪些级别的探针，避免重复。
  //   - core/event 已注入（PROBE_MARKER）且未请求 deep → 跳过
  //   - core/event 与 deep 都已注入 → 跳过
  const hasCore = content.includes(PROBE_MARKER);
  const hasDeep = content.includes(DEEP_MARKER);
  if ((hasCore && !enableDeep) || (hasCore && hasDeep)) return result;

  const parsed = await parseAstRoot(file, content);
  if (!parsed) {
    result.error = '解析失败（语言包不支持或语法错误）';
    return result;
  }
  const root = asInstr(parsed.root);

  const projectRoot = opts.projectRoot ?? inferProjectRoot(file);
  // 探针注入时附带的文件相对路径（相对项目根，正斜杠），供日志按文件过滤
  const fileRel = path.relative(projectRoot, file).replaceAll('\\', '/');

  // 收集插入点（从后往前构造，偏移由大到小）
  const insertions: { index: number; removeTo?: number; site: InstrumentedSite }[] = [];
  const probes = opts.contractProbes;
  // core/event 探针：仅当文件尚未注入 core/event 时收集（避免对已插桩文件重复注入）
  if (!hasCore) collectSites(root, file, content, insertions, fileRel, probes);
  // deep 探针：仅在请求 enableDeep 且尚未注入 deep 时收集
  if (enableDeep && !hasDeep) collectDeepSites(root, file, content, insertions, fileRel, probes);

  if (insertions.length === 0) return result;

  // 按 index 从大到小排序，从后往前注入避免偏移漂移
  insertions.sort((a, b) => b.index - a.index);

  const probeImport = opts.probeImport ?? relativeProbeImport(file, projectRoot);
  const importStmt = buildImportStmt(probeImport);

  let out = content;
  for (const ins of insertions) {
    const removeTo = ins.removeTo ?? ins.index; // 默认纯插入；removeTo>index 表示替换区间
    out = out.slice(0, ins.index) + ins.site.injected + out.slice(removeTo);
  }
  // 头部补 import 与分级标记（避免重复补：import 已存在则跳过）
  if (!hasCore) out = importStmt + `// ${PROBE_MARKER}\n` + out;
  if (enableDeep && !hasDeep) out = `// ${DEEP_MARKER}\n` + out;

  result.sites = insertions.map((i) => i.site);
  if (applyWrite) {
    // 写盘前先备份原文件（幂等：已备份则保留最早原版），供 --uninstrument 一键还原
    const backupRoot = opts.backupRoot ?? projectRoot;
    backupOriginal(backupRoot, file, content);
    fs.writeFileSync(file, out, 'utf-8');
  }
  return result;
}

/**
 * 收集一个文件内所有插桩点脚本。site.injected 为要插入/替换的源码文本，
 * site.line 为插入位置所在行（1-based）。probes 非 undefined（契约模式）时
 * 每个注入点用 matchContract 精确门控。
 */
function collectSites(
  root: InstrNode,
  file: string,
  content: string,
  insertions: { index: number; removeTo?: number; site: InstrumentedSite }[],
  fileRel: string,
  probes?: string[],
): void {
  const walk = (n: InstrNode, parent?: InstrNode): void => {
    // ── 函数入口/出口（core）──
    if (FN_TYPES.has(n.type) && isBlockBody(n)) {
      const body = n.childForFieldName!('body')!;
      const fn = detectEnclosingFunction(root, n.startIndex) || 'module';
      const mod = path.basename(file).replace('.ts', '');
      const params = extractParamNames(n);
      const probeName = `${mod}.${fn}`;

      // 入口：body.startIndex 指向 '{'，跳过后首非空白
      if (matchContract(probeName + '.enter', probes)) {
        const open = body.startIndex;
        let entryIdx = open;
        if (content[entryIdx] === '{') entryIdx++;
        while (entryIdx < content.length && /\s/.test(content[entryIdx])) entryIdx++;
        const argsObj = params.length ? `{ ${params.map((p) => `${p}: ${p}`).join(', ')} }` : '{}';
        const enterProbe = `captureProbe(${JSON.stringify(probeName + '.enter')}, { file: ${JSON.stringify(fileRel)}, args: ${argsObj}, level: 'core' });\n`;
        insertions.push({ index: entryIdx, site: { file, line: n.startPosition.row + 1, kind: 'enter', level: 'core', injected: enterProbe } });
      }

      // 出口：若函数体无 return，则在末尾补末尾出口探针（有 return 的由 return 分支负责）
      if (matchContract(probeName + '.exit', probes)) {
        const returns: InstrNode[] = [];
        collectReturns(body, returns);
        if (returns.length === 0) {
          // 在函数体最后一个 `}` 之前插入出口探针（保持函数体语法完整）
          const tailIdx = body.endIndex - 1; // 指向 '}'
          const exitProbe = `;captureProbe(${JSON.stringify(probeName + '.exit')}, { file: ${JSON.stringify(fileRel)}, ret: undefined, level: 'core' });`;
          insertions.push({ index: tailIdx, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: exitProbe } });
        }
      }
    }

    // ── return 出口（core）──
    if (n.type === 'return_statement') {
      handleReturn(n, root, file, content, insertions, fileRel, parent, probes);
    }

    // catch 块（event）：在 catch 体开头注入
    if (n.type === 'catch_clause') {
      const body = n.childForFieldName?.('body') || n.child(2);
      if (body) {
        const open = body.startIndex;
        let idx = open;
        const text = content;
        if (text[idx] === '{') idx++;
        while (idx < text.length && /\s/.test(text[idx])) idx++;
        const fn = detectEnclosingFunction(root, open);
        const probeName = `${path.basename(file).replace('.ts', '')}.${fn}.catch`;
        if (matchContract(probeName, probes)) {
          const injected = `captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, op: 'catch', err: (e as Error)?.message ?? '', level: 'event' });\n`;
          insertions.push({ index: idx, site: { file, line: n.startPosition.row + 1, kind: 'catch', level: 'event', injected } });
        }
      }
    }

    // IO 写盘调用（event）：在调用表达式后注入
    if (n.type === 'call_expression') {
      const calleeNode = n.childForFieldName?.('function');
      const callee = calleeNode ? calleeNode.text.split('.').pop() || calleeNode.text : '';
      if (IO_CALLS[callee]) {
        const idx = n.endIndex;
        const fnName = detectEnclosingFunction(root, n.startIndex);
        const probeName = `${path.basename(file).replace('.ts', '')}.${fnName}.${IO_CALLS[callee]}`;
        if (matchContract(probeName, probes)) {
          const injected = `;captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, op: ${JSON.stringify(IO_CALLS[callee])}, level: 'event' });`;
          insertions.push({ index: idx, site: { file, line: n.startPosition.row + 1, kind: 'io', level: 'event', injected } });
        }
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c, n);
    }
  };
  walk(root);
}

// ─────────────────────────────────────────────────────────────
// deep 级插桩（enableDeep=true 时启用）：捕获函数内部数据流动——
// 变量赋值、赋值表达式、分支/循环条件的关键中间值。事件量很大，默认关闭。
// 注入点统一打 level:'deep' 标签，与 core/event 分级正交，可按需选择性读取。
// ─────────────────────────────────────────────────────────────

/** 判断表达式是否无副作用（无调用/赋值/更新/await/yield）——deep 捕获需重求值，
 *  仅对无副作用表达式这样做，避免双求值或改变语义。 */
function isSideEffectFreeExpr(n: InstrNode): boolean {
  const bad = new Set([
    'call_expression', 'new_expression', 'import_expression',
    'assignment_expression', 'update_expression', 'await_expression',
    'yield_expression', 'sequence_expression', 'arrow_function',
  ]);
  if (bad.has(n.type)) return false;
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c && !isSideEffectFreeExpr(c)) return false;
  }
  return true;
}

/** 取括号表达式内部的实际表达式（parenthesized_expression → 内层），无括号原名返回。 */
function parenInner(n: InstrNode): InstrNode {
  let cur = n;
  while (cur.type === 'parenthesized_expression') {
    cur = asInstr(cur.child(1) ?? cur.child(0) ?? cur);
  }
  return cur;
}

/** 找节点下第一个 statement_block 直接子节点（if/while/for 的体，位置子节点，无字段名）。 */
function findBlockChild(n: InstrNode): InstrNode | null {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (c && c.type === 'statement_block') return c;
  }
  return null;
}

/** 计算某函数内 deep 探针名（基名复用函数名，.deep 后缀；模块级为 module.deep）。 */
function deepProbeName(root: InstrNode, file: string, atIndex: number): string {
  const mod = path.basename(file).replace('.ts', '');
  const fn = detectEnclosingFunction(root, atIndex);
  return `${mod}.${fn}.deep`;
}

/** 构造一条 deep 探针注入文本。fields 为捕获字段（value 用重求值安全的表达式文本）。 */
function deepProbeInjected(probeName: string, fileRel: string, fields: string): string {
  return `;captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, level: 'deep', ${fields} });`;
}

/**
 * 收集一个文件内所有 deep 级插桩点（enableDeep 时调用）。与 collectSites 互补，
 * 只处理 core/event 未覆盖的「函数内部数据流动」节点：
 *   A. variable_declaration：对每个带初值的简单标识符声明，在声明后捕获绑定变量值
 *      （`const y = a + b;` → 捕获 y）。跳过 for 头部的计数器声明。
 *   B. expression_statement 内的赋值表达式：`x = <expr>;` → 捕获赋值后 x 的值。
 *   C. if/while/for 的无副作用条件：在分支体内捕获条件判定值。
 * 所有注入都限定在可安全放置语句的位置，避免破坏语法。
 */
function collectDeepSites(
  root: InstrNode,
  file: string,
  content: string,
  insertions: { index: number; removeTo?: number; site: InstrumentedSite }[],
  fileRel: string,
  probes?: string[],
): void {
  const walk = (n: InstrNode, parent?: InstrNode): void => {
    // A. 变量声明（跳过 for 头：父节点是 for_*_statement）
    // 注意：const/let 是 lexical_declaration，var 才是 variable_declaration。
    if (n.type === 'variable_declaration' || n.type === 'lexical_declaration') {
      const inForHeader = parent && (parent.type === 'for_statement' || parent.type === 'for_in_statement' || parent.type === 'for_of_statement');
      if (!inForHeader) {
        for (let i = 0; i < n.childCount; i++) {
          const d = n.child(i);
          if (!d || d.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName?.('name');
          const init = d.childForFieldName?.('value');
          if (!nameNode || nameNode.type !== 'identifier' || !init) continue;
          const name = nameNode.text;
          const probeName = deepProbeName(root, file, d.startIndex);
          // 契约门：deep 探针名统一为 `mod.fn.deep`
          if (!matchContract(probeName, probes)) continue;
          const injected = deepProbeInjected(probeName, fileRel, `name: ${JSON.stringify(name)}, value: ${name}`);
          insertions.push({ index: d.endIndex, site: { file, line: d.startPosition.row + 1, kind: 'deep', level: 'deep', injected } });
        }
      }
    }

    // B. 赋值表达式（仅当位于表达式语句中，避免破坏 for 头/条件等非语句位置）
    if (n.type === 'assignment_expression' && parent?.type === 'expression_statement') {
      const left = n.childForFieldName?.('left');
      if (left && (left.type === 'identifier' || left.type === 'member_expression') && isSideEffectFreeExpr(left)) {
        const probeName = deepProbeName(root, file, n.startIndex);
        if (matchContract(probeName, probes)) {
          const injected = deepProbeInjected(probeName, fileRel, `name: ${JSON.stringify(left.text)}, value: ${left.text}`);
          insertions.push({ index: n.endIndex, site: { file, line: n.startPosition.row + 1, kind: 'deep', level: 'deep', injected } });
        }
      }
    }

    // C. 分支/循环条件捕获（仅在无副作用时重求值，且在块体内注入）。
    //  if/while/for 的体是位置子节点（statement_block），无 consequent/body 字段名。
    if (n.type === 'if_statement' || n.type === 'while_statement' || n.type === 'for_statement') {
      const cond = n.childForFieldName?.('condition');
      const body = findBlockChild(n);
      if (cond && body) {
        const inner = parenInner(cond);
        if (isSideEffectFreeExpr(inner)) {
          const probeName = deepProbeName(root, file, n.startIndex);
          if (matchContract(probeName, probes)) {
            const injected = `;captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, level: 'deep', cond: ${JSON.stringify(inner.text)}, value: ${inner.text} });`;
            // 在块体 '{' 之后注入
            let idx = body.startIndex;
            if (content[idx] === '{') idx++;
            while (idx < content.length && /\s/.test(content[idx])) idx++;
            insertions.push({ index: idx, site: { file, line: n.startPosition.row + 1, kind: 'deep', level: 'deep', injected } });
          }
        }
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c, n);
    }
  };
  walk(root);
}

/** 处理 return 出口：简单表达式做值捕获替换；复杂表达式仅做返回路径标记 */
function handleReturn(
  n: InstrNode,
  root: InstrNode,
  file: string,
  content: string,
  insertions: { index: number; removeTo?: number; site: InstrumentedSite }[],
  fileRel: string,
  parent?: InstrNode,
  probes?: string[],
): void {
  const fn = detectEnclosingFunction(root, n.startIndex);
  const mod = path.basename(file).replace('.ts', '');
  const probeName = `${mod}.${fn}.exit`;
  // 契约门：未声明的 exit 探针不注入（匹配 `mod.fn.exit`）
  if (!matchContract(probeName, probes)) return;
  const expr = returnExpr(n);

  // 无大括号控制语句的单语句 return（如 `if (x) return null;`）：
  // 若做值捕获替换会破坏语法（`if (x) const T=null;` 非法），降级为仅返回标记。
  if (isBracelessGuardReturn(parent)) {
    const marker = `captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, ret: undefined, level: 'core' });`;
    insertions.push({ index: n.startIndex, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: marker } });
    return;
  }

  if (expr && isSimpleExpr(expr)) {
    const lineSuffix = n.startPosition.row + 1;
    const tempVar = `__cam_ret${lineSuffix}`;
    // 替换整个 return 语句：`return <expr>;` → `const T=<expr>; probe; return T;`
    const replacement = `const ${tempVar} = ${expr.text};captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, ret: ${tempVar}, level: 'core' });return ${tempVar};`;
    insertions.push({ index: n.startIndex, removeTo: n.endIndex, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: replacement } });
  } else {
    // 复杂表达式或裸 return：仅记录返回路径（不捕获值，避免双求值/冲突）
    const marker = `captureProbe(${JSON.stringify(probeName)}, { file: ${JSON.stringify(fileRel)}, ret: undefined, level: 'core' });`;
    insertions.push({ index: n.startIndex, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: marker } });
  }
}

/** 对项目下所有 .ts 文件插桩。返回每个文件的插桩结果。 */
export async function instrumentProject(root: string, opts: InstrumentOptions = {}): Promise<InstrumentFileResult[]> {
  const files = collectTsFiles(root);
  // 备份根固定为被插桩项目根 root（与 projectRoot 无关：projectRoot 用于 probe import）
  const perFileOpts: InstrumentOptions = { ...opts, backupRoot: root };
  const results: InstrumentFileResult[] = [];
  for (const f of files) {
    results.push(await instrumentFile(f, perFileOpts));
  }
  return results;
}