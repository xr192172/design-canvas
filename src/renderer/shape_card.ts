/**
 * D1 静态形状卡：AnimationValueSchema → 人话字符串
 *
 * 目标读者是非开发者：
 *   {token: 字符串, user_id?: 整数, tags: 字符串[], state: (active|banned)}
 * 而不是 JSON Schema 原文（{"type":"object","properties":...}）。
 *
 * 规则：
 *   - 类型词中文化：string→字符串 number→数字 integer→整数 boolean→布尔 null→空
 *   - object → {k: 类型, k2?: 类型}（? = 非 required）
 *   - array  → 元素类型[]
 *   - enum   → (a|b|c) 追加在类型后
 *   - label 优先：schema.label 存在时直接返回（作者已写好人话）
 *   - 防爆：嵌套最多 2 层（更深显示 …），对象最多展示 4 个字段（更多显示 …+N）
 */

import type { AnimationValueSchema } from '../dsl/types.js';

const TYPE_WORDS: Record<AnimationValueSchema['type'], string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔',
  null: '空',
  array: '数组',
  object: '对象',
};

const MAX_DEPTH = 2;
const MAX_FIELDS = 4;

/**
 * AnimationValueSchema → 人话字符串
 * @param schema 数据形状（JSON Schema 子集）
 * @param depth  内部递归深度（外部调用勿传）
 */
export function schemaToHuman(schema: AnimationValueSchema | undefined, depth = 0): string {
  if (!schema) return '?';
  // 作者手写人话标签优先（D2 LLM 语义标注的落点）
  if (schema.label) return schema.label;

  let body: string;
  if (schema.type === 'object') {
    body = objectToHuman(schema, depth);
  } else if (schema.type === 'array') {
    // 数组不消耗嵌套深度：{…}[] 与 X[] 视觉开销相同，深度只计对象嵌套
    const inner = schema.items ? schemaToHuman(schema.items, depth) : '任意';
    body = `${inner}[]`;
  } else {
    body = TYPE_WORDS[schema.type] ?? schema.type;
  }

  if (schema.enum && schema.enum.length > 0) {
    body += `(${schema.enum.join('|')})`;
  }
  return body;
}

/** object 类型 → {k: 类型, k2?: 类型}；超深退化为 对象，超字段截断 */
function objectToHuman(schema: AnimationValueSchema, depth: number): string {
  if (depth >= MAX_DEPTH) return '{…}';
  const props = schema.properties ?? {};
  const keys = Object.keys(props);
  if (keys.length === 0) return '{}';
  const required = new Set(schema.required ?? []);
  const shown = keys.slice(0, MAX_FIELDS).map((k) => {
    const opt = required.size > 0 && !required.has(k) ? '?' : '';
    return `${k}${opt}: ${schemaToHuman(props[k], depth + 1)}`;
  });
  if (keys.length > MAX_FIELDS) shown.push(`…+${keys.length - MAX_FIELDS}`);
  return `{${shown.join(', ')}}`;
}
