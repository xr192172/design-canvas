/**
 * daemon 端到端冒烟（方向 E）：真进程全链验证
 *
 * 链路：临时项目 import → daemon 启动 → declare 预告 → 改文件 → violated 定损
 *       → SSE/游标双通道播报 → loop 自动回流（spawn camera-dsl）→ 新提案 → 优雅退出
 *
 * 运行：npm run build && node scripts/e2e_daemon.mjs
 * 退出码 0 = 全链通过。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonJs = path.join(repoRoot, 'dist', 'src', 'daemon', 'daemon.js');
const PORT = 17600;
const BASE = `http://127.0.0.1:${PORT}`;

let failed = 0;
const step = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '✗ FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. 临时项目：两个文件 + importProject 建 cache.db ──────────
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-daemon-'));
const put = (rel, content) => {
  const abs = path.join(proj, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
};
put('src/a.ts', `import { b } from './b';\nexport function a(x: number): number { return b(x); }\n`);
put('src/b.ts', `export function b(x: number): number { return x * 2; }\n`);
// c 是孤立文件：不在 declare(a) 的预告波及面内，改它必然产生计划外扩散
put('src/c.ts', `export function c(x: number): number { return x + 1; }\n`);

const { importProject } = await import(`file:///${path.join(repoRoot, 'dist', 'src', 'tools', 'import_project.js').replace(/\\/g, '/')}`);
const { openDb } = await import(`file:///${path.join(repoRoot, 'dist', 'src', 'db', 'db.js').replace(/\\/g, '/')}`);
const db = openDb(path.join(proj, '.design-canvas', 'cache.db'));
await importProject({ project_dir: proj, feature: 'e2e_daemon', cache_db: db });
db.close();
console.log(`项目就绪：${proj}（cache.db 已建）`);

// ── 2. daemon 启动（随机测试端口）────────────────────────────
const daemon = spawn(process.execPath, [daemonJs], {
  env: { ...process.env, DC_DAEMON_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let daemonLog = '';
daemon.stdout.on('data', (d) => { daemonLog += d; });
daemon.stderr.on('data', (d) => { daemonLog += d; });

// 就绪等待：health 通
let health = null;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  try {
    const r = await fetch(`${BASE}/api/health`);
    if (r.ok) { health = await r.json(); break; }
  } catch { /* 未就绪 */ }
}
step('daemon 启动 + /api/health', health !== null && health.ok === true,
  health ? `pid=${health.pid} watches=${health.watches.length}` : daemonLog.split('\n')[0]);

// 幂等：第二个 daemon 实例应自行退出
const dup = spawn(process.execPath, [daemonJs], {
  env: { ...process.env, DC_DAEMON_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
const dupExit = new Promise((res) => dup.on('exit', (code) => res(code)));
const dupCode = await Promise.race([dupExit, sleep(5000).then(() => 'timeout')]);
step('幂等：二次启动自行退出', dupCode === 0, `exit=${dupCode}`);

// ── 3. SSE 订阅（后台持续收集事件名）──────────────────────────
const sseEvents = [];
const ctrl = new AbortController();
(async () => {
  try {
    const res = await fetch(`${BASE}/api/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (const m of buf.matchAll(/event: (\S+)\ndata: (.+)\n/g)) {
        sseEvents.push({ event: m[1], data: m[2] });
      }
      buf = buf.slice(Math.max(0, buf.length - 4096));
    }
  } catch { /* abort */ }
})();
await sleep(500);
step('SSE 连接 + connected 握手', sseEvents.some((e) => e.event === 'connected'));

// ── 4. declare 预告（daemon 转发到权威注册表）──────────────────
const decl = await (await fetch(`${BASE}/api/watch`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project_dir: proj, action: 'declare', files: ['src/a.ts'] }),
})).json();
step('declare 改前预告（via daemon）', decl.watching === true && typeof decl.ledger_entry_id === 'string',
  decl.message?.slice(0, 80));

// ── 5. 改未预告文件 src/c.ts → 应 violated（计划外扩散）────────
// （declare 预告的是 src/a.ts，波及面 {a,b}；c 孤立不在面内 → 必然计划外扩散）
put('src/c.ts', `export function c(x: number): number { return x + 2; }\n`);

// 等 doWork（debounce 150ms + throttle 2000ms + 余量）
let alerts = [];
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const r = await (await fetch(`${BASE}/api/alerts?since=0`)).json();
  if (r.alerts.some((a) => a.line.includes('计划外扩散'))) { alerts = r.alerts; break; }
}
step('violated 定损 → 游标通道收到计划外扩散', alerts.some((a) => a.line.includes('计划外扩散')),
  alerts[0]?.line?.slice(0, 90) ?? '（超时未见）');
step('SSE 通道收到 ledger-violated', sseEvents.some((e) => e.event === 'ledger-violated'));
if (!alerts.some((a) => a.line.includes('计划外扩散'))) {
  // 诊断：watch status 看 error / last_change / 报告状态
  try {
    const st = await (await fetch(`${BASE}/api/watch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_dir: proj, action: 'status' }),
    })).json();
    console.log('--- 诊断 watch status ---\n' + JSON.stringify({ watching: st.watching, last_change_at: st.last_change_at, last_impact_seq: st.last_impact_seq, error: st.error, alerts: st.alerts, pending: st.pending_declarations }, null, 2));
  } catch (e) {
    console.log('--- 诊断 status 失败: ' + e.message);
  }
}

// ── 6. loop 自动回流：violated → 防抖 10s → spawn camera-dsl ──
// （findCameraDslBin 探测仓库内 go-camera/build/camera-dsl.exe）
let loopProposalOrDone = false;
let loopDetail = '';
for (let i = 0; i < 50; i++) {
  await sleep(1000);
  const ev = sseEvents.filter((e) => e.event.startsWith('loop-'));
  const proposal = ev.find((e) => e.event === 'loop-proposal');
  const skipped = ev.find((e) => e.event === 'loop-skipped');
  const done = ev.find((e) => e.event === 'loop-done');
  if (proposal) { loopProposalOrDone = true; loopDetail = '新提案：' + proposal.data.slice(0, 100); break; }
  if (done || skipped) { loopProposalOrDone = true; loopDetail = (skipped ? '跳过：' : '完成：') + (skipped ?? done).data.slice(0, 120); break; }
}
step('loop 自动触发（violated → camera-dsl loop）', loopProposalOrDone, loopDetail || '（超时未见 loop-* 事件）');

// ── 7. 优雅退出：POST /api/shutdown → flush → pidfile 清理 ──
// （Windows 无 POSIX 信号，daemon.kill() 是硬终止不走优雅流程）
try {
  await fetch(`${BASE}/api/shutdown`, { method: 'POST' });
} catch { /* server 关闭中连接重置，无碍 */ }
let exited = false;
for (let i = 0; i < 50; i++) {
  await sleep(200);
  if (daemon.exitCode !== null) { exited = true; break; }
}
const pidfile = path.join(os.tmpdir(), `design-canvas-daemon-${PORT}.pid`);
step('POST /api/shutdown 优雅退出', exited && daemon.exitCode === 0, `exitCode=${daemon.exitCode}`);
step('pidfile 已清理', !fs.existsSync(pidfile));
ctrl.abort();

// ── 收尾 ─────────────────────────────────────────────────────
if (failed === 0) {
  console.log('\nE2E 全链通过（9 步）');
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* Windows 占用 */ }
  process.exit(0);
}
console.log(`\nE2E 失败 ${failed} 步`);
console.log('--- daemon log ---\n' + daemonLog);
try {
  console.log('--- ledger.json ---\n' + fs.readFileSync(path.join(proj, '.design-canvas', 'impact', 'ledger.json'), 'utf-8'));
} catch { /* 无 ledger */ }
try { fs.rmSync(proj, { recursive: true, force: true }); } catch { /* Windows 占用 */ }
process.exit(1);
