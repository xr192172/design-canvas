/**
 * field_refs —— find_references 的 field/type 结构引用引擎（tree-sitter 背书的分类）
 *
 * 背景：find_references mode=field 第一版用正则，够用但粗糙——把「构造点、解构读取、
 * 声明键」全算成 field-key，还漏方括号访问、会把注释/字符串里的字面匹配当引用。
 * 本模块改用 ts_kernel 的 AST（parseAstRoot，节点带字节偏移）做精确分类：
 *
 *   field 模式：
 *     - 读取点   obj.field / obj?.field / obj['field'] / obj["field"]
 *     - 构造点   { field: v }（对象字面量键，pair 于 object 内）
 *     - 解构点   const { field } = o（object_pattern）
 *     - 声明点   interface T { field: string } / type T = { field: ... }（object_type）
 *     - 去噪     AST 判定能跳过注释/字符串里的同名文本
 *     - 行内上下文 snippet（免 LLM 再开文件）
 *     - scope   closure（给 file 时按 import 闭包）| all（全项目扫）
 *
 *   type 模式（「谁构造形如类型 T 的对象」，启发式）：
 *     - 从 file 里解析出 symbol 声明的成员字段集合
 *     - 在闭包/全项目里找对象字面量，其 pair 键与成员集交叠 ≥ 阈值 → 候选构造点
 *     - 标注「命中 N 个成员」，供 LLM 判断（非类型求解器，是候选）
 *
 * 只读，不改文件。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAstRoot, type SyntaxNodeLike } from './ts_kernel/kernel.js';
import { expandClosure, walkProjectFiles, loadAliasConfig } from './project_root.js';

export type FieldRefKind = 'field-read' | 'field-key' | 'field-destructure' | 'field-decl';

export interface FieldRefPoint {
  /** 字节偏移（匹配 token 起点） */
  offset: number;
  /** 1-based 行号 */
  line: number;
  /** 该字段名（匹配文本） */
  text: string;
  kind: FieldRefKind;
  /** 行内容（去首尾空白），LLM 免开文件判断 */
  snippet: string;
}

export interface FieldRefFile {
  /** 相对项目根（POSIX） */
  file: string;
  refs: FieldRefPoint[];
}

export interface TypeConstructCandidate {
  file: string;
  line: number;
  offset: number;
  /** 命中该类型成员的字段名（与成员集交集） */
  matched: string[];
  snippet: string;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function lineText(src: string, offset: number): string {
  const lines = src.split('\n');
  const l = lineOf(src, offset);
  return (lines[l - 1] ?? '').trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 收集给定文件范围内匹配的 (kind, offset) —— 读取点用正则（.field / ['field']），键位交给 AST 分类 */
function captureReads(src: string, field: string): FieldRefPoint[] {
  const out: FieldRefPoint[] = [];
  const re = new RegExp(`(?:\\.|\\?\\.)\\b${escapeRegex(field)}\\b|\\[\\s*['"]${escapeRegex(field)}['"]\\s*]`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // offset 取到字段名本体（. 或 [' 之后）
    const text = m[0];
    const dotIdx = text.indexOf(field);
    const off = m.index + Math.max(0, dotIdx);
    out.push({ offset: off, line: 0, text: field, kind: 'field-read', snippet: '' });
  }
  return out;
}

/** 对文件 src 的 AST：把每个字段名子串(含偏移)按 AST 归属分类 */
function classifyKeyOffsets(root: SyntaxNodeLike, src: string, field: string): Map<number, FieldRefKind> {
  const result = new Map<number, FieldRefKind>();
  const reWord = new RegExp(`\\b${escapeRegex(field)}\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = reWord.exec(src))) {
    const off = m.index;
    const kind = classifyOffset(root, off, field);
    if (kind) result.set(off, kind);
  }
  return result;
}

/** 定位 offset 所在最深节点并收集祖先链，返回归类；单次下降（可靠，不再用 findParent 引用相等上溯） */
function classifyOffset(root: SyntaxNodeLike, offset: number, _field: string): FieldRefKind | null {
  const path: SyntaxNodeLike[] = [];
  const collect = (n: SyntaxNodeLike): void => {
    if (n.startIndex !== undefined && n.endIndex !== undefined) {
      if (offset < n.startIndex || offset >= n.endIndex) return; // 不含该字节则剪枝
    }
    path.push(n);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) collect(c);
    }
  };
  collect(root);
  const deepestType = path[path.length - 1]?.type ?? '';
  // 注释里的同名（tree-sitter 会挂到外层对象字面量下）→ 直接跳过
  if (deepestType === 'comment') return null;
  // 字符串里的同名：只当它是 obj['field'] 方括号读才有意义（subscript_expression 之下）；否则是普通字符串，非引用
  if (STRING_LEAF_TYPES.has(deepestType)) {
    for (const n of path) if (n.type === 'subscript_expression') return 'field-read';
    return null;
  }
  // 叶→根 顺序判类（先验叶端，读取优先于容器键）
  for (let i = path.length - 1; i >= 0; i--) {
    const t = path[i].type;
    if (t === 'object_pattern') return 'field-destructure';
    if (t === 'object_type' || t === 'property_signature' || t === 'method_signature') return 'field-decl';
    if (t === 'object' || t === 'pair') return 'field-key';
    if (t === 'member_expression' || t === 'subscript_expression') return 'field-read';
  }
  return null;
}

const STRING_LEAF_TYPES = new Set(['string', 'string_fragment', 'template_string', 'template_literal', 'string_literal']);

/** field 模式主入口：scope 内收集字段的结构引用点 */
export async function collectFieldRefs(input: {
  project_dir: string;
  field: string;
  /** 定义文件（可选）：提供时默认按闭包扫描 */
  file?: string;
  /** closure（默认，给 file 时按 import 闭包）| all（全项目扫） */
  scope?: 'closure' | 'all';
}): Promise<FieldRefFile[]> {
  const resolvedRoot = path.resolve(input.project_dir);
  const field = input.field;
  const wantAll = input.scope === 'all';
  const fileAbs = input.file ? (path.isAbsolute(input.file) ? path.resolve(input.file) : path.resolve(resolvedRoot, input.file)) : undefined;

  const scopeFiles: string[] = [];
  if (!wantAll && fileAbs) {
    const closure = await expandClosure(fileAbs, resolvedRoot, loadAliasConfig(resolvedRoot));
    for (const f of closure) if (path.resolve(f).startsWith(resolvedRoot)) scopeFiles.push(f);
  }
  if (scopeFiles.length === 0) {
    const walked: string[] = [];
    walkProjectFiles(resolvedRoot, walked);
    scopeFiles.push(...walked);
  }

  const out: FieldRefFile[] = [];
  for (const abs of scopeFiles) {
    let src: string;
    try {
      src = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const ast = await parseAstRoot(abs, src);
    let byOff: Map<number, FieldRefKind>;
    if (ast) {
      // AST 全量分类（构造/解构/声明/读取，天然去重，且能跳过注释/字符串里的字面）
      byOff = classifyKeyOffsets(ast.root, src, field);
    } else {
      // 无 AST（语言不支持/解析失败）：正则兜底——.field 读 + field: 构造（保守）
      byOff = new Map<number, FieldRefKind>();
      for (const r of captureReads(src, field)) byOff.set(r.offset, 'field-read');
      const reKey = new RegExp(`\\b${escapeRegex(field)}\\s*:`, 'g');
      let km: RegExpExecArray | null;
      while ((km = reKey.exec(src))) byOff.set(km.index, 'field-key');
    }
    const points: FieldRefPoint[] = [];
    for (const [off, kind] of byOff) {
      points.push({ offset: off, line: lineOf(src, off), text: field, kind, snippet: lineText(src, off) });
    }
    if (points.length > 0) {
      points.sort((a, b) => a.offset - b.offset);
      out.push({ file: (path.relative(resolvedRoot, abs) || path.basename(abs)).replace(/\\/g, '/'), refs: points });
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}

/** type 模式：返回与类型成员集交叠 ≥ 阈值的对象字面量候选构造点 */
export async function collectTypeConstructCandidates(input: {
  project_dir: string;
  file: string;
  symbol: string;
  scope?: 'closure' | 'all';
  /** 交叠成员数阈值，默认 2 */
  min_hit?: number;
}): Promise<{ members: string[]; candidates: TypeConstructCandidate[] }> {
  const resolvedRoot = path.resolve(input.project_dir);
  const fileAbs = path.isAbsolute(input.file) ? path.resolve(input.file) : path.resolve(resolvedRoot, input.file);
  const minHit = input.min_hit ?? 2;
  const src = readFileSync(fileAbs, 'utf-8');
  const members = extractTypeMembers(fileAbs, src, input.symbol);
  if (members.length === 0) return { members, candidates: [] };

  const wantAll = input.scope === 'all';
  const scopeFiles: string[] = [];
  if (!wantAll) {
    const closure = await expandClosure(fileAbs, resolvedRoot, loadAliasConfig(resolvedRoot));
    for (const f of closure) if (path.resolve(f).startsWith(resolvedRoot)) scopeFiles.push(f);
  }
  if (scopeFiles.length === 0) {
    const walked: string[] = [];
    walkProjectFiles(resolvedRoot, walked);
    scopeFiles.push(...walked);
  }

  const candidates: TypeConstructCandidate[] = [];
  const memberSet = new Set(members);
  for (const abs of scopeFiles) {
    let fsrc: string;
    try {
      fsrc = readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const ast = await parseAstRoot(abs, fsrc);
    if (!ast) continue;
    const objs = findNodesByType(ast.root, new Set(['object']));
    for (const obj of objs) {
      const matched = objectLiteralKeys(obj).filter((k) => memberSet.has(k));
      if (matched.length >= minHit) {
        candidates.push({
          file: (path.relative(resolvedRoot, abs) || path.basename(abs)).replace(/\\/g, '/'),
          line: obj.startPosition.row + 1,
          offset: obj.startIndex ?? 0,
          matched: [...new Set(matched)],
          snippet: lineText(fsrc, obj.startIndex ?? 0),
        });
      }
    }
  }
  candidates.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { members, candidates };
}

/** 从类型声明里抽成员字段集（interface/type 的花括号属性键） */
function extractTypeMembers(fileAbs: string, src: string, symbol: string): string[] {
  // 定位 `symbol` 的声明段落，取其花括号块内所有标识符+可选 `?:`
  const symRe = new RegExp(`\\b(?:interface|type)\\s+${escapeRegex(symbol)}\\b[^\\n{]*\\{`);
  const m = symRe.exec(src);
  if (!m) return [];
  const open = src.indexOf('{', m.index);
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];
  const body = src.slice(open, close);
  const members: string[] = [];
  const re = /([A-Za-z_$][\w$]*)\s*[?:]/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(body))) members.push(mm[1]);
  return [...new Set(members)];
}

/** 返回子树里所有 type ∈ set 的节点 */
function findNodesByType(node: SyntaxNodeLike, types: Set<string>): SyntaxNodeLike[] {
  const out: SyntaxNodeLike[] = [];
  const walk = (n: SyntaxNodeLike): void => {
    if (types.has(n.type)) out.push(n);
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(node);
  return out;
}

/** 对象字面量成对键（pair 的属性键、shorthand 的键） */
function objectLiteralKeys(obj: SyntaxNodeLike): string[] {
  const keys: string[] = [];
  const walk = (n: SyntaxNodeLike): void => {
    const t = n.type;
    if (t === 'pair' && n.childCount >= 1) {
      const k = n.child(0)!;
      keys.push(k.text);
    } else if (t === 'shorthand_property_identifier_pattern' || t === 'shorthand_property_identifier') {
      keys.push(n.text);
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(obj);
  return keys;
}