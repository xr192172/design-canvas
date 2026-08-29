/* 临时探针：打印 teach JSON 每个 stepgroup 的步骤针脚（inputs/outputs 原始 + pinIdentity 身份），看 0 连线根因 */
import { readFileSync } from 'node:fs';
import { deriveStepFlow } from './dist/src/tools/derive_mind_map.js';

const jsonPath = '.design-canvas/mindmap/design-canvas.teach.json';
const mm = JSON.parse(readFileSync(jsonPath, 'utf-8'));

for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  const stepNodes = (sg?.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  const steps = stepNodes.map((c) => ({
    title: c.label, detail: c.description || '',
    involves: c.meta?.involves, inputs: c.meta?.inputs, outputs: c.meta?.outputs,
  }));
  const ids = stepNodes.map((c) => c.id);
  const { edges } = deriveStepFlow(steps, ids);
  console.log(`==== 功能: ${f.label}（${steps.length} 步 · 连线 ${edges.length} 条）`);
  steps.forEach((s, i) => {
    const pinStr = (p) => (p ? `${p.n || ''}[${p.t || ''}]` : '');
    console.log(`  [${i}] ${s.title}`);
    console.log(`      入: ${(s.inputs ?? []).map(pinStr).join(' · ') || '（无）'}`);
    console.log(`      出: ${(s.outputs ?? []).map(pinStr).join(' · ') || '（无）'}`);
  });
}
