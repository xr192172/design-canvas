// npm run hub：一键启动 design-canvas Hub（人类入口）
// 流程：dist 缺失→build → output/index.html 缺失→self-analyze 生成 → 起 serve → 自动开浏览器
// 用法：npm run hub        （默认 3000 端口）
//       npm run hub 8081   （指定端口）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = parseInt(process.argv[2]) || 3000;
const BASE_URL = `http://localhost:${PORT}`;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))));
  });
}

async function waitReady(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url) {
  const plat = process.platform;
  const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
  const args = plat === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// 0. 端口已有服务？直接复用，不重复起
if (await waitReady(BASE_URL, 1200)) {
  console.log(`[hub] 端口 ${PORT} 已有服务在跑，直接打开 ${BASE_URL}`);
  openBrowser(BASE_URL);
  process.exit(0);
}

// 1. dist 缺失 → 先构建
if (!fs.existsSync(path.join('dist', 'src', 'tools', 'serve.js'))) {
  console.log('[hub] dist 不存在，先 npm run build …');
  await run('npm', ['run', 'build']);
}

// 2. Hub 主页缺失 → 先生成自我分析报告
if (!fs.existsSync(path.join('output', 'index.html'))) {
  console.log('[hub] output/index.html 不存在，先生成自我分析报告 …');
  await run('node', ['scripts/self_analyze.mjs']);
}

// 3. 起 serve（前台常驻）
console.log(`[hub] 启动服务（端口 ${PORT}）…  Ctrl+C 停止`);
const server = spawn('node', [path.join('dist', 'src', 'tools', 'serve.js'), String(PORT)], { stdio: 'inherit' });
server.on('close', (code) => process.exit(code ?? 0));

// 4. 服务就绪后自动开浏览器
if (await waitReady(BASE_URL, 15000)) {
  console.log(`[hub] 已就绪，打开 ${BASE_URL}`);
  openBrowser(BASE_URL);
} else {
  console.warn(`[hub] 等待服务就绪超时，请手动打开 ${BASE_URL}`);
}
