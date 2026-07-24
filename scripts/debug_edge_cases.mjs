// 调试：复现两条残余交叉边的绕障搜索，穷举更大幅度验证贝塞尔族表达能力
import { computeEdgePath, countCubicHits, countQuadHits, intersectRect } from '../dist/src/renderer/edge_geom.js';
import fs from 'node:fs';

const html = fs.readFileSync('output/self_import.html', 'utf-8');
const nodes = {};
const nodeRe = /<g class="node[^"]*" data-id="([^"]+)"[\s\S]*?<rect data-shape="true" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g;
let m;
while ((m = nodeRe.exec(html))) nodes[m[1]] = { x: +m[2], y: +m[3], w: +m[4], h: +m[5] };

// 由矩形包含推导祖先（与渲染器 ancestorsOf 一致）
function ancestorsOf(id) {
  const r = nodes[id];
  const out = [];
  for (const oid in nodes) {
    if (oid === id) continue;
    const o = nodes[oid];
    if (r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h) out.push(oid);
  }
  return out;
}
function obstaclesFor(fromId, toId) {
  const excluded = new Set([fromId, toId, ...ancestorsOf(fromId), ...ancestorsOf(toId)]);
  return Object.keys(nodes).filter((id) => !excluded.has(id)).map((id) => nodes[id]);
}

const cases = [
  ['file_src_server_ts', 'file_src_tools_consistency_ts'],
  ['file_src_storage_ts', 'file_src_dsl_types_ts'],
];

for (const [f, t] of cases) {
  const fromBox = nodes[f], toBox = nodes[t];
  const obstacles = obstaclesFor(f, t);
  const res = computeEdgePath({ fromBox, toBox, edgeType: 'curve', obstacles });
  console.log(`\n=== ${f} → ${t}`);
  console.log('chosen:', res.d);

  // 端点
  const fc = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 };
  const tc = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 };
  const s0 = intersectRect(fc, tc, fromBox);
  const e0 = intersectRect(tc, fc, toBox);
  const dx = e0.x - s0.x, dy = e0.y - s0.y;
  const len = Math.hypot(dx, dy);
  const px = -dy / len, py = dx / len;
  console.log(`endpoints (${s0.x.toFixed(0)},${s0.y.toFixed(0)})→(${e0.x.toFixed(0)},${e0.y.toFixed(0)}) len=${len.toFixed(0)} perp=(${px.toFixed(2)},${py.toFixed(2)})`);

  // 穷举非对称幅度 ±1000，步长 40，找零碰撞对
  let found = 0;
  const cands = [];
  for (let a = -1000; a <= 1000; a += 40) cands.push(a);
  outer: for (const a of cands) {
    for (const b of cands) {
      const hits = countCubicHits(s0.x, s0.y, s0.x + px * a, s0.y + py * a, e0.x + px * b, e0.y + py * b, e0.x, e0.y, obstacles);
      if (hits === 0) {
        console.log(`zero-hit asym pair: a=${a} b=${b}`);
        if (++found >= 5) break outer;
      }
    }
  }
  if (!found) console.log('NO zero-hit cubic pair within ±1000 on base endpoints');
}
