/**
 * 导出工具
 *
 * - export_svg: 从 DSL 提取 SVG 内容，生成独立 SVG 文件
 * - export_markdown: 从 DSL 生成 Markdown 设计文档
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL } from '../storage.js';
import type { DesignDSL, Node, Edge } from '../dsl/types.js';

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 计算画布尺寸 */
function computeCanvasSize(dsl: DesignDSL): { width: number; height: number } {
  const nodes = dsl.geometry.nodes;
  if (nodes.length === 0) return { width: 1200, height: 800 };
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    const x = (n.x ?? 0) + (n.width ?? 200);
    const y = (n.y ?? 0) + (n.height ?? 80);
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { width: Math.max(maxX + 100, 1200), height: Math.max(maxY + 100, 800) };
}

/** 渲染单个节点为 SVG（简化版，不含交互） */
function renderNodeSvg(n: Node): string {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const w = n.width ?? 200;
  const h = n.height ?? 80;
  const label = n.label ?? n.id;
  const fill = n.style?.bg ?? '#152141';
  const stroke = n.style?.border ?? '#243459';
  const textColor = n.style?.color ?? '#ffffff';

  const shape = n.style?.shape ?? 'rounded';
  let shapeEl = '';

  if (shape === 'rect') {
    shapeEl = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  } else if (shape === 'circle') {
    const r = Math.min(w, h) / 2;
    const cx = x + w / 2;
    const cy = y + h / 2;
    shapeEl = `<ellipse cx="${cx}" cy="${cy}" rx="${w/2}" ry="${h/2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  } else if (shape === 'diamond') {
    const cx = x + w / 2;
    const cy = y + h / 2;
    shapeEl = `<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  } else {
    shapeEl = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`;
  }

  return `  <g class="node">
    ${shapeEl}
    <text x="${x + w/2}" y="${y + h/2}" text-anchor="middle" dominant-baseline="central" fill="${textColor}" font-size="14" font-family="sans-serif">${escapeXml(label)}</text>
  </g>`;
}

/** 渲染边为 SVG path */
function renderEdgeSvg(e: Edge, nodeMap: Map<string, Node>): string {
  const from = nodeMap.get(e.from);
  const to = nodeMap.get(e.to);
  if (!from || !to) return '';

  const x1 = (from.x ?? 0) + (from.width ?? 200) / 2;
  const y1 = (from.y ?? 0) + (from.height ?? 80);
  const x2 = (to.x ?? 0) + (to.width ?? 200) / 2;
  const y2 = (to.y ?? 0);

  const label = e.label ?? '';
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  const labelEl = label ? `<text x="${midX}" y="${midY - 5}" text-anchor="middle" fill="#8ea3c8" font-size="12" font-family="sans-serif">${escapeXml(label)}</text>` : '';

  return `  <g class="edge">
    <path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#4f8df7" stroke-width="2" fill="none" marker-end="url(#arrow)"/>
    ${labelEl}
  </g>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

export interface ExportSvgInput {
  feature: string;
  output_path?: string;
}

export interface ExportSvgResult {
  message: string;
  feature: string;
  file: string;
}

/** 导出为独立 SVG 文件 */
export function exportSvg(input: ExportSvgInput): ExportSvgResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);

  const canvas = computeCanvasSize(dsl);
  const nodeMap = new Map<string, Node>();
  for (const n of dsl.geometry.nodes) nodeMap.set(n.id, n);

  const nodesXml = dsl.geometry.nodes.map(renderNodeSvg).join('\n');
  const edgesXml = (dsl.geometry.edges ?? []).map((e) => renderEdgeSvg(e, nodeMap)).join('\n');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas.width} ${canvas.height}" width="${canvas.width}" height="${canvas.height}">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#4f8df7"/>
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#0a1128"/>
${edgesXml}
${nodesXml}
</svg>`;

  const file = path.resolve(input.output_path ?? `output/${input.feature}.svg`);
  ensureDir(file);
  fs.writeFileSync(file, svg, 'utf-8');

  return {
    message: `已导出 SVG：${file}\n节点数：${dsl.geometry.nodes.length}\n边数：${dsl.geometry.edges?.length ?? 0}`,
    feature: input.feature,
    file,
  };
}

export interface ExportMarkdownInput {
  feature: string;
  output_path?: string;
}

export interface ExportMarkdownResult {
  message: string;
  feature: string;
  file: string;
}

/** 导出为 Markdown 设计文档 */
export function exportMarkdown(input: ExportMarkdownInput): ExportMarkdownResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);

  const lines: string[] = [];
  lines.push(`# ${dsl.feature}`);
  lines.push('');
  if (dsl.title) {
    lines.push(`> ${dsl.title}`);
    lines.push('');
  }
  lines.push(`**状态**: ${dsl.status ?? 'draft'}  |  **版本**: ${dsl.version ?? '0.1.0'}  |  **主题**: ${dsl.theme ?? 'blue'}`);
  lines.push('');

  // 节点列表
  lines.push('## 节点');
  lines.push('');
  lines.push('| ID | 标签 | 类型 | 状态 | 描述 |');
  lines.push('|---|---|---|---|---|');
  for (const n of dsl.geometry.nodes) {
    const desc = n.description ?? '';
    lines.push(`| ${n.id} | ${n.label ?? n.id} | ${n.type ?? '-'} | ${n.status ?? '-'} | ${desc} |`);
  }
  lines.push('');

  // 边列表
  if (dsl.geometry.edges && dsl.geometry.edges.length > 0) {
    lines.push('## 连接关系');
    lines.push('');
    lines.push('| 起点 | 终点 | 标签 |');
    lines.push('|---|---|---|');
    for (const e of dsl.geometry.edges) {
      lines.push(`| ${e.from} | ${e.to} | ${e.label ?? ''} |`);
    }
    lines.push('');
  }

  // 泳道
  if (dsl.geometry.swimlanes && dsl.geometry.swimlanes.length > 0) {
    lines.push('## 泳道');
    lines.push('');
    for (const sl of dsl.geometry.swimlanes) {
      lines.push(`### ${sl.label ?? sl.id}`);
      const slNodes = dsl.geometry.nodes.filter(n => n.swimlane === sl.id).map(n => n.id);
      if (slNodes.length > 0) {
        lines.push(`节点: ${slNodes.join(', ')}`);
      }
      lines.push('');
    }
  }

  // 语义层 — 文件
  if (dsl.semantic?.files && dsl.semantic.files.length > 0) {
    lines.push('## 语义层 — 文件');
    lines.push('');
    for (const f of dsl.semantic.files) {
      lines.push(`### ${f.id}`);
      lines.push(`- 路径: \`${f.path}\``);
      if (f.responsibility) lines.push(`- 职责: ${f.responsibility}`);
      if (f.expected_apis && f.expected_apis.length > 0) {
        lines.push('- 预期 API:');
        for (const api of f.expected_apis) {
          lines.push(`  - \`${api.signature}\``);
        }
      }
      lines.push('');
    }
  }

  // 跨文件不变式
  if (dsl.semantic?.multi_file_invariants && dsl.semantic.multi_file_invariants.length > 0) {
    lines.push('## 跨文件不变式');
    lines.push('');
    for (const inv of dsl.semantic.multi_file_invariants) {
      lines.push(`- ${inv}`);
    }
    lines.push('');
  }

  // 仿真器配置
  if (dsl.simulation) {
    const sim = dsl.simulation;
    lines.push('## 仿真器');
    lines.push('');
    if (sim.name) lines.push(`**名称**: ${sim.name}`);
    if (sim.description) lines.push(`**描述**: ${sim.description}`);
    lines.push('');
    lines.push('### 初始状态');
    lines.push('');
    lines.push('| 键 | 值 | 类型 | 描述 |');
    lines.push('|---|---|---|---|');
    for (const s of sim.initial_state) {
      const val = Array.isArray(s.value) ? `[${s.value.length} 项]` : String(s.value);
      lines.push(`| ${s.key} | ${val} | ${s.type ?? '?'} | ${s.description ?? ''} |`);
    }
    lines.push('');
    lines.push('### 事件规则');
    lines.push('');
    for (const r of sim.rules) {
      lines.push(`#### ${r.id}: ${r.name ?? r.event}`);
      lines.push(`- 事件: \`${r.event}\``);
      if (r.condition) lines.push(`- 条件: \`${r.condition}\``);
      if (r.emits && r.emits.length > 0) lines.push(`- 发射: ${r.emits.join(', ')}`);
      lines.push('');
    }
    lines.push('### 状态映射');
    lines.push('');
    for (const m of sim.mappings ?? []) {
      lines.push(`- ${m.stateKey} → 节点 \`${m.nodeId}\``);
      if (m.labelTemplate) lines.push(`  - 标签模板: \`${m.labelTemplate}\``);
    }
    lines.push('');
  }

  // 标注
  if (dsl.annotations && dsl.annotations.length > 0) {
    lines.push('## 人审标注');
    lines.push('');
    for (const a of dsl.annotations) {
      const status = a.resolved ? '✅ 已解决' : '⏳ 待处理';
      lines.push(`### [${status}] ${a.node_id ?? a.target_id ?? '全局'} — ${a.type ?? 'comment'}`);
      lines.push(a.text);
      lines.push('');
    }
  }

  const md = lines.join('\n');
  const file = path.resolve(input.output_path ?? `output/${input.feature}.md`);
  ensureDir(file);
  fs.writeFileSync(file, md, 'utf-8');

  return {
    message: `已导出 Markdown：${file}\n节点数：${dsl.geometry.nodes.length}\n文件数：${dsl.semantic?.files?.length ?? 0}`,
    feature: input.feature,
    file,
  };
}
