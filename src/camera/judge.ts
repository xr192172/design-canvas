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
 * 变更影响爆炸半径契约（Step 3：watch 影响报告与 Camera 合流）。
 *
 * watch impact_on_change=true 生成的 `impact.report` 事件：波及文件总数
 * （direct+indirect）超阈值即偏差——提醒"这一改动的爆炸半径过大，考虑拆分"。
 * 只对 probe 以 `impact.` 开头的事件生效，其他事件一律 ok（不干扰既有规则）。
 * 生成失败（fields.err 非空）由 silentErrorDiscard 先命中，不在此重复。
 */
export const IMPACT_BLAST_RADIUS_LIMIT = 50;

export function impactBlastRadius(ev: TSEvent): JudgeVerdict {
  if (!ev.probe.startsWith('impact.')) {
    return { probe: ev.probe, rule: 'design:impact-blast-radius', result: 'ok', reason: 'not an impact event', fields: ev.fields };
  }
  const num = (k: string): number => (typeof ev.fields[k] === 'number' ? (ev.fields[k] as number) : 0);
  const direct = num('direct_files');
  const indirect = num('indirect_files');
  const threshold = num('threshold') || IMPACT_BLAST_RADIUS_LIMIT;
  const total = direct + indirect;
  if (total > threshold) {
    return {
      probe: ev.probe,
      rule: 'design:impact-blast-radius',
      result: 'deviation',
      reason: `blast radius ${total} files (direct ${direct} + indirect ${indirect}) exceeds threshold ${threshold} — consider splitting the change`,
      fields: ev.fields,
    };
  }
  return { probe: ev.probe, rule: 'design:impact-blast-radius', result: 'ok', reason: `blast radius ${total} files within threshold ${threshold}`, fields: ev.fields };
}

/**
 * 计划外扩散契约（Impact Ledger：改前预告-改后验证闭环）。
 *
 * `impact.spread` 事件：改前 declare 登记的预告波及面 vs 改后实际波及面对比结果。
 * unexpected_files 非空 = 出现了预告之外的波及文件 → 偏差（改动走出了预告面，
 * 说明计划遗漏或改动越界）。只对 probe === 'impact.spread' 生效。
 */
export function impactUnplannedSpread(ev: TSEvent): JudgeVerdict {
  if (ev.probe !== 'impact.spread') {
    return { probe: ev.probe, rule: 'design:impact-unplanned-spread', result: 'ok', reason: 'not a spread event', fields: ev.fields };
  }
  const unexpected = Array.isArray(ev.fields['unexpected_files']) ? (ev.fields['unexpected_files'] as string[]) : [];
  if (unexpected.length > 0) {
    return {
      probe: ev.probe,
      rule: 'design:impact-unplanned-spread',
      result: 'deviation',
      reason: `unplanned spread: ${unexpected.length} file(s) impacted beyond the declared preview: ${unexpected.join(', ')}`,
      fields: ev.fields,
    };
  }
  const expected = typeof ev.fields['expected_count'] === 'number' ? (ev.fields['expected_count'] as number) : 0;
  const actual = typeof ev.fields['actual_count'] === 'number' ? (ev.fields['actual_count'] as number) : 0;
  return { probe: ev.probe, rule: 'design:impact-unplanned-spread', result: 'ok', reason: `impact within declared preview (${actual}/${expected} files)`, fields: ev.fields };
}

/**
 * 对单条事件执行全部已注册规则判定，返回首条命中偏差的判定（无偏差则 ok）。
 * 规则顺序即优先级。
 */
export function judgeEvent(
  ev: TSEvent,
  rules: Array<(e: TSEvent) => JudgeVerdict> = [silentErrorDiscard, impactUnplannedSpread, impactBlastRadius],
): JudgeVerdict {
  for (const rule of rules) {
    const v = rule(ev);
    if (v.result === 'deviation') return v;
  }
  // 全部规则都 ok → ok（取首条 ok 作为代表）
  return rules[0] ? rules[0](ev) : { probe: ev.probe, rule: '', result: 'ok', reason: 'no contract violation', fields: ev.fields };
}