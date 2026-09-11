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
import { DEFAULT_CONSTRAINTS } from './unit.js';

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

/** 批量填充用的最小待译描述（复用 fill 的 FillContext 视图） */
export interface BatchUnitView {
  unit: TransUnit;
  skeleton: string;
  srcSnippet: string;
  constraints: string[];
}

/** 输出标记块的包裹：每条函数体必须包在 `<unit id="...">...</unit>` 里，便于确定性切分 */
export function buildBatchFillPrompt(views: BatchUnitView[], projectNote?: string): string {
  const block = (v: BatchUnitView): string => {
    // 只列该单元的独特约束（全局默认约束抽到头部一次性给，省 N-1 份重复 token）
    const unique = v.constraints.filter((c) => !DEFAULT_CONSTRAINTS.includes(c));
    const parts = [`<unit id="${v.unit.id}">`, '【目标签名（锁定，勿改）】', v.skeleton, '', '【待翻译的 Go 源】', v.srcSnippet];
    if (unique.length) parts.push('', '【该单元特有约束】', ...unique.map((c) => `- ${c}`));
    parts.push('</unit>');
    return parts.join('\n');
  };
  const head = [
    `把下面 ${views.length} 个 Go 函数分别翻译为 TypeScript 函数体。`,
    '【输出契约——必须严格遵守】',
    `- 共 ${views.length} 个函数，就输出 ${views.length} 个块，数量一一对应，不许合并、不许遗漏、不许自创；`,
    '- 每个块格式：`<unit id="题目里的ID">\n函数体\n</unit>`，只含函数体，不含 export function 外壳，不改签名/参数名/返回类型；',
    '- 块之间只留空行，不要插入任何解释文字；',
    '- 全部块输出完毕后，另起一行输出 `__END__` 标记；',
  ];
  if (projectNote) head.push('', projectNote);
  head.push('', '【全局约束（适用于所有函数）】', ...DEFAULT_CONSTRAINTS.map((c) => `- ${c}`));
  head.push('', '--------------------', '', views.map(block).join('\n\n'));
  return head.join('\n');
}