/**
 * daemon 感知分流测试（方向 E Phase 2）
 *
 * 覆盖：
 *   - daemon 不在 → dispatchWatch 降级本地执行（现状行为，幂等 start）
 *   - daemon 在 → 转发 daemon 执行 + [via daemon] 标记；响应注入从 daemon 游标拉取
 *   - daemon 在但转发失败（server 停了但缓存 TTL 未过）→ 静默降级本地
 *   - collectPendingAlertText：本地 inbox + daemon 游标合并；watch_project 跳过；游标推进不重复
 *   - isDaemonAvailable 缓存：invalidateDaemonCache 后强制重探
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createDaemonServer } from '../../src/daemon/server';
import { dispatchWatch, collectPendingAlertText, isDaemonAvailable, invalidateDaemonCache } from '../../src/daemon/dispatch';
import { watchProjectTool, closeAllActiveWatches } from '../../src/tools/watch_project_tool';
import { pushAlert, clearAlertInbox, alertsSince, setAlertListener } from '../../src/tools/alert_inbox';

const cleanups: Array<() => Promise<void> | void> = [];
const roots: string[] = [];

afterAll(async () => {
  setAlertListener(null);
  closeAllActiveWatches();
  delete process.env.DC_DAEMON_PORT;
  invalidateDaemonCache();
  for (const c of cleanups) await c();
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows 文件占用，留给 OS 清理 */
    }
  }
});

/** 起测试 daemon（随机端口 + 写 DC_DAEMON_PORT），返回 baseUrl */
async function startDaemon(): Promise<string> {
  const srv = createDaemonServer(
    {
      health: () => ({ ok: true, name: 'design-canvas-daemon', pid: process.pid, watches: [] }),
      watch: (input) => watchProjectTool(input as Parameters<typeof watchProjectTool>[0]) as unknown as Promise<Record<string, unknown>>,
      alertsSince: (cursor) => alertsSince(cursor),
    },
    { port: 0 },
  );
  const { port } = await srv.start();
  process.env.DC_DAEMON_PORT = String(port);
  invalidateDaemonCache();
  cleanups.push(async () => {
    await srv.stop();
  });
  return `http://127.0.0.1:${port}`;
}

function mkproj(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dispatch-${name}-`));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function a(): number { return 1; }\n', 'utf-8');
  return root;
}

describe('dispatch · daemon 不在 → 降级本地', () => {
  beforeEach(() => {
    delete process.env.DC_DAEMON_PORT;
    invalidateDaemonCache();
    clearAlertInbox();
  });

  it('isDaemonAvailable 返回 false', async () => {
    expect(await isDaemonAvailable()).toBe(false);
  });

  it('dispatchWatch 本地执行：start → status → stop 全链（无 via 标记）', async () => {
    const root = mkproj('local');
    const start = await dispatchWatch({ project_dir: root, rebuild_on_change: false });
    expect(start.watching).toBe(true);
    expect(start.message).not.toContain('[via daemon]');

    const status = await dispatchWatch({ project_dir: root, action: 'status' });
    expect(status.watching).toBe(true);

    const stop = await dispatchWatch({ project_dir: root, action: 'stop' });
    expect(stop.watching).toBe(false);
  });
});

describe('dispatch · daemon 在 → 转发', () => {
  beforeEach(() => {
    clearAlertInbox();
  });

  it('健康探测通过 + 转发带 [via daemon] 标记（watch 注册表在 daemon 进程内）', async () => {
    await startDaemon();
    expect(await isDaemonAvailable()).toBe(true);

    const root = mkproj('remote');
    // daemon 进程内的注册表执行 start（真实 watchProjectTool 在本测试进程 = 同进程模拟 daemon 语义）
    const start = await dispatchWatch({ project_dir: root, rebuild_on_change: false });
    expect(start.watching).toBe(true);
    expect(start.message).toContain('[via daemon]');

    const status = await dispatchWatch({ project_dir: root, action: 'status' });
    expect(status.watching).toBe(true);

    await dispatchWatch({ project_dir: root, action: 'stop' });
  });

  it('collectPendingAlertText 从 daemon 游标拉取且推进游标（不重复投递）', async () => {
    await startDaemon();
    // daemon 进程内产生的 alert（测试同进程直接 push，daemon 的 /api/alerts 接同一 alertLog）
    pushAlert({ project_dir: '/p-daemon', seq: 5, line: '[影响#5] daemon 侧提醒', created_at: '2026-08-17T00:00:00Z' });

    const text1 = await collectPendingAlertText('get_dsl');
    expect(text1).toContain('[未读影响提醒');
    expect(text1).toContain('daemon 侧提醒');

    // 游标已推进：再次拉取无新增（本地 inbox 也已被 take 清空）
    const text2 = await collectPendingAlertText('get_dsl');
    expect(text2).toBe('');
    clearAlertInbox();
  });

  it('collectPendingAlertText：watch_project 跳过注入', async () => {
    await startDaemon();
    pushAlert({ project_dir: '/p2', seq: 6, line: '[影响#6] 不应注入', created_at: '2026-08-17T00:00:00Z' });
    const text = await collectPendingAlertText('watch_project');
    expect(text).toBe('');
    clearAlertInbox();
  });

  it('daemon 探测缓存 TTL 内 server 已死 → 转发失败静默降级本地', async () => {
    const root = mkproj('fallback');
    // 先起 daemon 并探测成功（缓存 alive）
    const baseUrl = await startDaemon();
    expect(await isDaemonAvailable()).toBe(true);
    // 探测缓存后立即停掉 daemon（模拟 daemon 崩溃），缓存 TTL 30s 内仍认为 alive
    const idx = cleanups.length - 1;
    await cleanups[idx]();
    cleanups.splice(idx, 1);

    // 转发失败 → 静默降级本地执行，仍能 start 成功（不带 via 标记）
    const start = await dispatchWatch({ project_dir: root, rebuild_on_change: false });
    expect(start.watching).toBe(true);
    expect(start.message).not.toContain('[via daemon]');
    await dispatchWatch({ project_dir: root, action: 'stop' });
    void baseUrl;
  });
});
