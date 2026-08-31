/**
 * Observe 实时判定守卫（serve 内嵌开关，默认关闭）
 *
 * 用途：长时压测守门。开发时跑测试已能发现偏差，无需额外机制；但长时压测里
 * 事件是持续流入的，需要有人一直盯着。开启本开关后，serve 会在每条事件落盘
 * 的瞬间做实时判定，把命中的契约偏差逐条打印到控制台（仅打印，不中断进程、
 * 不写状态文件），供压测观察窗口实时看到是否出现问题。
 *
 * 启用（serve 启动时）：
 *   OBSERVE_GUARD=1   # 开启实时判定打印
 *
 * 叠加在现有 enableObserveFromEnv 的 onEvent 回调之上——该回调已负责 SSE 推送，
 * 本君卫只额外负责控制台打印，互不干扰。未开启时是纯 no-op。
 */

import { judgeEvent } from './judge.js';
import type { TSEvent } from './probe.js';

/** 是否开启 console 实时判定打印（读取 OBSERVE_GUARD 环境变量）。 */
export function judgeGuardEnabled(): boolean {
  return process.env.OBSERVE_GUARD === '1';
}

/** 对单条事件做实时判定，命中的偏差打印到控制台。仅打印，不中断。 */
export function judgeGuardLog(ev: TSEvent): void {
  if (!judgeGuardEnabled()) return;
  const v = judgeEvent(ev);
  if (v.result !== 'deviation') return;
  const ts = new Date().toISOString();
  console.error(
    `[observe-guard][${ts}] ✗ 偏差 rule=${v.rule} probe=${v.probe} source=${ev.source}\n` +
      `    ${v.reason}\n` +
      `    fields=${JSON.stringify(ev.fields ?? {})}`,
  );
}