// S3 冒烟：MCP watch_project 工具注册 + 真实文件变更自动同步 + 实际 DSL 重建
// 用法：npm run build && node scripts/watch_project_mcp_smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('dist/src/server.js');
const ROOT = process.cwd();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
});

const client = new Client({ name: 'watch-smoke', version: '1.0.0' });
await client.connect(transport);

let ok = true;
const check = (name, cond) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
  if (!cond) ok = false;
};

// 1. 列出工具，确认 watch_project 已注册
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
check('watch_project 已注册', names.includes('watch_project'));

// 2. 建一个临时项目，start 监听（带 feature → 变更后重建实际 DSL）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mcp-'));
fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'export function alpha(): void {}\n', 'utf-8');
const feature = 'wsmoke';

// 先建缓存（import_project），否则 rebuild 无缓存可写
const imp = await client.callTool({ name: 'import_project', arguments: { project_dir: tmp, feature } });
console.log('[import]', imp.content.map((c) => c.text).join('\n').split('\n')[0]);

const start = await client.callTool({ name: 'watch_project', arguments: { project_dir: tmp, feature } });
const startText = start.content.map((c) => c.text).join('\n');
console.log('---- start ----\n' + startText);
check('start 返回 watching=true', /watching=true/.test(startText));

// 3. 触发一次文件变更 → 轮询 status 直到 last_rebuild_at 出现（rebuild 有 2000ms 节流窗口）
fs.writeFileSync(path.join(tmp, 'src/a.ts'), 'export function alpha(): void {}\n\nexport function beta(): void {}\n', 'utf-8');
let statusText = '';
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300));
  const s = await client.callTool({ name: 'watch_project', arguments: { project_dir: tmp, action: 'status' } });
  statusText = s.content.map((c) => c.text).join('\n');
  if (/last_rebuild_at=/.test(statusText)) break;
}
console.log('---- status ----\n' + statusText);
check('status 返回 watching=true', /watching=true/.test(statusText));
check('捕获到变更批次', /last_batch: changed=\d+/.test(statusText));
check('rebuild 已收敛执行（last_rebuild_at 出现）', /last_rebuild_at=/.test(statusText));

// 4. 实际 DSL 已重建到 live/（live_only 不覆盖设计 DSL）
const liveFile = path.join(tmp, '.design-canvas', 'live', feature + '.dsl.json');
check('实际 DSL 已生成到 live/', fs.existsSync(liveFile));
if (fs.existsSync(liveFile)) {
  const liveDsl = JSON.parse(fs.readFileSync(liveFile, 'utf-8'));
  check('实际 DSL _sync.source=live', liveDsl._sync && liveDsl._sync.source === 'live');
  check('实际 DSL 含 beta 符号', JSON.stringify(liveDsl).includes('beta'));
}

// 5. stop → status 应 watching=false
const stop = await client.callTool({ name: 'watch_project', arguments: { project_dir: tmp, action: 'stop' } });
const stopText = stop.content.map((c) => c.text).join('\n');
console.log('---- stop ----\n' + stopText);
check('stop 返回 watching=false', /watching=false/.test(stopText));
const status2 = await client.callTool({ name: 'watch_project', arguments: { project_dir: tmp, action: 'status' } });
check('stop 后 status watching=false', /watching=false/.test(status2.content.map((c) => c.text).join('\n')));

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
await client.close();
console.log('\n[S3] watch_project 冒烟' + (ok ? '通过 ✓' : '失败 ✗'));
process.exit(ok ? 0 : 1);