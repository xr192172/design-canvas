/* 临时探针：MCP stdio 冒烟 —— 验证 canvas-notes Resource + read_canvas_notes/mark_canvas_notes_status 工具注册 */
import { spawn } from 'node:child_process';

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
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});

await new Promise((r) => setTimeout(r, 800));

await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '1.0' },
});
await send('notifications/initialized', {});

const tools = await send('tools/list', {});
const toolNames = tools.result.tools.map((t) => t.name);
console.log('工具总数:', toolNames.length);
console.log('read_canvas_notes:', toolNames.includes('read_canvas_notes') ? '✅' : '❌');
console.log('mark_canvas_notes_status:', toolNames.includes('mark_canvas_notes_status') ? '✅' : '❌');

const resources = await send('resources/list', {});
console.log('resources/list 响应:', JSON.stringify(resources, null, 1));

const readRes = await send('resources/read', { uri: 'design-canvas://design-canvas/notes' });
const text = readRes.result?.contents?.[0]?.text ?? '';
console.log('Resource read 响应:', JSON.stringify(readRes, null, 1).slice(0, 300));
console.log('Resource read 前缀:', JSON.stringify(text.slice(0, 120)));
console.log(text.includes('批注工单') ? '✅ Resource 返回 Markdown 工单' : '⚠️ 无批注（返回空文档）');

child.kill();
process.exit(0);
