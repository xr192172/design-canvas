/**
 * Camera 即时判定器（TS 侧轻量版）
 *
 * 用于「开发时即时观测提示」：serve 每次探针 emit 后立即调用，判定该事件是否
 * 违反契约，命中就 SSE 推送。与 Go 装配层（camera-dsl loop）的权威判定共用
 * 同一契约语义（单一事实来源：Go 谓词判确定性，这里做等价的轻量即时判断）。
 *
 * 定位：实时提示（秒级反馈），不做全量聚合/未观测判定——那部分仍由
 * `camera-dsl loop` 事后权威执行。这里只回答「这条事件当下有没有问题」。
 */

import type { TSEvent } from './probe.js';

/** 即时判定结果。 */
export interface JudgeVerdict {
  probe: string;
  rule: string;
  result: 'ok' | 'deviation';
  reason: string;
  fields: Record<string, unknown>;
}

/**
 * 静默错误丢弃契约（与 Go SilentErrorDiscard 语义对齐）：
 * 捕获到 err 的事件，若 err 非空且非良性，即为偏差。
 * 良性判定与操作相关：cleanup/remove 的 os.IsNotExist 良性；writefile/save/mkdirall 一律非良性。
 */
export function silentErrorDiscard(ev: TSEvent): JudgeVerdict {
  const errStr = typeof ev.fields['err'] === 'string' ? (ev.fields['err'] as string) : '';
  if (!errStr) {
    return { probe: ev.probe, rule: 'design:silent-error-discard', result: 'ok', reason: 'err is nil — nothing was discarded', fields: ev.fields };
  }
  const op = typeof ev.fields['op'] === 'string' ? (ev.fields['op'] as string) : '';
  switch (op) {
    case 'remove':
    case 'remove-tmp':
    case 'cleanup':
      if (ev.fields['benign']) {
        return { probe: ev.probe, rule: 'design:silent-error-discard', result: 'ok', reason: 'benign: os.IsNotExist on cleanup — nothing to clean', fields: ev.fields };
      }
      return { probe: ev.probe, rule: 'design:silent-error-discard', result: 'deviation', reason: `cleanup error silently discarded: "${errStr}"`, fields: ev.fields };
    default:
      return { probe: ev.probe, rule: 'design:silent-error-discard', result: 'deviation', reason: `non-benign error silently discarded (op=${op}): "${errStr}"`, fields: ev.fields };
  }
}

/**
 * 对单条事件执行全部已注册规则判定，返回首条命中偏差的判定（无偏差则 ok）。
 * 规则顺序即优先级。
 */
export function judgeEvent(ev: TSEvent, rules: Array<(e: TSEvent) => JudgeVerdict> = [silentErrorDiscard]): JudgeVerdict {
  for (const rule of rules) {
    const v = rule(ev);
    if (v.result === 'deviation') return v;
  }
  // 全部规则都 ok → ok（取首条 ok 作为代表）
  return rules[0] ? rules[0](ev) : { probe: ev.probe, rule: '', result: 'ok', reason: 'no contract violation', fields: ev.fields };
}