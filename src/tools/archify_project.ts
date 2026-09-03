/**
 * archify_project —— IR 视模型 ↔ Archify IR 的投影契约（演示模式用 Archify 渲染）
 *
 * 定位（与 dsl-workbench 的分工）：
 *   - 唯一作者真源 = workbench 编辑 IR（字段：pins/shapes/runtime/gaps/panel/status/layer/
 *     file/children + 边的 kind/active/light）。编辑永远只写它。
 *   - 演示模式 = 把当前真源【投影】成 Archify IR（components/boundaries/connections/cards/views）。
 *     Archify 是派生、只读、不落盘为真源。
 *   - 视觉语言：沿用 Archify DESIGN 色彩令牌（frontend/backend/database/cloud/security/
 *     messagebus/external），映射确定性、可测。
 *
 * 契约（往返测试锚定，见 tests/tools/archify_project.test.ts）：
 *   - 不可逆改：toArchify 绝不 mutation 输入；编辑字段(pins/runtime/gaps/panel…)只存在于
 *     真源，投影不写回 → 演示→再编辑天然无损（真源没被碰过）。
 *   - 身份双射：IRView 节点/边 id 与 Archify components/connections id 一一对应、稳定可逆；
 *     fromArchify 能还原同一 id 集（供"退出演示重新进入编辑器"）。
 *   - 保真结构：label 原样；role 无常映射到 Archify type（确定性）。
 */

// ── ① 编辑真源的最小可投影子集（对齐 dsl-workbench ir/types.ts 的 IRView/IRNode/IREdge） ──

/** 编辑态"必须保留"的字段（真源全量；Archify 投影只读这些、绝不改它们） */
export interface ProjNode {
  id: string;
  label: string;
  /** 归一化角色（stage/actor/port/container…）——真源的编辑语义 */
  role: string;
  /** 原始 type（保留兜底） */
  type: string;
  /** 只读投影采纳：sublabel / tag */
  sublabel?: string;
  tag?: string;
  // —— 以下为编辑语义，投影不读不写（演示态不表达），往返由"真源不变"保证 ——
  layer?: string;
  status?: string;
  pins?: { in?: string[]; out?: string[] };
  runtime?: { trace?: unknown[] };
}
export interface ProjEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  kind: 'flow' | 'contains' | 'cross'; // flow→连线；cross→虚线；contains→边界（v1 跳过）
  active?: boolean;
  light?: boolean;
}
export interface ProjView {
  id: string;
  label: string;
  title: string;
  nodes: ProjNode[];
  edges: ProjEdge[];
}

// ── ② Archify IR（演示目标） ──

export interface ArchifyComponent { id: string; type: string; label: string; sublabel?: string; pos: [number, number]; size: [number, number]; tag?: string }
export interface ArchifyConnection { id: string; from: string; to: string; label?: string; variant?: 'dashed' | 'emphasis' | 'security' }
export interface ArchifyBoundary { kind: 'region' | 'security-group'; label: string; wraps: string[] }
export interface ArchifyCard { dot: string; title: string; items: string[] }
export interface ArchifyViewDef { id: string; label: string; focus: string[]; note: string }
export interface ArchifyIR {
  schema_version: 1;
  diagram_type: 'architecture';
  meta: { title: string; output: string; quality_profile: 'standard' | 'showcase'; views: ArchifyViewDef[] };
  components: ArchifyComponent[];
  boundaries: ArchifyBoundary[];
  connections: ArchifyConnection[];
  cards: ArchifyCard[];
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

// ── ④ 投影：IRView → Archify（派生只读；不突变输入） ──

const TYPE_COLUMN: Record<string, number> = {
  external: 40, frontend: 300, backend: 560, database: 820, cloud: 1080, security: 1080, messagebus: 820,
};

export function toArchify(view: ProjView, opts?: { quality?: 'standard' | 'showcase'; showLabelOnEdge?: boolean }): ArchifyIR {
  const q = opts?.quality ?? 'standard';
  const components: ArchifyComponent[] = [];
  const layers: Record<string, number> = {};
  for (const n of view.nodes) {
    const type = roleToType(n.role);
    const x = TYPE_COLUMN[type] ?? 400;
    const row = (layers[x] ?? 0);
    layers[x] = row + 1;
    components.push({
      id: n.id,
      type,
      label: n.label,
      sublabel: n.sublabel,
      pos: [x, 80 + (row % 3) * 220],
      size: [150, 60],
      ...(n.tag ? { tag: n.tag } : {}),
    });
  }
  const connections: ArchifyConnection[] = [];
  for (const e of view.edges) {
    if (e.kind === 'contains') continue; // 层级 v1 不入线（未来映射为 boundaries）
    connections.push({
      id: e.id,
      from: e.from,
      to: e.to,
      label: e.label,
      ...(e.kind === 'cross' ? { variant: 'dashed' as const } : {}),
    });
  }
  const focusAll = view.nodes.map((n) => n.id);
  const boundaries: ArchifyBoundary[] = [
    { kind: 'region', label: view.label, wraps: focusAll },
  ];
  const cards: ArchifyCard[] = [
    { dot: 'cyan', title: '入口', items: [] },
    { dot: 'emerald', title: '核心', items: [`${view.nodes.length} 节点 · ${connections.length} 关系（演示投影）`] },
  ];
  const views: ArchifyViewDef[] = [
    { id: 'all', label: '全貌', focus: focusAll, note: '演示模式的 Archify 拓扑' },
  ];
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: view.title, output: `${view.id}-archify.html`, quality_profile: q, views },
    components,
    boundaries,
    connections,
    cards,
  };
}

// ── ⑤ 逆向：Archify → 最小 IR（供"退出演示重进编辑器"还原 id 集；编辑字段由真源保存） ──

export interface RecoveredView { id: string; nodes: { id: string; label: string; role: string }[]; edges: { id: string; from: string; to: string }[] }

export function fromArchify(ar: ArchifyIR): RecoveredView {
  const idByType: Record<string, string> = {};
  for (const c of ar.components) idByType[c.type] = c.id; // v1 仅用于反向锚定（不强求）
  return {
    id: ar.meta.title,
    nodes: ar.components.map((c) => ({ id: c.id, label: c.label, role: c.type })),
    edges: ar.connections.map((c) => ({ id: c.id, from: c.from, to: c.to })),
  };
}

/** 判断投影是否会触碰编辑字段：toArchify 只读 id/label/role/sublabel/tag——断言它不读也不
 *  需要 pins/runtime 等。此纯函数供契约测试校验"投影不表达≠会丢"的边界说明。 */
export function projectableFields(): string[] {
  return ['id', 'label', 'role', 'type', 'sublabel', 'tag'];
}