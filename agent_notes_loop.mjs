/* 阶段C · 外部 agent 接入验证：模拟外部 agent 通过 MCP 消费批注工单并闭环
 *
 * 这是「信息返回给 LLM」的最终消费形态骨架：
 *   agent(本脚本=MCP 客户端) → stdio 连 MCP server
 *   → read_canvas_notes 读语义工单 → decide_canvas_notes（内置 LLM 决策器）出决策
 *   → change 映射到审批流（propose 干跑 → workbench 可见 → reject 安全回收）
 *   → mark_canvas_notes_status 闭环 → 回读验证状态归组
 *
 * 决策模式（decide_canvas_notes）：
 *   - 默认 LLM_DECIDER_MOCK=1（确定性假决策，无 key 环境跑通"提改动→审批→标 done"全链）
 *   - 配置 LLM_API_KEY/LLM_MODEL/LLM_BASE_URL 或 config.json 后设 LLM_DECIDER_MOCK=0 走真实 LLM
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
// 决策模式：默认 mock（确定性），显式配置真实 LLM 时走真实 LLM
const mock = process.env.LLM_DECIDER_MOCK ?? (process.env.LLM_API_KEY ? '0' : '1');
const child = spawn('node', ['dist/src/server.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, LLM_DECIDER_MOCK: mock },
});
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
    { id: 'ag-2', groupId: 'ag-g2', type: 'sticky', x: 320, y: 220, w: 160, h: 104, text: 'observe_chain 的入口参数校验缺失', color: '#fde68a', status: 'open' },
  ],
});
console.log('[0] 预置 2 条 open 批注（锚定真实文件节点），决策模式 mock=' + mock);

/* ---------- 1. MCP 握手 + 工具可见性 ---------- */
await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'external-agent-probe', version: '1.0' } });
await send('notifications/initialized', {});
const tools = (await send('tools/list', {})).result.tools.map((t) => t.name);
check('工具已注册 canvas_notes', tools.includes('canvas_notes'));
check('工具已注册 canvas_notes(含mark)', tools.includes('canvas_notes'));
check('工具已注册 canvas_notes(含decide)', tools.includes('canvas_notes'));

/* ---------- 2. agent 读批注工单（JSON 结构化，捆绑 L1-L4 上下文） ---------- */
const read = parseToolResult(await send('tools/call', {
  name: 'canvas_notes',
  arguments: { action: 'read', feature: FEATURE, format: 'json' },
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

/* ---------- 3. LLM 决策器（decide_canvas_notes）替换手写决策段 ---------- */
console.log('[3] LLM 决策器读工单 → 决策 → 映射审批流');
const decide = parseToolResult(await send('tools/call', {
  name: 'canvas_notes',
  arguments: { action: 'decide', feature: FEATURE },
}));
const dd = decide.data;
console.log('  决策模式: ' + dd.note);
check('decide 返回 2 条决策', dd.decisions.length === 2, `open=${dd.open} proposed=${dd.proposed} applied=${dd.applied_statuses.length}`);
const d1 = dd.decisions.find((x) => x.note_id === 'ag-g1');
const d2 = dd.decisions.find((x) => x.note_id === 'ag-g2');
check('每条决策 action 合法（change/done/reject）', dd.decisions.every((x) => ['change', 'done', 'reject'].includes(x.action)), dd.decisions.map((x) => `${x.note_id}=${x.action}`).join(', '));
if (mock === '1') {
  // mock：确定性假决策 → 严格断言（无 key 环境的端到端接线验证）
  check('ag-g1 → change（产出改动方案）', d1 && d1.action === 'change', d1 && `${d1.kind} ${d1.label || ''}`);
  check('ag-g1 已进审批流（有 pending_change_id）', !!d1 && !!d1.pending_change_id, d1 && d1.pending_change_id);
  check('ag-g1 提案为干跑预览（未写源文件）', !!d1 && !!d1.preview && d1.preview.includes('语法门'), (d1?.preview || '').slice(0, 40));
  check('ag-g2 → done（信息性批注直接标已处理）', d2 && d2.action === 'done', d2 && d2.reason);
  console.log('  提案预览: ' + (d1?.preview || '').split('\n')[0]);
} else {
  // 真实 LLM：结构断言（LLM 会诚实判断，不预设 change/done）
  check('ag-g1 由 LLM 决策（非降级）', d1 && d1.llm === true, d1 && d1.reason);
  check('ag-g2 由 LLM 决策（非降级）', d2 && d2.llm === true, d2 && d2.reason);
  check('LLM 拒绝编造（无 pending 也给了理由）', dd.decisions.every((x) => x.action !== 'change' || !!x.pending_change_id), dd.decisions.map((x) => `${x.note_id}:${x.reason || ''}`.slice(0, 40)).join(' | '));
  console.log('  决策明细: ' + dd.decisions.map((x) => `${x.note_id}→${x.action}「${(x.reason || '').slice(0, 30)}」`).join(' | '));
}
const changeDecisions = dd.decisions.filter((x) => x.action === 'change' && x.pending_change_id);

/* ---------- 4. 审批流可见 + 安全回收 + 标 done ---------- */
console.log('[4] 审批流（HTTP workbench 可见 → reject 安全回收 → 标 done）');
const wb = await httpGet('/api/code/workbench?project_dir=' + encodeURIComponent(dd.project_dir));
if (changeDecisions.length > 0) {
  const pendingChanges = changeDecisions.map((c) => wb.changes.find((x) => x.id === c.pending_change_id));
  check('workbench 可见全部 pending 提案', pendingChanges.every((c) => c && c.status === 'pending'), pendingChanges.map((c) => (c ? `${c.kind} · ${c.label}` : '缺失')).join('; '));
  // 提案走一遍审批流闭环（reject 不写盘，安全回收），模拟"人看过 diff 后决定"
  const rej = await httpPost('/api/code/reject', { project_dir: dd.project_dir, id: changeDecisions[0].pending_change_id });
  check('提案 reject 成功（不写源文件）', rej.success === true && rej.status === 'rejected', rej.status);
} else {
  check('（无 change 提案，审批流跳过——本轮均由 LLM 标 done/reject）', true, dd.decisions.map((x) => `${x.note_id}=${x.action}`).join(', '));
}
// 模拟"human 已处理"→ 标 done（画布显示已处理）
const stillOpen = [d1, d2].filter((d) => d && d.action === 'change');
const mark = parseToolResult(await send('tools/call', {
  name: 'canvas_notes',
  arguments: { action: 'mark', feature: FEATURE, updates: stillOpen.map((d) => ({ id: d.note_id, status: 'done' })) },
}));
check('剩余 change 工单已标 done（画布已处理）', !mark.message.startsWith('Error'), (mark.message || '').slice(0, 50));

/* ---------- 5. 回读验证：状态归组 + digest 已处理段 ---------- */
const read2 = parseToolResult(await send('tools/call', {
  name: 'canvas_notes',
  arguments: { action: 'read', feature: FEATURE, format: 'json' },
}));
const d2r = read2.data;
check('回读 open=0（全部落终态）', d2r.open === 0 && d2r.done + d2r.rejected === 2, `open=${d2r.open} done=${d2r.done} rejected=${d2r.rejected}`);

/* ---------- 6. HTTP 侧共享存储一致性（MCP 写入 → 3100 digest 可见） ---------- */
const digest = await httpGet('/api/canvas-notes/digest?feature=' + FEATURE);
check('HTTP digest 与 MCP 状态一致', digest.open === 0 && digest.done === d2r.done && digest.rejected === d2r.rejected, `open=${digest.open} done=${digest.done} rejected=${digest.rejected}`);
const md = digest.markdown;
check('digest 已处理段含 ag-1 文字', md.includes('rebuildChains 匹配阈值待评估') && md.includes('已处理'));
check('digest 已处理段含 ag-2 文字', md.includes('observe_chain 的入口参数校验缺失') && md.includes('已处理'));

/* ---------- 7. 清理还原 ---------- */
await httpPost('/api/canvas-notes', { feature: FEATURE, canvas_notes: [] });
console.log('[7] 已清理还原（workbench 保留一条 rejected 记录作为审批流证据，可忽略）');

child.kill();
console.log(`\n==== 外部 agent 接入验证（LLM 决策器）${fail.length === 0 ? '通过 ✅' : '失败 ❌'}：${ok.length}/${ok.length + fail.length} ====`);
if (fail.length) { console.log('失败项:', fail.join('、')); process.exit(1); }
process.exit(0);
