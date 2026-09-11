/**
 * prompts —— 单孔 LLM prompt 构造（三段式落地"③ LLM 填充"的唯一输入契约）
 *
 * 把一条 trans_unit 的"锁定骨架 + 源证据 + 约束"拼成给模型的一条翻译指令。
 * 关键：模型看到的不是"整包"，而是"一个签名为焊死、仅函数体待填的孔"——
 * 输出空间被收窄到单函数，错误本地化、可重试（对应方案里"规范 LLM 比
 * 自由翻译简单"的核心判断）。
 *
 * 本文件只负责"把单元翻译成 prompt 文本"，不负责调用 LLM（调用端可插拔）。
 */

import type { TransUnit } from './unit.js';

/** 单孔翻译指令：只输出函数体，禁止改签名/导出 */
export function buildHolePrompt(u: TransUnit): string {
  return [
    '把下面的 Go 函数翻译为 TypeScript，并填入锁定的骨架。',
    '',
    '【只允许翻译 src 里的函数体。】不得改动签名、参数名、返回类型，不得新增导出。',
    '',
    '【目标签名（已锁定，勿改）】',
    u.skeleton,
    '',
    '【待翻译的 Go 源】',
    u.srcSnippet,
    '',
    '【约束】',
    ...(u.constraints.length ? u.constraints.map((c) => `- ${c}`) : ['- 无']),
    '',
    '输出要求：',
    '- 只输出函数体（不含 export function... 外壳和收尾括号）',
    '- 语义不可机械翻译处，保留近似并加 TODO(translate) 注释，不要编造 API',
  ].join('\n');
}

/** 生成一轮批量孔指令（供批处理，每孔一段为一行 —— 便于切分/对账） */
export function buildHolePrompts(units: TransUnit[]): string[] {
  return units.filter((u) => u.bodyHole).map(buildHolePrompt);
}