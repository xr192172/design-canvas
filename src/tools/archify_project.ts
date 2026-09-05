/**
 * archify_project —— 编辑 IR 树 ↔ Archify 数据层契约的适配 + 语义令牌（只读，非投影）
 *
 * 定位：Archify 已作为内置能力接入（见 archify_pipeline/archify_semantics/archify_mappers），
 * 本模块只保留输入契约与适配，不承载任何自造布局/投影：
 *   - ArchifyTreeNode/ArchifyTreeEdge：Archify 面对编辑 IR 树的宽松数据层契约形状；
 *   - adaptIRTree：把前端 workbench 的编辑真源（IRView/IRNode 渲染形状）显式归一化成契约形状，
 *     只搬运投影原料字段（id/label/role/type/sublabel/tag/file/pins），剥离渲染字段、绝不写回；
 *   - ROLE_TYPE / roleToType / ARCHIFY_TYPE_COLOR / ARCHIFY_COLOR_TOKEN：Archify 视觉令牌，
 *     映射确定性、可测。
 */

// ── ① Archify 面对编辑 IR 树的输入契约（数据层宽松形状） ──

export interface ArchifyTreeNode {
  id: string;
  label: string;
  role?: string;
  type?: string;
  sublabel?: string;
  tag?: string;
  file?: string;
  /** 步骤/文件的数据形态（编辑 IR 的 pins 契约投影：吃什么/吐什么）——依赖推导原料 */
  pins?: { in?: string[]; out?: string[] };
  children?: { nodes?: ArchifyTreeNode[]; edges?: ArchifyTreeEdge[] };
}
export interface ArchifyTreeEdge {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: string;
}

// ── ② 适配：编辑 IR 树（IRView/IRNode 渲染形状）→ ArchifyTreeNode（数据层契约形状） ──
// 前端 workbench 的编辑真源是 IRView/IRNode：根视图顶层挂 nodes/edges、节点带
// x/y/w/h/panel/statusText/layer/status 等渲染语义字段，children 是 IRView（可递归）。
// 本适配层显式归一化：IRView 是渲染容器，适配时只取其承载的 nodes/edges 落到节点的
// children 上；IRNode 只搬运契约字段，渲染/编辑字段一律剥离。纯函数、不突变输入；
// id/label 保持原样（身份双射不漂移）。往返由"真源不变"保证（投影绝不写回）。
export function adaptIRTree(input: unknown): ArchifyTreeNode {
  const v = (input ?? {}) as {
    id?: string; label?: string; nodes?: unknown[]; edges?: unknown[];
    role?: string; type?: string; sublabel?: string; tag?: string; file?: string;
    pins?: { in?: string[]; out?: string[] }; children?: unknown;
  };
  const id = String(v.id ?? 'view');
  const label = String(v.label ?? id);
  if (Array.isArray(v.nodes)) {
    return { id, label, children: { nodes: v.nodes.map((n) => adaptIRTree(n)), edges: (v.edges ?? []).map(adaptIREdge) } };
  }
  const node: ArchifyTreeNode = { id, label };
  if (v.role) node.role = String(v.role);
  if (v.type) node.type = String(v.type);
  if (v.sublabel) node.sublabel = String(v.sublabel);
  if (v.tag) node.tag = String(v.tag);
  if (v.file) node.file = String(v.file);
  const hasIn = !!v.pins?.in?.length;
  const hasOut = !!v.pins?.out?.length;
  if (hasIn || hasOut) {
    node.pins = {
      ...(hasIn ? { in: v.pins!.in! } : {}),
      ...(hasOut ? { out: v.pins!.out! } : {}),
    };
  }
  if (v.children) {
    const view = v.children as { nodes?: unknown[]; edges?: unknown[] };
    if (Array.isArray(view.nodes)) {
      node.children = {
        nodes: view.nodes.map((n) => adaptIRTree(n)),
        edges: (view.edges ?? []).map(adaptIREdge),
      };
    }
  }
  return node;
}
/** IREdge（kind: flow|contains|cross + stroke/dash/active/light 渲染字段）→ ArchifyTreeEdge（只留投影原料） */
function adaptIREdge(input: unknown): ArchifyTreeEdge {
  const e = (input ?? {}) as { id?: string; from?: string; to?: string; label?: string; kind?: string };
  const edge: ArchifyTreeEdge = { from: String(e.from ?? ''), to: String(e.to ?? '') };
  if (e.id) edge.id = String(e.id);
  if (e.label) edge.label = String(e.label);
  if (e.kind) edge.kind = String(e.kind);
  return edge;
}

// ── ③ Archify 视觉令牌（DESIGN.md 角色 → 缺省 type；"视觉语言用 Archify 这一套"） ──

const ROLE_TYPE: Record<string, string> = {
  client: 'external', human: 'external', user: 'external', external: 'external',
  entry: 'external', endpoint: 'backend', controller: 'backend', service: 'backend',
  stage: 'backend', actor: 'backend', worker: 'backend', gateway: 'backend', core: 'backend',
  frontend: 'frontend', renderer: 'frontend', ui: 'frontend',
  data: 'database', port: 'database', storage: 'database', contract: 'database', registry: 'database',
  queue: 'messagebus', messagebus: 'messagebus',
  auth: 'security', security: 'security',
  cloud: 'cloud', infra: 'cloud',
};
/** Archify 各 type 的展示色（DESIGN.md colors）——视觉语言统一走这一套 */
export const ARCHIFY_TYPE_COLOR: Record<string, string> = {
  frontend: '#22D3EE', backend: '#34D399', database: '#A78BFA', cloud: '#FBBF24',
  security: '#FB7185', messagebus: '#FB923C', external: '#94A3B8',
};
export const ARCHIFY_COLOR_TOKEN = { canvas: '#020617', mask: '#0F172A', ink: '#FFFFFF', muted: '#94A3B8', border: '#1E293B' };

export function roleToType(role: string): string {
  return ROLE_TYPE[role] ?? 'backend';
}