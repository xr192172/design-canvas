/* 临时探针：批注语义化闭环验证（resolveCanvasNotesFromDSL → renderCanvasNotesDigest → markCanvasNotesStatus）
 * 在真实 design-canvas DSL 上注入合成批注，覆盖 锚定文件 / 坐标命中 / 空白批注 / 状态闭环。 */
import { readFileSync } from 'node:fs';
import { resolveCanvasNotesFromDSL, renderCanvasNotesDigest, markCanvasNotesStatus } from './dist/src/tools/derive_mind_map.js';

const FEATURE = 'design-canvas';
const dsl = JSON.parse(readFileSync('.design-canvas/live/design-canvas.dsl.json', 'utf-8'));

// 找一个真实文件节点做锚定；找一个几何节点坐标做命中
const fileId = 'file_camera_chain_ts';
const geo = (dsl.geometry?.nodes ?? []).find((n) => n.id === 'dir_tools_ts_kernel');
const hitX = geo ? geo.x + 10 : 0;
const hitY = geo ? geo.y + 10 : 0;

dsl.canvas_notes = [
  // 1. 锚定文件节点（anchor 优先）
  { id: 'n1', groupId: 'g1', type: 'highlight', anchor: { nodeId: fileId }, text: '这里 rebuildChains 的 chain 匹配阈值建议调高', color: '#ffd666', status: 'open', created: new Date().toISOString() },
  // 2. 坐标命中 dir_tools_ts_kernel（via=hit）
  { id: 'n2', groupId: 'g2', type: 'arrow', points: [[hitX + 100, hitY], [hitX, hitY]], text: '这个目录的探针文件职责描述模糊', color: '#ff7875' },
  // 3. 空白处批注（无目标）
  { id: 'n3', type: 'sticky', x: 99999, y: 99999, text: '整体拆分方案待定', color: '#69b1ff' },
  // 4. 已处理批注（状态透传）
  { id: 'n4', groupId: 'g4', type: 'highlight', anchor: { nodeId: fileId }, text: '已确认无需改', status: 'done' },
];

const resolved = resolveCanvasNotesFromDSL(dsl, FEATURE);
console.log(`\n==== resolveCanvasNotesFromDSL：${resolved.length} 条 ====`);
for (const r of resolved) {
  console.log(`  [${r.id}] status=${r.status} type=${r.type} target=${r.target ? r.target.kind + ':' + (r.target.file?.path ?? r.target.step?.title ?? r.target.feature ?? r.target.nodeId) + ' via=' + r.target.via : 'null(空白)'} text=${r.text || ''}`);
}

const digest = renderCanvasNotesDigest(FEATURE, resolved);
console.log(`\n==== renderCanvasNotesDigest：total=${digest.total} open=${digest.open} done=${digest.done} rejected=${digest.rejected} ====`);
console.log('---- Markdown ----');
console.log(digest.markdown.split('\n').slice(0, 30).join('\n'));
const j = JSON.parse(digest.json);
console.log(`---- JSON 校验 ---- items=${j.items.length} fields=${Object.keys(j).join(',')}`);

// 状态闭环：把 g2 标 done、g4 标 rejected
const updated = markCanvasNotesStatus({ ...dsl, canvas_notes: [...dsl.canvas_notes] }, [
  { id: 'g2', status: 'done' },
  { id: 'g4', status: 'rejected' },
]);
console.log(`\n==== markCanvasNotesStatus ====`);
for (const n of updated) console.log(`  [${n.id}] group=${n.groupId || '-'} status=${n.status}`);
const doneCount = updated.filter((n) => n.status === 'done').length;
const rejCount = updated.filter((n) => n.status === 'rejected').length;
console.log(`  断言: done=${doneCount}(期望1) rejected=${rejCount}(期望1)`);
console.log(doneCount === 1 && rejCount === 1 ? '  ✅ 状态闭环通过' : '  ❌ 状态闭环失败');
