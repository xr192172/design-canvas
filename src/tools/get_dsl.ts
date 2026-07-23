/**
 * get_dsl 工具实现
 *
 * 读取已保存的 DSL JSON
 */

import { getDSL } from '../storage.js';

export interface GetDslInput {
  feature_name: string;
}

export interface GetDslResult {
  /** DSL JSON 字符串 */
  json: string;
  /** 文件路径 */
  file: string;
  feature: string;
}

export function getDsl(input: GetDslInput): GetDslResult {
  const dsl = getDSL(input.feature_name);
  if (!dsl) {
    throw new Error(`feature not found: ${input.feature_name}`);
  }
  return {
    json: JSON.stringify(dsl, null, 2),
    file: '',
    feature: dsl.feature,
  };
}
