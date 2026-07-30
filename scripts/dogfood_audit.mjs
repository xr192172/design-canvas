#!/usr/bin/env node
// dogfood_audit.mjs — 用 design-canvas 扫描自己的产物，反查项目自身缺陷
// 读取 .design-canvas/features/self_analyze.json，从图结构发现架构问题

import fs from 'node:fs';
import path from 'node:path';

const DSL_PATH = path.resolve('.design-canvas/features/self_analyze.json');
const dsl = JSON.parse(fs.readFileSync(DSL_PATH, 'utf8'));

const nodes = dsl.geometry?.nodes || [];
const edges = dsl.geometry?.edges || [];
const semantic = dsl.semantic || {};

// ── 1. 度数分析：找出"枢纽节点"（过高入度/出度 = 上帝对象） ──
const inDeg = new Map();
const outDeg = new Map();
for (const n of nodes) {
  inDeg.set(n.id, 0);
  outDeg.set(n.id, 0);
}
for (const e of edges) {
  if (e.type === 'contains') continue;  // 只看依赖/调用边
  outDeg.set(e.from, (outDeg.get(e.from) || 0) + 1);
  inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
}

const nodeById = new Map(nodes.map(n => [n.id, n]));
const hubNodes = [...inDeg.entries()]
  .filter(([id, d]) => d >= 5)
  .sort((a, b) => b[1] - a[1])
  .map(([id, d]) => ({ id, label: nodeById.get(id)?.label || id, inDeg: d, outDeg: outDeg.get(id) || 0 }));

const fanOutNodes = [...outDeg.entries()]
  .filter(([id, d]) => d >= 5)
  .sort((a, b) => b[1] - a[1])
  .map(([id, d]) => ({ id, label: nodeById.get(id)?.label || id, outDeg: d, inDeg: inDeg.get(id) || 0 }));

// ── 2. 循环依赖检测（强连通分量 SCC，Tarjan 简化版） ──
const adj = new Map();
const radj = new Map();
for (const n of nodes) { adj.set(n.id, []); radj.set(n.id, []); }
for (const e of edges) {
  if (e.type === 'contains') continue;
  if (e.from === e.to) continue;
  adj.get(e.from)?.push(e.to);
  radj.get(e.to)?.push(e.from);
}

// Tarjan SCC
let index = 0;
const stack = [];
const onStack = new Set();
const indices = new Map();
const lowlink = new Map();
const sccs = [];

function strongconnect(v) {
  indices.set(v, index);
  lowlink.set(v, index);
  index++;
  stack.push(v);
  onStack.add(v);
  for (const w of (adj.get(v) || [])) {
    if (!indices.has(w)) {
      strongconnect(w);
      lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
    } else if (onStack.has(w)) {
      lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
    }
  }
  if (lowlink.get(v) === indices.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1) sccs.push(comp);  // 只记录有环的 SCC
  }
}
for (const n of nodes) {
  if (!indices.has(n.id)) strongconnect(n.id);
}

// ── 3. 层级混乱：文件被"下层"依赖（违反应有的分层） ──
// 简化：按目录路径判断层级，renderer/ 应在 tools/ 之上，db/ 在最底层
const layerOrder = ['tests', 'vendor', 'docs', 'scripts', 'src/tools', 'src/server', 'src/renderer', 'src/db', 'src'];
function layerOf(id) {
  const desc = nodeById.get(id)?.description || '';
  for (const l of layerOrder) {
    if (desc.includes(l)) return layerOrder.indexOf(l);
  }
  return 99;
}
const layerViolations = [];
for (const e of edges) {
  if (e.type === 'contains') continue;
  const lf = layerOf(e.from);
  const lt = layerOf(e.to);
  // tools(4) 依赖 renderer(6) = 违反（下层依赖上层）
  if (lf < lt && lf < 99 && lt < 99) {
    layerViolations.push({
      from: nodeById.get(e.from)?.label || e.from,
      to: nodeById.get(e.to)?.label || e.to,
      fromLayer: layerOrder[lf],
      toLayer: layerOrder[lt],
    });
  }
}

// ── 4. 孤岛节点：无依赖边连接的文件 ──
const connected = new Set();
for (const e of edges) {
  if (e.type === 'contains') continue;
  connected.add(e.from);
  connected.add(e.to);
}
const orphans = nodes.filter(n => n.type === 'file' && !connected.has(n.id))
  .map(n => ({ id: n.id, label: n.label, desc: n.description }));

// ── 5. 巨石文件（从 monolith_report 复述） ──
const files = (semantic.files || []).map(f => ({
  path: f.path,
  lines: f.lines || 0,
  apis: f.expected_apis?.length || 0,
})).sort((a, b) => b.lines - a.lines);

// ── 6. 过深调用链（从 detail 层节点推断） ──
const detailNodes = nodes.filter(n => n.id.includes('__s') || n.id.includes('__alg'));
const chainDepth = new Map();
for (const n of detailNodes) {
  const parts = n.id.split('__');
  if (parts.length >= 2) {
    const fileId = parts[0];
    chainDepth.set(fileId, (chainDepth.get(fileId) || 0) + 1);
  }
}
const deepChains = [...chainDepth.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([id, cnt]) => ({ file: nodeById.get(id)?.label || id, detailNodes: cnt }));

// ── 输出报告 ──
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  design-canvas 自我审计（dogfooding）');
console.log('  数据源：.design-canvas/features/self_analyze.json');
console.log(`  规模：${nodes.length} 节点 / ${edges.length} 边`);
console.log('═══════════════════════════════════════════════════════════\n');

console.log('【缺陷 1：上帝对象 / 过高入度（被太多文件依赖）】');
console.log('  阈值：入度 ≥ 5');
console.log('  含义：这些文件改动会波及大量调用方，是重构瓶颈');
hubNodes.slice(0, 8).forEach((n, i) => {
  console.log(`  ${i+1}. ${n.label.padEnd(45)} 入度=${n.inDeg} 出度=${n.outDeg}`);
});
console.log('');

console.log('【缺陷 2：扇出过大 / 过高出度（依赖太多文件）】');
console.log('  阈值：出度 ≥ 5');
console.log('  含义：这些文件耦合面广，单测难写，变更影响不可控');
fanOutNodes.slice(0, 8).forEach((n, i) => {
  console.log(`  ${i+1}. ${n.label.padEnd(45)} 出度=${n.outDeg} 入度=${n.inDeg}`);
});
console.log('');

console.log(`【缺陷 3：循环依赖 / 强连通分量】`);
console.log(`  检测到 ${sccs.length} 个循环依赖环：`);
sccs.slice(0, 5).forEach((comp, i) => {
  console.log(`  环 ${i+1}（${comp.length} 节点）：`);
  comp.forEach(id => console.log(`    - ${nodeById.get(id)?.label || id}`));
});
console.log('');

console.log(`【缺陷 4：层级混乱（下层依赖上层）】`);
console.log(`  检测到 ${layerViolations.length} 处层级违反：`);
layerViolations.slice(0, 8).forEach((v, i) => {
  console.log(`  ${i+1}. ${v.from} (${v.fromLayer}) → ${v.to} (${v.toLayer})`);
});
console.log('');

console.log(`【缺陷 5：孤岛文件（无依赖边连接）】`);
console.log(`  共 ${orphans.length} 个文件节点无任何依赖边：`);
orphans.slice(0, 8).forEach((n, i) => {
  console.log(`  ${i+1}. ${n.label.padEnd(40)} ${n.desc || ''}`);
});
console.log('');

console.log(`【缺陷 6：巨石文件 Top 10】`);
files.slice(0, 10).forEach((f, i) => {
  console.log(`  ${i+1}. ${(f.path || '').padEnd(45)} ${f.lines} 行 / ${f.apis} API`);
});
console.log('');

console.log(`【缺陷 7：调用链展开深度 Top 5】`);
console.log('  含义：detail 层节点最多的文件，调用链最复杂');
deepChains.forEach((c, i) => {
  console.log(`  ${i+1}. ${c.file.padEnd(45)} ${c.detailNodes} 个 detail 节点`);
});

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  审计完成');
console.log('═══════════════════════════════════════════════════════════\n');
