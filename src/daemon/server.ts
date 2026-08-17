/**
 * daemon HTTP + SSE server（方向 E Phase 1）
 *
 * 端点（绑定 127.0.0.1，默认 7600，DC_DAEMON_PORT 可配）：
 *   GET  /api/health          存活探测 + 活跃 watch 汇总（MCP 自动降级的判据）
 *   POST /api/watch           watch_project_tool 全量 action 转发（daemon 进程内注册表为权威）
 *   GET  /api/alerts?since=N  按游标拉取未读提醒（多客户端各持游标，互不互抢）
 *   GET  /api/events          SSE 事件流（watch-alert / ledger-violated / loop-proposal / daemon-log）
 *
 * 安全边界：仅绑定 127.0.0.1 + Host 头校验（只认 127.0.0.1/localhost 字面量，
 * 防 DNS rebinding）；不加 CORS 头——浏览器跨域默认拿不到响应，Node/Go CLI
 * 不受影响。浏览器接入走 serve 同源代理（后续）。
 *
 * handler 全部注入（纯逻辑可测），server 不持有业务状态。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

// ─────────────────────────────────────────────────────────────
// 按依赖区域分桶的串行队列：同一 feature（同一块依赖区域）串行，
// 不同 feature（不同区域）并行，写吞吐不因无关区域互相阻塞
// ─────────────────────────────────────────────────────────────
const dslWriteTails = new Map<string, Promise<unknown>>();

/**
 * 入队：以 key（依赖区域标识，当前取 feature）分桶，桶内链式串行、桶间并行。
 * key 相同的后续写在前序完成后才执行，杜绝同区域并发直写导致「最后写者胜」。
 */
function enqueueDslWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = dslWriteTails.get(key) ?? Promise.resolve();
  const run = tail.then(fn, fn); // 无论前序成败都执行本次
  // 链住尾，但吞掉自身错误避免整条链断 —— 错误由调用方 await 捕获
  dslWriteTails.set(key, run.catch(() => undefined));
  return run;
}

/** POST /api/dsl 的入参（单写者提交 DSL，base_dsl_rev 乐观锁）
 *  两种形态：ops（edit_dsl 原始入参，daemon 内执行读改写）或 dsl（完整提交）二选一
 */
export interface DslWriteRequest {
  feature: string;
  /** edit_dsl 原始入参（含 action/feature/各 op 参数），daemon 内执行 updateFeature */
  ops?: Record<string, unknown>;
  /** 完整 DSL 提交形态 */
  dsl?: Record<string, unknown>;
  base_dsl_rev?: number;
  source?: string;
}

/** POST /api/dsl 的返回；冲突时 error 携带 current_rev 供客户端 rebase */
export interface DslWriteResult {
  ok: boolean;
  rev: number;
  conflict?: boolean;
  current_rev?: number;
  message?: string;
  /** 本次提交影响的目标元素（用于依赖重叠判断），随结果回带 */
  touched?: string[];
}

export interface DaemonServerHandlers {
  /** GET /api/health 的负载（进程存活信息 + watch 汇总） */
  health: () => Record<string, unknown>;
  /** POST /api/watch：执行 watch action，返回结果 JSON（抛错 → 500 + error 字段） */
  watch: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** POST /api/dsl：单写者提交设计 DSL（串行队列 + 乐观锁 + 写后 SSE 广播）。缺省则返回 501 */
  dslWrite?: (req: DslWriteRequest) => Promise<DslWriteResult>;
  /** GET /api/alerts?since=N：游标拉取 */
  alertsSince: (cursor: number) => { alerts: unknown[]; cursor: number };
  /** POST /api/shutdown：优雅退出（Windows 无 POSIX 信号，HTTP 触发 shutdown 流程） */
  shutdown: () => Promise<void>;
}

export interface DaemonServer {
  start(): Promise<{ port: number; host: string }>;
  stop(): Promise<void>;
  /** 向全部 SSE 客户端广播事件（无客户端时 no-op） */
  broadcast(event: string, data: unknown): void;
  sseClientCount(): number;
}

/** Host 头校验：只认本机回环字面量（防 DNS rebinding 拿 daemon 接口） */
function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function createDaemonServer(handlers: DaemonServerHandlers, opts: { port?: number; host?: string } = {}): DaemonServer {
  const wantPort = opts.port ?? (Number(process.env.DC_DAEMON_PORT || 0) || 7600);
  const host = opts.host ?? '127.0.0.1';
  const sseClients = new Set<http.ServerResponse>();
  let actualPort = wantPort;

  const server = http.createServer((req, res) => {
    // 统一安全闸：Host 校验（浏览器 DNS rebinding 会带外域 Host）
    if (!hostAllowed(req.headers.host, actualPort)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden host' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${host}:${actualPort}`);

    // SSE 事件流
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('event: connected\ndata: {"ok":true}\n\n');
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handlers.health()));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/alerts') {
      const since = Number(url.searchParams.get('since') || 0) || 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handlers.alertsSince(since)));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/dsl') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 5_000_000) req.destroy(); // 防御性上限：DSL 不会这么大
      });
      req.on('end', () => {
        void (async () => {
          try {
            const input = body ? (JSON.parse(body) as DslWriteRequest) : ({} as DslWriteRequest);
            const hasPayload = (typeof input.dsl === 'object' && input.dsl) || (typeof input.ops === 'object' && input.ops);
            if (typeof input.feature !== 'string' || !input.feature.trim() || !hasPayload) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'feature 与 (dsl 或 ops) 必填' }));
              return;
            }
            if (!handlers.dslWrite) {
              res.writeHead(501, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'dsl write 未启用', conflict: false, ok: false }));
              return;
            }
            // 关键：按依赖区域分桶串行——同 feature 的写请求在同一进程内按序排队，
            // 杜绝多会话并发直写导致「最后写者胜」的丢改动；异 feature 互不阻塞
            const result = await enqueueDslWrite(input.feature, () => handlers.dslWrite!(input));
            if (result.conflict) {
              res.writeHead(409, { 'content-type': 'application/json' });
              res.end(JSON.stringify(result));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: (e as Error).message, conflict: false, ok: false }));
          }
        })();
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      // 先响应再退出：客户端拿到 200 才知道触发成功
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'shutdown initiated' }));
      void handlers.shutdown();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/watch') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy(); // 防御性上限：入参不可能这么大
      });
      req.on('end', () => {
        void (async () => {
          try {
            const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            if (typeof input.project_dir !== 'string' || !input.project_dir.trim()) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'project_dir 必填' }));
              return;
            }
            const result = await handlers.watch(input);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: (e as Error).message }));
          }
        })();
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `no route: ${req.method} ${url.pathname}` }));
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantPort, host, () => {
          const addr = server.address() as AddressInfo;
          actualPort = addr.port;
          resolve({ port: actualPort, host });
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const client of sseClients) {
          try {
            client.end();
          } catch {
            /* 已断开的客户端 */
          }
        }
        sseClients.clear();
        server.close(() => resolve());
        // close 只等新连接退出；keep-alive 空连接由 server.closeIdleConnections 兜底
        (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
      }),
    broadcast: (event, data) => {
      if (sseClients.size === 0) return;
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(message);
        } catch {
          sseClients.delete(client);
        }
      }
    },
    sseClientCount: () => sseClients.size,
  };
}
