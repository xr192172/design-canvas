/**
 * render_sandbox_canvas —— 画布沙盘（在 mock「DSL 协作工作台」HTML 上改的真数据版）
 *
 * 用户定调（2026-08-25）：最终形态演进到 `DSL 协作工作台.zip` 的样式。该 mock 是
 * "高完成度拼凑"——视觉皮肤（CSS 变量/节点卡/连线/小地图/悬窗）精致，但数据写死、
 * 节点坐标绝对定位硬编码、连线是手工描的贝塞尔常量，**没有任何运算逻辑**。
 *
 * 本模块的改法：壳照抄 mock（--dslw-* 变量/节点结构/动画），芯整个换真：
 *   - 数据：brickify 簇 + cluster_narrator 人话（title/desc/角色/内聚度）
 *   - 布局（mock 没有）：SCC 缩点 + 最长路径分层——被依赖的底层在左，消费者在右，
 *     同层垂直堆叠；环内节点（互相调用的死结）塌缩为同层如实呈现
 *   - 连线（mock 没有）：程序从节点几何生成三次贝塞尔 path（右缘中点→左缘中点，
 *     控制点水平外伸），线宽∝调用量，top 边走 active 深色快速流动
 *   - 图标：lucide SVG path 内联（自包含，无 CDN）
 *   - 交互：节点点击→右侧详情悬窗（文件清单+角色）；缩放（按钮+滚轮）；
 *     空白拖拽平移；小地图视口同步+点击定位
 *
 * 忠实纪律：节点状态点/徽章只映射确定性事实——
 *   ok绿=正常 · warn橙=整层耦合(重构信号) · gray=待翻译(rule 降级)；
 *   徽章色=三层角色（功能绿/契约蓝/胶水灰）。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult, BrickifyBrick, BrickSubCluster } from './brickify.js';
import { roleOfFile } from './brickify.js';
import type { ClusterNarratives } from './cluster_narrator.js';

// ─────────────────────────────────────────────────────────────
// 布局（mock 没有的"运算逻辑"）
// ─────────────────────────────────────────────────────────────

export interface CanvasNode {
  id: string;
  brick: string;
  title: string;
  desc: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 分层列（0=最左/最底层） */
  level: number;
  status: 'ok' | 'warn' | 'gray';
  role: 'brick' | 'contract' | 'glue';
  files: number;
  cohesion: number;
  icon: string;
}

export interface CanvasEdge {
  from: string;
  to: string;
  count: number;
  /** 调用量 top 档 → 深色快速流动 */
  active: boolean;
}

export interface CanvasLayout {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  width: number;
  height: number;
}

const NODE_W = 180;
const NODE_H = 118;
const GAP_X = 90;
const GAP_Y = 26;
const PAD = 40;

/** Tarjan 强连通分量：返回每个节点所属分量 id（环塌缩成同层）。 */
function sccOf(ids: string[], adj: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const comp = new Map<string, number>();
  let counter = 0;
  let compId = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      while (true) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.set(w, compId);
        if (w === v) break;
      }
      compId++;
    }
  };
  for (const v of ids) if (!index.has(v)) strongconnect(v);
  return comp;
}

/** 真实布局：SCC 缩点 → DAG 最长路径分层（被依赖在左）→ 列内垂直堆叠。 */
export function layoutCanvas(
  r: BrickifyResult,
  edges: CanvasEdge[],
  narratives?: ClusterNarratives,
): CanvasLayout {
  // 收集簇 + 出入边
  const clusters: Array<{ s: BrickSubCluster; b: BrickifyBrick }> = [];
  for (const b of r.bricks) for (const s of b.sub_clusters) clusters.push({ s, b });
  const ids = clusters.map((c) => c.s.id);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  // SCC 缩点（环塌缩）
  const comp = sccOf(ids, adj);
  // 分量间最长路径：level(c) = 0（无入边的分量）或 max(level(前驱))+1
  const compAdj = new Map<number, Set<number>>();
  const compIn = new Map<number, number>();
  for (const e of edges) {
    const a = comp.get(e.from)!;
    const b = comp.get(e.to)!;
    if (a === b) continue;
    if (!compAdj.has(a)) compAdj.set(a, new Set());
    compAdj.get(a)!.add(b);
  }
  for (const set of compAdj.values()) for (const b of set) compIn.set(b, (compIn.get(b) ?? 0) + 1);
  const compLevel = new Map<number, number>();
  const queue: number[] = [];
  for (const c of new Set(comp.values())) {
    if (!compIn.has(c)) {
      compLevel.set(c, 0);
      queue.push(c);
    }
  }
  while (queue.length > 0) {
    const a = queue.shift()!;
    for (const b of compAdj.get(a) ?? []) {
      compLevel.set(b, Math.max(compLevel.get(b) ?? 0, (compLevel.get(a) ?? 0) + 1));
      compIn.set(b, (compIn.get(b) ?? 1) - 1);
      if (compIn.get(b) === 0) queue.push(b);
    }
  }
  // 环分量（未触达）兜底为 0 层
  for (const c of new Set(comp.values())) if (!compLevel.has(c)) compLevel.set(c, 0);

  // 节点定位：列 = 分量层级，行 = 列内序（大簇靠上）
  const byLevel = new Map<number, typeof clusters>();
  for (const c of clusters) {
    const lv = compLevel.get(comp.get(c.s.id)!) ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv)!.push(c);
  }
  const maxCount = Math.max(1, ...edges.map((e) => e.count));
  const topEdges = new Set(
    [...edges].sort((a, b) => b.count - a.count).slice(0, Math.min(8, edges.length)).map((e) => `${e.from}\u0001${e.to}`),
  );

  const nodes: CanvasNode[] = [];
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const lv of levels) {
    const list = byLevel.get(lv)!.sort((a, b) => b.s.files.length - a.s.files.length || (a.s.id < b.s.id ? -1 : 1));
    list.forEach((c, i) => {
      const n = narratives?.clusters[c.s.id];
      nodes.push({
        id: c.s.id,
        brick: c.b.id,
        title: n?.title ?? c.s.id,
        desc: n?.desc ?? '',
        x: PAD + lv * (NODE_W + GAP_X),
        y: PAD + i * (NODE_H + GAP_Y),
        w: NODE_W,
        h: NODE_H,
        level: lv,
        status:
          c.s.degenerate && c.s.files.length > 1 ? 'warn' : n?.mode === 'llm' ? 'ok' : 'gray',
        role: c.s.role,
        files: c.s.files.length,
        cohesion: Math.round(c.s.cohesion * 100),
        icon: iconOf(c.b.id, c.s.role),
      });
    });
  }
  const layoutEdges: CanvasEdge[] = edges.map((e) => ({
    ...e,
    active: topEdges.has(`${e.from}\u0001${e.to}`) && e.count >= maxCount * 0.25,
  }));
  const width = PAD * 2 + Math.max(...levels.map((l) => l + 1)) * (NODE_W + GAP_X) - GAP_X;
  const height = PAD * 2 + Math.max(...levels.map((l) => byLevel.get(l)!.length)) * (NODE_H + GAP_Y) - GAP_Y;
  return { nodes, edges: layoutEdges, width, height };
}

/** 积木→图标（lucide path 内联）；未知积木按三层角色兜底。 */
function iconOf(brickId: string, role: 'brick' | 'contract' | 'glue'): string {
  const MAP: Record<string, string> = {
    observe: 'observe',
    daemon: 'server',
    db: 'database',
    dsl: 'code',
    renderer: 'layers',
    root: 'package',
    tools: 'wrench',
  };
  if (MAP[brickId]) return MAP[brickId];
  return role === 'contract' ? 'code' : role === 'glue' ? 'workflow' : 'box';
}

/** lucide 单 path 图标库（24x24 viewBox，stroke=currentColor）。 */
const ICONS: Record<string, string> = {
  observe: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  workflow: '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
};

function iconSvg(name: string): string {
  const body = ICONS[name] ?? ICONS.box;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

/** 簇级依赖边 → 画布边（换向：file_deps 是"from imports to"即消费者→提供者；
 *  画布走 mock 的数据流视觉——提供者在左，箭头向右流向消费者）。 */
function canvasEdges(r: BrickifyResult): CanvasEdge[] {
  const fileToCluster = new Map<string, string>();
  for (const b of r.bricks) for (const s of b.sub_clusters) for (const f of s.files) fileToCluster.set(f, s.id);
  const acc = new Map<string, number>();
  for (const d of r.file_deps) {
    const consumer = fileToCluster.get(d.from);
    const provider = fileToCluster.get(d.to);
    if (!consumer || !provider || consumer === provider) continue;
    const k = `${provider}\u0001${consumer}`;
    acc.set(k, (acc.get(k) ?? 0) + d.count);
  }
  const edges: CanvasEdge[] = [];
  for (const [k, count] of acc) {
    const i = k.indexOf('\u0001');
    edges.push({ from: k.slice(0, i), to: k.slice(i + 1), count, active: false });
  }
  return edges.sort((x, y) => y.count - x.count);
}

const STATUS_TXT: Record<string, string> = { ok: '正常', warn: '整层耦合', gray: '待解读' };
const ROLE_BADGE: Record<string, string> = {
  brick: 'dslw-badge-ok',
  contract: 'dslw-badge-info',
  glue: 'dslw-badge-gray',
};
const ROLE_TXT: Record<string, string> = { brick: '功能', contract: '契约', glue: '胶水' };

export function renderSandboxCanvasHtml(
  r: BrickifyResult,
  narratives?: ClusterNarratives,
): string {
  const projectName = path.basename(r.meta.project_dir);
  const edges = canvasEdges(r);
  const layout = layoutCanvas(r, edges, narratives);
  const ov = narratives?.overview;

  // 节点 DOM（mock 的 .dslw-node 结构照抄，位置来自布局运算）
  const nodesHtml = layout.nodes
    .map(
      (n) => `<div class="dslw-node" data-id="${esc(n.id)}" style="top:${n.y}px;left:${n.x}px;">
  <div class="dslw-node-status">
    <span class="dslw-status-dot ${n.status}"></span>
    <span class="dslw-status-text ${n.status}">${STATUS_TXT[n.status]}</span>
    <span class="dslw-status-text gray" style="margin-left:auto;">${n.files} 文件 · 内聚 ${n.cohesion}%</span>
  </div>
  <div class="dslw-node-title-row">
    <div class="dslw-node-icon">${iconSvg(n.icon)}</div>
    <div class="dslw-node-name">${esc(n.title)}</div>
  </div>
  <div class="dslw-node-desc">${esc(n.desc.slice(0, 52))}${n.desc.length > 52 ? '…' : ''}</div>
  <div class="dslw-node-footer">
    <span class="dslw-badge ${ROLE_BADGE[n.role]}">${ROLE_TXT[n.role]}</span>
    <span style="color:var(--dslw-muted-foreground);margin-left:auto;font-family:ui-monospace,monospace;font-size:10px;">${esc(n.brick)}/</span>
  </div>
</div>`,
    )
    .join('\n');

  // 连线 path：右缘中点 → 左缘中点，三次贝塞尔（mock 的视觉语法，坐标程序生成）
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const pathsHtml = layout.edges
    .map((e) => {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const bend = Math.max(40, Math.abs(x2 - x1) * 0.4);
      const w = e.count > 0 ? Math.min(4.5, 1.4 + (e.count / Math.max(...layout.edges.map((x) => x.count))) * 3) : 1.4;
      return `<path class="${e.active ? 'active flow-active' : 'flow'}" style="stroke-width:${w.toFixed(1)}" d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" marker-end="url(#${e.active ? 'dslw-arrow-active' : 'dslw-arrow'})"><title>${esc(e.to)} 调用 ${esc(e.from)} · ${e.count} 次</title></path>`;
    })
    .join('\n');

  // 小地图节点点
  const mmNodes = layout.nodes
    .map((n) => {
      const color = n.status === 'warn' ? 'var(--dslw-warning)' : n.status === 'gray' ? 'var(--dslw-chart-2)' : 'var(--dslw-success)';
      return `<div class="mm-node" data-id="${esc(n.id)}" style="left:${((n.x / layout.width) * 100).toFixed(1)}%;top:${((n.y / layout.height) * 100).toFixed(1)}%;background:${color}"></div>`;
    })
    .join('');

  // 详情悬窗数据（与 cluster_workbench 同构）
  const detail = r.bricks.flatMap((b) =>
    b.sub_clusters.map((s) => ({
      id: s.id,
      brick: b.id,
      title: narratives?.clusters[s.id]?.title ?? s.id,
      desc: narratives?.clusters[s.id]?.desc ?? '',
      facts: `${s.files.length} 文件 · 内聚 ${Math.round(s.cohesion * 100)}% · 角色 ${ROLE_TXT[s.role]}${s.degenerate && s.files.length > 1 ? ' · 整层耦合' : ''}`,
      files: s.files.map((f) => ({ path: f, role: roleOfFile(f) })),
    })),
  );

  const narMeta = narratives
    ? `LLM 解读 ${narratives.meta.llm_ok}/${narratives.meta.total}`
    : '未启用解读层';
  const ovDesc = ov?.desc ?? '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>沙盘 · ${esc(projectName)}</title>
<style>
:root{--dslw-background:#fafafa;--dslw-foreground:#0a0a0a;--dslw-card:#fff;--dslw-muted:#f5f5f5;--dslw-muted-foreground:#71717a;--dslw-border:#e4e4e7;--dslw-border-strong:#d4d4d8;--dslw-primary:#111827;--dslw-success:#16a34a;--dslw-success-text:#15803d;--dslw-warning:#d97706;--dslw-warning-text:#b45309;--dslw-info:#2563eb;--dslw-info-text:#1d4ed8;--dslw-radius:.625rem;--dslw-radius-sm:.375rem;--dslw-shadow-xs:0 1px 2px rgba(0,0,0,.04);--dslw-shadow-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--dslw-shadow:0 4px 6px -1px rgba(0,0,0,.06),0 2px 4px -2px rgba(0,0,0,.04);--dslw-canvas-bg:#f8f8f8;--dslw-canvas-grid:#ececee;--dslw-node-bg:#fff;--dslw-node-border:#d4d4d8;--dslw-node-selected:#111827;--dslw-connection:#a1a1aa;--dslw-connection-active:#111827}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--dslw-foreground);background:var(--dslw-background);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;gap:14px;padding:10px 18px;background:var(--dslw-card);border-bottom:1px solid var(--dslw-border);flex-shrink:0}
header h1{font-size:14px;margin:0;font-weight:650}
header .ov-title{font-size:14px;font-weight:700}
header .meta{font-size:11.5px;color:var(--dslw-muted-foreground)}
header .ov-desc{font-size:11.5px;color:var(--dslw-muted-foreground);max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{flex:1;position:relative;overflow:hidden;background:var(--dslw-canvas-bg);background-image:radial-gradient(var(--dslw-canvas-grid) 1px,transparent 1px);background-size:22px 22px;cursor:grab}
main.panning{cursor:grabbing}
.dslw-canvas-inner{position:absolute;top:0;left:0;transform-origin:0 0;width:${layout.width}px;height:${layout.height}px}
.dslw-connections{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible}
.dslw-connections path{fill:none;stroke:var(--dslw-connection);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.dslw-connections path.active{stroke:var(--dslw-connection-active);stroke-width:2.5}
.dslw-connections path.flow{stroke-dasharray:6 8;animation:dslw-flow 3s linear infinite}
.dslw-connections path.flow-active{stroke-dasharray:6 8;animation:dslw-flow 1.6s linear infinite}
@keyframes dslw-flow{to{stroke-dashoffset:-28}}
.dslw-node{position:absolute;width:${NODE_W}px;background:var(--dslw-node-bg);border:1.5px solid var(--dslw-node-border);border-radius:var(--dslw-radius);padding:12px 14px;box-shadow:var(--dslw-shadow-sm);z-index:2;transition:box-shadow .2s,border-color .2s;cursor:pointer}
.dslw-node:hover{box-shadow:var(--dslw-shadow);border-color:var(--dslw-border-strong)}
.dslw-node.selected{border-color:var(--dslw-node-selected);border-width:2px;box-shadow:0 0 0 3px rgba(17,24,39,.1),var(--dslw-shadow);transform:scale(1.02);z-index:5}
.dslw-node-status{display:flex;align-items:center;gap:5px;font-size:11px;margin-bottom:7px}
.dslw-status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.dslw-status-dot.ok{background:var(--dslw-success)}
.dslw-status-dot.warn{background:var(--dslw-warning)}
.dslw-status-dot.gray{background:var(--dslw-chart-2,#a1a1aa)}
.dslw-status-text{font-weight:500}
.dslw-status-text.ok{color:var(--dslw-success-text)}
.dslw-status-text.warn{color:var(--dslw-warning-text)}
.dslw-status-text.gray{color:var(--dslw-muted-foreground)}
.dslw-node-title-row{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.dslw-node-icon{width:26px;height:26px;border-radius:6px;background:var(--dslw-muted);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--dslw-foreground)}
.dslw-node.selected .dslw-node-icon{background:#fff7ed;color:var(--dslw-warning-text)}
.dslw-node-name{font-size:13px;font-weight:600;line-height:1.2}
.dslw-node-desc{font-size:11px;color:var(--dslw-muted-foreground);line-height:1.5;margin-bottom:8px;min-height:32px}
.dslw-node-footer{display:flex;align-items:center;font-size:11px}
.dslw-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:10px;font-size:10.5px;font-weight:500;line-height:1}
.dslw-badge-ok{background:#f0fdf4;color:var(--dslw-success-text)}
.dslw-badge-warn{background:#fffbeb;color:var(--dslw-warning-text)}
.dslw-badge-info{background:#eff6ff;color:var(--dslw-info-text)}
.dslw-badge-gray{background:var(--dslw-muted);color:var(--dslw-muted-foreground)}
.dslw-minimap-wrap{position:absolute;bottom:16px;left:16px;z-index:10;display:flex;flex-direction:column;gap:8px}
.dslw-minimap{width:150px;height:100px;background:#fff;border:1px solid var(--dslw-border);border-radius:var(--dslw-radius-sm);box-shadow:var(--dslw-shadow-xs);position:relative;overflow:hidden;cursor:pointer}
.dslw-minimap .mm-node{position:absolute;width:8px;height:6px;border-radius:1.5px}
.dslw-minimap .mm-viewport{position:absolute;border:1.5px solid var(--dslw-primary);background:rgba(17,24,39,.06);border-radius:2px}
.dslw-legend{display:flex;gap:10px;font-size:11px;color:var(--dslw-muted-foreground);background:#fff;padding:6px 10px;border-radius:var(--dslw-radius-sm);border:1px solid var(--dslw-border);box-shadow:var(--dslw-shadow-xs);width:fit-content;flex-wrap:wrap;max-width:220px}
.dslw-legend-item{display:flex;align-items:center;gap:4px}
.dslw-legend-dot{width:7px;height:7px;border-radius:50%}
.dslw-canvas-ctrls{position:absolute;bottom:16px;right:16px;z-index:10;display:flex;flex-direction:column;gap:6px}
.dslw-canvas-ctrl{width:32px;height:32px;background:#fff;border:1px solid var(--dslw-border);border-radius:var(--dslw-radius-sm);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--dslw-shadow-xs);color:var(--dslw-foreground);transition:background .15s;font-size:13px;font-weight:600}
.dslw-canvas-ctrl:hover{background:var(--dslw-muted)}
.dslw-zoom-val{font-size:10px;color:var(--dslw-muted-foreground);text-align:center;background:#fff;border:1px solid var(--dslw-border);border-radius:4px;padding:1px 0;box-shadow:var(--dslw-shadow-xs)}
.dslw-panel{position:fixed;top:0;right:-420px;width:400px;height:100vh;background:#fff;border-left:1px solid var(--dslw-border);box-shadow:-8px 0 24px rgba(0,0,0,.08);transition:right .18s ease;z-index:50;display:flex;flex-direction:column}
.dslw-panel.open{right:0}
.panel-head{padding:16px 18px 12px;border-bottom:1px solid var(--dslw-border)}
.panel-title{font-size:15px;font-weight:650}
.panel-desc{font-size:12.5px;color:#3f3f46;margin-top:6px;line-height:1.6}
.panel-facts{font-size:11.5px;color:var(--dslw-muted-foreground);margin-top:6px}
.panel-body{flex:1;overflow-y:auto;padding:12px 18px}
.f-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:8px;font-size:12px;margin-bottom:2px}
.f-row:hover{background:var(--dslw-muted)}
.f-path{font-family:ui-monospace,'Cascadia Code',monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f-role{margin-left:auto;flex-shrink:0}
.panel-close{position:absolute;top:10px;right:12px;font-size:18px;color:var(--dslw-muted-foreground);cursor:pointer;background:none;border:none;line-height:1}
.panel-close:hover{color:var(--dslw-foreground)}
</style>
</head>
<body>
<header>
  <h1>沙盘 ·</h1>
  <span class="ov-title">${esc(ov?.title ?? projectName)}</span>
  <span class="meta">${esc(projectName)} · ${r.meta.scanned_files} 文件 · ${r.bricks.length} 积木 · ${layout.nodes.length} 功能簇 · ${narMeta}</span>
  <span class="ov-desc" title="${esc(ovDesc)}">${esc(ovDesc)}</span>
</header>
<main id="main">
  <div class="dslw-canvas-inner" id="inner">
    <svg class="dslw-connections" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="dslw-arrow" class="arrowhead" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--dslw-connection)"/></marker>
        <marker id="dslw-arrow-active" class="arrowhead-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--dslw-connection-active)"/></marker>
      </defs>
      ${pathsHtml}
    </svg>
    ${nodesHtml}
  </div>
  <div class="dslw-minimap-wrap">
    <div class="dslw-minimap" id="minimap">
      ${mmNodes}
      <div class="mm-viewport" id="mmvp"></div>
    </div>
    <div class="dslw-legend">
      <span class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-success)"></span>正常</span>
      <span class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-warning)"></span>整层耦合</span>
      <span class="dslw-legend-item"><span class="dslw-legend-dot" style="background:var(--dslw-chart-2,#a1a1aa)"></span>待解读</span>
      <span class="dslw-legend-item" style="color:var(--dslw-connection-active);font-weight:600">━ 热线(高频调用)</span>
    </div>
  </div>
  <div class="dslw-canvas-ctrls">
    <button class="dslw-canvas-ctrl" id="zin" title="放大">+</button>
    <div class="dslw-zoom-val" id="zval">100%</div>
    <button class="dslw-canvas-ctrl" id="zout" title="缩小">−</button>
    <button class="dslw-canvas-ctrl" id="zfit" title="适应画布" style="font-size:11px">⤢</button>
  </div>
</main>
<aside class="dslw-panel" id="panel">
  <button class="panel-close" id="pclose">×</button>
  <div class="panel-head">
    <div class="panel-title" id="ptitle"></div>
    <div class="panel-desc" id="pdesc"></div>
    <div class="panel-facts" id="pfacts"></div>
  </div>
  <div class="panel-body" id="pbody"></div>
</aside>
<script>
const DETAIL = ${jsonForScript(detail)};
const LAYOUT = ${jsonForScript({ width: layout.width, height: layout.height })};
const inner = document.getElementById('inner');
const mainEl = document.getElementById('main');
let zoom = 1, panX = 0, panY = 0;
function applyTransform(){
  inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  document.getElementById('zval').textContent = Math.round(zoom * 100) + '%';
  syncMinimap();
}
function fit(){
  const z = Math.min(mainEl.clientWidth / LAYOUT.width, mainEl.clientHeight / LAYOUT.height) * 0.96;
  zoom = Math.max(0.15, Math.min(1.5, z));
  panX = (mainEl.clientWidth - LAYOUT.width * zoom) / 2;
  panY = (mainEl.clientHeight - LAYOUT.height * zoom) / 2;
  applyTransform();
}
function syncMinimap(){
  const vp = document.getElementById('mmvp');
  const vw = mainEl.clientWidth / zoom / LAYOUT.width;
  const vh = mainEl.clientHeight / zoom / LAYOUT.height;
  const vx = (-panX / zoom) / LAYOUT.width;
  const vy = (-panY / zoom) / LAYOUT.height;
  vp.style.left = Math.max(0, vx * 100) + '%';
  vp.style.top = Math.max(0, vy * 100) + '%';
  vp.style.width = Math.min(100, vw * 100) + '%';
  vp.style.height = Math.min(100, vh * 100) + '%';
}
document.getElementById('zin').addEventListener('click', () => { zoom = Math.min(2, zoom * 1.2); applyTransform(); });
document.getElementById('zout').addEventListener('click', () => { zoom = Math.max(0.15, zoom / 1.2); applyTransform(); });
document.getElementById('zfit').addEventListener('click', fit);
mainEl.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = mainEl.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const oldZ = zoom;
  zoom = Math.max(0.15, Math.min(2, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  panX = mx - ((mx - panX) / oldZ) * zoom;
  panY = my - ((my - panY) / oldZ) * zoom;
  applyTransform();
}, { passive: false });
let drag = null;
mainEl.addEventListener('mousedown', (ev) => {
  if (ev.target.closest('.dslw-node') || ev.target.closest('.dslw-minimap-wrap') || ev.target.closest('.dslw-canvas-ctrls')) return;
  drag = { x: ev.clientX, y: ev.clientY, px: panX, py: panY };
  mainEl.classList.add('panning');
});
window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  panX = drag.px + (ev.clientX - drag.x);
  panY = drag.py + (ev.clientY - drag.y);
  applyTransform();
});
window.addEventListener('mouseup', () => { drag = null; mainEl.classList.remove('panning'); });
document.getElementById('minimap').addEventListener('click', (ev) => {
  const rect = ev.currentTarget.getBoundingClientRect();
  const fx = (ev.clientX - rect.left) / rect.width;
  const fy = (ev.clientY - rect.top) / rect.height;
  panX = mainEl.clientWidth / 2 - fx * LAYOUT.width * zoom;
  panY = mainEl.clientHeight / 2 - fy * LAYOUT.height * zoom;
  applyTransform();
});
document.querySelectorAll('.dslw-node').forEach(el => {
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const d = DETAIL.find(x => x.id === el.dataset.id);
    if (!d) return;
    document.querySelectorAll('.dslw-node').forEach(x => x.classList.remove('selected'));
    el.classList.add('selected');
    document.getElementById('ptitle').textContent = d.title;
    document.getElementById('pdesc').textContent = d.desc || '（暂无 LLM 解读）';
    document.getElementById('pfacts').textContent = d.facts + ' · 所属积木 ' + d.brick;
    const body = document.getElementById('pbody');
    body.innerHTML = d.files.map(f =>
      '<div class="f-row"><span class="f-path"></span>' +
      '<span class="dslw-badge f-role ' + ({brick:'dslw-badge-ok',contract:'dslw-badge-info',glue:'dslw-badge-gray'}[f.role]||'dslw-badge-gray') + '">' +
      ({brick:'功能',contract:'契约',glue:'胶水'}[f.role]||f.role) + '</span></div>'
    ).join('');
    body.querySelectorAll('.f-path').forEach((p, i) => { p.textContent = d.files[i].path; p.title = d.files[i].path; });
    document.getElementById('panel').classList.add('open');
  });
});
document.getElementById('pclose').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.dslw-node').forEach(x => x.classList.remove('selected'));
});
fit();
</script>
</body>
</html>`;
}

/** 落盘便捷入口。 */
export function buildSandboxCanvas(opts: {
  result: BrickifyResult;
  narratives?: ClusterNarratives;
  out_file?: string;
}): string {
  const html = renderSandboxCanvasHtml(opts.result, opts.narratives);
  if (opts.out_file) {
    const abs = path.resolve(opts.out_file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, html, 'utf-8');
  }
  return html;
}
