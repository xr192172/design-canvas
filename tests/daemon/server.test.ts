/**
 * daemon HTTP + SSE server 测试（方向 E Phase 1）
 *
 * 覆盖：
 *   - /api/health：返回注入 handler 的负载
 *   - POST /api/watch：project_dir 必填（400）、正常转发、handler 抛错（500）
 *   - /api/alerts?since=N：游标过滤（多客户端互不互抢的语义基础）
 *   - /api/events：SSE 握手 + broadcast 实时送达
 *   - Host 头校验：外域 Host → 403（防 DNS rebinding）
 *   - 未知路由 404
 */
import http from 'node:http';
import { describe, it, expect, afterAll } from 'vitest';
import { createDaemonServer } from '../../src/daemon/server';
import { pushAlert, clearAlertInbox, alertsSince } from '../../src/tools/alert_inbox';

const cleanups: Array<() => Promise<void> | void> = [];
const servers: Array<{ stop: () => Promise<void>; baseUrl: () => string; broadcast: (e: string, d: unknown) => void }> = [];

afterAll(async () => {
  clearAlertInbox();
  for (const c of cleanups) await c();
});

/** 起一个测试 daemon server（随机端口），注册到清理列表 */
async function startTestServer(
  handlers: Parameters<typeof createDaemonServer>[0],
): Promise<{ baseUrl: string; broadcast: (e: string, d: unknown) => void }> {
  const srv = createDaemonServer(handlers, { port: 0 });
  const { port } = await srv.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  servers.push({ stop: () => srv.stop(), baseUrl: () => baseUrl, broadcast: srv.broadcast });
  cleanups.push(() => srv.stop());
  return { baseUrl, broadcast: srv.broadcast };
}

describe('daemon server · HTTP 端点', () => {
  it('GET /api/health 返回 handler 负载', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true, name: 'test', pid: 1, watches: [] }),
      watch: async () => ({}),
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('test');
  });

  it('POST /api/watch 缺 project_dir → 400', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async () => ({}),
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    const res = await fetch(`${baseUrl}/api/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'status' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('project_dir');
  });

  it('POST /api/watch 正常转发并返回 handler 结果', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async (input) => ({ echoed: input.project_dir, watching: true }),
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    const res = await fetch(`${baseUrl}/api/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_dir: 'D:/proj/x', action: 'start' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { echoed: string; watching: boolean };
    expect(body.echoed).toBe('D:/proj/x');
    expect(body.watching).toBe(true);
  });

  it('POST /api/watch handler 抛错 → 500 + error 字段', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async () => {
        throw new Error('boom');
      },
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    const res = await fetch(`${baseUrl}/api/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project_dir: 'x' }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('boom');
  });

  it('GET /api/alerts?since=N 游标过滤（接真实 alertLog）', async () => {
    clearAlertInbox();
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async () => ({}),
      alertsSince: (cursor) => alertsSince(cursor),
    });
    pushAlert({ project_dir: '/p1', seq: 1, line: 'alert-1', created_at: '2026-08-17T00:00:00Z' });
    pushAlert({ project_dir: '/p1', seq: 2, line: 'alert-2', created_at: '2026-08-17T00:00:01Z' });

    // 客户端 A 从 0 拉：两条
    const r1 = (await (await fetch(`${baseUrl}/api/alerts?since=0`)).json()) as { alerts: Array<{ line: string }>; cursor: number };
    expect(r1.alerts.map((a) => a.line)).toEqual(['alert-1', 'alert-2']);

    // 客户端 B 也从 0 拉：仍是两条（游标制互不互抢——takeAlerts 语义下 B 会拿空）
    const r2 = (await (await fetch(`${baseUrl}/api/alerts?since=0`)).json()) as { alerts: unknown[] };
    expect(r2.alerts.length).toBe(2);

    // A 用返回的 cursor 增量拉：无新增 → 空
    const r3 = (await (await fetch(`${baseUrl}/api/alerts?since=${r1.cursor}`)).json()) as { alerts: unknown[] };
    expect(r3.alerts.length).toBe(0);
    clearAlertInbox();
  });

  it('伪造外域 Host → 403（防 DNS rebinding）', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async () => ({}),
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    // fetch 规范禁止改 Host 头（forbidden header），用原生 http 才能伪造
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(baseUrl);
      const req = http.request(
        { host: u.hostname, port: u.port, path: '/api/health', headers: { host: 'evil.example.com' }, method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('未知路由 → 404', async () => {
    const { baseUrl } = await startTestServer({
      health: () => ({ ok: true }),
      watch: async () => ({}),
      alertsSince: () => ({ alerts: [], cursor: 0 }),
    });
    const res = await fetch(`${baseUrl}/api/no-such-route`);
    expect(res.status).toBe(404);
  });
});

describe('daemon server · SSE 事件流', () => {
  it(
    '连接握手 + broadcast 实时送达',
    async () => {
      const { baseUrl, broadcast } = await startTestServer({
        health: () => ({ ok: true }),
        watch: async () => ({}),
        alertsSince: () => ({ alerts: [], cursor: 0 }),
      });
      const ctrl = new AbortController();
      const res = await fetch(`${baseUrl}/api/events`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // 手动读流：先收 connected 握手，再收 broadcast 事件
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      const readUntil = async (predicate: () => boolean): Promise<void> => {
        for (let i = 0; i < 20 && !predicate(); i++) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      };
      await readUntil(() => chunks.some((c) => c.includes('connected')));

      broadcast('watch-alert', { id: 42, line: '测试广播' });
      await readUntil(() => chunks.some((c) => c.includes('watch-alert')));

      const all = chunks.join('');
      expect(all).toContain('event: connected');
      expect(all).toContain('event: watch-alert');
      expect(all).toContain('测试广播');
      ctrl.abort();
    },
    10000,
  );
});
