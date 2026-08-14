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
  kind: 'enter' | 'exit' | 'catch' | 'io';
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
  /** 是否实际写盘；false 只做 dry-run 报告（默认 true） */
  write?: boolean;
}

/** 探针调用标记：已插桩文件里若含此标记则跳过（幂等） */
const PROBE_MARKER = 'camera:instrumented';

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

/** 计算 import 相对路径：从 file 目录到 src/camera/probe.js */
function relativeProbeImport(file: string, projectRoot: string): string {
  const cameraProbe = path.join(projectRoot, 'src', 'camera', 'probe.js');
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
 * 对单个 TS 文件插桩。返回注入的探针点（dry-run 不写盘）。
 * level 分级：enter/exit=core，catch=event，io=event。
 */
export async function instrumentFile(file: string, opts: InstrumentOptions = {}): Promise<InstrumentFileResult> {
  const applyWrite = opts.write ?? true;
  const result: InstrumentFileResult = { file, sites: [] };
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  // 幂等：已插桩跳过
  if (content.includes(PROBE_MARKER)) return result;

  const parsed = await parseAstRoot(file, content);
  if (!parsed) {
    result.error = '解析失败（语言包不支持或语法错误）';
    return result;
  }
  const root = asInstr(parsed.root);

  // 收集插入点（从后往前构造，偏移由大到小）
  const insertions: { index: number; removeTo?: number; site: InstrumentedSite }[] = [];
  collectSites(root, file, content, insertions);

  if (insertions.length === 0) return result;

  // 按 index 从大到小排序，从后往前注入避免偏移漂移
  insertions.sort((a, b) => b.index - a.index);

  const projectRoot = opts.projectRoot ?? inferProjectRoot(file);
  const probeImport = opts.probeImport ?? relativeProbeImport(file, projectRoot);
  const importStmt = buildImportStmt(probeImport);

  let out = content;
  for (const ins of insertions) {
    const removeTo = ins.removeTo ?? ins.index; // 默认纯插入；removeTo>index 表示替换区间
    out = out.slice(0, ins.index) + ins.site.injected + out.slice(removeTo);
  }
  out = importStmt + `// ${PROBE_MARKER}\n` + out;

  result.sites = insertions.map((i) => i.site);
  if (applyWrite) {
    fs.writeFileSync(file, out, 'utf-8');
  }
  return result;
}

/**
 * 收集一个文件内所有插桩点脚本。site.injected 为要插入/替换的源码文本，
 * site.line 为插入位置所在行（1-based）。
 */
function collectSites(
  root: InstrNode,
  file: string,
  content: string,
  insertions: { index: number; removeTo?: number; site: InstrumentedSite }[],
): void {
  const walk = (n: InstrNode): void => {
    // ── 函数入口/出口（core）──
    if (FN_TYPES.has(n.type) && isBlockBody(n)) {
      const body = n.childForFieldName!('body')!;
      const fn = detectEnclosingFunction(root, n.startIndex) || 'module';
      const mod = path.basename(file).replace('.ts', '');
      const params = extractParamNames(n);
      const probeName = `${mod}.${fn}`;

      // 入口：body.startIndex 指向 '{'，跳过后首非空白
      const open = body.startIndex;
      let entryIdx = open;
      if (content[entryIdx] === '{') entryIdx++;
      while (entryIdx < content.length && /\s/.test(content[entryIdx])) entryIdx++;
      const argsObj = params.length ? `{ ${params.map((p) => `${p}: ${p}`).join(', ')} }` : '{}';
      const enterProbe = `captureProbe(${JSON.stringify(probeName + '.enter')}, { args: ${argsObj}, level: 'core' });\n`;
      insertions.push({ index: entryIdx, site: { file, line: n.startPosition.row + 1, kind: 'enter', level: 'core', injected: enterProbe } });

      // 出口：若函数体无 return，则在末尾补末尾出口探针（有 return 的由 return 分支负责）
      const returns: InstrNode[] = [];
      collectReturns(body, returns);
      if (returns.length === 0) {
        // 在函数体最后一个 `}` 之前插入出口探针（保持函数体语法完整）
        const tailIdx = body.endIndex - 1; // 指向 '}'
        const exitProbe = `;captureProbe(${JSON.stringify(probeName + '.exit')}, { ret: undefined, level: 'core' });`;
        insertions.push({ index: tailIdx, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: exitProbe } });
      }
    }

    // ── return 出口（core）──
    if (n.type === 'return_statement') {
      handleReturn(n, root, file, content, insertions);
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
        const injected = `captureProbe(${JSON.stringify(probeName)}, { op: 'catch', err: (e as Error)?.message ?? '', level: 'event' });\n`;
        insertions.push({ index: idx, site: { file, line: n.startPosition.row + 1, kind: 'catch', level: 'event', injected } });
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
        const injected = `;captureProbe(${JSON.stringify(probeName)}, { op: ${JSON.stringify(IO_CALLS[callee])}, level: 'event' });`;
        insertions.push({ index: idx, site: { file, line: n.startPosition.row + 1, kind: 'io', level: 'event', injected } });
      }
    }

    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
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
): void {
  const fn = detectEnclosingFunction(root, n.startIndex);
  const mod = path.basename(file).replace('.ts', '');
  const probeName = `${mod}.${fn}.exit`;
  const expr = returnExpr(n);

  if (expr && isSimpleExpr(expr)) {
    const lineSuffix = n.startPosition.row + 1;
    const tempVar = `__cam_ret${lineSuffix}`;
    // 替换整个 return 语句：`return <expr>;` → `const T=<expr>; probe; return T;`
    const replacement = `const ${tempVar} = ${expr.text};captureProbe(${JSON.stringify(probeName)}, { ret: ${tempVar}, level: 'core' });return ${tempVar};`;
    insertions.push({ index: n.startIndex, removeTo: n.endIndex, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: replacement } });
  } else {
    // 复杂表达式或裸 return：仅记录返回路径（不捕获值，避免双求值/冲突）
    const marker = `captureProbe(${JSON.stringify(probeName)}, { ret: undefined, level: 'core' });`;
    insertions.push({ index: n.startIndex, site: { file, line: n.startPosition.row + 1, kind: 'exit', level: 'core', injected: marker } });
  }
}

/** 对项目下所有 .ts 文件插桩。返回每个文件的插桩结果。 */
export async function instrumentProject(root: string, opts: InstrumentOptions = {}): Promise<InstrumentFileResult[]> {
  const files = collectTsFiles(root);
  const results: InstrumentFileResult[] = [];
  for (const f of files) {
    results.push(await instrumentFile(f, opts));
  }
  return results;
}