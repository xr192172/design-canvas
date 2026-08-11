/**
 * derive_detail_chain 工具（D2 变形链推导）
 *
 * TreeSitter 提取函数骨架 + 文本法调用图 → 生成 detail 层节点/边，写回 DSL。
 *
 * 混合来源分工（animation-design.md 10.5）：
 *   - 本工具（机械活）：函数骨架、调用顺序、参数/返回类型 → shapes 类型推导
 *   - LLM（语义活）：update_node 填人话 label / shapes.label、聚合相邻细步骤
 *
 * 调用边提取是文本匹配（name( 出现即连边），语言无关但存在近似性：
 * 同名不同 receiver 的方法会误连——语义标注阶段由 LLM 修正。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AnimationValueSchema, Edge, Node } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import type { Database } from '../db/db.js';
import { parseFileFull, isSupported, type ParsedCall, type ParsedSymbol } from './ts_kernel/index.js';
import { extractFunctionCfg } from './ts_kernel/cfg.js';
import { KIND_SHAPE } from './derive_algorithm.js';

export interface DeriveChainInput {
  /** feature 名 */
  feature: string;
  /** 主干文件节点 id（detail 链挂在它下面） */
  node_id: string;
  /** 源文件路径（缺省取 semantic.files[node_id].path，相对 project_root） */
  source_path?: string;
  /** 源文件根目录，默认 process.cwd() */
  project_root?: string;
  /** 入口函数名（缺省自动推导：入度 0 且优先导出） */
  entry?: string;
  /** 入链函数上限，默认 12 */
  max_steps?: number;
  /** 主链外分支函数上限（调用图除主链外的被调函数节点），默认 20 */
  max_branches?: number;
  /** 跨文件追加上限（数据流追进被调外部函数的数量），默认 2 */
  max_cross?: number;
}

export interface DeriveChainResult {
  message: string;
  feature: string;
  node_id: string;
  chain: Array<{ step: number; name: string; signature: string; node_id: string }>;
  /** 主链外的分支调用：jump=链上跳边（谁调谁），extra=截断未入链的辅助函数（建了节点） */
  branch: Array<{ name: string; signature: string; node_id: string; caller: string; kind: 'jump' | 'extra' }>;
  /** 跨文件调用标注（cache.db 有数据时；本文件函数 → 其他文件符号） */
  cross_calls: Array<{ caller: string; targets: string[] }>;
  /** 跨文件追加（v1）：链尾函数追进被调外部函数（detail 节点 + 链边 + 外部 CFG） */
  cross_trace: Array<{ caller: string; target: string; node_id: string; has_cfg: boolean }>;
  skipped: string[];
  nodes_created: number;
  edges_created: number;
}

// ─────────────────────────────────────────────────────────────
// 语言推断与顶层逗号切分
// ─────────────────────────────────────────────────────────────

type Lang = 'go' | 'ts' | 'py' | 'unknown';

function detectLang(filePath: string): Lang {
  if (filePath.endsWith('.go')) return 'go';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return 'ts';
  if (filePath.endsWith('.py')) return 'py';
  return 'unknown';
}

/** 按顶层逗号切分（跟踪 () [] {} <> 嵌套深度） */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 取签名的参数段与返回段（第一个 '(' 起配对） */
function splitSignature(signature: string): { params: string; ret: string } {
  const open = signature.indexOf('(');
  if (open < 0) return { params: '', ret: '' };
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return { params: signature.slice(open + 1, i), ret: signature.slice(i + 1).trim() };
      }
    }
  }
  return { params: signature.slice(open + 1), ret: '' };
}

// ─────────────────────────────────────────────────────────────
// 类型 → AnimationValueSchema
// ─────────────────────────────────────────────────────────────

const ANY: AnimationValueSchema = { type: 'object', label: '任意' };

function mapGoType(raw: string): AnimationValueSchema {
  let t = raw.trim();
  if (!t) return ANY;
  if (t.startsWith('...')) return { type: 'array', items: mapGoType(t.slice(3)) };
  while (t.startsWith('*')) t = t.slice(1).trim();
  // []byte/[]uint8 是 Go 字节串惯用法，推成 array<integer> 非开发者看不懂（真实工程教训）
  if (t === '[]byte' || t === '[]uint8') return { type: 'string', label: '字节串' };
  if (t.startsWith('[]')) return { type: 'array', items: mapGoType(t.slice(2)) };
  if (t.startsWith('map[')) return { type: 'object', label: t };
  if (t === 'string') return { type: 'string' };
  if (t === 'bool') return { type: 'boolean' };
  if (/^(u?int(8|16|32|64)?|byte|rune|uintptr)$/.test(t)) return { type: 'integer' };
  if (/^float(32|64)$/.test(t)) return { type: 'number' };
  if (t === 'interface{}' || t === 'any') return ANY;
  return { type: 'object', label: t };
}

function mapTsType(raw: string): AnimationValueSchema {
  let t = raw.trim().replace(/;$/, '');
  if (!t) return ANY;
  // 联合类型取首个非空成员
  if (t.includes('|')) {
    const first = splitTopLevel(t.replace(/\|/g, ',')).find((m) => m && m !== 'null' && m !== 'undefined');
    return first ? mapTsType(first) : ANY;
  }
  const promiseMatch = t.match(/^Promise<(.+)>$/);
  if (promiseMatch) return mapTsType(promiseMatch[1]);
  if (t.startsWith('readonly ')) t = t.slice(9).trim();
  if (t.endsWith('[]')) return { type: 'array', items: mapTsType(t.slice(0, -2)) };
  const arrayMatch = t.match(/^Array<(.+)>$/);
  if (arrayMatch) return { type: 'array', items: mapTsType(arrayMatch[1]) };
  if (t === 'string') return { type: 'string' };
  if (t === 'number') return { type: 'number' };
  if (t === 'boolean') return { type: 'boolean' };
  if (t === 'bigint') return { type: 'integer' };
  if (t === 'void' || t === 'undefined' || t === 'null') return { type: 'null' };
  if (t === 'any' || t === 'unknown') return ANY;
  if (t.startsWith('{')) return { type: 'object', label: '对象' };
  return { type: 'object', label: t };
}

function mapPyType(raw: string): AnimationValueSchema {
  const t = raw.trim();
  if (!t) return ANY;
  const optMatch = t.match(/^Optional\[(.+)\]$/);
  if (optMatch) return mapPyType(optMatch[1]);
  const listMatch = t.match(/^(?:list|List)\[(.+)\]$/);
  if (listMatch) return { type: 'array', items: mapPyType(listMatch[1]) };
  if (t === 'list' || t === 'List') return { type: 'array', items: ANY };
  if (t === 'str') return { type: 'string' };
  if (t === 'int') return { type: 'integer' };
  if (t === 'float') return { type: 'number' };
  if (t === 'bool') return { type: 'boolean' };
  if (t === 'dict' || t === 'Dict') return { type: 'object', label: 'dict' };
  if (t === 'None') return { type: 'null' };
  return { type: 'object', label: t };
}

function mapType(raw: string, lang: Lang): AnimationValueSchema {
  if (lang === 'go') return mapGoType(raw);
  if (lang === 'ts') return mapTsType(raw);
  if (lang === 'py') return mapPyType(raw);
  return ANY;
}

// ─────────────────────────────────────────────────────────────
// 参数 / 返回 → shapes
// ─────────────────────────────────────────────────────────────

interface Param {
  name: string;
  type: string;
}

function parseParams(params: string, lang: Lang): Param[] {
  if (!params.trim()) return [];
  const segs = splitTopLevel(params);
  const out: Param[] = [];

  if (lang === 'go') {
    // Go 共享类型：a, b int —— 无类型段继承后一段类型
    let pending: string[] = [];
    for (const seg of segs) {
      const tokens = seg.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const type = tokens[tokens.length - 1];
        const names = [...pending, ...tokens.slice(0, -1)];
        pending = [];
        for (const n of names) out.push({ name: n, type });
      } else if (tokens.length === 1) {
        pending.push(tokens[0]);
      }
    }
    for (const n of pending) out.push({ name: n, type: '' });
    // context.Context 是承载不是数据，滤除
    return out.filter((p) => p.type !== 'context.Context');
  }

  if (lang === 'ts') {
    for (const seg of segs) {
      const colonIdx = seg.indexOf(':');
      if (colonIdx >= 0) {
        const name = seg.slice(0, colonIdx).trim().replace(/[?…]/g, '').replace(/^\.\.\./, '');
        out.push({ name, type: seg.slice(colonIdx + 1).trim() });
      } else {
        out.push({ name: seg.replace(/^\.\.\./, '').trim(), type: '' });
      }
    }
    return out.filter((p) => p.name);
  }

  // python：先去默认值，再按 : 取注解；self/cls 滤除
  for (const seg of segs) {
    const noDefault = splitTopLevel(seg.replace(/=/g, ','))[0] ?? seg;
    const colonIdx = noDefault.indexOf(':');
    const name = (colonIdx >= 0 ? noDefault.slice(0, colonIdx) : noDefault).trim();
    const type = colonIdx >= 0 ? noDefault.slice(colonIdx + 1).trim() : '';
    if (name && name !== 'self' && name !== 'cls') out.push({ name, type });
  }
  return out;
}

/** Go 返回段 → { schemas, named }：滤掉 error；命名返回保留名字 */
function parseGoReturns(ret: string): Array<{ name?: string; schema: AnimationValueSchema }> {
  const t = ret.trim();
  if (!t) return [];
  const segs: string[] = [];
  if (t.startsWith('(')) {
    const close = t.lastIndexOf(')');
    if (close < 0) return [];
    for (const seg of splitTopLevel(t.slice(1, close))) segs.push(seg);
  } else {
    segs.push(t);
  }
  const out: Array<{ name?: string; schema: AnimationValueSchema }> = [];
  for (const seg of segs) {
    const tokens = seg.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens.length >= 2) {
      const type = tokens[tokens.length - 1];
      if (type === 'error') continue;
      out.push({ name: tokens[0], schema: mapGoType(type) });
    } else {
      if (tokens[0] === 'error') continue;
      out.push({ schema: mapGoType(tokens[0]) });
    }
  }
  return out;
}

/** 函数签名 → shapes.in / shapes.out */
function signatureToShapes(
  signature: string,
  lang: Lang,
): { in?: AnimationValueSchema; out?: AnimationValueSchema } {
  const { params, ret } = splitSignature(signature);
  const shapes: { in?: AnimationValueSchema; out?: AnimationValueSchema } = {};

  const parsed = parseParams(params, lang);
  if (parsed.length > 0) {
    const properties: Record<string, AnimationValueSchema> = {};
    for (const p of parsed) properties[p.name] = p.type ? mapType(p.type, lang) : ANY;
    shapes.in = { type: 'object', properties };
  }

  if (lang === 'go') {
    const returns = parseGoReturns(ret);
    if (returns.length === 1 && !returns[0].name) {
      shapes.out = returns[0].schema;
    } else if (returns.length > 0) {
      const properties: Record<string, AnimationValueSchema> = {};
      returns.forEach((r, i) => {
        properties[r.name ?? `r${i}`] = r.schema;
      });
      shapes.out = { type: 'object', properties };
    }
  } else {
    const prefix = lang === 'ts' ? ':' : '->';
    const idx = ret.indexOf(prefix);
    if (idx >= 0) {
      // kernel 的 return_type 字段可能自带前缀（TS type_annotation 含冒号），剥净
      let typeStr = ret.slice(idx + prefix.length).trim();
      while (typeStr.startsWith(':')) typeStr = typeStr.slice(1).trim();
      const schema = mapType(typeStr, lang);
      if (schema.type !== 'null') shapes.out = schema;
    }
  }

  return shapes;
}

// ─────────────────────────────────────────────────────────────
// 调用图（AST 级，路线图序号 3 的调用边接入渲染）
// ─────────────────────────────────────────────────────────────

interface CallEdge {
  callee: string;
  /** 被调函数在 caller body 中首次调用行号（邻居排序用） */
  line: number;
}

/**
 * AST 级调用图：parseFileFull.calls（同文件 resolved 的精确调用边）。
 * 替代原文本正则（name( 出现即连边）——同名不同 receiver 的方法不再误连。
 * graph key/value 均为 qualified_name（class 方法如 Svc.Start）。
 */
export function buildCallGraph(
  symbols: ParsedSymbol[],
  calls: ParsedCall[],
): Map<string, CallEdge[]> {
  const graph = new Map<string, CallEdge[]>();
  const byQName = new Map(symbols.map((s) => [s.qualified_name, s]));
  for (const c of calls) {
    // 只取同文件解析成功的边：caller/callee 都必须在符号表
    if (!c.resolved || !c.callee_qn) continue;
    if (!byQName.has(c.caller) || !byQName.has(c.callee_qn)) continue;
    let arr = graph.get(c.caller);
    if (!arr) {
      arr = [];
      graph.set(c.caller, arr);
    }
    // 同一定向调用去重（一行内多次调用 / 循环内重复）
    if (!arr.some((e) => e.callee === c.callee_qn)) arr.push({ callee: c.callee_qn, line: c.line });
  }
  for (const arr of graph.values()) arr.sort((a, b) => a.line - b.line);
  return graph;
}

/** 入口推导：入度 0 → 链最长优先 → 导出（Go 大写 / Python 无下划线前缀）→ 行号最早 */
export function pickEntry(symbols: ParsedSymbol[], graph: Map<string, CallEdge[]>): ParsedSymbol {
  const called = new Set<string>();
  for (const edges of graph.values()) for (const e of edges) called.add(e.callee);
  const candidates = symbols.filter((s) => !called.has(s.qualified_name));
  const pool = candidates.length > 0 ? candidates : symbols;
  // 偏好链最长的候选（真实工程教训：先入度 0 的构造函数常无调用，流水线入口在后面）
  const scored = pool.map((s) => ({ s, len: walkChain(s, symbols, graph).length }));
  const maxLen = Math.max(...scored.map((x) => x.len));
  const best = scored.filter((x) => x.len === maxLen).map((x) => x.s);
  const exported = best.filter((s) => /^[A-Z]/.test(s.name) || !s.name.startsWith('_'));
  const finalPool = exported.length > 0 ? exported : best;
  return finalPool.reduce((a, b) => (a.start_line <= b.start_line ? a : b));
}

/** DFS pre-order 调用链（邻居按 body 内调用出现位置排序） */
export function walkChain(
  entry: ParsedSymbol,
  symbols: ParsedSymbol[],
  graph: Map<string, CallEdge[]>,
): ParsedSymbol[] {
  const byQName = new Map(symbols.map((s) => [s.qualified_name, s]));
  const visited = new Set<string>();
  const chain: ParsedSymbol[] = [];
  const dfs = (s: ParsedSymbol): void => {
    if (visited.has(s.qualified_name)) return;
    visited.add(s.qualified_name);
    chain.push(s);
    for (const e of graph.get(s.qualified_name) ?? []) {
      const t = byQName.get(e.callee);
      if (t) dfs(t);
    }
  };
  dfs(entry);
  return chain;
}

// ─────────────────────────────────────────────────────────────
// 节点 / 边生成
// ─────────────────────────────────────────────────────────────

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫'];

function sanitize(s: string): string {
  return s.replace(/[^\w]/g, '_');
}

// ─────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────

export async function deriveDetailChain(input: DeriveChainInput): Promise<DeriveChainResult> {
  const { feature, node_id, source_path, entry, max_steps = 12 } = input;
  const projectRoot = input.project_root ? path.resolve(input.project_root) : process.cwd();

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 create_feature 或 render_dsl`);
  const host = dsl.geometry.nodes.find((n) => n.id === node_id);
  if (!host) throw new Error(`节点 "${node_id}" 不存在于 feature "${feature}"`);

  // 源文件定位：显式 source_path 优先，其次 semantic.files[node_id].path
  let filePath: string | undefined;
  if (source_path) {
    filePath = path.isAbsolute(source_path) ? source_path : path.join(projectRoot, source_path);
  } else {
    const rel = dsl.semantic?.files?.find((f) => f.id === node_id)?.path;
    // semantic path 可能是绝对路径（外部项目回填），直接 join 会在 Windows 拼出怪胎
    if (rel) filePath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  }
  if (!filePath) {
    throw new Error(`节点 "${node_id}" 没有对应源文件（semantic.files 无此 id，且未传 source_path）`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`源文件不存在，无法读取: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lang = detectLang(filePath);
  const parsed = await parseFileFull(filePath, content);
  if (parsed.error) {
    throw new Error(`解析失败: ${parsed.error}`);
  }
  const symbols = parsed.symbols.filter((s) => s.kind === 'function' || s.kind === 'method');
  if (symbols.length === 0) {
    throw new Error(`未从 ${path.basename(filePath)} 解析到函数/方法（语言不支持或文件无函数定义）`);
  }
  const byQName = new Map(symbols.map((s) => [s.qualified_name, s]));

  // AST 级调用图（路线图序号 3：调用边接入渲染——精确边替代文本正则）
  const graph = buildCallGraph(symbols, parsed.calls);
  let entrySym: ParsedSymbol;
  if (entry) {
    const found = symbols.find((s) => s.name === entry || s.qualified_name === entry);
    if (!found) throw new Error(`入口函数 "${entry}" 在源文件中不存在`);
    entrySym = found;
  } else {
    entrySym = pickEntry(symbols, graph);
  }
  const fullChain = walkChain(entrySym, symbols, graph);
  const chain = fullChain.slice(0, max_steps);
  const chainSet = new Set(chain.map((s) => s.qualified_name));

  // 分支 = 谁调谁的完整图结构（walkChain 全遍历只给出线性加工序）：
  //   - 跳边（jump）：链上 A 调 B 且 B 非 A 的紧邻后继（如 Entry 同时调 stepA/stepB）→ 虚线边
  //   - 链外节点（extra）：链上 A 调 B 但 B 未入链（max_steps 截断）→ 建节点 + 虚线边
  const maxBranches = input.max_branches ?? 20;
  const extraOrder: Array<{ fn: ParsedSymbol; caller: string }> = [];
  const extraSet = new Set<string>();
  const jumpOrder: Array<{ fromQn: string; toQn: string }> = [];
  for (let i = 0; i < chain.length; i++) {
    const s = chain[i];
    const nextQn = i + 1 < chain.length ? chain[i + 1].qualified_name : null;
    for (const e of graph.get(s.qualified_name) ?? []) {
      if (e.callee === nextQn) continue; // 链顺序边已画，跳过
      const t = byQName.get(e.callee);
      if (!t) continue;
      if (chainSet.has(t.qualified_name)) {
        jumpOrder.push({ fromQn: s.qualified_name, toQn: t.qualified_name });
      } else if (!extraSet.has(t.qualified_name)) {
        extraSet.add(t.qualified_name);
        extraOrder.push({ fn: t, caller: s.qualified_name });
      }
    }
  }
  const extraLimited = extraOrder.slice(0, maxBranches);
  const jumpLimited = jumpOrder.slice(0, Math.max(0, maxBranches - extraLimited.length));

  // 跨文件调用标注（可选增强）：cache.db 有数据时读 edges(kind='call', cross) 中
  // source 属于本文件的行 → 标注调用方节点 label/description（v1 不建外部节点防图爆炸）
  // cache.db 定位：projectRoot 下没有则向上逐级找（源文件根常是项目根的子目录，如 src/）
  const crossByCaller = new Map<string, string[]>();
  const relPath = path.relative(projectRoot, filePath).split(path.sep).join('/') || path.basename(filePath);
  let cacheDbPath: string | null = null;
  for (let dir = path.resolve(projectRoot); dir && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const cand = path.join(dir, '.design-canvas', 'cache.db');
    if (fs.existsSync(cand)) {
      cacheDbPath = cand;
      break;
    }
  }
  if (cacheDbPath) {
    let db: Database | null = null;
    try {
      const { openDb: open } = await import('../db/db.js');
      db = open(cacheDbPath);
      // source 格式对齐：cache.db 的 relPath 可能相对 src/ 根（如 renderer/xx.ts），
      // 与 project_root 计算的 relPath 不一致 → relPath 查不到时退化为 basename 匹配
      let rows = db
        .prepare("SELECT source, target FROM edges WHERE kind='call' AND metadata IS NOT NULL AND source LIKE ?")
        .all(`${relPath}#%`) as Array<{ source: string; target: string }>;
      if (rows.length === 0) {
        rows = db
          .prepare("SELECT source, target FROM edges WHERE kind='call' AND metadata IS NOT NULL AND source LIKE ?")
          .all(`%${path.basename(filePath)}#%`) as Array<{ source: string; target: string }>;
      }
      for (const r of rows) {
        const callerName = r.source.slice(r.source.lastIndexOf('#') + 1);
        let arr = crossByCaller.get(callerName);
        if (!arr) {
          arr = [];
          crossByCaller.set(callerName, arr);
        }
        if (!arr.includes(r.target) && arr.length < 8) arr.push(r.target);
      }
    } catch {
      // cache.db 损坏/被锁 → 跳过跨文件标注，不影响主流程
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* 已关闭 */
        }
      }
    }
  }
  const crossCallsInfo: DeriveChainResult['cross_calls'] = [...crossByCaller.entries()]
    .map(([caller, targets]) => ({ caller, targets }))
    .sort((a, b) => a.caller.localeCompare(b.caller));

  const skipped = symbols
    .filter((s) => !chainSet.has(s.qualified_name) && !extraSet.has(s.qualified_name))
    .sort((a, b) => a.start_line - b.start_line)
    .map((s) => s.name);

  // 幂等：清理旧的 derived 节点/边（含分支与跨文件追加的 CFG 边——后者 id 形如 {node_id}__sx{n}_...__alge_*）
  const nodePrefix = `${node_id}__s`;
  const edgePrefix = `${node_id}__chain_`;
  const branchEdgePrefix = `${node_id}__branch_`;
  dsl.geometry.nodes = dsl.geometry.nodes.filter((n) => !n.id.startsWith(nodePrefix));
  dsl.geometry.edges = (dsl.geometry.edges ?? []).filter(
    (e) =>
      !e.id.startsWith(edgePrefix) &&
      !e.id.startsWith(branchEdgePrefix) &&
      !e.id.startsWith(nodePrefix),
  );

  // 布局：宿主正下方一行（与 conveyor D1 手工布局同风格：220 宽 + 20 间隔）
  const hx = host.x ?? 0;
  const hy = host.y ?? 0;
  const hh = host.height ?? 60;
  const baseY = hy + hh + 40;

  const newNodes: Node[] = [];
  const newEdges: Edge[] = [];
  const chainInfo: DeriveChainResult['chain'] = [];
  const branchInfo: DeriveChainResult['branch'] = [];

  /** 防御：跳过 name 为空或非法的符号（extractName 兜底失败返回代码片段的情况） */
  const isBadName = (s: ParsedSymbol): boolean =>
    !s.name || s.name.length > 64 || !/^[A-Za-z_$]/.test(s.name);
  /** 跨文件调用 → label 后缀（可见标记；完整签名进 description） */
  const crossSuffix = (qn: string): string => {
    const targets = crossByCaller.get(qn);
    if (!targets || targets.length === 0) return '';
    const fileNames = [...new Set(targets.map((t) => t.split('#')[0].split('/').pop() ?? t))];
    return ` ·→${fileNames.slice(0, 2).join(',')}${fileNames.length > 2 ? '…' : ''}`;
  };
  const crossNote = (qn: string): string => {
    const targets = crossByCaller.get(qn);
    return targets && targets.length > 0 ? `\n跨文件调用:\n→ ${targets.join('\n→ ')}` : '';
  };

  let stepNum = 0;
  const chainNodeByQn = new Map<string, string>();
  chain.forEach((s) => {
    if (isBadName(s)) return;
    stepNum++;
    const id = `${nodePrefix}${stepNum}_${sanitize(s.qualified_name)}`;
    const shapes = signatureToShapes(s.signature, lang);
    const node: Node = {
      id,
      x: hx + (stepNum - 1) * 240,
      y: baseY,
      width: 220,
      label: `${CIRCLED[stepNum - 1] ?? `${stepNum}.`} ${s.name}${crossSuffix(s.qualified_name)}`,
      layer: 'detail',
      host: node_id,
      description: `${s.signature}${crossNote(s.qualified_name)}`,
    };
    if (shapes.in || shapes.out) node.shapes = shapes;
    newNodes.push(node);
    chainNodeByQn.set(s.qualified_name, id);
    chainInfo.push({ step: stepNum, name: s.name, signature: s.signature, node_id: id });

    if (stepNum > 1) {
      newEdges.push({
        id: `${edgePrefix}${stepNum - 1}`,
        from: newNodes[newNodes.length - 2].id,
        to: id,
        layer: 'detail',
      });
    }
  });

  // 链外节点（extra）：max_steps 截断未入链但被主链函数调用 → 建节点，编号续排
  const chainCount = stepNum;
  const nodeIdOf = (qn: string): string => chainNodeByQn.get(qn) ?? '';
  extraLimited.forEach(({ fn, caller }, bi) => {
    if (isBadName(fn)) return;
    const num = chainCount + bi + 1;
    const id = `${nodePrefix}${num}_${sanitize(fn.qualified_name)}`;
    const shapes = signatureToShapes(fn.signature, lang);
    const node: Node = {
      id,
      x: hx + (num - 1) * 240,
      y: baseY,
      width: 220,
      label: `${CIRCLED[num - 1] ?? `${num}.`} ${fn.name}·分支${crossSuffix(fn.qualified_name)}`,
      layer: 'detail',
      host: node_id,
      description: `${fn.signature}${crossNote(fn.qualified_name)}`,
    };
    if (shapes.in || shapes.out) node.shapes = shapes;
    newNodes.push(node);
    chainNodeByQn.set(fn.qualified_name, id);
    branchInfo.push({ name: fn.name, signature: fn.signature, node_id: id, caller, kind: 'extra' });
    const callerId = nodeIdOf(caller);
    if (callerId) {
      newEdges.push({
        id: `${branchEdgePrefix}x${bi + 1}`,
        from: callerId,
        to: id,
        label: '分支',
        type: 'dashed',
        layer: 'detail',
      });
    }
  });

  // 跳边（jump）：链上 A 调 B 且 B 非 A 紧邻后继 → 虚线边（谁调谁的图结构）
  let jumpNo = 0;
  for (const { fromQn, toQn } of jumpLimited) {
    const fromId = nodeIdOf(fromQn);
    const toId = nodeIdOf(toQn);
    if (!fromId || !toId || fromId === toId) continue;
    jumpNo++;
    newEdges.push({
      id: `${branchEdgePrefix}j${jumpNo}`,
      from: fromId,
      to: toId,
      label: '分支',
      type: 'dashed',
      layer: 'detail',
    });
    const t = byQName.get(toQn);
    if (t) {
      branchInfo.push({ name: t.name, signature: t.signature, node_id: toId, caller: fromQn, kind: 'jump' });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 跨文件追加（v1）：数据流到跨文件调用点 → 追进被调的外部函数（深度 1 层）
  // 链上每个有跨文件调用的函数都是锚点（数据流进入外部文件，返回后继续主链）
  // 复用：cache.db cross 边定位目标；signatureToShapes 生成 shapes；
  //       extractFunctionCfg 生成外部函数 CFG → 跨文件判定可追踪
  // 节点 id：{node_id}__sx{n}_{fn}（含 __s 前缀 → 幂等清理一并覆盖）；
  // 外部 CFG：{xid}__alg_* / {xid}__alge_*（含 __alg_ → collectJudgements 按 label 关联可命中）
  // ─────────────────────────────────────────────────────────────
  const crossTrace: DeriveChainResult['cross_trace'] = [];
  const maxCross = input.max_cross ?? 3; // 外部函数追加总数上限
  const xStart = stepNum + extraLimited.length;
  let xNo = 0;
  let xTotal = 0;
  for (let ci = 0; ci < chain.length && xTotal < maxCross; ci++) {
    const s = chain[ci];
    if (isBadName(s)) continue;
    const sId = chainNodeByQn.get(s.qualified_name);
    if (!sId) continue;
    // 每锚点最多 1 个目标（防爆炸），总数受 maxCross 限制
    const targets = (crossByCaller.get(s.qualified_name) ?? []).slice(0, maxCross - xTotal);
    if (targets.length === 0) continue;
    // 锚点原紧邻后继：外部函数处理完数据流返回继续主链
    const nextSym = ci + 1 < chain.length ? chain[ci + 1] : undefined;
    const nextId = nextSym && !isBadName(nextSym) ? chainNodeByQn.get(nextSym.qualified_name) : undefined;
    for (const t of targets) {
      const [tfile, tfn] = t.split('#');
      if (!tfile || !tfn) continue;
      // cache.db 的 target 相对 src/ 根（如 renderer/styles.ts）→ 尝试 project_root 与 project_root/src 两个候选
      const candPaths = [
        path.isAbsolute(tfile) ? tfile : path.join(projectRoot, tfile),
        path.join(projectRoot, 'src', tfile),
      ];
      const tpath = candPaths.find((p) => fs.existsSync(p));
      if (!tpath || !isSupported(path.extname(tpath))) continue;
      try {
        const tcontent = fs.readFileSync(tpath, 'utf-8');
        const tlang = detectLang(tpath);
        const tparsed = await parseFileFull(tpath, tcontent);
        if (tparsed.error) continue;
        const tsym = tparsed.symbols.find((sy) => sy.name === tfn || sy.qualified_name === tfn);
        if (!tsym) continue;
        xNo++;
        xTotal++;
        const num = xStart + xNo;
        const xid = `${nodePrefix}x${xNo}_${sanitize(tfn)}`;
        const tshapes = signatureToShapes(tsym.signature, tlang);
        const tfileName = tfile.split('/').pop() ?? tfile;
        const xnode: Node = {
          id: xid,
          x: hx + (num - 1) * 240,
          y: baseY + 96, // 与主链错开一行：外部文件层
          width: 220,
          label: `${CIRCLED[num - 1] ?? `${num}.`} ${tfn}·→${tfileName}`,
          layer: 'detail',
          host: node_id,
          description: `${tsym.signature}\n跨文件调用：${tfile}`,
        };
        if (tshapes.in || tshapes.out) xnode.shapes = tshapes;
        newNodes.push(xnode);
        // 进入边：锚点 → 外部函数；返回边：外部函数 → 锚点原紧邻后继（数据流返回继续主链）
        newEdges.push({ id: `${edgePrefix}x${xNo}`, from: sId, to: xid, layer: 'detail' });
        if (nextId) newEdges.push({ id: `${edgePrefix}x${xNo}r`, from: xid, to: nextId, layer: 'detail' });

        // 外部函数 CFG：数据流进入后继续展示其内部判定
        const tcfg = await extractFunctionCfg(tpath, tcontent, tfn, 3);
        if (tcfg) {
          const algP = `${xid}__alg_`;
          const algeP = `${xid}__alge_`;
          const cfgX = (xnode.x ?? hx) + 260;
          const cfgNodes: Node[] = tcfg.nodes.map((cn, i) => {
            const meta = KIND_SHAPE[cn.kind] ?? KIND_SHAPE.step;
            const node: Node = {
              id: `${algP}${cn.id}`,
              x: cfgX,
              y: baseY + i * 104,
              width: meta.w,
              height: meta.h,
              label: cn.label,
              layer: 'detail',
              host: node_id,
              style: { shape: meta.shape, ...(meta.tone ? { tone: meta.tone } : {}) },
            };
            const descParts: string[] = [`${cn.kind}${cn.line > 0 ? ` · 源码第 ${cn.line} 行` : ''}`];
            if (cn.condition && cn.condition !== cn.label) descParts.push(`条件：${cn.condition}`);
            node.description = descParts.join('\n');
            return node;
          });
          const cfgEdges: Edge[] = tcfg.edges.map((ce, i) => ({
            id: `${algeP}${i}`,
            from: `${algP}${ce.from}`,
            to: `${algP}${ce.to}`,
            label: ce.label,
            layer: 'detail',
          }));
          newNodes.push(...cfgNodes);
          newEdges.push(...cfgEdges);
          crossTrace.push({ caller: s.qualified_name, target: t, node_id: xid, has_cfg: true });
        } else {
          crossTrace.push({ caller: s.qualified_name, target: t, node_id: xid, has_cfg: false });
        }
      } catch {
        // 外部文件解析失败 → 跳过追加（不影响主链）
      }
    }
  }

  dsl.geometry.nodes.push(...newNodes);
  dsl.geometry.edges.push(...newEdges);
  saveDSL(dsl);

  const lines = [
    `已推导 detail 变形链：feature "${feature}" 节点 ${node_id}`,
    `源文件：${relPath}（${symbols.length} 个函数，入链 ${chain.length} 个${fullChain.length > chain.length ? `，max_steps=${max_steps} 截断` : ''}${branchInfo.length > 0 ? `，分支 ${branchInfo.length} 个` : ''}）`,
    '',
    '加工链（按调用顺序）：',
    ...chainInfo.map((c) => `  ${CIRCLED[c.step - 1] ?? c.step} ${c.signature}`),
    ...(branchInfo.length > 0
      ? ['', '分支调用（虚线边，谁调谁的图结构）：',
        ...branchInfo.map((b) => `  ${b.name}（被 ${b.caller} 调用${b.kind === 'jump' ? '，链上跳边' : '，截断建节点'}）`)]
      : []),
    ...(crossCallsInfo.length > 0
      ? ['', '跨文件调用（→ 目标文件#函数，节点 label 后缀标记）：',
        ...crossCallsInfo.map((c) => `  ${c.caller} → ${c.targets.join(', ')}`)]
      : []),
    ...(crossTrace.length > 0
      ? ['', '跨文件追加（数据流追进外部函数：detail 节点 + 链边 + 外部 CFG）：',
        ...crossTrace.map((c) => `  ${c.caller} → ${c.target}（${c.has_cfg ? '含判定' : '无 CFG'}）`)]
      : []),
    '',
    `未入链函数（不在主调用路径、非分支或被截断）: ${skipped.length > 0 ? skipped.join(', ') : '无'}`,
    ...(chain.length === 1 && branchInfo.length === 0 && symbols.length > 1
      ? [
          '',
          '提示：该文件函数互不调用（扁平 API 面），变形链退化为单节点。' +
            '若需展示数据流，建议换用含调用流水线的文件，或显式 entry 指定关注点函数。',
        ]
      : []),
    '',
    '下一步（LLM 语义标注）：',
    '  1. update_node 把 label 改为人话步骤名（如 "① 预算核算"）',
    '  2. update_node 给 shapes.in/out 填 label（人话描述，渲染优先于类型推导）',
    '  3. 相邻细步骤可聚合：保留语义步骤节点，删除过细节点并重连边',
    '注意：调用边为 AST 级精确提取（parseFileFull.calls）；跨文件标注来自 cache.db，缺省无。',
  ];

  return {
    message: lines.join('\n'),
    feature,
    node_id,
    chain: chainInfo,
    branch: branchInfo,
    cross_calls: crossCallsInfo,
    cross_trace: crossTrace,
    skipped,
    nodes_created: newNodes.length,
    edges_created: newEdges.length,
  };
}
