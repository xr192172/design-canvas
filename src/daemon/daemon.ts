/**
 * design-canvas daemon（方向 E）—— watch/影响播报/loop 回流的常驻宿主进程
 *
 * 启动：npm run daemon（node dist/src/daemon/daemon.js）
 * 端口：127.0.0.1:7600（DC_DAEMON_PORT 可配）；pidfile 落 OS tmpdir
 *
 * 为什么需要 daemon（此前"伪常驻"的三个断点）：
 *   1. watch 注册表挂在 MCP stdio 进程内存——LLM 会话重启全丢；daemon 独立
 *      生命周期，注册表跨会话存活（Ledger 本就落盘，配合后状态完全连续）
 *   2. serve 与 MCP 各自跑 watch 实例互不知情（重复同步）；daemon 单实例权威
 *   3. alert 单订阅互抢（takeAlerts 一次清空）；daemon 游标制多客户端各取所需
 *
 * 方向 D 闭环自动化：ledger-violated 事件 → 防抖 10s → spawn camera-dsl loop
 * （读 events.jsonl + ledger.json，产出 known-spread/未声明探针提案）→
 * 新提案 pushAlert + SSE 广播。deviation 回流 DSL 从"外部手动触发"变事件驱动。
 *
 * 幂等：启动时探测已有 daemon（health 通）→ 打印提示直接退出；pidfile 只做
 * 事后诊断（进程已死但 pidfile 残留 → 覆盖）。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchProjectTool, listActiveWatches, setWatchToolEventListener } from '../tools/watch_project_tool.js';
import { setAlertListener, alertsSince, pushAlert } from '../tools/alert_inbox.js';
import { createDaemonServer } from './server.js';
import { probeDaemon, daemonPort } from './client.js';

const startedAt = new Date().toISOString();

// ─────────────────────────────────────────────────────────────
// pidfile（诊断用：确认端口归属；不承担互斥——互斥靠 health 探测）
// ─────────────────────────────────────────────────────────────

function pidfilePath(port: number): string {
  return path.join(os.tmpdir(), `design-canvas-daemon-${port}.pid`);
}

function writePidfile(port: number): void {
  fs.writeFileSync(pidfilePath(port), JSON.stringify({ pid: process.pid, port, started_at: startedAt }, null, 2));
}

function removePidfile(port: number): void {
  try {
    fs.rmSync(pidfilePath(port), { force: true });
  } catch {
    /* 残留无碍 */
  }
}

// ─────────────────────────────────────────────────────────────
// Phase 3：ledger-violated → camera-dsl loop 自动回流
// ─────────────────────────────────────────────────────────────

/** loop 触发防抖（每项目冷却窗口）：编辑风暴里连续 violated 只触发一次 */
const LOOP_COOLDOWN_MS = 10_000;
/** camera-dsl 执行超时（Go 二进制冷启动 + loop 单次迭代足够） */
const LOOP_TIMEOUT_MS = 60_000;
const loopCooldown = new Map<string, number>();
let loopRunning = false;

/** camera-dsl 二进制定位：env 显式指定 → 仓库内 build 产物 → PATH */
function findCameraDslBin(): string {
  if (process.env.DC_CAMERA_DSL_BIN) return process.env.DC_CAMERA_DSL_BIN;
  const exe = process.platform === 'win32' ? 'camera-dsl.exe' : 'camera-dsl';
  // dist/src/daemon/daemon.js → 上溯 3 级到仓库根 → go-camera/build/
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const candidate = path.join(repoRoot, 'go-camera', 'build', exe);
  if (fs.existsSync(candidate)) return candidate;
  return exe; // 交给 PATH
}

/** 事件驱动 loop：violated 后防抖触发，产出新提案则 pushAlert + SSE 广播 */
function scheduleLoopTrigger(projectDir: string, broadcast: (event: string, data: unknown) => void): void {
  const now = Date.now();
  const last = loopCooldown.get(projectDir) ?? 0;
  if (now - last < LOOP_COOLDOWN_MS) return; // 冷却中：本轮违反已进 ledger，下轮 loop 会带上
  if (loopRunning) return; // 全局互斥：loop 幂等，串行足够
  loopCooldown.set(projectDir, now);
  loopRunning = true;

  const dataDir = path.join(projectDir, '.agent', 'camera');
  const proposalsDir = path.join(dataDir, 'proposals');
  const before = new Set(fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir) : []);
  const eventsPath = path.join(projectDir, '.design-canvas', 'camera', 'events.jsonl');
  const ledgerPath = path.join(projectDir, '.design-canvas', 'impact', 'ledger.json');
  const bin = findCameraDslBin();
  const args = [
    '--project-root', projectDir,
    'loop', eventsPath,
    '--ledger', ledgerPath,
  ];

  broadcast('loop-started', { project_dir: projectDir, bin, at: new Date().toISOString() });
  execFile(
    bin,
    args,
    { timeout: LOOP_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      loopRunning = false;
      try {
        if (err) {
          // 常见：events.jsonl 尚不存在（项目还没产生 camera 事件）——不算错，静默跳过
          const notReady = !fs.existsSync(eventsPath);
          const reason = notReady ? '尚无 camera 事件流（events.jsonl 不存在）' : String(err.message).split('\n')[0];
          broadcast('loop-skipped', { project_dir: projectDir, reason });
          return;
        }
        // proposals/ 在第一份提案产生前不存在——容错为空集合
        const after = new Set(fs.existsSync(proposalsDir) ? fs.readdirSync(proposalsDir) : []);
        const newProposals = [...after].filter((f) => !before.has(f));
        if (newProposals.length > 0) {
          const line = `[loop 回流] ${projectDir} 产生 ${newProposals.length} 条新提案（${newProposals.map((p) => p.replace('.json', '')).join(', ')}）· camera-dsl proposals 查看，approve 后并入设计 DSL`;
          pushAlert({ project_dir: projectDir, seq: 0, line, created_at: new Date().toISOString() });
          broadcast('loop-proposal', { project_dir: projectDir, proposals: newProposals, at: new Date().toISOString() });
        } else {
          broadcast('loop-done', { project_dir: projectDir, proposals: 0, at: new Date().toISOString() });
        }
        if (stderr && stderr.trim()) {
          console.warn('[loop:stderr]', stderr.trim().split('\n')[0]);
        }
      } catch (e) {
        // 回调内任何异常都不能波及 daemon 宿主进程
        console.warn('[loop] 结果处理失败:', (e as Error).message);
        broadcast('loop-skipped', { project_dir: projectDir, reason: (e as Error).message });
      }
    },
  );
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const port = daemonPort();

  // 幂等：已有 daemon 在跑 → 提示并退出（不抢端口）
  const existing = await probeDaemon(500);
  if (existing) {
    console.log(`design-canvas daemon 已在运行（pid ${existing.pid}，${existing.watches.length} 个监听），本次启动退出。`);
    process.exit(0);
  }

  // /api/shutdown 的实际流程在 server 就绪后绑定（闭包延迟绑定）
  let doShutdown: (() => Promise<void>) | null = null;
  const srv = createDaemonServer({
    health: () => ({
      ok: true,
      name: 'design-canvas-daemon',
      pid: process.pid,
      port,
      started_at: startedAt,
      watches: listActiveWatches(),
    }),
    watch: (input) => watchProjectTool(input as unknown as Parameters<typeof watchProjectTool>[0]) as unknown as Promise<Record<string, unknown>>,
    alertsSince: (cursor) => alertsSince(cursor),
    shutdown: () => doShutdown?.() ?? Promise.resolve(),
  }, { port });

  // 事件桥 ①：alert 入箱 → SSE 即时广播
  setAlertListener((a) => srv.broadcast('watch-alert', a));
  // 事件桥 ②：ledger violated → SSE 广播 + 防抖触发 loop 回流（方向 D 闭环）
  setWatchToolEventListener((e) => {
    srv.broadcast(e.type, e);
    if (e.type === 'ledger-violated') scheduleLoopTrigger(e.project_dir, (ev, d) => srv.broadcast(ev, d));
  });

  await srv.start();
  writePidfile(port);
  console.log(`design-canvas daemon 就绪：http://127.0.0.1:${port}`);
  console.log(`  GET  /api/health          存活 + 监听汇总`);
  console.log(`  POST /api/watch           watch action 转发（start/status/stop/declare/ledger/impact）`);
  console.log(`  GET  /api/alerts?since=N  游标拉取未读提醒`);
  console.log(`  GET  /api/events          SSE（watch-alert / ledger-violated / loop-*）`);
  console.log(`  POST /api/shutdown        优雅退出（Windows 无 POSIX 信号的 HTTP 替代）`);
  console.log(`  pid ${process.pid} · pidfile ${pidfilePath(port)}`);

  // 优雅退出：停 watch（flush 未落库变更）→ 关 server → 清 pidfile。
  // 触发：SIGINT/SIGTERM（POSIX）或 POST /api/shutdown（Windows/远程一律走这里）
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n收到 ${signal}，正在关闭（flush 监听队列）…`);
    return (async () => {
      try {
        for (const w of listActiveWatches()) {
          await watchProjectTool({ project_dir: w.project_dir, action: 'stop' });
        }
      } catch (e) {
        console.warn('停止监听时出错:', (e as Error).message);
      }
      await srv.stop();
      removePidfile(port);
      console.log('daemon 已退出。');
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  doShutdown = () => shutdown('api/shutdown') ?? Promise.resolve();
}

main().catch((e) => {
  console.error('daemon 启动失败:', e.message);
  process.exit(1);
});
