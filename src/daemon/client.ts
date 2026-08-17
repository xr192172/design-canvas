/**
 * daemon 客户端（方向 E Phase 2）—— MCP 进程 / CLI 与 daemon 通信的薄封装
 *
 * daemon（npm run daemon，127.0.0.1:7600）是 watch 注册表的单一权威宿主：
 *   - probeDaemon：健康探测（MCP 侧自动降级的判据；daemon 不在 → 进程内 watch 兜底）
 *   - postWatch：把 watch_project_tool 的 action 转发给 daemon 进程执行
 *   - fetchAlertsSince：按游标拉取未读提醒（多客户端各持游标，互不互抢）
 *
 * 全部走 localhost HTTP，超时保守（探测 400ms / 转发 10s），任何失败由调用方
 * 决定降级路径——client 本身不重试、不缓存。
 */

/** daemon 默认端口（DC_DAEMON_PORT 可覆盖） */
export function daemonPort(): number {
  const p = Number(process.env.DC_DAEMON_PORT || 0);
  return p > 0 ? p : 7600;
}

export function daemonBaseUrl(): string {
  return `http://127.0.0.1:${daemonPort()}`;
}

export interface DaemonHealth {
  ok: boolean;
  name: string;
  pid: number;
  port: number;
  started_at: string;
  watches: Array<{
    project_dir: string;
    feature?: string;
    rebuild: boolean;
    impact_on_change: boolean;
    started_at: string;
    last_change_at?: string;
    last_impact_seq?: number;
    pending_declarations: number;
  }>;
}

/** 健康探测：daemon 不在 / 超时 / 响应异常 → null（调用方走进程内降级） */
export async function probeDaemon(timeoutMs = 400): Promise<DaemonHealth | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl()}/api/health`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as DaemonHealth;
    return body?.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 转发 watch action 给 daemon 执行。失败抛错（调用方决定是否降级重试本地） */
export async function postWatch(input: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl()}/api/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(typeof body.error === 'string' ? body.error : `daemon HTTP ${res.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/** 单写者提交设计 DSL（经 daemon /api/dsl 串行队列）。返回结果；冲突时 result.conflict=true + current_rev */
export async function postDsl(
  req: {
    feature: string;
    ops?: Record<string, unknown>;
    dsl?: Record<string, unknown>;
    base_dsl_rev?: number;
    source?: string;
  },
  timeoutMs = 10_000,
): Promise<{ ok: boolean; rev: number; conflict?: boolean; current_rev?: number; message?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl()}/api/dsl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    // 409 = 乐观锁冲突，仍返回解析结果（带 conflict+current_rev），不抛
    const body = (await res.json()) as { ok: boolean; rev: number; conflict?: boolean; current_rev?: number; message?: string };
    return body; // 冲突(409)也带 conflict+current_rev 返回，由调用方决定 rebase
  } finally {
    clearTimeout(timer);
  }
}

/** 按游标拉取 daemon 侧未读提醒（返回新条目 + 最新游标；失败抛错） */
export async function fetchAlertsSince(
  cursor: number,
  timeoutMs = 800,
): Promise<{ alerts: Array<{ id: number; project_dir: string; seq: number; line: string; created_at: string }>; cursor: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${daemonBaseUrl()}/api/alerts?since=${cursor}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`daemon HTTP ${res.status}`);
    return (await res.json()) as { alerts: Array<{ id: number; project_dir: string; seq: number; line: string; created_at: string }>; cursor: number };
  } finally {
    clearTimeout(timer);
  }
}
