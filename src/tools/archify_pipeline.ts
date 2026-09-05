/**
 * archify_pipeline —— 把 Archify 作为内置能力：一份语义面 → 5 类 showcase 图（各一张）
 *
 * 流程：deriveSemantics(语义面) → 5 个 mapper(官方 candidate) → 官方 validate(showcase) →
 * deliver(HTML) → manifest。遵循 skill 的诚实降级：
 *   - ARCHIFY_ROOT 未装配 → 仅返回 candidate，不 deliver；
 *   - validate 不达 showcase → 返回官方诊断摘要，绝不加自造几何去"修"；
 *   - 类型间隔离：某类型不通过不影响其余类型已产出的图。
 */
import path from 'node:path';
import fs from 'node:fs';
import { deriveSemantics, type SemanticSurface } from './archify_semantics.js';
import { DIAGRAM_TYPES, toArchitecture, toWorkflow, toSequence, toDataflow, toLifecycle, type DiagramCandidate, type DiagramType } from './archify_mappers.js';
import { resolveArchifyRoot, archifyCliPath, validateCandidate, deliverHtml } from './archify_cli.js';
import type { FileIndex } from './derive_mind_map.js';
import type { ArchifyTreeNode } from './archify_project.js';

export interface ProductionItem {
  type: DiagramType;
  delivered: boolean;
  htmlPath?: string;
  /** 未交付时的诚实说明（含官方校验诊断摘要） */
  note?: string;
  /** candidate IR（供测试/溯源；前端展示只需 htmlPath，可忽略） */
  candidate?: unknown;
}
export interface ProductionManifest {
  delivered: boolean;
  manifest: ProductionItem[];
}

export interface PipelineOptions {
  ir: ArchifyTreeNode;
  fileIndex?: FileIndex;
  archifyRoot?: string;
  outDir?: string;
}

export function runArchifyPipeline(opts: PipelineOptions): ProductionManifest {
  const sem = deriveSemantics(opts.ir, { fileIndex: opts.fileIndex });
  const root = resolveArchifyRoot(opts.archifyRoot);
  const outDir = path.resolve(opts.outDir ?? path.join(process.cwd(), 'output'));
  const safeId = String(opts.ir.id || 'project').replace(/[:\\/*?"<>|]/g, '_');

  const items: ProductionItem[] = [];
  for (const type of DIAGRAM_TYPES) {
    const candidate = mapCandidate(type, sem);
    if (!candidate) {
      items.push({ type, delivered: false, note: '当前输入不适配该图类型（主节点/主路径/终态不足），已跳过' });
      continue;
    }
    if (!root) {
      items.push({ type, delivered: false, candidate: candidate.ir, note: 'ARCHIFY_ROOT 未配置：仅返回 candidate，设 ARCHIFY_ROOT=<含 archify/ 的根> 后可 validate+deliver' });
      continue;
    }
    if (!fs.existsSync(archifyCliPath(root))) {
      items.push({ type, delivered: false, candidate: candidate.ir, note: `Archify CLI 未找到：${archifyCliPath(root)}` });
      continue;
    }
    // validate：showcase 优先；不达则如实尝试 quality=standard 降级（skill 允许的合法 profile），
    // 能过就交付并标注「已按 standard」——不静默降级，note 如实说明。
    const v = validateCandidate(root, type, candidate.ir, 'showcase', outDir);
    let quality: 'showcase' | 'standard' = 'showcase';
    if (!v.ok) {
      const std = validateCandidate(root, type, candidate.ir, 'standard', outDir);
      if (std.ok) { quality = 'standard'; }
      else {
        items.push({ type, delivered: false, candidate: candidate.ir, note: `validate 未达 showcase：${truncate(v.stdout || v.stderr || '未知诊断', 400)}${topoHint(candidate.ir, type)}` });
        continue;
      }
    }
    const htmlPath = path.resolve(outDir, `${safeId}-${type}.html`);
    const d = deliverHtml(root, type, candidate.ir, htmlPath, quality, outDir);
    if (d.ok) items.push({ type, delivered: true, htmlPath, ...(quality === 'standard' ? { note: '已按 standard 交付（showcase 需精简节点/边；质量已如实标注）' } : {}) });
    else items.push({ type, delivered: false, candidate: candidate.ir, note: `deliver 失败：${truncate(d.stdout || d.stderr || '未知错误', 400)}` });
  }

  return { delivered: items.some((it) => it.delivered), manifest: items };
}

function mapCandidate(type: DiagramType, sem: SemanticSurface): DiagramCandidate | null {
  switch (type) {
    case 'architecture': return toArchitecture(sem);
    case 'workflow': return toWorkflow(sem);
    case 'sequence': return toSequence(sem);
    case 'dataflow': return toDataflow(sem);
    case 'lifecycle': return toLifecycle(sem);
  }
}

function truncate(s: string, n: number): string {
  const c = String(s || '');
  return c.length > n ? c.slice(0, n) + '…' : c;
}

/** 失败自诊断：把 candidate 的紧凑拓扑（组件+坐标 / 连接）压进 note，便于据此修 archPosComponents 的跨列穿行 */
function topoHint(candidate: unknown, type: DiagramType): string {
  const c = candidate as { components?: Array<{ label?: string; pos?: [number, number]; id?: string }>; connections?: Array<{ from?: string; to?: string }>; nodes?: Array<{ label?: string; id?: string }>; edges?: Array<{ from?: string; to?: string }>; messages?: unknown[]; participants?: unknown[] };
  const comps = (c.components || c.nodes || []).map((n) => `${n.label ?? n.id ?? '?'}`).slice(0, 12);
  const conns = (c.connections || c.edges || []).map((e) => `${e.from}->${e.to}`).slice(0, 12);
  const pos = (c.components || []).slice(0, 8).map((n) => `${n.label ?? n.id}@${(n.pos || []).join(',') || '?'}`);
  const parts = [`【candidate】${type}`];
  if (comps.length) parts.push(`组件(${comps.length}): ${comps.join(' | ')}`);
  if (conns.length) parts.push(`连接(${conns.length}): ${conns.join(' ') || '无'}`);
  if (pos.length) parts.push(`布局: ${pos.join(' ') || '无'}`);
  return ' ' + parts.join(' · ');
}