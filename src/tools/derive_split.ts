/**
 * derive_split 工具：执行文件拆分（P2，路线图序号 16）
 *
 * 承接 analyze_monolith 的社区分析结果：一个"多社区共占的超标文件"里，把某个
 * 次社区（secondary community）的符号抽到新的兄弟文件，接线 import，并从原文件移除。
 *
 * 设计口径（用户愿景）：
 *   - 社区锚点是功能/业务；拆分粒度 = 社区，不把功能拆碎
 *   - "模型判断 + 人确认"：默认 dry_run=true，只产出两份文件草稿 + 交叉引用 +
 *     语法级验收证据，LLM 看证据后裁决；dry_run=false 才落盘写文件
 *   - 自动验收闭环：写前/写后都用 tree-sitter 语法校验两个文件，输出 readable 报告
 *   - 默认同目录拆分（new_file 缺省时兄弟文件就在原目录），语义：同包/同模块迁移符号
 *
 * 语言范围：
 *   - TypeScript / JavaScript（.ts/.tsx/.js/.jsx/.mjs/.cjs）：ESM 相对 import 接线
 *   - Go（.go）：同包拆分无需跨文件 import（包级符号共享），复制 package + import 块
 *   - Python（.py）：相对/绝对 import 接线，自动检测目录是否构成包（__init__.py）
 * 结构上按语言配置节点类型 + import 生成器扩展，语法差异集中在 derive_split 的 import 适配层。
 *
 * 产出：
 *   - new_content / original_content：两份文件草稿（dry_run 时仅展示）
 *   - extracted：被抽取的符号清单（名称/kind/行区间/行数）
 *   - imports_copied / imports_added_original / imports_added_new：import 接线说明
 *   - references_to_extracted：原文件中指向被抽取符号的引用点（拆后需走新文件 import；Go 同包则无需）
 *   - verification：两个文件草稿的语法校验结果 + 符号对账
 */

import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFileFull, parseAstRoot, ParsedSymbol } from './ts_kernel/index.js';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 社区内子拆分计划（与 analyze_monolith 的 CommunitySubSplit 形状兼容，本地定义以解耦） */
export interface SubSplitMethod {
  /** 方法名（在该文件里的 name） */
  name: string;
  /** 方法所在文件（相对 project_dir） */
  file: string;
}
export interface SubSplitGroupPlan {
  /** 类型/结构体名，用作新文件命名 */
  owner: string;
  /** 该类型要抽取的方法 */
  methods: SubSplitMethod[];
}
export interface CommunitySubSplitPlan {
  community_id: number;
  community_name: string;
  /** 是否建议社区内再拆（编排只处理 splittable 的社区） */
  splittable: boolean;
  groups: SubSplitGroupPlan[];
}

export interface DeriveSplitInput {
  /** 项目根（定位源文件；相对路径解析基准） */
  project_dir: string;
  /** 目标文件（相对 project_dir，如 src/tools/serve.ts） */
  target_file: string;
  /** 要抽取的符号名（顶层函数/类的 name 或 qualified_name） */
  symbols: string[];
  /** 新文件路径（相对 project_dir；默认 <dir>/<basename>__split.<ext>） */
  new_file?: string;
  /** true=只出草稿不落盘（默认）；false=写文件 */
  dry_run?: boolean;
  /** 编译级验收：dry_run=false 落盘后跑真实编译器（go build/tsc/py_compile），失败自动回滚。
   *  默认 = !dry_run（写文件即验收）；显式传 false 可关闭。 */
  verify_compile?: boolean;
  /** 测试级验收（P3 收尾）：编译级验收通过后，跑该语言的项目测试命令（go test/pytest/npm test），
   *  验证拆分后功能正确性，失败同样自动回滚。默认 = verify_compile；显式传 false 可关闭。 */
  verify_test?: boolean;
  /** 社区内子拆分计划（P3）：提供后进入编排模式，对每个 splittable 社区的每个类型单元
   *  自动按 owner 拆到独立文件。此时 target_file/symbols/new_file 由编排内部生成。 */
  subsplit?: CommunitySubSplitPlan[];
}

export interface DeriveSplitResult {
  message: string;
  dry_run: boolean;
  target_file: string;
  new_file: string;
  language: string;
  extracted: Array<{ name: string; kind: string; start_line: number; end_line: number; lines: number }>;
  imports_copied: string[];
  imports_added_original: string[];
  imports_added_new: string[];
  references_to_extracted: Array<{ line: number; ref: string }>;
  new_content: string;
  original_content: string;
  verification: {
    new_syntax_ok: boolean;
    original_syntax_ok: boolean;
    new_symbols: string[];
    original_symbols: string[];
    /** 裁剪掉的未用 import（编译器阻塞项，Go 未用 import 会使 go build 失败） */
    imports_pruned_new: string[];
    imports_pruned_original: string[];
    /** 真实编译器验收结果（dry_run=false 且未关闭时存在） */
    compile?: { command: string; ok: boolean; output: string; skipped?: string };
    /** 测试级验收结果（编译通过后、dry_run=false 且未关闭时存在） */
    test?: { command: string; ok: boolean; output: string; skipped?: string };
    note?: string;
  };
  /** 编译级验收失败后是否已回滚原文件（项目保持拆分前状态） */
  rolled_back: boolean;
  /** 社区内子拆分编排结果（输入含 subsplit 时存在）：每个类型单元的一次拆分摘要 */
  subsplit?: Array<{
    community_name: string;
    owner: string;
    target_file: string;
    new_file: string;
    method_count: number;
    ok: boolean;
    note: string;
  }>;
}

// ─────────────────────────────────────────────────────────────
// 语言识别 + import 节点类型
// ─────────────────────────────────────────────────────────────

type LangId = 'ts' | 'go' | 'python';

/** 扩展名 → 语言适配层 id */
function detectLang(ext: string): LangId | null {
  if (ext === '.go') return 'go';
  if (ext === '.py') return 'python';
  if (/^\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ext)) return 'ts';
  return null;
}

/** 各语言"import 声明"的 tree-sitter 节点类型（collectImportRanges 用来整段复制） */
const IMPORT_NODE_TYPES: Record<LangId, string[]> = {
  ts: ['import_statement'],
  go: ['import_declaration'],
  python: ['import_statement', 'import_from_statement'],
};

// ─────────────────────────────────────────────────────────────
// 行区间工具
// ─────────────────────────────────────────────────────────────

/** 合并重叠/相邻的 [start,end] 区间（1 基行号），返回去重后的不重叠区间 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** 按行号保留所有非抽取行（1 基），返回新文件内容 */
function removeLineRanges(content: string, ranges: Array<[number, number]>): string {
  const lines = content.split('\n');
  const remove = new Set<number>();
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) remove.add(i);
  }
  return lines.filter((_, i) => !remove.has(i + 1)).join('\n');
}

/** 抽取指定行区间的内容（1 基），返回片段文本 */
function sliceLineRanges(content: string, ranges: Array<[number, number]>): string {
  const lines = content.split('\n');
  const parts: string[] = [];
  for (const [s, e] of ranges) {
    for (let i = s; i <= e; i++) parts.push(lines[i - 1]);
  }
  return parts.join('\n');
}

/** 按 name 去重，保留外层符号（end_line 最大者）——处理 Go type_declaration 与内嵌 type_spec 双提取 */
function dedupByOutermost(list: ParsedSymbol[]): ParsedSymbol[] {
  const byName = new Map<string, ParsedSymbol>();
  for (const s of list) {
    const cur = byName.get(s.name);
    if (!cur || s.end_line > cur.end_line || (s.end_line === cur.end_line && s.start_line < cur.start_line)) {
      byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

/**
 * 从 AST 收集 import 声明文本（TS：import_statement；Go：import_declaration 整块；
 * Python：import_statement / import_from_statement）。返回 { start, end, text }。
 */
async function collectImportRanges(
  filePath: string,
  content: string,
  lang: LangId,
): Promise<Array<{ start: number; end: number; text: string }>> {
  const parsed = await parseAstRoot(filePath, content);
  if (!parsed) return [];
  const types = new Set(IMPORT_NODE_TYPES[lang] ?? []);
  const out: Array<{ start: number; end: number; text: string }> = [];
  const walk = (node: unknown): void => {
    const n = node as { type: string; startPosition: { row: number }; endPosition: { row: number }; text: string; childCount: number; child(i: number): unknown };
    if (types.has(n.type)) {
      out.push({ start: n.startPosition.row + 1, end: n.endPosition.row + 1, text: n.text });
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  };
  walk(parsed.root as unknown);
  return out;
}

/** 从 import 语句文本提取模块路径（TS/JS 才用；用于判断是否自引用原文件） */
function importSourceOf(text: string): string {
  const m = text.match(/from\s+['"]([^'"]+)['"]/);
  return m ? m[1] : '';
}

/** 引用扫描：在给定文本中统计每个目标符号名是否出现（词边界），返回命中的名字 */
function referNames(text: string, names: string[]): string[] {
  const present = new Set<string>();
  for (const n of names) {
    if (new RegExp(`\\b${escapeRe(n)}\\b`).test(text)) present.add(n);
  }
  return [...present];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 提取 Go 包名（package <name>） */
function goPackage(content: string): string {
  const m = content.match(/^\s*package\s+([A-Za-z_]\w*)/m);
  return m ? m[1] : '';
}

/** 判断 Python 文件所在目录是否构成包：从该目录向上到 project_root 之间存在 __init__.py */
function isPythonPackage(projectRoot: string, fileRel: string): boolean {
  let dir = path.resolve(projectRoot, path.posix.dirname(fileRel.replace(/\\/g, '/')));
  const root = path.resolve(projectRoot);
  while (dir.length >= root.length) {
    if (existsSync(path.join(dir, '__init__.py'))) return true;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// import 接线构建（逐语言）
// ─────────────────────────────────────────────────────────────

interface Wiring {
  /** 新文件头部（插在 imports 之前；Go = package 声明，TS/Python = 空） */
  newFileHeader: string;
  /** 复制原文件 import 声明文本（给新文件） */
  copiedImports: string[];
  /** 新文件里被抽取符号引用的"留在原文件"符号 → 需要从原文件导入 */
  importFromOriginalNames: string[];
  /** 新文件里从原文件导入的语句（空串=无需） */
  importFromOriginalLine: string;
  /** 原文件里从新文件导入的语句（空串=无需） */
  importFromNewLine: string;
  /** 是否需要在原/新文件之间加 import（Go 同包不需要） */
  needsCrossImport: boolean;
}

/**
 * 按语言构建 import 接线。
 * @param projectRoot 项目根（Python 包检测用）
 * @param targetRel 目标文件相对路径
 * @param newRel 新文件相对路径
 * @param content 原文件内容
 * @param extractedText 被抽取符号文本
 * @param remainingNames 留在原文件的顶层符号名
 * @param extractedNames 被抽取符号名
 */
function buildWiring(
  lang: LangId,
  projectRoot: string,
  targetRel: string,
  newRel: string,
  content: string,
  extractedText: string,
  remainingNames: string[],
  extractedNames: string[],
): Wiring {
  const base = path.posix.basename(targetRel.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
  const newBase = path.posix.basename(newRel.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');

  if (lang === 'go') {
    // 同包拆分：包级符号共享，无需跨文件 import。复制 package + import 块即可。
    const pkg = goPackage(content);
    return {
      newFileHeader: pkg ? `package ${pkg}\n\n` : '',
      copiedImports: [], // 由外部用 collectImportRanges 填（Go 的 import_declaration）
      importFromOriginalNames: [],
      importFromOriginalLine: '',
      importFromNewLine: '',
      needsCrossImport: false,
    };
  }

  if (lang === 'python') {
    const isPkg = isPythonPackage(projectRoot, targetRel);
    const origSpec = isPkg ? `.${base}` : base;
    const newSpec = isPkg ? `.${newBase}` : newBase;
    const importedFromOrig = referNames(extractedText, remainingNames);
    const importFromOrigLine =
      importedFromOrig.length > 0 ? `from ${origSpec} import ${importedFromOrig.join(', ')}` : '';
    const importFromNewLine = `from ${newSpec} import ${extractedNames.join(', ')}`;
    return {
      newFileHeader: '',
      copiedImports: [],
      importFromOriginalNames: importedFromOrig,
      importFromOriginalLine: importFromOrigLine,
      importFromNewLine,
      needsCrossImport: true,
    };
  }

  // ts / js：ESM 相对 import
  const origImportPath = `./${base}`;
  const newImportPath = `./${newBase}`;
  const importedFromOrig = referNames(extractedText, remainingNames);
  return {
    newFileHeader: '',
    copiedImports: [],
    importFromOriginalNames: importedFromOrig,
    importFromOriginalLine:
      importedFromOrig.length > 0 ? `import { ${importedFromOrig.join(', ')} } from '${origImportPath}';` : '',
    importFromNewLine: `import { ${extractedNames.join(', ')} } from '${newImportPath}';`,
    needsCrossImport: true,
  };
}

/** 在原文件内容顶部插入 import：放在已有 import 块之后，否则放文件头 */
function insertImport(content: string, importLine: string): string {
  if (!importLine) return content;
  const lines = content.split('\n');
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('import ') || t.startsWith('import\t') || t.startsWith('from ') || t.startsWith('require(')) {
      insertAt = i + 1;
    } else if (t !== '' && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('#')) {
      break; // 遇到第一个非 import/非注释代码行，往后插
    }
  }
  lines.splice(insertAt, 0, importLine);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// 未用 import 裁剪（编译器阻塞项） + 编译级验收
// ─────────────────────────────────────────────────────────────

function stripQuotesStr(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('`') && s.endsWith('`'))) return s.slice(1, -1);
  return s;
}

interface GoImportSpec {
  path: string;
  alias: string;
  line: number;
  pkg: string;
  clean: boolean;
}

/** 收集 Go 的 import_spec（含别名/路径/行号）；供裁剪判断每个 spec 是否被使用 */
async function collectGoImportSpecs(filePath: string, content: string): Promise<GoImportSpec[]> {
  const parsed = await parseAstRoot(filePath, content);
  if (!parsed) return [];
  const out: GoImportSpec[] = [];
  const walk = (node: unknown): void => {
    const n = node as { type: string; startPosition: { row: number }; childCount: number; child(i: number): unknown; childForFieldName(f: string): unknown | null };
    if (n.type === 'import_spec') {
      const pathChild = n.childForFieldName('path') as { text: string } | null;
      const nameChild = n.childForFieldName('name') as { text: string } | null;
      const importPath = pathChild ? stripQuotesStr(pathChild.text) : '';
      const alias = nameChild ? nameChild.text.trim() : '';
      const pkg = alias || importPath.split('/').pop() || '';
      out.push({ path: importPath, alias, line: n.startPosition.row + 1, pkg, clean: /^[A-Za-z_]\w*$/.test(pkg) });
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  };
  walk(parsed.root as unknown);
  return out;
}

/**
 * 裁剪 Go 文件未用 import。Go 的未用 import 是编译错误（compiler-blocking），
 * 拆分后原/新文件都可能残留——必须裁掉才能通过 go build。
 * 规则：包名 = 别名或路径末段；只裁"干净包名"（字母数字下划线）且在文件体（去掉 import 块）中
 * 未以 `<pkg>.` 选择器形式出现的 spec；blank(`_`) / dot(`.`) import 保守保留。
 */
async function pruneGoImports(content: string, filePath: string): Promise<string> {
  const parsed = await parseAstRoot(filePath, content);
  if (!parsed) return content;
  const specs: GoImportSpec[] = [];
  const decls: Array<{ start: number; end: number }> = [];
  const walk = (node: unknown): void => {
    const n = node as { type: string; startPosition: { row: number }; endPosition: { row: number }; childCount: number; child(i: number): unknown; childForFieldName(f: string): unknown | null };
    if (n.type === 'import_declaration') {
      decls.push({ start: n.startPosition.row + 1, end: n.endPosition.row + 1 });
    } else if (n.type === 'import_spec') {
      const pathChild = n.childForFieldName('path') as { text: string } | null;
      const nameChild = n.childForFieldName('name') as { text: string } | null;
      const importPath = pathChild ? stripQuotesStr(pathChild.text) : '';
      const alias = nameChild ? nameChild.text.trim() : '';
      const pkg = alias || importPath.split('/').pop() || '';
      specs.push({ path: importPath, alias, line: n.startPosition.row + 1, pkg, clean: /^[A-Za-z_]\w*$/.test(pkg) });
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  };
  walk(parsed.root as unknown);

  if (specs.length === 0) return content;

  // 用 tree-sitter 精确收集 body 中 selector_expression / qualified_type 的**根操作数**标识符
  // （如 ws.UpgradeWS / ws.WSConn.Send → 根操作数 ws；context.Context / sync.Mutex → 根操作数
  //  context / sync）。排除 import 声明与注释，避免正则误匹配注释/字符串里的 `pkg.`（例：
  //  注释 `this.ws.send('')` 会让 ws 被误判为已用）。Go 类型引用（qualified_type）同样计入，
  //  否则 `context.Context`/`sync.Mutex` 这类类型使用会被误判为未用而裁掉整个 import 块。
  const selectorOperands = new Set<string>();
  const resolveBase = (n: { type?: string; text: string; childForFieldName(f: string): unknown | null; child(i: number): unknown }): string => {
    let cur = n as { type?: string; text: string; childForFieldName(f: string): unknown | null; child(i: number): unknown } | null;
    while (cur && (cur.type === 'selector_expression' || cur.type === 'qualified_type')) {
      cur = (cur.childForFieldName('operand') || cur.child(0)) as { type?: string; text: string; childForFieldName(f: string): unknown | null; child(i: number): unknown } | null;
    }
    return cur ? cur.text.trim() : '';
  };
  const walkUsage = (node: unknown): void => {
    const n = node as { type: string; text: string; childCount: number; child(i: number): unknown; childForFieldName(f: string): unknown | null };
    if (n.type === 'import_declaration' || n.type === 'comment') return;
    if (n.type === 'selector_expression' || n.type === 'qualified_type') {
      const base = resolveBase(n);
      if (base) selectorOperands.add(base);
      return; // 该 selector/type 子树已计入根操作数，无需再下钻
    }
    for (let i = 0; i < n.childCount; i++) walkUsage(n.child(i));
  };
  walkUsage(parsed.root as unknown);

  // 判断每个 spec 是否使用
  const used = new Map<string, boolean>();
  for (const s of specs) {
    if (s.alias === '_' || s.alias === '.') {
      used.set(s.pkg, true);
      continue;
    }
    if (!s.clean) {
      used.set(s.pkg, true); // 域风格路径（含 . / -）保守保留
      continue;
    }
    used.set(s.pkg, selectorOperands.has(s.pkg));
  }

  // 单行独占的 spec 才可整行删除（多 spec 同行保守保留）
  const rowCount = new Map<number, number>();
  for (const s of specs) rowCount.set(s.line, (rowCount.get(s.line) || 0) + 1);

  const removeRanges: Array<[number, number]> = [];
  for (const d of decls) {
    const inDecl = specs.filter((s) => s.line >= d.start && s.line <= d.end);
    if (inDecl.length === 0) continue;
    const allUnused = inDecl.every((s) => !used.get(s.pkg));
    if (allUnused) {
      removeRanges.push([d.start, d.end]);
    } else {
      for (const s of inDecl) {
        if (!used.get(s.pkg) && rowCount.get(s.line) === 1) removeRanges.push([s.line, s.line]);
      }
    }
  }
  if (removeRanges.length === 0) return content;
  return removeLineRanges(content, mergeRanges(removeRanges));
}

/** 提取 Python import 语句绑定的名字（别名解析）；`import *` 返回 []（保守保留） */
function pythonBoundNames(stmtText: string): string[] {
  const t = stmtText.trim();
  const names: string[] = [];
  const addAlias = (s: string): void => {
    const m = s.match(/^(.*?)\s+as\s+(\w+)$/);
    const raw = (m ? m[1] : s).trim();
    const target = m ? m[2] : raw.split('.')[0].trim();
    if (target && /^[A-Za-z_]\w*$/.test(target)) names.push(target);
  };
  if (t.startsWith('from ') && t.includes(' import ')) {
    const listPart = t.split(' import ')[1] || '';
    if (listPart.includes('*')) return [];
    for (const item of listPart.split(',')) addAlias(item.trim());
  } else if (t.startsWith('import ')) {
    const listPart = t.slice('import '.length);
    for (const item of listPart.split(',')) addAlias(item.trim());
  }
  return names;
}

/**
 * 裁剪 Python 文件未用 import（Python 未用 import 不阻塞编译，属质量项）。
 * 只裁"整条语句所有绑定名都未使用"的 import 行；`from x import a, b` 中任一被用则整条保留（保守）。
 */
async function prunePythonImports(content: string, filePath: string): Promise<string> {
  const parsed = await parseAstRoot(filePath, content);
  if (!parsed) return content;
  const stmts: Array<{ start: number; end: number; text: string }> = [];
  const walk = (node: unknown): void => {
    const n = node as { type: string; startPosition: { row: number }; endPosition: { row: number }; text: string; childCount: number; child(i: number): unknown };
    if (n.type === 'import_statement' || n.type === 'import_from_statement') {
      stmts.push({ start: n.startPosition.row + 1, end: n.endPosition.row + 1, text: n.text });
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  };
  walk(parsed.root as unknown);
  if (stmts.length === 0) return content;

  const body = removeLineRanges(content, mergeRanges(stmts.map((s) => [s.start, s.end])));
  const removeRanges: Array<[number, number]> = [];
  for (const st of stmts) {
    const names = pythonBoundNames(st.text);
    if (names.length === 0) continue; // * 或未知：保守保留
    const anyUsed = names.some((n) => new RegExp(`\\b${escapeRe(n)}\\b`).test(body));
    if (!anyUsed) removeRanges.push([st.start, st.end]);
  }
  if (removeRanges.length === 0) return content;
  return removeLineRanges(content, mergeRanges(removeRanges));
}

/** 按语言裁剪未用 import；返回 {content, pruned:[说明]}。TS 不做裁剪（tsc 默认不报未用变量）。 */
async function pruneUnusedImports(
  content: string,
  filePath: string,
  lang: LangId,
): Promise<{ content: string; pruned: string[] }> {
  if (lang === 'go') {
    const before = content;
    const after = await pruneGoImports(content, filePath);
    return { content: after, pruned: prunedDiffs(before, after, 'go') };
  }
  if (lang === 'python') {
    const before = content;
    const after = await prunePythonImports(content, filePath);
    return { content: after, pruned: prunedDiffs(before, after, 'python') };
  }
  return { content, pruned: [] };
}

/** 对比裁剪前后，提取被移除的 import 行文本（用于报告） */
function prunedDiffs(before: string, after: string, lang: LangId): string[] {
  const removed: string[] = [];
  const afterSet = new Set(after.split('\n').map((l) => l.trim()).filter(Boolean));
  for (const line of before.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const isImport = lang === 'go' ? t.startsWith('import ') || t.startsWith('"') || t.startsWith('_ "') || t.startsWith('. "') : t.startsWith('import ') || t.startsWith('from ');
    if (isImport && !afterSet.has(t)) removed.push(t);
  }
  return removed;
}

/** shell 单参数引号包裹（含 Windows 盘符/空格/# 等） */
function shq(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/**
 * 编译级验收：在真实项目里跑该语言编译器，验证拆分后能编译通过。
 * 未落盘（dry_run）或项目缺构建清单（go.mod/tsconfig.json）时跳过（skipped）。
 * 用 shell 执行以兼容 Windows 的 .cmd 解析（npx）；Go 编译输出重定向到系统临时目录，避免污染项目。
 */
async function runCompile(
  lang: LangId,
  projectDir: string,
  targetRel: string,
  newRel: string,
): Promise<{ command: string; ok: boolean; output: string; skipped?: string }> {
  let command: string;
  if (lang === 'go') {
    if (!existsSync(path.join(projectDir, 'go.mod'))) {
      return { command: 'go build', ok: true, output: '', skipped: '项目无 go.mod，跳过 Go 编译级验收' };
    }
    // 只编译拆分所在包（连同其依赖），输出到临时文件避免污染项目目录
    const pkgDir = path.posix.dirname(targetRel.replace(/\\/g, '/')) || '.';
    const spec = pkgDir === '.' ? '.' : `./${pkgDir}`;
    const outBin = path.join(tmpdir(), `dc_compile_${Date.now()}.exe`);
    command = `go build -o ${shq(outBin)} ${spec}`;
    try {
      await execFileAsync(command, [], { cwd: projectDir, shell: true, timeout: 180000, windowsHide: true });
      for (const cand of [outBin, outBin.replace(/\.exe$/, '')]) {
        if (existsSync(cand)) {
          try {
            rmSync(cand);
          } catch {
            /* 清理失败忽略 */
          }
        }
      }
      return { command, ok: true, output: '' };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return { command, ok: false, output: ((err.stdout || '') + (err.stderr || '')).trim() || (err.message || 'go build 失败') };
    }
  }
  if (lang === 'python') {
    const files = [targetRel, newRel].map((f) => shq(path.resolve(projectDir, f))).join(' ');
    command = `python -m py_compile ${files}`;
    try {
      const { stdout, stderr } = await execFileAsync(command, [], { cwd: projectDir, shell: true, timeout: 120000, windowsHide: true });
      return { command, ok: true, output: (stdout + stderr).trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      return { command, ok: false, output: ((err.stdout || '') + (err.stderr || '')).trim() || (err.message || 'py_compile 失败') };
    }
  }
  // TypeScript
  if (!existsSync(path.join(projectDir, 'tsconfig.json'))) {
    return { command: 'tsc --noEmit', ok: true, output: '', skipped: '项目无 tsconfig.json，跳过 TS 编译级验收' };
  }
  command = 'npx tsc --noEmit';
  try {
    const { stdout, stderr } = await execFileAsync(command, [], { cwd: projectDir, shell: true, timeout: 180000, windowsHide: true });
    return { command, ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { command, ok: false, output: ((err.stdout || '') + (err.stderr || '')).trim() || (err.message || 'tsc 失败') };
  }
}

/** shell 执行统一封装：返回 {ok, output}，异常路径收敛为 ok=false */
async function runShell(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [], { cwd, shell: true, timeout: 600000, windowsHide: true });
    return { ok: true, output: (stdout + stderr).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: ((err.stdout || '') + (err.stderr || '')).trim() || (err.message || '命令执行失败') };
  }
}

/** 在 projectDir（含子目录）下递归查找是否含匹配 re 的测试文件 */
function hasTestFiles(projectDir: string, re: RegExp): boolean {
  const stack = [projectDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (re.test(e.name)) return true;
    }
  }
  return false;
}

/**
 * 测试级验收（P3 收尾）：在编译级验收通过后，跑该语言的项目测试命令，验证拆分后功能正确性。
 * 未落盘（dry_run）、缺测试清单（go.mod / package.json.test 脚本）或项目无测试文件时跳过（skipped）。
 * 测试失败同样触发自动回滚，保证项目不被拆坏。
 */
async function runTest(
  lang: LangId,
  projectDir: string,
  targetRel: string,
  newRel: string,
): Promise<{ command: string; ok: boolean; output: string; skipped?: string }> {
  if (lang === 'go') {
    if (!existsSync(path.join(projectDir, 'go.mod'))) {
      return { command: 'go test', ok: true, output: '', skipped: '项目无 go.mod，跳过 Go 测试级验收' };
    }
    const pkgDir = path.posix.dirname(targetRel.replace(/\\/g, '/')) || '.';
    const pkgAbs = path.join(projectDir, pkgDir === '.' ? '' : pkgDir);
    if (!hasTestFiles(pkgAbs, /_test\.go$/)) {
      return { command: 'go test', ok: true, output: '', skipped: '拆分所在包无 _test.go 测试文件，跳过' };
    }
    const spec = pkgDir === '.' ? '.' : `./${pkgDir}`;
    const command = `go test ${spec}`;
    const r = await runShell(command, projectDir);
    return { command, ok: r.ok, output: r.output };
  }
  if (lang === 'python') {
    if (!hasTestFiles(projectDir, /(^|[\\/])(test_.*|.*_test)\.py$/)) {
      return { command: 'python -m pytest -q', ok: true, output: '', skipped: '项目无测试文件（test_*.py / *_test.py），跳过' };
    }
    const command = 'python -m pytest -q';
    const r = await runShell(command, projectDir);
    if (!r.ok && /No module named ['"]pytest['"]|pytest: command not found/i.test(r.output)) {
      return { command, ok: true, output: r.output, skipped: 'pytest 未安装，跳过 Python 测试级验收' };
    }
    return { command, ok: r.ok, output: r.output };
  }
  // TypeScript
  let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } | undefined;
  try {
    pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
  } catch {
    /* 无 package.json */
  }
  if (!pkg?.scripts?.test) {
    return { command: 'npm test', ok: true, output: '', skipped: 'package.json 无 test 脚本，跳过 TS 测试级验收' };
  }
  const useVitest = !!(pkg.devDependencies?.vitest || pkg.dependencies?.vitest);
  const files = [targetRel, newRel].map((f) => shq(f)).join(' ');
  const command = useVitest ? `npx vitest run ${files}` : 'npm test';
  const r = await runShell(command, projectDir);
  return { command, ok: r.ok, output: r.output };
}

// 单次拆分核心（从某一文件抽取若干符号到新文件）。deriveSplit 单次模式与
// 社区内子拆分编排（runSubSplit）都复用它。input 不含 subsplit。
async function splitOnce(input: DeriveSplitInput): Promise<DeriveSplitResult> {
  const dryRun = input.dry_run ?? true;
  const projectRoot = path.resolve(input.project_dir);
  const targetRel = input.target_file.replace(/^[/\\]+/, '');
  const targetAbs = path.resolve(projectRoot, targetRel);

  const fail = (e: string): DeriveSplitResult => ({
    message: e,
    dry_run: dryRun,
    target_file: targetRel,
    new_file: '',
    language: '',
    extracted: [],
    imports_copied: [],
    imports_added_original: [],
    imports_added_new: [],
    references_to_extracted: [],
    new_content: '',
    original_content: '',
    verification: { new_syntax_ok: false, original_syntax_ok: false, new_symbols: [], original_symbols: [], imports_pruned_new: [], imports_pruned_original: [] },
    rolled_back: false,
  });

  if (!existsSync(targetAbs)) {
    return fail(`目标文件不存在：${targetAbs}`);
  }
  const content = readFileSync(targetAbs, 'utf8');
  const ext = path.extname(targetAbs);
  const lang = detectLang(ext);
  if (!lang) {
    return fail(`暂支持 TypeScript/JavaScript（.ts/.tsx/.js/.jsx/.mjs/.cjs）、Go（.go）、Python（.py），收到 .${ext}。`);
  }

  // 解析符号 + import + 调用
  const parsedResult = await parseFileFull(targetRel, content);
  const symbols = parsedResult.symbols;
  if (symbols.length === 0) {
    return fail(`解析目标文件无符号（${targetRel}）。`);
  }

  // 目标符号：按 name/qualified_name 命中。既支持顶层函数/类，也支持带 parent 的方法
  // （Go receiver 方法、类方法），供社区内子拆分按 owner 方法名抽取。按 name 去重保留外层。
  const want = new Set(input.symbols);
  const topLevel = dedupByOutermost(symbols.filter((s) => !s.parent));
  const extractedSyms = dedupByOutermost(
    symbols.filter((s) => want.has(s.name) || want.has(s.qualified_name)),
  );
  if (extractedSyms.length === 0) {
    return fail(
      `未在 ${targetRel} 的顶层符号中命中要抽取的符号 {${input.symbols.join(', ')}}。` +
        `可用的顶层符号：${topLevel.map((s) => `${s.name}(${s.kind})`).join(', ') || '(无)'}`,
    );
  }

  // 抽取行区间（合并相邻）
  const ranges = mergeRanges(extractedSyms.map((s) => [s.start_line, s.end_line]));

  // 新文件名
  const dir = path.posix.dirname(targetRel.replace(/\\/g, '/'));
  const base = path.posix.basename(targetRel).replace(/\.[^.]+$/, '');
  const newRel = input.new_file
    ? input.new_file.replace(/^[/\\]+/, '')
    : path.posix.join(dir, `${base}__split${ext}`);
  const newAbs = path.resolve(projectRoot, newRel);

  // —— 接线 ——
  const extractedText = sliceLineRanges(content, ranges);
  const importRanges = await collectImportRanges(targetRel, content, lang);
  const remainingSyms = topLevel.filter((s) => !extractedSyms.includes(s));
  const remainingNames = remainingSyms.map((s) => s.name);
  const extractedNames = extractedSyms.map((s) => s.name);

  const wiring = buildWiring(lang, projectRoot, targetRel, newRel, content, extractedText, remainingNames, extractedNames);

  // 新文件要复制的 import：TS/Python 复制 import 声明文本；Go 复制 import_declaration 整块
  let copiedImports: string[];
  if (lang === 'ts') {
    const selfSource = `./${base}`;
    copiedImports = importRanges.filter((ir) => importSourceOf(ir.text) !== selfSource).map((ir) => ir.text);
  } else {
    copiedImports = importRanges.map((ir) => ir.text);
  }

  // —— 新文件草稿（先不含接线 import，裁剪后再注入，避免接线 import 被误裁） ——
  const newBodyLines = [wiring.newFileHeader, ...copiedImports, '', extractedText]
    .filter((l) => l !== '')
    .join('\n');
  let newContent = newBodyLines.trimEnd() + '\n';

  // —— 原文件草稿：先移除符号、暂不含接线 import ——
  let originalContent = removeLineRanges(content, ranges);

  // —— 未用 import 裁剪（Go/Python；编译器阻塞项，Go 未用 import 会编译失败） ——
  // 裁剪在注入接线 import 之前进行，确保向后兼容的再导出 import 不被误删
  const prunedNew = await pruneUnusedImports(newContent, newRel, lang);
  const prunedOrig = await pruneUnusedImports(originalContent, targetRel, lang);
  newContent = prunedNew.content;
  originalContent = prunedOrig.content;

  // —— 接线 import（裁剪后注入，受保护） ——
  if (wiring.importFromOriginalLine) {
    newContent = insertImport(newContent, wiring.importFromOriginalLine);
  }
  let origContentWithImport = originalContent;
  if (wiring.needsCrossImport) {
    origContentWithImport = insertImport(originalContent, wiring.importFromNewLine);
  }

  // 原文件里指向被抽取符号的引用（在非抽取文本中扫描）
  const keptLines = content.split('\n').filter((_, i) => {
    for (const [s, e] of ranges) if (i + 1 >= s && i + 1 <= e) return false;
    return true;
  });
  const referencesToExtracted: Array<{ line: number; ref: string }> = [];
  keptLines.forEach((ln, i) => {
    for (const nm of extractedNames) {
      if (new RegExp(`\\b${escapeRe(nm)}\\b`).test(ln)) {
        referencesToExtracted.push({ line: i + 1, ref: nm });
      }
    }
  });

  // —— 语法级验收：对两份草稿重新解析 ——
  const newCheck = await parseFileFull(newRel, newContent);
  const origCheck = await parseFileFull(targetRel, origContentWithImport);
  const newSyntaxOk = !newCheck.error && newCheck.symbols.length > 0;
  const origSyntaxOk = !origCheck.error;
  const leftover = dedupByOutermost(newCheck.symbols.filter((s) => !s.parent)).map((s) => s.name);

  // —— 编译级验收（dry_run=false 且未显式关闭）：落盘后跑真实编译器，失败自动回滚 ——
  const verifyCompile = input.verify_compile ?? !dryRun;
  let compileResult: { command: string; ok: boolean; output: string; skipped?: string } | undefined;
  let rolledBack = false;

  if (!dryRun) {
    writeFileSync(newAbs, newContent, 'utf8');
    writeFileSync(targetAbs, origContentWithImport, 'utf8');
    if (verifyCompile) {
      compileResult = await runCompile(lang, projectRoot, targetRel, newRel);
      if (!compileResult.ok) {
        // 编译失败：回滚原文件到拆分前，并删除新文件（不能只清空——空 .go 文件本身非法会破坏整个包）
        writeFileSync(targetAbs, content, 'utf8');
        if (existsSync(newAbs)) rmSync(newAbs);
        rolledBack = true;
      }
    }
  }

  // —— 测试级验收（P3 收尾）：编译通过后跑项目测试命令，失败同样回滚 ——
  const verifyTest = input.verify_test ?? verifyCompile;
  let testResult: { command: string; ok: boolean; output: string; skipped?: string } | undefined;
  if (!dryRun && !rolledBack && verifyCompile && compileResult?.ok && verifyTest) {
    testResult = await runTest(lang, projectRoot, targetRel, newRel);
    if (!testResult.ok) {
      writeFileSync(targetAbs, content, 'utf8');
      if (existsSync(newAbs)) rmSync(newAbs);
      rolledBack = true;
    }
  }

  // 报告
  const langLabel = lang === 'ts' ? 'TypeScript/JavaScript' : lang === 'go' ? 'Go' : 'Python';
  const wiringNote =
    lang === 'go'
      ? '同包拆分：包级符号共享，无需跨文件 import，仅复制 package + import 块'
      : lang === 'python'
        ? isPythonPackage(projectRoot, targetRel)
          ? '目录构成包：使用相对 import（. 前缀）'
          : '目录非包：使用绝对式 import'
        : 'ESM 相对 import 接线';

  const lines: string[] = [
    `derive_split：${targetRel}（${langLabel}）抽取 ${extractedSyms.length} 个符号 → ${newRel}${dryRun ? '（dry-run，未落盘）' : '（已落盘）'}`,
    `接线方式：${wiringNote}`,
    '',
    `抽取符号（${ranges.length} 段 / ${ranges.reduce((a, r) => a + (r[1] - r[0] + 1), 0)} 行）：`,
  ];
  for (const s of extractedSyms) {
    lines.push(`  ${s.kind} ${s.name} · L${s.start_line}-${s.end_line}`);
  }
  lines.push('', 'import 接线：');
  lines.push(`  new ${newRel} ← 复制原文件 import ×${copiedImports.length}`);
  if (wiring.importFromOriginalNames.length > 0) lines.push(`  new ${newRel} ← 从原文件补 import ${wiring.importFromOriginalNames.join(', ')}`);
  if (wiring.needsCrossImport) lines.push(`  ${targetRel} ← 补 import { ${extractedNames.join(', ')} }`);
  else lines.push(`  ${targetRel} / ${newRel}：同包共享，无需补 import`);
  if (referencesToExtracted.length > 0) {
    lines.push('', `原文件中 ${referencesToExtracted.length} 处指向被抽取符号${lang === 'go' ? '（同包直接可见，无需改动）' : '（拆后走新文件 import）'}：`);
    for (const r of referencesToExtracted.slice(0, 15)) lines.push(`  L${r.line} · ${r.ref}`);
    if (referencesToExtracted.length > 15) lines.push(`  … 共 ${referencesToExtracted.length} 处`);
  }
  lines.push('', '语法级验收（tree-sitter 重解析草稿）：');
  lines.push(`  new ${newRel}: ${newSyntaxOk ? 'OK' : 'FAILED'} (${newCheck.error ?? `符号 ${leftover.length} 个`})`);
  lines.push(`  ${targetRel}: ${origSyntaxOk ? 'OK' : 'FAILED'} (${origCheck.error ?? '语法完好'})`);
  lines.push('', dryRun ? ' dry-run=true：未写文件。确认后设 dry_run=false 执行。' : ' dry_run=false：文件已写入。');

  // 编译级验收信息
  if (compileResult) {
    if (compileResult.skipped) {
      lines.push('', `编译级验收：已跳过（${compileResult.skipped}）`);
    } else if (compileResult.ok) {
      lines.push('', `编译级验收：${compileResult.command} → 通过`);
    } else {
      lines.push('', `编译级验收：${compileResult.command} → 失败${rolledBack ? '（已回滚原文件，项目未被拆坏）' : ''}`);
      lines.push(compileResult.output.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
    }
  } else if (verifyCompile && dryRun) {
    lines.push('', ' 编译级验收：dry_run=true 未运行（落盘后自动执行）');
  }

  // 测试级验收信息
  if (testResult) {
    if (testResult.skipped) {
      lines.push('', `测试级验收：已跳过（${testResult.skipped}）`);
    } else if (testResult.ok) {
      lines.push('', `测试级验收：${testResult.command} → 通过`);
    } else {
      lines.push('', `测试级验收：${testResult.command} → 失败${rolledBack ? '（已回滚原文件，项目未被拆坏）' : ''}`);
      lines.push(testResult.output.split('\n').slice(0, 20).map((l) => `  ${l}`).join('\n'));
    }
  } else if (verifyTest && dryRun) {
    lines.push('', ' 测试级验收：dry_run=true 未运行（落盘后自动执行）');
  }

  return {
    message: lines.join('\n'),
    dry_run: dryRun,
    target_file: targetRel,
    new_file: newRel,
    language: langLabel,
    extracted: extractedSyms.map((s) => ({
      name: s.name,
      kind: s.kind,
      start_line: s.start_line,
      end_line: s.end_line,
      lines: s.end_line - s.start_line + 1,
    })),
    imports_copied: copiedImports,
    imports_added_original: wiring.needsCrossImport ? [wiring.importFromNewLine] : [],
    imports_added_new: wiring.importFromOriginalLine ? [wiring.importFromOriginalLine] : [],
    references_to_extracted: referencesToExtracted,
    new_content: newContent,
    original_content: origContentWithImport,
    verification: {
      new_syntax_ok: newSyntaxOk,
      original_syntax_ok: origSyntaxOk,
      new_symbols: leftover,
      original_symbols: dedupByOutermost(origCheck.symbols.filter((s) => !s.parent)).map((s) => s.name),
      imports_pruned_new: prunedNew.pruned,
      imports_pruned_original: prunedOrig.pruned,
      ...(compileResult ? { compile: compileResult } : {}),
      ...(testResult ? { test: testResult } : {}),
      ...(verifyCompile && dryRun ? { note: 'dry_run=true，未运行编译/测试级验收（落盘后自动执行）' } : {}),
    },
    rolled_back: rolledBack,
  };
}

/**
 * 社区内子拆分编排（P3）：消费 analyze_monolith 的 community_subsplit 评估结果，
 * 对每个 splittable 社区的每个实质类型单元（owner），自动把该类型的方法从所在文件
 * 抽到以 owner 命名的新兄弟文件。同一文件内按 owner 逐个抽取（后一个基于前一个拆分后的内容）。
 */
async function runSubSplit(input: DeriveSplitInput): Promise<DeriveSplitResult> {
  const dryRun = input.dry_run ?? true;
  const plans = (input.subsplit ?? []).filter((s) => s.splittable);
  const summary: NonNullable<DeriveSplitResult['subsplit']> = [];
  const messageLines: string[] = [
    `derive_subsplit：消费 ${plans.length} 个可拆社区，按类型单元自动二次拆分（${dryRun ? 'dry-run，未落盘' : '已落盘'}）`,
  ];

  for (const plan of plans) {
    for (const group of plan.groups) {
      // 按文件分组：同一文件的所有方法一并抽取（避免同一文件拆多次）
      const byFile = new Map<string, string[]>();
      for (const m of group.methods) {
        const arr = byFile.get(m.file) ?? [];
        arr.push(m.name);
        byFile.set(m.file, arr);
      }
      for (const [file, names] of byFile) {
        const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
        const ext = path.extname(file);
        const newFile = path.posix.join(path.posix.dirname(file), `${base}_${group.owner}${ext}`);
        const r = await splitOnce({
          project_dir: input.project_dir,
          target_file: file,
          symbols: names,
          new_file: newFile,
          dry_run: dryRun,
          verify_compile: input.verify_compile,
          verify_test: input.verify_test,
        });
        const ok = !r.rolled_back && (r.verification?.new_syntax_ok ?? false) && (r.verification?.original_syntax_ok ?? false);
        summary.push({
          community_name: plan.community_name,
          owner: group.owner,
          target_file: file,
          new_file: r.new_file,
          method_count: names.length,
          ok,
          note: ok ? '拆分成功' : r.rolled_back ? `编译失败已回滚：${r.message.split('\n').pop()}` : r.message.split('\n')[0],
        });
        messageLines.push(`  [${plan.community_name}] ${group.owner}（${names.length} 方法）→ ${r.new_file}：${ok ? 'OK' : 'FAILED'}`);
      }
    }
  }

  if (summary.length === 0) {
    messageLines.push('  无可拆社区/类型单元（subsplit 为空或均非 splittable）。');
  } else {
    const okCount = summary.filter((s) => s.ok).length;
    messageLines.push(`  共 ${summary.length} 次拆分，成功 ${okCount}，失败 ${summary.length - okCount}。`);
  }

  return {
    message: messageLines.join('\n'),
    dry_run: dryRun,
    target_file: '',
    new_file: '',
    language: '',
    extracted: [],
    imports_copied: [],
    imports_added_original: [],
    imports_added_new: [],
    references_to_extracted: [],
    new_content: '',
    original_content: '',
    verification: {
      new_syntax_ok: false,
      original_syntax_ok: false,
      new_symbols: [],
      original_symbols: [],
      imports_pruned_new: [],
      imports_pruned_original: [],
      ...(dryRun ? { note: 'dry_run=true，未运行编译级验收（落盘后自动执行）' } : {}),
    },
    rolled_back: false,
    subsplit: summary,
  };
}

/**
 * derive_split：执行文件拆分。
 *  - 单次模式：抽取 target_file 里 symbols 指定的符号到新文件（沿用原语义）。
 *  - 编排模式：输入含 subsplit 时，消费社区内子拆分计划，自动对每个类型单元二次拆分。
 */
export async function deriveSplit(input: DeriveSplitInput): Promise<DeriveSplitResult> {
  if (input.subsplit && input.subsplit.length > 0) {
    return runSubSplit(input);
  }
  return splitOnce(input);
}