/**
 * fill —— LLM 单孔填充闭环（三段式落地"③ 填充 → ④ 验证"）
 *
 * 把一个 bodyHole 单元（func）交给可注入的 HoleTranslator（LLM 调用端/桩）翻译函数体，
 * 拼回锁定骨架后立即重跑 verify 闸——错误本地化到单孔、可重试。
 *
 * 关键：HoleTranslator 是可注入的（不硬绑某家 LLM／key），本文件只负责
 *   "给翻译器一份自包含的锁定上下文 → 拿回函数体 → splice 进骨架 → 重验证"。
 * 调用方（CLI / MCP / gateway）负责把 FillContext 交给真实的 LLM，并把输出夹回
 * 本文件约束好的边界内（只给函数体、不改签名）。
 */

import { verifySkeletons, type VerifyIssue } from './verify.js';
import { buildHolePrompt } from './prompts.js';
import type { TransUnit } from './unit.js';

/** 交给翻译器的自包含上下文：签名锁定 + Go 源证据 + 约束 + 给模型的单孔 prompt */
export interface FillContext {
  unit: TransUnit;
  /** 锁定骨架（签名外壳，勿改） */
  skeleton: string;
  /** Go 源原文，翻译依据 */
  srcSnippet: string;
  /** 合并后的约束（typeMap 语义 note + 默认约束） */
  constraints: string[];
  /** 给模型的单孔指令（可由调用方改用 buildHolePrompt 变体） */
  prompt: string;
}

/** 翻译器契约：输入锁定上下文，只输出目标函数体（不含 export function 外壳） */
export type HoleTranslator = (ctx: FillContext) => string | Promise<string>;

export interface FillResult {
  /** 被填充的单元 */
  unit: TransUnit;
  /** splice 后完整目标源码（骨架 + 函数体） */
  filledSource: string;
  /** 重验证是否通过（语法闸 + 结构闸） */
  ok: boolean;
  issues: VerifyIssue[];
  /** 若翻译器返回空/骨架无法闭合，填 false 并给原因 */
  error?: string;
}

/** 把翻译器产出的函数体拼进骨架：首 `{` 到末 `}` 之间。骨架统一 `export function ...: Ret {\n  <体>\n}`。 */
export function spliceBody(skeleton: string, body: string): string {
  const open = skeleton.indexOf('{');
  const close = skeleton.lastIndexOf('}');
  if (open < 0 || close <= open) return skeleton;
  const head = skeleton.slice(0, open + 1);
  const tail = skeleton.slice(close);
  return `${head}\n${indentBody(body)}\n${tail}`;
}

/** 函数体整体缩进两级（对齐骨架体内） */
function indentBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return '';
  return trimmed
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');
}

/**
 * 填充单个 bodyHole 单元并重验证。type 单元（非孔）返回 null。
 * 验证不过 → ok:false + 具体 issue，不抛、不丢源（骨架原样保留）。
 */
export async function fillUnit(u: TransUnit, translate: HoleTranslator): Promise<FillResult | null> {
  if (!u.bodyHole) return null;
  const ctx: FillContext = {
    unit: u,
    skeleton: u.skeleton,
    srcSnippet: u.srcSnippet,
    constraints: u.constraints,
    prompt: buildHolePrompt(u),
  };
  let body: string;
  try {
    body = await translate(ctx);
  } catch (e) {
    return { unit: u, filledSource: u.skeleton, ok: false, issues: [], error: `翻译器异常：${(e as Error).message}` };
  }
  const filledSource = spliceBody(u.skeleton, body);
  if (body.trim() === '') {
    return { unit: u, filledSource, ok: false, issues: [], error: '翻译器返回空函数体' };
  }
  const issues = await verifySkeletons([{ ...u, bodyHole: false, skeleton: filledSource }]);
  return { unit: u, filledSource, ok: issues.length === 0, issues };
}

/** 批量填充全部 bodyHole 单元；逐孔独立验证，单孔失败不影响其余。 */
export async function fillUnits(units: TransUnit[], translate: HoleTranslator): Promise<FillResult[]> {
  const out: FillResult[] = [];
  for (const u of units) {
    const r = await fillUnit(u, translate);
    if (r) out.push(r);
  }
  return out;
}