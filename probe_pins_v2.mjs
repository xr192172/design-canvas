/* 临时探针 v2：用「改进后」的全量投影重投影每个 teach 步骤针脚，看连线能否从 0 提升 */
import { readFileSync } from 'node:fs';
import { buildFileIndex, projectStepDataShape, deriveStepFlow } from './dist/src/tools/derive_mind_map.js';

const dsl = JSON.parse(readFileSync('.design-canvas/live/design-canvas.dsl.json', 'utf-8'));
const fileIndex = buildFileIndex(dsl);
const mm = JSON.parse(readFileSync('.design-canvas/mindmap/design-canvas.teach.json', 'utf-8'));

let totalEdges = 0, featWithEdges = 0, featN = 0;
for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  if (!sg) continue;
  const stepNodes = (sg.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  featN++;
  const steps = stepNodes.map((c) => ({
    title: c.label, detail: c.description || '',
    involves: c.meta?.involves,
    inputs: c.meta?.inputs, outputs: c.meta?.outputs, // 占位，下面重投影
  }));
  // 重投影：全量 API + 代表力打分
  let edge = 0;
  steps.forEach((s, i) => {
    const shape = projectStepDataShape(s.involves, fileIndex);
    s.inputs = shape?.inputs ?? [];
    s.outputs = shape?.outputs ?? [];
  });
  const { edges } = deriveStepFlow(steps, stepNodes.map((c) => c.id));
  edge = edges.length;
  totalEdges += edge;
  if (edge > 0) featWithEdges++;
  console.log(`==== ${f.label}（${steps.length} 步 · 连线 ${edge} 条）`);
  steps.forEach((s, i) => {
    const pinStr = (p) => (p ? `${p.n || ''}[${p.t || ''}]` : '');
    console.log(`  [${i}] ${s.title}`);
    console.log(`      入: ${(s.inputs ?? []).map(pinStr).join(' · ') || '（无）'}`);
    console.log(`      出: ${(s.outputs ?? []).map(pinStr).join(' · ') || '（无）'}`);
  });
  for (const e of edges) console.log(`      └─ 边: ${e.from} → ${e.to}（${e.data}）`);
}
console.log(`\n==== 汇总：${featN} 功能 · 有连线功能 ${featWithEdges} · 总连线 ${totalEdges} 条`);
