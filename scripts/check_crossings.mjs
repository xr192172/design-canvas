// 一次性：分析 output HTML 中边-节点穿越详情（与浏览器检测脚本同算法）
// 支持多段路径（M/L/Q/C 混合，waypoint 路由产生的圆角折线）
import fs from 'node:fs';

const file = process.argv[2] ?? 'output/self_import.html';
const html = fs.readFileSync(file, 'utf-8');

// 提取节点矩形（rect 形状即可，self_import 全是 rect）
const nodes = {};
const nodeRe = /<g class="node[^"]*" data-id="([^"]+)"[\s\S]*?<rect data-shape="true" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g;
let m;
while ((m = nodeRe.exec(html))) {
  nodes[m[1]] = { x: +m[2], y: +m[3], w: +m[4], h: +m[5] };
}

const edgeBlockRe = /<g class="edge" data-id="([^"]+)" data-label="([^"]*)"[^>]*>\s*<path d="([^"]+)"/g;
const edges = [];
while ((m = edgeBlockRe.exec(html))) {
  edges.push({ id: m[1], label: m[2], d: m[3] });
}

function owner(x, y) {
  // 取最小面积包含者（叶子优先）
  let best = null, bestArea = Infinity;
  for (const id in nodes) {
    const r = nodes[id];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const a = r.w * r.h;
      if (a < bestArea) { bestArea = a; best = id; }
    }
  }
  return best;
}

// 路径 d 属性分词 → 分段列表 [{sample(t), from:[x,y], to:[x,y]}]
function parsePath(d) {
  const tokens = d.match(/[MLQCAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const segs = [];
  let i = 0, cx = 0, cy = 0;
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') {
      cx = num(); cy = num();
    } else if (cmd === 'L') {
      const x0 = cx, y0 = cy;
      cx = num(); cy = num();
      const fx = cx, fy = cy;
      segs.push({ from: [x0, y0], to: [fx, fy], sample: (t) => [x0 + (fx - x0) * t, y0 + (fy - y0) * t] });
    } else if (cmd === 'Q') {
      const x0 = cx, y0 = cy;
      const qx = num(), qy = num();
      cx = num(); cy = num();
      const fx = cx, fy = cy;
      segs.push({
        from: [x0, y0], to: [fx, fy],
        sample: (t) => { const u = 1 - t; return [u * u * x0 + 2 * u * t * qx + t * t * fx, u * u * y0 + 2 * u * t * qy + t * t * fy]; },
      });
    } else if (cmd === 'C') {
      const x0 = cx, y0 = cy;
      const c1x = num(), c1y = num(), c2x = num(), c2y = num();
      cx = num(); cy = num();
      const fx = cx, fy = cy;
      segs.push({
        from: [x0, y0], to: [fx, fy],
        sample: (t) => {
          const u = 1 - t;
          return [
            u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * fx,
            u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * fy,
          ];
        },
      });
    } else if (cmd === 'Z') {
      // 闭合：忽略
    } else if (cmd === 'A') {
      // 圆弧：跳过 7 个参数，按直线近似
      num(); num(); num(); num(); num();
      const x0 = cx, y0 = cy;
      cx = num(); cy = num();
      const fx = cx, fy = cy;
      segs.push({ from: [x0, y0], to: [fx, fy], sample: (t) => [x0 + (fx - x0) * t, y0 + (fy - y0) * t] });
    }
  }
  return segs;
}

const bad = [];
let total = 0;
for (const e of edges) {
  if (e.label === 'contains' || e.label === '包含') continue;
  total++;
  const segs = parsePath(e.d);
  if (segs.length === 0) continue;
  const [fx, fy] = segs[0].from;
  const [tx, ty] = segs[segs.length - 1].to;
  const fId = owner(fx, fy), tId = owner(tx, ty);
  let hit = null;
  outer: for (const seg of segs) {
    for (let i = 2; i <= 22; i++) {
      const t = i / 24;
      const [x, y] = seg.sample(t);
      for (const id in nodes) {
        if (id === fId || id === tId) continue;
        const r = nodes[id];
        const fc = fId && nodes[fId];
        const tc = tId && nodes[tId];
        const fIn = fc && fc.x + fc.w / 2 > r.x && fc.x + fc.w / 2 < r.x + r.w && fc.y + fc.h / 2 > r.y && fc.y + fc.h / 2 < r.y + r.h;
        const tIn = tc && tc.x + tc.w / 2 > r.x && tc.x + tc.w / 2 < r.x + r.w && tc.y + tc.h / 2 > r.y && tc.y + tc.h / 2 < r.y + r.h;
        if (fIn || tIn) continue; // 容器是任一端点的祖先 → 合法穿越（渲染器同样豁免）
        if (x > r.x + 4 && x < r.x + r.w - 4 && y > r.y + 4 && y < r.y + r.h - 4) {
          hit = `${e.id} crosses ${id} @(${x.toFixed(0)},${y.toFixed(0)}) t=${t.toFixed(2)} [${fId} → ${tId}]`;
          break outer;
        }
      }
    }
  }
  if (hit) bad.push(hit);
}
console.log(`nodes=${Object.keys(nodes).length} edges=${total} crossings=${bad.length}`);
bad.forEach((b) => console.log(' -', b));
