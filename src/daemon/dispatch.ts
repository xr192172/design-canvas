/**
 * watch 调度 + 响应注入的 daemon 感知层（方向 E Phase 2）
 *
 * 自动降级策略（用户决策 2026-08-17）：daemon 在 → 转发（单实例权威）；
 * daemon 不在 → 进程内 watch 兜底（现状行为）。向后兼容、渐进迁移，
 * daemon 崩溃系统照常工作。
 *
 * 三件事：
 *   - isDaemonAvailable：健康探测 + 30s TTL 缓存（避免每次工具调用都打 daemon）
 *   - dispatchWatch：watch action 分流（daemon 转发失败也静默降级本地）
 *   - collectPendingAlertText：响应注入升级——本地 inbox（降级路径）与
 *     daemon 游标拉取（权威路径）合并，daemon alert 也能借 MCP 响应送达
 */

import { probeDaemon, postWatch, fetchAlertsSince } from './client.js';
import { takeAlerts } from '../tools/alert_inbox.js';
import type { WatchProjectToolInput, WatchProjectToolResult } from '../tools/watch_project_tool.js';
import { watchProjectTool } from '../tools/watch_project_tool.js';

const PROBE_TTL_MS = 30_000;
let daemonCache: { alive: boolean; checkedAt: number } | null = null;

/** daemon 可用性（带 TTL 缓存；daemon 中途启停最多 30s 后被发现） */
export async function isDaemonAvailable(): Promise<boolean> {
  if (daemonCache && Date.now() - daemonCache.checkedAt < PROBE_TTL_MS) return daemonCache.alive;
  const h = await probeDaemon();
  daemonCache = { alive: h !== null, checkedAt: Date.now() };
  return daemonCache.alive;
}

/** 测试/运维：清空探测缓存，下次调用强制重探 */
export function invalidateDaemonCache(): void {
  daemonCache = null;
}

/**
 * watch action 分流入口（MCP 侧唯一调用点：explore_code action=watch）。
 * daemon 模式的响应带 `[via daemon]` 前缀标记，便于辨识权威宿主。
 */
export async function dispatchWatch(input: WatchProjectToolInput): Promise<WatchProjectToolResult> {
  if (await isDaemonAvailable()) {
    try {
      const r = (await postWatch(input as unknown as Record<string, unknown>)) as unknown as WatchProjectToolResult;
      return { ...r, message: `[via daemon] ${r.message ?? ''}` };
    } catch {
      // daemon 探测活着但本次转发失败（正在关闭/瞬时故障）→ 静默降级本地
    }
  }
  return watchProjectTool(input);
}

// ─────────────────────────────────────────────────────────────
// 响应注入：daemon 游标拉取与本地 inbox 合并
// ─────────────────────────────────────────────────────────────

/** 本 MCP 进程的 daemon alert 游标（各客户端独立，互不互抢） */
let daemonAlertCursor = 0;

/** 响应自带 alerts piggyback 的工具：跳过注入避免同屏重复（与本地语义一致） */
const SELF_CARRYING_TOOLS = new Set(['watch_project']);

/**
 * 响应注入升级版：本地未读（进程内降级路径产生）+ daemon 新增（权威路径
 * 产生，按游标增量）合并成一段提醒文本。任一通道失败都静默——提醒注入
 * 是尽力而为的附加通道，绝不能阻断工具响应。
 */
export async function collectPendingAlertText(toolName: string): Promise<string> {
  if (SELF_CARRYING_TOOLS.has(toolName)) return '';
  const lines: string[] = [];

  // ① 本地 inbox（降级路径 / serve 模式产生）
  for (const p of takeAlerts()) {
    lines.push(`- ${p.line}（${p.project_dir}，全文 watch action=impact seq=${p.seq}）`);
  }

  // ② daemon 游标增量（daemon 模式的权威 alert 流）
  if (await isDaemonAvailable()) {
    try {
      const r = await fetchAlertsSince(daemonAlertCursor);
      daemonAlertCursor = r.cursor;
      for (const a of r.alerts) {
        lines.push(`- ${a.line}（${a.project_dir}${a.seq > 0 ? `，全文 watch action=impact seq=${a.seq}` : ''}）`);
      }
    } catch {
      /* 拉取失败不阻断响应；游标不动下次重试 */
    }
  }

  if (lines.length === 0) return '';
  return `\n\n[未读影响提醒 · 自动附带] watch 侦测到代码变更影响：\n${lines.join('\n')}`;
}
