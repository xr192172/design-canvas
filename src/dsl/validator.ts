/**
 * DSL 校验器
 *
 * 用 ajv 跑 JSON Schema 校验，再补两项 schema 无法表达的语义校验：
 * 1. geometry.nodes.id 唯一
 * 2. semantic.files.id 必须能在 geometry.nodes 中找到对应 id（锚定完整性）
 */

import { Ajv, type ErrorObject } from 'ajv';
import * as addFormatsNS from 'ajv-formats';
import schema from '../../schema/design_dsl.schema.json' with { type: 'json' };
import type { DesignDSL } from './types.js';

// ajv-formats 在 NodeNext 严格模式下 default import 不可直接调用，
// 这里通过 namespace import 取 default（运行时是 CommonJS module.exports.default）
type AddFormatsFn = (ajv: Ajv, options?: unknown) => unknown;
const addFormats = (
  (addFormatsNS as unknown as { default?: AddFormatsFn }).default ??
  (addFormatsNS as unknown as AddFormatsFn)
) as AddFormatsFn;

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile<DesignDSL>(schema);

export interface ValidationResult {
  valid: boolean;
  /** 人类可读错误信息列表（valid=true 时为空） */
  errors: string[];
}

/** 把 ajv ErrorObject[] 转成可读字符串 */
function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => {
    const path = e.instancePath || '(root)';
    return `[${e.keyword}] ${path}: ${e.message ?? ''}`;
  });
}

/** 校验 geometry.nodes.id 唯一性 + semantic.files.id 锚定完整性 */
function validateSemanticAnchoring(dsl: DesignDSL): string[] {
  const errors: string[] = [];

  // 1. nodes.id 唯一
  const seen = new Map<string, number>();
  for (const node of dsl.geometry.nodes) {
    const count = (seen.get(node.id) ?? 0) + 1;
    seen.set(node.id, count);
    if (count === 2) {
      errors.push(`[duplicate_id] geometry.nodes.id "${node.id}" 重复出现`);
    }
  }

  // 2. edges.from / edges.to 必须在 nodes 中存在
  const nodeIds = new Set(dsl.geometry.nodes.map((n) => n.id));
  for (const edge of dsl.geometry.edges ?? []) {
    if (!nodeIds.has(edge.from)) {
      errors.push(
        `[dangling_edge] edge "${edge.id}".from "${edge.from}" 在 geometry.nodes 中找不到`,
      );
    }
    if (!nodeIds.has(edge.to)) {
      errors.push(
        `[dangling_edge] edge "${edge.id}".to "${edge.to}" 在 geometry.nodes 中找不到`,
      );
    }
  }

  // 3. semantic.files.id 必须在 nodes 中存在（锚定完整性）
  if (dsl.semantic?.files) {
    for (const file of dsl.semantic.files) {
      if (!nodeIds.has(file.id)) {
        errors.push(
          `[anchor_broken] semantic.files.id "${file.id}" 在 geometry.nodes 中找不到对应节点`,
        );
      }
    }
  }

  // 4. annotations.target_id 应指向 node.id 或 edge.id（警告级别，不阻断）
  //    这里以 error 形式报，方便发现拼写错误
  const edgeIds = new Set((dsl.geometry.edges ?? []).map((e) => e.id));
  for (const anno of dsl.annotations ?? []) {
    const target = anno.target_id || anno.node_id;
    if (target && !nodeIds.has(target) && !edgeIds.has(target)) {
      errors.push(
        `[dangling_annotation] annotation "${anno.id}".target_id "${target}" 既不在 nodes 也不在 edges 中`,
      );
    }
  }

  return errors;
}

/**
 * 校验 DSL 对象
 *
 * 用法：
 * ```ts
 * const { valid, errors } = validateDSL(dslObj);
 * if (!valid) throw new Error(errors.join('\n'));
 * ```
 */
export function validateDSL(dsl: unknown): ValidationResult {
  // 先跑 schema 校验
  if (!validateSchema(dsl)) {
    return { valid: false, errors: formatAjvErrors(validateSchema.errors) };
  }
  // schema 通过后跑语义校验
  const semanticErrors = validateSemanticAnchoring(dsl as DesignDSL);
  if (semanticErrors.length > 0) {
    return { valid: false, errors: semanticErrors };
  }
  return { valid: true, errors: [] };
}

/**
 * 校验 DSL JSON 字符串
 *
 * @returns valid=true 时返回解析后的 DSL 对象；valid=false 时 errors 有内容
 */
export function validateDSLJson(json: string): ValidationResult & { dsl?: DesignDSL } {
  let parsed: unknown;
  try {
    // strip UTF-8 BOM（Windows 编辑器常带 BOM，JSON.parse 不接受）
    const clean = json.charCodeAt(0) === 0xfeff ? json.slice(1) : json;
    parsed = JSON.parse(clean);
  } catch (e) {
    return {
      valid: false,
      errors: [`[json_parse] JSON 解析失败: ${(e as Error).message}`],
    };
  }
  const result = validateDSL(parsed);
  return result.valid ? { ...result, dsl: parsed as DesignDSL } : result;
}
