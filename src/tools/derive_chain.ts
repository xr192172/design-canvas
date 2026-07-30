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
import { parseFile, type ParsedSymbol } from './ts_kernel/index.js';

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
}

export interface DeriveChainResult {
  message: string;
  feature: string;
  node_id: string;
  chain: Array<{ step: number; name: string; signature: string; node_id: string }>;
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
// 调用图（文本法，language-agnostic）
// ─────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CallEdge {
  callee: string;
  /** 被调函数在 caller body 中首次出现位置（邻居排序用） */
  pos: number;
}

function buildCallGraph(symbols: ParsedSymbol[], content: string): Map<string, CallEdge[]> {
  const lines = content.split('\n');
  const graph = new Map<string, CallEdge[]>();
  for (const s of symbols) {
    const body = lines.slice(s.start_line - 1, s.end_line).join('\n');
    const edges: CallEdge[] = [];
    for (const t of symbols) {
      if (t === s || t.name.length < 3) continue;
      const m = body.match(new RegExp(`(?<![\\w])${escapeRegex(t.name)}\\s*\\(`));
      if (m && m.index !== undefined) edges.push({ callee: t.qualified_name, pos: m.index });
    }
    edges.sort((a, b) => a.pos - b.pos);
    graph.set(s.qualified_name, edges);
  }
  return graph;
}

/** 入口推导：入度 0 → 链最长优先 → 导出（Go 大写 / Python 无下划线前缀）→ 行号最早 */
function pickEntry(symbols: ParsedSymbol[], graph: Map<string, CallEdge[]>): ParsedSymbol {
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
function walkChain(
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
  const symbols = (await parseFile(filePath, content)).filter(
    (s) => s.kind === 'function' || s.kind === 'method',
  );
  if (symbols.length === 0) {
    throw new Error(`未从 ${path.basename(filePath)} 解析到函数/方法（语言不支持或文件无函数定义）`);
  }

  // 调用图 → 入口 → DFS 主链 → max_steps 截断
  const graph = buildCallGraph(symbols, content);
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
  const skipped = symbols
    .filter((s) => !chainSet.has(s.qualified_name))
    .sort((a, b) => a.start_line - b.start_line)
    .map((s) => s.name);

  // 幂等：清理旧的 derived 节点/边
  const nodePrefix = `${node_id}__s`;
  const edgePrefix = `${node_id}__chain_`;
  dsl.geometry.nodes = dsl.geometry.nodes.filter((n) => !n.id.startsWith(nodePrefix));
  dsl.geometry.edges = (dsl.geometry.edges ?? []).filter((e) => !e.id.startsWith(edgePrefix));

  // 布局：宿主正下方一行（与 conveyor D1 手工布局同风格：220 宽 + 20 间隔）
  const hx = host.x ?? 0;
  const hy = host.y ?? 0;
  const hh = host.height ?? 60;
  const baseY = hy + hh + 40;

  const newNodes: Node[] = [];
  const newEdges: Edge[] = [];
  const chainInfo: DeriveChainResult['chain'] = [];

  let stepNum = 0;
  chain.forEach((s) => {
    // 防御：跳过 name 为空或非法的符号（extractName 兜底失败返回代码片段的情况）
    if (!s.name || s.name.length > 64 || !/^[A-Za-z_$]/.test(s.name)) return;
    stepNum++;
    const id = `${nodePrefix}${stepNum}_${sanitize(s.qualified_name)}`;
    const shapes = signatureToShapes(s.signature, lang);
    const node: Node = {
      id,
      x: hx + (stepNum - 1) * 240,
      y: baseY,
      width: 220,
      label: `${CIRCLED[stepNum - 1] ?? `${stepNum}.`} ${s.name}`,
      layer: 'detail',
      host: node_id,
      description: s.signature,
    };
    if (shapes.in || shapes.out) node.shapes = shapes;
    newNodes.push(node);
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

  dsl.geometry.nodes.push(...newNodes);
  dsl.geometry.edges.push(...newEdges);
  saveDSL(dsl);

  const relPath = path.relative(projectRoot, filePath) || path.basename(filePath);
  const lines = [
    `已推导 detail 变形链：feature "${feature}" 节点 ${node_id}`,
    `源文件：${relPath}（${symbols.length} 个函数，入链 ${chain.length} 个${fullChain.length > chain.length ? `，max_steps=${max_steps} 截断` : ''}）`,
    '',
    '加工链（按调用顺序）：',
    ...chainInfo.map((c) => `  ${CIRCLED[c.step - 1] ?? c.step} ${c.signature}`),
    '',
    `未入链函数（不在主调用路径或被截断）: ${skipped.length > 0 ? skipped.join(', ') : '无'}`,
    ...(chain.length === 1 && symbols.length > 1
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
    '注意：调用边为文本匹配推导，同名方法可能误连，语义标注阶段请修正。',
  ];

  return {
    message: lines.join('\n'),
    feature,
    node_id,
    chain: chainInfo,
    skipped,
    nodes_created: newNodes.length,
    edges_created: newEdges.length,
  };
}
