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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseFileFull, parseAstRoot, ParsedSymbol } from './ts_kernel/index.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

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
    note?: string;
  };
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
// 主流程
// ─────────────────────────────────────────────────────────────

export async function deriveSplit(input: DeriveSplitInput): Promise<DeriveSplitResult> {
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
    verification: { new_syntax_ok: false, original_syntax_ok: false, new_symbols: [], original_symbols: [] },
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

  // 目标符号 = 顶层符号（parent 为空）且 name/qualified_name 命中；按 name 去重保留外层
  const want = new Set(input.symbols);
  const topLevel = dedupByOutermost(symbols.filter((s) => !s.parent));
  const extractedSyms = dedupByOutermost(
    topLevel.filter((s) => want.has(s.name) || want.has(s.qualified_name)),
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

  // —— 新文件草稿 ——
  const newBodyLines = [wiring.newFileHeader, ...copiedImports, wiring.importFromOriginalLine, '', extractedText]
    .filter((l) => l !== '')
    .join('\n');
  const newContent = newBodyLines.trimEnd() + '\n';

  // —— 原文件草稿 ——
  let originalContent = removeLineRanges(content, ranges);
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

  // 落盘（dry_run=false）
  if (!dryRun) {
    writeFileSync(newAbs, newContent, 'utf8');
    writeFileSync(targetAbs, origContentWithImport, 'utf8');
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
    },
  };
}