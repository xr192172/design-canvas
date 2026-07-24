// 一次性：打印指定节点矩形与边路径，分析穿越几何
import fs from 'node:fs';

const file = process.argv[2] ?? 'output/self_import.html';
const ids = (process.argv[3] ?? '').split(',').filter(Boolean);
const edgeIds = (process.argv[4] ?? '').split(',').filter(Boolean);
const html = fs.readFileSync(file, 'utf-8');

const nodeRe = /<g class="node[^"]*" data-id="([^"]+)"[\s\S]*?<rect data-shape="true" x="([\d.-]+)" y="([\d.-]+)" width="([\d.-]+)" height="([\d.-]+)"/g;
let m;
while ((m = nodeRe.exec(html))) {
  if (ids.length && !ids.includes(m[1])) continue;
  console.log(`node ${m[1]}: x=${m[2]} y=${m[3]} w=${m[4]} h=${m[5]}  (right=${+m[2] + +m[4]}, bottom=${+m[3] + +m[5]})`);
}
const edgeRe = /<g class="edge" data-id="([^"]+)"[^>]*>\s*<path d="([^"]+)"/g;
while ((m = edgeRe.exec(html))) {
  if (edgeIds.length && !edgeIds.includes(m[1])) continue;
  console.log(`edge ${m[1]}: d=${m[2]}`);
}
