/**
 * referenced —— 从 TransUnit 提取"候选外部类型引用"（纯函数、确定性）
 *
 * 用途：项目级翻译时，为每个模块找出"签名里用到的、可能定义在别处 Go 文件"的类型名，
 * 以便生成跨文件 import。做法：扫描 unit 的类型串里的标识符 → 过滤掉 TS 已知类型、
 * 本文件泛型参数、自身名字 → 剩下的为候选外部类型名。
 *
 * 只做类型引用（签名能编译）；函数体里的跨文件函数调用归 LLM（body 是孔）。
 */

import type { TransUnit } from './unit.js';

/** TS 侧"已知内置/工具类型"，不视为需要 import 的名字 */
const KNOWN_TS_TYPES = new Set([
  'number', 'string', 'boolean', 'boolean', 'Error', 'unknown', 'any', 'void', 'null', 'undefined',
  'Uint8Array', 'Map', 'Channel', 'Array', 'Promise', 'Record', 'Readonly', 'Partial', 'ArrayLike',
  'Iterable', 'AsyncIterable', 'Iterator', 'Function', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Object',
  'number[]', 'string[]', 'never',
]);

/** 从一段类型串里提取标识符 token（支持泛型/数组/管道/对象字面量混写） */
function identifiersFrom(typeStr: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(typeStr)) !== null) out.push(m[0]);
  return out;
}

/** 本文件内可自解的名字：类型参数 + 自身符号名 */
function localNames(u: TransUnit): Set<string> {
  const s = new Set<string>();
  if (u.name) s.add(u.name);
  for (const tp of u.typeParams ?? []) s.add(tp);
  return s;
}

/** 从 unit 的类型串收集候选外部类型引用名集合 */
export function collectExternalTypeRefs(u: TransUnit): string[] {
  const seen = new Set<string>();
  const locals = localNames(u);
  const refs = [
    ...(u.params ?? []).map((p) => p.type),
    ...(u.result ? [u.result] : []),
    ...(u.fields ?? []).map((f) => f.type),
    ...(u.aliasType ? [u.aliasType] : []),
    ...(u.methods ?? []).flatMap((mm) => [...mm.params.map((p) => p.type), ...(mm.result ? [mm.result] : [])]),
  ];
  for (const t of refs) {
    for (const id of identifiersFrom(t)) {
      if (KNOWN_TS_TYPES.has(id) || locals.has(id)) continue;
      seen.add(id);
    }
  }
  return [...seen].sort();
}