/* 临时探针：端到端 API 闭环（serve:3100）
 * 画批注(POST) → 读语义文档(GET digest) → 标 done(POST status) → 读回验证 → 清理还原 */
const BASE = 'http://localhost:3100';
const FEATURE = 'design-canvas';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const j = await res.json();
  return { status: res.status, j };
}

// 1. 画批注：一条 open（锚定文件），一条 done（锚定文件）
const notes = [
  { id: 'e2e-1', groupId: 'e2e-g1', type: 'highlight', anchor: { nodeId: 'file_camera_chain_ts' }, points: [[100, 100], [150, 120], [200, 100]], text: 'E2E 验收：rebuildChains 匹配阈值待评估', color: '#fbbf24', status: 'open', created: new Date().toISOString() },
  { id: 'e2e-2', groupId: 'e2e-g2', type: 'sticky', x: 300, y: 200, w: 160, h: 104, text: 'E2E 验收：这条已处理', color: '#fde68a', status: 'done', created: new Date().toISOString() },
];
let r = await api('/api/canvas-notes', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feature: FEATURE, canvas_notes: notes }),
});
console.log('[1] POST canvas-notes:', r.status, JSON.stringify(r.j));

// 2. 读语义文档
r = await api('/api/canvas-notes/digest?feature=' + FEATURE);
console.log('[2] GET digest:', r.status, `total=${r.j.total} open=${r.j.open} done=${r.j.done}`);
console.log('    ---- Markdown 头部 ----');
console.log(r.j.markdown.split('\n').slice(0, 16).join('\n'));

// 3. 标 done：把 e2e-g1 标 done
r = await api('/api/canvas-notes/status', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feature: FEATURE, updates: [{ id: 'e2e-g1', status: 'done' }] }),
});
console.log('[3] POST status:', r.status, JSON.stringify(r.j));

// 4. 读回验证状态
r = await api('/api/canvas-notes?feature=' + FEATURE);
const doneIds = r.j.canvas_notes.filter((n) => n.status === 'done').map((n) => n.id);
console.log('[4] GET canvas-notes:', r.status, 'done 图元:', JSON.stringify(doneIds));
console.log(doneIds.includes('e2e-1') ? '   ✅ e2e-1 已标 done（持久化成功）' : '   ❌ e2e-1 未标 done');

// 5. 清理还原（保持仓库干净）
r = await api('/api/canvas-notes', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ feature: FEATURE, canvas_notes: [] }),
});
console.log('[5] 清理还原 canvas_notes:', r.status, JSON.stringify(r.j));
