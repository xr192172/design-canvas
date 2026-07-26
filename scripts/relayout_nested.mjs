/**
 * relayout_nested：从 contains 层级重建嵌套布局（布局腐坏恢复工具）
 *
 * 背景：dag/force 平铺布局曾破坏 import_project 产物的嵌套结构
 * （子节点逃逸出容器，浏览器 auto-save 持久化后不可逆）。本脚本只依据
 * DSL 自身的 contains 边 + 依赖边重排几何层，不触碰语义层。
 * 现已对嵌套 DSL 禁用平铺布局（dag_layout.assertFlatLayoutSafe），
 * 本脚本用于修复历史腐坏数据，或手动拖拽失控后一键复位。
 *
 * 用法：
 *   node scripts/relayout_nested.mjs <feature名 | json路径> [--html]
 *   --html：同时重新渲染 output/<feature>.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { layoutGroup, IMPORT_LAYOUT } from '../dist/src/tools/import_project.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const { PAD, TITLE_H, MARGIN, FILE_W, FILE_H } = IMPORT_LAYOUT;
const ROOT = '__root__';

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/relayout_nested.mjs <feature名 | json路径> [--html]');
  process.exit(1);
}
const jsonPath = arg.endsWith('.json')
  ? path.resolve(arg)
  : path.resolve('.design-canvas', 'features', arg + '.json');
if (!fs.existsSync(jsonPath)) {
  console.error('文件不存在: ' + jsonPath);
  process.exit(1);
}

const dsl = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const nodes = dsl.geometry.nodes;
const edges = dsl.geometry.edges || [];
const nodeById = new Map(nodes.map((n) => [n.id, n]));

// contains 层级
const childrenOf = new Map();
const parentOf = new Map();
const isContains = (e) => {
  const l = (e.label || '').toLowerCase();
  return l === 'contains' || e.label === '包含';
};
for (const e of edges) {
  if (!isContains(e) || !nodeById.has(e.from) || !nodeById.has(e.to)) continue;
  if (!childrenOf.has(e.from)) childrenOf.set(e.from, []);
  childrenOf.get(e.from).push(e.to);
  parentOf.set(e.to, e.from);
}
const depEdges = edges.filter((e) => !isContains(e));

// nid 属于 cid 的哪个直接子项（cid=ROOT 时返回根祖先）
function ownerOf(cid, nid) {
  let cur = nid;
  let guard = 0;
  while (cur && guard++ < 1000) {
    const p = parentOf.get(cur);
    if (p === cid) return cur;
    if (p === undefined) return cid === ROOT && nodeById.has(cur) ? cur : null;
    cur = p;
  }
  return null;
}

const localPos = new Map(); // 相对父容器内容原点的局部坐标
const sizeOf = new Map(); // 容器 → 紧凑包裹尺寸

function layoutContainer(cid) {
  const kids = (childrenOf.get(cid) || []).slice().sort();
  for (const k of kids) {
    if (childrenOf.has(k)) layoutContainer(k);
  }
  const items = kids.map((id) => {
    const n = nodeById.get(id);
    const s = sizeOf.get(id);
    return {
      id,
      w: s ? s.w : n.width || FILE_W,
      h: s ? s.h : n.height || FILE_H,
      x: 0,
      y: 0,
    };
  });
  const localDeps = [];
  for (const e of depEdges) {
    const a = ownerOf(cid, e.from);
    const b = ownerOf(cid, e.to);
    if (a && b && a !== b) localDeps.push([a, b]);
  }
  layoutGroup(items, localDeps);
  const maxX = Math.max(0, ...items.map((i) => i.x + i.w));
  const maxY = Math.max(0, ...items.map((i) => i.y + i.h));
  for (const it of items) localPos.set(it.id, { x: it.x, y: it.y });
  if (cid !== ROOT) {
    sizeOf.set(cid, { w: maxX + PAD * 2, h: maxY + PAD * 2 + TITLE_H });
  }
}

const roots = nodes.filter((n) => !parentOf.has(n.id)).map((n) => n.id);
childrenOf.set(ROOT, roots);
layoutContainer(ROOT);

// 汇总绝对坐标并回写容器尺寸
function place(id, baseX, baseY) {
  const lp = localPos.get(id) || { x: 0, y: 0 };
  const n = nodeById.get(id);
  const ax = baseX + lp.x;
  const ay = baseY + lp.y;
  n.x = ax;
  n.y = ay;
  if (childrenOf.has(id) && id !== ROOT) {
    const s = sizeOf.get(id);
    n.width = s.w;
    n.height = s.h;
    for (const k of childrenOf.get(id)) place(k, ax + PAD, ay + PAD + TITLE_H);
  }
}
for (const r of roots) place(r, MARGIN, MARGIN);

let maxX = 0;
let maxY = 0;
nodes.forEach((n) => {
  maxX = Math.max(maxX, n.x + (n.width || 0));
  maxY = Math.max(maxY, n.y + (n.height || 0));
});
// 回写画布尺寸：computeCanvasSize 优先使用 geometry.width/height，
// 腐坏数据残留的旧值会让 viewBox 与实际内容脱节（如 2380x68000 空画布）
dsl.geometry.width = maxX + MARGIN;
dsl.geometry.height = maxY + MARGIN;
fs.writeFileSync(jsonPath, JSON.stringify(dsl, null, 2));

console.log(
  `relayout done: ${nodes.length} nodes, ${childrenOf.size - 1} containers, extent ${dsl.geometry.width}x${dsl.geometry.height}`,
);

if (process.argv.includes('--html')) {
  const outDir = path.resolve('output');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, (dsl.feature || path.basename(jsonPath, '.json')) + '.html');
  fs.writeFileSync(out, renderHTML(dsl));
  console.log('html regenerated: ' + out);
}
