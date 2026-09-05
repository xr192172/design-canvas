/**
 * archify_semantics —— 从编辑 IR 树提炼「语义面」（与具体图类型无关）
 *
 * 5 种图类型（architecture/workflow/sequence/dataflow/lifecycle）共用一份语义面。
 * 设计原则（贴合"免连线设计把真实上下游当线看"）：
 *   - 主节点 = 目录/模块（容器），而非平铺后的模糊分组——AVOID 折叠出无意义节点；
 *   - 边 = 真实 imports/flow/cross（文件级 imports 提升到所属模块，跨模块才保留）；
 *   - 节点带真实细节：职责(responsibility)、图 layer、status、文件/API 数作 sublabel/tag；
 *   - 不硬造单链主路径：无真实依赖边则诚实返回空主路径（sequence/lifecycle 会如实"不适配"）。
 *
 * 复用 buildFileIndex 产出的 FileIndex（pv exact 按 path 取 FileInfo）、projectFileDataShape、
 * pinIdentityKeys、deriveCrossFeatureFlow。不重造。id 一律合法化且稳定。
 */
import { projectFileDataShape, pinIdentityKeys, deriveCrossFeatureFlow } from './derive_mind_map.js';
import type { FileIndex } from './derive_mind_map.js';
import type { TeachPin } from '../dsl/mindmap.js';
import { roleToType, type ArchifyTreeNode } from './archify_project.js';

const GENERIC_T = /^(string|number|boolean|void|unknown|any|null|undefined|object|array|promise|error|date|buffer|function|map|set|symbol|bigint|never)$/i;
const GENERIC_T_ZH = /^(字符串|数字|布尔|空|未知|对象|数组|异常|无|数据|结果)$/;

export interface SemanticNode { id: string; label: string; sublabel?: string; tag?: string; role: string; type: string; files: string[]; pinsIn: string[]; pinsOut: string[] }
export interface SemanticEdge { from: string; to: string; data: string; kind: 'flow' | 'async' | 'return' | 'error' }
export interface SemanticSurface { id: string; label: string; nodes: SemanticNode[]; edges: SemanticEdge[]; mainPath: string[]; colOrder: Map<string, number>; /** 节点 id → 顶层功能分区（顶层目录作边界分组）；缺省无分组 */ groupOf?: Map<string, string> }

export function legalNodeId(raw: string, i: number): string {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(raw) ? raw : `n${i}`;
}

/** 树节点（适配后契约形状） */
interface RawNode { id: string; label?: string; type?: string; role?: string; file?: string; pins?: { in?: string[]; out?: string[] }; children?: { nodes?: RawNode[]; edges?: REdge[] } }
interface REdge { id?: string; from: string; to: string; label?: string; kind?: string }

export function deriveSemantics(input: ArchifyTreeNode, opts?: { fileIndex?: FileIndex }): SemanticSurface {
  const root = input as RawNode & { children?: { nodes?: RawNode[]; edges?: REdge[] } };
  const rootView = root.children ?? (root as { nodes?: RawNode[]; edges?: REdge[] });
  const fileIndex = opts?.fileIndex;

  // ① 定层 → 主节点（目录/模块优先；平铺时按顶层目录聚合）；ownerOf 提升到所属主节点
  const { chosen, ownerOf } = pickMain(rootView.nodes ?? []);

  // ② 折叠细节：职责/图层/状态/文件数/API 数
  const semNodes: SemanticNode[] = [];
  const semByRaw = new Map<string, SemanticNode>();
  chosen.forEach((raw, i) => {
    const id = legalNodeId(raw.id, i);
    const ins = new Set<string>(), outs = new Set<string>();
    const files: string[] = [];
    const layers = new Map<string, number>(), status = new Map<string, number>();
    let apiCount = 0, resp = '';
    foldDetail(raw, fileIndex, files, ins, outs, layers, status, (r) => { if (!resp && r) resp = r; }, () => { apiCount += 1; });
    const dominant = (m: Map<string, number>) => { let k = ''; let c = 0; for (const [kk, vv] of m) if (vv > c) { c = vv; k = kk; } return k; };
    const layer = dominant(layers);
    const sem: SemanticNode = {
      id, label: moduleLabel(raw),
      role: raw.role ?? 'backend', type: roleToType(raw.role ?? 'backend'),
      files, pinsIn: [...ins], pinsOut: [...outs],
      ...(resp ? { sublabel: shortResp(resp) } : { sublabel: `${descCount(raw)} 节点${files.length ? ` · ${files.length} 文件` : ''}` }),
      ...(layer ? { tag: layer } : {}),
    };
    if (files.length && !resp) sem.sublabel = `${files.length} 个文件${apiCount ? ` · ${apiCount} 个 API` : ''}`;
    semNodes.push(sem);
    semByRaw.set(raw.id, sem);
  });

  // ③ 边：跨模块的真实 imports/flow/cross / fileIndex 依赖（当线看）
  const edges: SemanticEdge[] = [];
  const seen = new Set<string>();
  const addRaw = (f: string, t: string, data: string, kind: SemanticEdge['kind']) => {
    const a = semByRaw.get(f), b = semByRaw.get(t);
    if (!a || !b || a.id === b.id) return;
    const key = `${a.id}>${b.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: a.id, to: b.id, data: data === '顺序承接' ? '' : (data === 'imports' ? '' : data), kind });
  };
  // 3a：文件级 imports（kind flow 提升到所属模块，跨模块才保留）+ 显式 flow/cross
  const collectTree = (v: { nodes?: RawNode[]; edges?: REdge[] } | undefined) => {
    for (const e of v?.edges || []) {
      if (e.kind === 'contains' || (e.label === 'contains') || (e.label === 'imports' && /\s×\d/.test(e.label))) continue;
      const f = ownerOf.get(e.from), t = ownerOf.get(e.to);
      if (f && t && f !== t) addRaw(f, t, String(e.label || ''), e.kind === 'cross' ? 'async' : 'flow');
    }
    for (const n of v?.nodes || []) collectTree(n.children);
  };
  collectTree(rootView);
  // 3b：语义层实测依赖 actual_deps → 文件真实 import 边提升到模块（真实事实，优先于签名猜测）
  if (fileIndex) {
    for (const info of fileIndex.exact.values()) {
      const fromMod = ownerOf.get(info.id);
      if (!fromMod) continue;
      for (const dep of info.actual_deps || []) {
        const depInfo = fileIndex.exact.get(dep);
        const toMod = depInfo ? ownerOf.get(depInfo.id) : undefined;
        if (toMod && toMod !== fromMod) addRaw(fromMod, toMod, '', 'flow');
      }
    }
  }
  const hasReal = edges.some((e) => !e.data); // 有 real import 边（data 空 = 纯 import）
  // 3c：fileIndex 文件签名跨模块依赖（唯一产出者）——仅在无实际 import 事实时兜底
  if (fileIndex && !hasReal && !edges.length) {
    const feats = chosen.map((raw) => {
      const sem = semByRaw.get(raw.id)!;
      const pins = (x: string[]): TeachPin[] => x.map((nn) => ({ n: nn, t: 'string' } as TeachPin));
      return { id: sem.id, steps: [{ title: sem.label, detail: '', inputs: pins(sem.pinsIn), outputs: pins(sem.pinsOut) }] };
    });
    for (const e of deriveCrossFeatureFlow(feats)) addRaw(e.from, e.to, e.data || '', 'flow');
  }
  // 3d：无任何真实边时的身份相交兜底（不作为结构来源，仅 ARCHIF 图有内容时保留）
  if (!edges.length) {
    for (const a of semNodes) for (const b of semNodes) {
      if (a.id === b.id) continue;
      const shared = a.pinsOut.filter((s) => b.pinsIn.includes(s));
      if (shared.length) addRaw(a.id, b.id, shared[0], 'flow');
    }
  }

  const { mainPath, colOrder } = deriveMainPath(semNodes, edges);
  // 分组：节点 id → 顶层功能分区（顶层目录作边界分组）
  const groupOf = new Map<string, string>();
  if (fileIndex) {
    for (const n of semNodes) {
      // 从文件路径反推顶层分区：取第一个出现在文件路径里的顶层目录
      // 更准确：从 ownerOf 回溯到原始文件路径的顶层目录
      const top = n.files
        .map((f) => f.split('/')[0])
        .filter(Boolean)
        .sort((a, b) => (b.length - a.length) || a.localeCompare(b))[0];
      if (top) groupOf.set(n.id, top);
    }
  }
  return { id: String(root.id || 'project'), label: String(root.label || 'project'), nodes: semNodes, edges, mainPath, colOrder, groupOf: groupOf.size ? groupOf : undefined };
}

// ── 主节点选取：目录/模块优先，平铺文件夹按顶层目录聚合，>12 折叠 ──

function pickMain(nodes: RawNode[]): { chosen: RawNode[]; ownerOf: Map<string, string> } {
  let chosen = chooseModules(nodes);
  const ownerOf = new Map<string, string>();
  const chosenSet = new Set(chosen.map((n) => n.id));
  const rec = (n: RawNode | undefined, parentMain: string | null) => {
    if (!n) return;
    const isMain = chosenSet.has(n.id);
    ownerOf.set(n.id, isMain ? n.id : (parentMain ?? n.id));
    for (const c of n.children?.nodes || []) rec(c, isMain ? n.id : parentMain);
  };
  for (const n of nodes) rec(n, null);
  return { chosen, ownerOf };
}

/** 模块层选取：优先容器（有 children / type=module / dir_）；不足则往下探；仍平铺则按顶层目录聚合 */
function chooseModules(nodes: RawNode[]): RawNode[] {
  const isDirish = (n: RawNode) => (n.children?.nodes?.length ?? 0) >= 1 || n.type === 'module' || /^dir[_-]/.test(n.id ?? '');
  // 顶层是"功能分区"（其下还有二级目录）时，下钻到二级子系统层——这才是看得见结构的粒度；
  // 就近取文件/后代数最多的 ≤12 个子系统，顶层只作为边界分组（见 groupOf）。
  const top = nodes.filter(isDirish);
  if (top.length >= 1) {
    const subsystems: RawNode[] = [];
    for (const t of top) {
      const kids = t.children?.nodes || [];
      const subDirs = kids.filter(isDirish);
      if (subDirs.length >= 1) subsystems.push(...subDirs);
      else if (kids.length) subsystems.push(t); // 无二级目录的顶层叶子容器
    }
    if (subsystems.length >= 2) {
      return subsystems.sort((a, b) => countDescRaw(b) - countDescRaw(a)).slice(0, 12);
    }
  }
  const containers = nodes.filter(isDirish);
  if (containers.length >= 2 && containers.length <= 12) return containers;
  if (containers.length >= 2) return foldTo(containers);
  if (containers.length === 1 && containers[0].children?.nodes) {
    const sub = chooseModules(containers[0].children.nodes);
    if (sub.length >= 2) return sub;
  }
  // 平铺文件/散节点：按路径第一段聚合成目录模块，控制 ≤12
  const byTop = new Map<string, RawNode[]>();
  nodes.forEach((n) => {
    const key = topDir(n);
    if (!byTop.has(key)) byTop.set(key, []);
    byTop.get(key)!.push(n);
  });
  const entries = [...byTop.entries()];
  const groups = entries.map(([key, kids], idx) => ({
    id: legalNodeId(`mod_${sanitize(key)}_${idx}`, idx), label: key,
    role: 'service', children: { nodes: kids, edges: [] },
  }));
  if (nodes.length === 0) return [];
  return groups.length >= 2 ? (groups.length <= 12 ? groups : foldTo(groups)) : nodes.slice(0, 12);
}

function topDir(n: RawNode): string {
  const p = String(n.file || n.id || '');
  const base = p.replace(/^dir[_-]/, '').replace(/\.(ts|tsx|go|js|py)$/i, '');
  const seg = base.split('/')[0] || '核心';
  return seg;
}
function sanitize(s: string): string { return s.replace(/[^a-zA-Z0-9_-]/g, '_'); }
function moduleLabel(n: RawNode): string {
  if (n.label) return String(n.label).replace(/^📁\s*/, '');
  return n.file ? topDir(n) : String(n.id);
}
/** 职责摘要：取角色的短段（"/"后的多层路径第一节），12 字符内，适配官方组件 sublabel 宽限制 */
function shortResp(r: string): string {
  const c = r.replace(/\s*—.*$/, '').trim();
  // 优先取"入口层 · cmd/conveyor-validation"的短侧：若含" · "取后半路径首段
  if (c.includes(' · ')) {
    const seg = c.split(' · ').pop()?.split('/')[0] || c;
    return seg.length > 16 ? seg.slice(0, 15) + '…' : seg;
  }
  return c.length > 16 ? c.slice(0, 15) + '…' : c;
}
function descCount(n: RawNode): number { let c = 0; for (const ch of n.children?.nodes || []) { c += 1; c += descCount(ch); } return c; }
function countDescRaw(n: RawNode): number { let c = 0; for (const ch of n.children?.nodes || []) { c += 1; c += countDescRaw(ch); } return c; }

/** 折叠子树细节：职责/图层/状态/文件/API */
function foldDetail(
  raw: RawNode, fileIndex: FileIndex | undefined, files: string[], ins: Set<string>, outs: Set<string>,
  layers: Map<string, number>, status: Map<string, number>, onResp: (r: string) => void, onApi: () => void,
): void {
  const walk = (n: RawNode | undefined) => {
    if (!n) return;
    if (n.file && !files.includes(n.file)) {
      files.push(n.file);
      const info = fileIndex?.exact.get(n.file) || fileIndex?.bySuffix.get(n.file);
      if (info) {
        if (info.layer) layers.set(info.layer, (layers.get(info.layer) ?? 0) + 1);
        if (info.status) status.set(info.status, (status.get(info.status) ?? 0) + 1);
        if (info.responsibility) onResp(info.responsibility.replace(/\s*—.*$/, '').trim());
        onApi(); // 有文件即至少有模块/函数级 API 摘要
      }
      if (fileIndex) {
        const shape = projectFileDataShape(n.file, fileIndex, 6);
        if (shape) { for (const k of pinIdentityKeys(shape.inputs)) ins.add(k); for (const k of pinIdentityKeys(shape.outputs)) outs.add(k); }
      }
    }
    for (const s of n.pins?.in || []) { const t = (s || '').trim(); if (t && !GENERIC_T.test(t) && !GENERIC_T_ZH.test(t)) ins.add(t); }
    for (const s of n.pins?.out || []) { const t = (s || '').trim(); if (t && !GENERIC_T.test(t) && !GENERIC_T_ZH.test(t)) outs.add(t); }
    for (const c of n.children?.nodes || []) walk(c);
  };
  walk(raw);
}

/** 超过 12 → 确定性均匀折叠成 ≤12 合成节点 */
function foldTo(xs: RawNode[]): RawNode[] {
  const bucket = Math.ceil(xs.length / 12);
  const out: RawNode[] = [];
  for (let k = 0; k < xs.length; k += bucket) {
    const grp = xs.slice(k, k + bucket);
    if (grp.length <= 1) { out.push(grp[0]); continue; }
    const lead = grp[0].label || grp[0].id;
    out.push({ id: legalNodeId(`grp_${k}`, k), label: `${String(lead)}+`, role: 'service', children: { nodes: grp, edges: [] } });
  }
  return out;
}

// ── 主路径 + 拓扑列号（仅真实边；不造单链） ──

export function deriveMainPath(nodes: SemanticNode[], edges: SemanticEdge[]): { mainPath: string[]; colOrder: Map<string, number> } {
  const outAdj = new Map<string, string[]>(), inDeg = new Map<string, number>();
  nodes.forEach((n) => { outAdj.set(n.id, []); inDeg.set(n.id, 0); });
  for (const e of edges) {
    if (!outAdj.has(e.from) || !outAdj.has(e.to) || e.from === e.to) continue;
    outAdj.get(e.from)!.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const queue = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  const order: string[] = []; const deg = new Map(inDeg); const queued = new Set(queue);
  while (queue.length) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of outAdj.get(u) || []) {
      deg.set(v, (deg.get(v) ?? 0) - 1);
      if ((deg.get(v) ?? 0) <= 0 && !queued.has(v)) { queue.push(v); queued.add(v); }
    }
    if (!queue.length && queued.size < nodes.length) {
      const rest = nodes.find((n) => !queued.has(n.id));
      if (rest) { queue.push(rest.id); queued.add(rest.id); }
    }
  }
  const colOrder = new Map<string, number>();
  order.forEach((id, i) => colOrder.set(id, i));
  // 仅真实依赖边的 DAG 最长路径；无真实边则留空（不造单链，sequence/lifecycle 诚实不适配）
  let best: string[] = [];
  const on = new Set<string>();
  const dfs = (u: string, path: string[]) => {
    if (path.length > best.length) best = [...path];
    for (const v of outAdj.get(u) || []) { if (on.has(v)) continue; on.add(v); dfs(v, [...path, v]); on.delete(v); }
  };
  for (const id of order) { on.add(id); dfs(id, [id]); on.delete(id); }
  return { mainPath: best, colOrder };
}