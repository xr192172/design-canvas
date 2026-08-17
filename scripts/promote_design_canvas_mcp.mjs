// promote_design_canvas_mcp.mjs — 把 design-canvas 注册为 TRAE 用户级（全局）MCP。
// 核心修复：用户级配置里的 ${workspaceFolder} 会解析成「当前打开的工作区」，
// 导致在非 design-canvas 窗口（如 ai-base）加载不到。改为绝对路径后真正全局可用。
//
// 用法：node scripts/promote_design_canvas_mcp.mjs
// 写前自动备份到同目录 mcp.json.design-canvas.bak
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const server = path.join(ROOT, 'dist', 'src', 'server.js').replaceAll('\\', '/');

const mcpPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae Solo CN', 'User', 'mcp.json');

if (!fs.existsSync(mcpPath)) {
  console.error(`[promote-mcp] 找不到用户级 MCP 配置: ${mcpPath}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'dist', 'src', 'server.js'))) {
  console.error('[promote-mcp] dist/src/server.js 不存在，请先 npm run build');
  process.exit(1);
}

const raw = fs.readFileSync(mcpPath, 'utf8');
const cfg = JSON.parse(raw);

cfg.mcpServers = cfg.mcpServers || {};
const old = cfg.mcpServers['design-canvas'];
cfg.mcpServers['design-canvas'] = {
  command: 'node',
  args: [server],
  env: { DESIGN_CANVAS_HOME: ROOT.replaceAll('\\', '/') },
};

// 备份原始文件
const bak = mcpPath + '.design-canvas.bak';
fs.copyFileSync(mcpPath, bak);

fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`[promote-mcp] 已更新用户级 MCP 配置: ${mcpPath}`);
console.log(`[promote-mcp] design-canvas server -> ${server}`);
console.log(`[promote-mcp] DESIGN_CANVAS_HOME -> ${ROOT}`);
console.log(`[promote-mcp] 原配置已备份到: ${bak}`);
if (old && old.args && old.args[0]?.includes('${workspaceFolder}')) {
  console.log('[promote-mcp] 注意：已把 ${workspaceFolder} 相对路径改为绝对路径（此前会导致非本窗口加载失败）');
}
