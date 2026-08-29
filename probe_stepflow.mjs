/* 临时探针：在现有 teach JSON 上跑 deriveStepFlow，验证跨步连线+缺口算法（不触发 LLM/不覆盖数据） */
import { readFileSync } from 'node:fs';
import { deriveStepFlow } from './dist/src/tools/derive_mind_map.js';

const jsonPath = '.design-canvas/mindmap/design-canvas.teach.json';
const mm = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const out = [];
let featTotal = 0, edgeTotal = 0, gapTotal = 0;

for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  const stepNodes = (sg?.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  const steps = stepNodes.map((c) => ({
    title: c.label,
    detail: c.description || '',
    involves: c.meta?.involves,
    inputs: c.meta?.inputs,
    outputs: c.meta?.outputs,
  }));
  const ids = stepNodes.map((c) => c.id);
  const { edges, gaps } = deriveStepFlow(steps, ids);
  featTotal++; edgeTotal += edges.length; gapTotal += gaps.length;
  out.push(`==== 功能: ${f.label} ====`);
  out.push(`  连线 ${edges.length} 条${edges.length ? '：' + edges.map((e) => `${e.from} → ${e.to} [${e.data}]`).join(' · ') : '（无跨步同数据名连线）'}`);
  for (const g of gaps) {
    const tag = { in_missing: '无入边', out_missing: '无出边', in_no_source: '入边无源', out_no_consumer: '出边无人接' }[g.kind];
    out.push(`  [${g.seq}] ${stepNodes[g.seq].label} · ${tag}${g.data ? `「${g.data}」` : ''}: ${g.msg}`);
  }
  out.push('');
}
out.unshift(`共 ${featTotal} 个功能 · 推导连线 ${edgeTotal} 条 · 缺口 ${gapTotal} 条\n`);
console.log(out.join('\n'));
