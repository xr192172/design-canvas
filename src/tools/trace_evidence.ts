/**
 * trace_evidence：L4 证据回溯的「真实可复算」校验引擎
 *
 * 目标：把 reason_validator 的 L4 从「带证据就拒」的挡板，升级为「真能验证据」。
 * 核心原则：证据不是让 LLM 交一份说明，而是让程序自己从真实采集的 trace 里复算验证。
 *
 * 证据 ref 约定（type='trace'）：
 *   - `<qualified_name>`              仅存在性：该函数必须真实被执行并记录过
 *   - `<qualified_name>@token>N`     存在性 + 复算声明：程序读取该函数真实采集的 token，
 *                                    若实际值未超过声称阈值 N，说明证据与 trace 不符 → 打回
 *
 * 纯函数、无副作用（读文件除外），便于单测。由 server_registry 注入到 edit_dsl 的 L4 resolver。
 */

import fs from 'node:fs';
import type { TraceRecord } from './trace_reasoning.js';
import type { ReasonEvidenceRef, ReasonEvidenceResolver } from './reason_validator.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 落盘 trace 文件结构（与 trace_reasoning 的 traceFile 输出对齐） */
export interface TraceEvidenceFile {
  feature: string;
  generated_at: string;
  records: TraceRecord[];
}

/** 单条证据校验结果 */
export type TraceEvidenceResult =
  | { ok: true; actual?: number; expected?: number }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────
// 核心：单条证据的复算校验
// ─────────────────────────────────────────────────────────────

/**
 * 校验一条 trace 证据：
 *  - 解析 ref（含可选 `@token>N` 复算声明）
 *  - 在真实 trace 记录里定位该函数（qualified_name 或 name 匹配，取最后一次调用）
 *  - 找不到 → 打回（编造 / 未执行）
 *  - 有复算声明 → 用真实采集的实际 token 与声称阈值比对，未超则打回
 */
export function resolveTraceEvidence(
  records: TraceRecord[],
  ev: ReasonEvidenceRef,
): TraceEvidenceResult {
  if (ev.type !== 'trace') {
    return { ok: false, error: `L4 仅支持 type='trace' 证据，收到 '${ev.type}'` };
  }
  const ref = (ev.ref ?? '').trim();
  if (!ref) return { ok: false, error: 'trace 证据未提供 ref' };

  // 解析声明：`<qualified_name>@token>N`
  let base = ref;
  let claim: number | null = null;
  const at = ref.lastIndexOf('@');
  if (at > 0) {
    const m = /^token>(\d+)$/.exec(ref.slice(at + 1));
    if (m) {
      base = ref.slice(0, at);
      claim = parseInt(m[1], 10);
    }
  }

  const hit = records
    .filter((r) => r.qualified_name === base || r.name === base)
    .at(-1);
  if (!hit) {
    return { ok: false, error: `trace 记录中无函数 "${base}"（证据编造或函数未被真实执行）` };
  }

  const actual = hit.tokens;
  if (claim !== null) {
    if (Number.isFinite(actual) && actual <= claim) {
      return {
        ok: false,
        error: `复算失败：函数 "${base}" 实际 token=${actual}，未超声称阈值 ${claim}，证据与 trace 不符`,
      };
    }
    return { ok: true, actual, expected: claim };
  }
  return { ok: true, actual };
}

// ─────────────────────────────────────────────────────────────
// 落盘读写
// ─────────────────────────────────────────────────────────────

/** 从 trace 文件读记录；文件不存在返回空数组（调用方据此判定「无法回溯」） */
export function loadTraceRecords(file: string): TraceRecord[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as TraceEvidenceFile;
    return Array.isArray(raw.records) ? raw.records : [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 组装 L4 resolver
// ─────────────────────────────────────────────────────────────

/**
 * 由真实 trace 记录构造 L4 resolver：
 *  - traceRefs：真实存在过的函数名集合（L3 实体绑定也可命中）
 *  - exists：逐条复算校验证据
 */
export function buildTraceResolver(records: TraceRecord[]): Pick<
  ReasonEvidenceResolver,
  'exists' | 'traceRefs'
> {
  const refs = Array.from(new Set(records.map((r) => r.qualified_name).filter(Boolean)));
  return {
    traceRefs: refs,
    exists: (ev) => resolveTraceEvidence(records, ev).ok,
  };
}