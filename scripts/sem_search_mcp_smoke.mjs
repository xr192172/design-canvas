// S3 冒烟：MCP semantic_search 工具注册 + 真实 embedding 调用
// 用法：npm run build && node scripts/sem_search_mcp_smoke.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = path.resolve('dist/src/server.js');
const ROOT = process.cwd();

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
});

const client = new Client({ name: 'sem-smoke', version: '1.0.0' });
await client.connect(transport);

// 1. 列出工具，确认 semantic_search 已注册
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log('[tools] semantic_search 已注册 =', names.includes('semantic_search'));
console.log('[tools] 工具总数 =', names.length);

// 2. 调用 semantic_search（真实 embedding：硅基流动 bge-m3）
const res = await client.callTool({
  name: 'semantic_search',
  arguments: { project_dir: ROOT, query: '审批一个设计变更', limit: 5 },
});
const text = res.content.map((c) => c.text).join('\n');
console.log('---- 调用结果 ----');
console.log(text);

const ok = names.includes('semantic_search') && /provider=semantic/.test(text);
console.log('\n[S3] 冒烟' + (ok ? '通过 ✓' : '失败 ✗'));
await client.close();
process.exit(ok ? 0 : 1);