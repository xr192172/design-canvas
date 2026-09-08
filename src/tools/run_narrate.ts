/**
 * run_narrate —— 环节旁白解析器（"这一步做了什么"的人话）。
 *
 * 回放真实调用链时，每个环节不想只 dump 函数名+字段，而是想先看一句人话。
 * 本模块把"现成的函数注释"加工成旁白，复用 annotate_functions 的注释提取
 * （scanFileAnnotations 的 @fnhash 描述块 / 手写注释），诚实优先级：
 *   - 有描述性注释（status='ok'）→ 取注释正文当旁白
 *   - 无注释 / 空体 → 返回 null（展示层如实标注"无描述"，不硬造）
 *
 * 旁白是 IO（读文件解析），故不并入纯同步的 parseRunTraces；由回放展示层按
 * frame 的(file, func)逐个拉取。
 */
import { scanFileAnnotations } from './function_annotation.js';

/** 从一行注释文本剥离注释记号 / 星号 / 可忽略前景 */
function stripCommentLine(raw: string): string {
  return raw
    .replace(/^\s*\/\*\*?\s?/, '')
    .replace(/^\s*\*\/?\s?/, '')
    .replace(/^\s*\* ?/, '')
    .replace(/^\s*\/\/\s?/, '')
    .trim();
}

/** 给定 绝对文件路径 + 函数/方法名 → 说清该函数做什么的人话；无描述/不可解析返回 null。 */
export async function narrateFunc(absFile: string, funcName: string): Promise<string | null> {
  let t;
  try {
    const targets = await scanFileAnnotations(absFile);
    t = targets.find((x) => x.name === funcName && x.status === 'ok');
  } catch {
    return null;
  }
  if (!t || !t.blockLines.length) return null;
  const desc = t.blockLines
    .map(stripCommentLine)
    .filter((ln) => ln && !/^@fnhash/.test(ln))
    .join(' ');
  return desc || null;
}