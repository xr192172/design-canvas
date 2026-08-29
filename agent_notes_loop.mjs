/* 阶段C · 外部 agent 接入验证：模拟外部 agent 通过 MCP 消费批注工单并闭环
 *
 * 这是「信息返回给 LLM」的最终消费形态骨架：
 *   agent(本脚本=MCP 客户端) → stdio 连 MCP server → read_canvas_notes 读语义工单
 *   → 决策(此处用规则模拟，未来可替换为真 LLM 调用) → mark_canvas_notes_status 闭环
 *   → 回读验证状态归组
 *
 * 依赖：node dist/src/server.js（MCP server，与 3100 HTTP serve 共享同一 DSL 存储）
 * 运行：node agent_notes_loop.mjs
 */
import { spawn } from 'node:child_process';

const FEATURE = 'design-canvas';
const HTTP = 'http://127.0.0.1:3100';

async function httpPost(path, payload) {
  const res = await fetch(HTTP + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return res.json();
}
async function httpGet(path) {
  return (await fetch(HTTP + path)).json();
}

/* ---------- MCP stdio 客户端 ---------- */
const child = spawn('node', ['dist/src/server.js'], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
let id = 0;
const pending = new Map();
function send(method, params) {
  const msg = { jsonrpc: '2.0', id: ++id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve) => pending.set(id, resolve));
}
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
function parseToolResult(res) {
  const text = res?.result?.content?.[0]?.text ?? '';
  const sep = '---DATA---';
  const i = text.indexOf(sep);
  if (i >= 0) return { message: text.slice(0, i).trim(), data: JSON.parse(text.slice(i + sep.length).trim()) };
  return { message: text, data: null };
}
await new Promise((r) => setTimeout(r, 800));

const ok = [];
const fail = [];
function check(name, cond, detail = '') {
  (cond ? ok : fail).push(name);
  console.log(`  ${cond ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
}

/* ---------- 0. 预置：清空 + 写 2 条 open 批注（锚定到真实文件节点 → digest 有 L1-L4 上下文） ---------- */
await httpPost('/api/canvas-notes', { feature: FEATURE, canvas_notes: [] });
await httpPost('/api/canvas-notes', {
  feature: FEATURE,
  canvas_notes: [
    { id: 'ag-1', groupId: 'ag-g1', type: 'highlight', anchor: { nodeId: 'file_camera_chain_ts' }, points: [[100, 100], [150, 120], [200, 100]], text: 'rebuildChains 匹配阈值待评估', color: '#fbbf24', status: 'open' },
    { id: 'ag-2', groupId: 'ag-g2', type: 'sticky', x: 320, y: 220, w: 160, h: 104, text: 'camera_chain 的入口参数校验缺失', color: '#fde68a', status: 'open' },
  ],
});
console.log('[0] 预置 2 条 open 批注（锚定真实文件节点）');

/* ---------- 1. MCP 握手 + 工具可见性 ---------- */
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'external-agent-probe', version: '1.0' } });
await send('notifications/initialized', {});
const tools = (await send('tools/list', {})).result.tools.map((t) => t.name);
check('工具已注册 read_canvas_notes', tools.includes('read_canvas_notes'));
check('工具已注册 mark_canvas_notes_status', tools.includes('mark_canvas_notes_status'));

/* ---------- 2. agent 读批注工单（JSON 结构化，捆绑 L1-L4 上下文） ---------- */
const read = parseToolResult(await send('tools/call', {
  name: 'read_canvas_notes',
  arguments: { feature: FEATURE, format: 'json' },
}));
const data = read.data;
check('read_canvas_notes 返回 2 条', data.total === 2, `total=${data.total} open=${data.open}`);
const first = data.notes[0];
console.log('  工单示例（agent 可见语义上下文）:');
console.log('    id=' + first.id, '| status=' + first.status, '| type=' + first.type);
console.log('    text=' + first.text);
if (first.target) {
  const t = first.target;
  console.log('    target: ' + [t.feature && `功能「${t.feature}」`, t.step && `步骤${t.step.seq}「${t.step.title}」`, t.file && `文件 ${t.file.path}`, t.detail?.responsibility && `职责:${t.detail.responsibility}`, t.detail?.layer && `分层:${t.detail.layer}`, t.detail?.inputs?.length && `入针:${t.detail.inputs.join('、')}`, t.detail?.outputs?.length && `出针:${t.detail.outputs.join('、')}`].filter(Boolean).join(' | '));
}
check('工单携带 L1-L4 上下文', !!first.target && !!(first.target.feature || first.target.file || first.target.step));

/* ---------- 3. agent 决策并闭环：ag-1 标 done（已处理），ag-2 标 rejected（已驳回） ---------- */
console.log('[3] agent 决策 → mark_canvas_notes_status');
const mark = parseToolResult(await send('tools/call', {
  name: 'mark_canvas_notes_status',
  arguments: {
    feature: FEATURE,
    updates: [
      { id: 'ag-1', status: 'done' },
      { id: 'ag-2', status: 'rejected' },
    ],
  },
}));
check('mark 返回成功', !mark.message.startsWith('Error') && !mark.message.includes('缺少'), (mark.message || '').slice(0, 60));

/* ---------- 4. 回读验证：状态归组正确 ---------- */
const read2 = parseToolResult(await send('tools/call', {
  name: 'read_canvas_notes',
  arguments: { feature: FEATURE, format: 'json' },
}));
const d2 = read2.data;
check('回读 open=0 done=1 rejected=1', d2.open === 0 && d2.done === 1 && d2.rejected === 1, `open=${d2.open} done=${d2.done} rejected=${d2.rejected}`);
const s1 = d2.notes.find((n) => n.id === 'ag-g1').status;
const s2 = d2.notes.find((n) => n.id === 'ag-g2').status;
check('ag-1=done / ag-2=rejected', s1 === 'done' && s2 === 'rejected', `${s1}/${s2}`);

/* ---------- 5. HTTP 侧共享存储一致性（MCP 写入 → 3100 digest 可见） ---------- */
const digest = await httpGet('/api/canvas-notes/digest?feature=' + FEATURE);
check('HTTP digest 与 MCP 状态一致', digest.open === 0 && digest.done === 1 && digest.rejected === 1, `open=${digest.open} done=${digest.done} rejected=${digest.rejected}`);
const md = digest.markdown;
check('digest 已处理段含 ag-1 文字', md.includes('rebuildChains 匹配阈值待评估') && md.includes('已处理'));
check('digest 已驳回段含 ag-2 文字', md.includes('camera_chain 的入口参数校验缺失') && md.includes('已驳回'));

/* ---------- 6. 清理还原 ---------- */
await httpPost('/api/canvas-notes', { feature: FEATURE, canvas_notes: [] });
console.log('[6] 已清理还原');

child.kill();
console.log(`\n==== 外部 agent 接入验证 ${fail.length === 0 ? '通过 ✅' : '失败 ❌'}：${ok.length}/${ok.length + fail.length} ====`);
if (fail.length) { console.log('失败项:', fail.join('、')); process.exit(1); }
process.exit(0);
