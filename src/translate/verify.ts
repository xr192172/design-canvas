/**
 * verify —— 骨架验证闸（三段式落地"④ 行为对账"的前置静态闸）
 *
 * 在 LLM 介入前先保证"机械产物不会打烂目标语言"：
 *   1. 语法闸：每条骨架以 .ts 重新 tree-sitter 解析，必须解析出根节点——
 *      拦截"写成了不可解析的垃圾"（同仓库 refactor 管线的静态复核兜底做法）。
 *   2. 结构闸：核对骨架签名与单元源证据一致（函数名 / 参数个数；func 必带
 *      导出、type 以 interface 开头），防骨架生成本身漂移。
 *
 * 这是"飞刀"级保证（非 tsc 权威编译），失败即回滚该单元、不落盘。
 * 说明：真编译闸（tsc + 行为基线）留给切片之后接行为层时再加。
 */

import { parseAstRoot } from '../tools/ts_kernel/index.js';
import type { TransUnit } from './unit.js';

export interface VerifyIssue {
  id: string;
  /** 'syntax' | 'structure' */
  gate: 'syntax' | 'structure';
  detail: string;
}

/** 结构闸：签名/形状与源证据一致（func 导出+参数计数；type 为 interface） */
function structureCheck(u: TransUnit): string | null {
  if (u.kind === 'func') {
    if (!/^export\s+function\s+/.test(u.skeleton)) return 'func 骨架缺少 export function 前缀';
    const n = (u.params ?? []).length;
    const re = new RegExp(`^export\\s+function\\s+${escapeRe(u.name)}(?:<[^>]*>)?\\s*\\(`);
    if (!re.test(u.skeleton)) return `骨架函数名与单元不一致：${u.name}`;
    // 粗略数参数：函数头括号内逗号数 + (0 个参数时无逗号)
    const head = u.skeleton.slice(u.skeleton.indexOf('(') + 1, u.skeleton.indexOf(')'));
    const nParams = countTopLevelParams(head);
    if (nParams !== n) return `参数个数不一致：源=${n}，骨架=${nParams}`;
    return null;
  }
  if (u.kind === 'const') {
    if (!new RegExp(`^export\\s+const\\s+${escapeRe(u.name)}\\s*=`, 'm').test(u.skeleton)) return `const 骨架缺少 export const ${u.name} =`;
    return null;
  }
  if (u.kind === 'type') {
    if (u.typeKind === 'alias') {
      if (!new RegExp(`^export\\s+type\\s+${escapeRe(u.name)}(?:<[^>]*>)?\\s*=`).test(u.skeleton)) return `type 骨架缺少 export type ${u.name} =`;
    } else {
      if (!/^export\s+interface\s+/.test(u.skeleton)) return 'type 骨架缺少 export interface 前缀';
      if (!new RegExp(`^export\\s+interface\\s+${escapeRe(u.name)}\\b`).test(u.skeleton)) return `骨架类型名与单元不一致：${u.name}`;
    }
    return null;
  }
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 深度感知的参数个数：逗号在 <>{}([]) 内不算分隔（如 `Map<string, number>, k: string` = 2 参） */
function countTopLevelParams(s: string): number {
  const t = s.trim();
  if (t === '') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of t) {
    if ('<({['.includes(ch)) depth++;
    else if ('>)}]'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

/**
 * 对一批单元做骨架验证。返回全部发现的 issue；任一语法闸失败即该单元不可用。
 * 依赖 tree-sitter .ts 解析（仓库已装 typescript 语言包）。
 */
export async function verifySkeletons(units: TransUnit[]): Promise<VerifyIssue[]> {
  const issues: VerifyIssue[] = [];
  for (const u of units) {
    if (!u.skeleton) {
      issues.push({ id: u.id, gate: 'structure', detail: '骨架为空（未生成）' });
      continue;
    }
    const parsed = await parseAstRoot(`__skeleton_${u.id}.ts`, u.skeleton);
    // tree-sitter 是容错解析：坏骨架仍可能返回根节点。除"解析不到根"外，
    // 还检查根节点 hasError（含 ERROR/MISSING）——拦截"写成了带语法错误的垃圾"。
    if (!parsed?.root) {
      issues.push({ id: u.id, gate: 'syntax', detail: '骨架无法被 .ts 解析（tree-sitter 静态复核失败）' });
    } else if (parsed.root.hasError) {
      issues.push({ id: u.id, gate: 'syntax', detail: '骨架 .ts 解析含 ERROR/MISSING 节点（语法不完整）' });
    }
    const structural = structureCheck(u);
    if (structural) issues.push({ id: u.id, gate: 'structure', detail: structural });
  }
  return issues;
}