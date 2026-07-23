/**
 * AnimCore —— 动画引擎纯逻辑核心（无 DOM / 无 Node API 依赖）
 *
 * 双重消费（单源）：
 * 1. vitest 直接 import 本文件做单元测试（tests/renderer/anim_core.test.ts）
 * 2. 构建期 scripts/gen_anim_core_bundle.mjs 用 TypeScript transpileModule
 *    编译为 ES2015、剥离 export，生成 anim_core_bundle.gen.ts（字符串常量），
 *    由 animation_engine.ts 内联进浏览器动画脚本
 *
 * 因此本文件只能使用浏览器与 Node 共有的标准 ES API，
 * 禁止 import 任何模块（保持可独立内联）。
 *
 * 覆盖能力：
 * - L3  条件分支：evalCondition / pickBranch / createMockRotator
 * - L4  函数绑定：resolvePath / applyInputMapping / applyOutputMapping
 * - L4.5 异常语义：matchError
 * - 通用：makeSnapshot（状态快照对比）
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 分支结构（L3）——结构上与 AnimationBranch 对齐，此处独立声明避免 import */
export interface BranchLike {
  /** 分支条件（JS 表达式，访问 value）；'else'/'true'/'default'/空串 视为兜底命中 */
  condition?: string;
  /** 分支目标节点 ID */
  to: string;
  /** 分支携带的值 */
  value?: { type: string; label?: string };
  /** 视觉效果（particle_red / particle_green / ...） */
  effect?: string;
}

/** 异常声明结构（L4.5）——与 AnimationError 对齐 */
export interface ErrorDeclLike {
  type: string;
  condition: string;
  severity: 'expected' | 'unexpected';
  to: string;
  value?: { type: string; label?: string };
  effect?: string;
  log?: string;
}

// ─────────────────────────────────────────────────────────────
// L3 / L4.5 条件表达式求值
// ─────────────────────────────────────────────────────────────

/**
 * 条件表达式求值（设计文档 §9 已决策：简单 JS 表达式）
 *
 * - expr 为空 / 'else' / 'true' / 'default' → 恒真（兜底分支）
 * - 语法错误或运行时异常 → false（不命中），不抛出
 *
 * @param expr   JS 表达式，可访问 value / result
 * @param value  求值上下文 value（L3：flow 数据；L4.5：可为 undefined）
 * @param result 求值上下文 result（L4.5：handler 返回值 / 异常对象）
 */
export function evalCondition(expr: string | undefined | null, value?: unknown, result?: unknown): boolean {
  if (expr == null) return true;
  var trimmed = String(expr).trim();
  if (trimmed === '' || trimmed === 'else' || trimmed === 'true' || trimmed === 'default') return true;
  try {
    // 受控作用域：只暴露 value / result 两个形参
    var fn = new Function('value', 'result', '"use strict"; return (' + trimmed + ');');
    return !!fn(value, result);
  } catch (e) {
    return false;
  }
}

/**
 * L3 分支选择：按声明顺序返回第一个条件命中的分支
 * @returns 命中分支及其索引（索引用于引擎侧按序配色）；全部未命中返回 null
 */
export function pickBranch(
  branches: BranchLike[] | undefined | null,
  value?: unknown,
  result?: unknown,
): { branch: BranchLike; index: number } | null {
  if (!branches || branches.length === 0) return null;
  for (var i = 0; i < branches.length; i++) {
    if (evalCondition(branches[i].condition, value, result)) {
      return { branch: branches[i], index: i };
    }
  }
  return null;
}

/**
 * L3 mock 数据源轮换器：periodic 触发时按序轮流返回示例值
 * 空数组 / undefined 输入时恒返回 undefined（引擎回退到 flow.value 声明）
 */
export function createMockRotator(mockValues: unknown[] | undefined | null): () => unknown {
  var idx = 0;
  return function (): unknown {
    if (!mockValues || mockValues.length === 0) return undefined;
    var v = mockValues[idx % mockValues.length];
    idx++;
    return v;
  };
}

// ─────────────────────────────────────────────────────────────
// L4 函数绑定：路径解析与输入/输出映射
// ─────────────────────────────────────────────────────────────

/**
 * 解析 '$value.a.b' / '$result.x.y' 形式的路径
 * @returns 路径值；路径不存在或根标识非法时返回 undefined
 */
export function resolvePath(
  context: { value?: unknown; result?: unknown },
  path: string | undefined | null,
): unknown {
  if (!path || typeof path !== 'string') return undefined;
  var parts = path.trim().split('.');
  var cur: any;
  if (parts[0] === '$value') {
    cur = context.value;
  } else if (parts[0] === '$result') {
    cur = context.result;
  } else {
    return undefined;
  }
  for (var i = 1; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/**
 * 写入路径（忽略 $value/$result 根前缀，直接写入 target 对应层级）
 * 中间层缺失时自动创建对象
 */
export function setPath(target: any, path: string, val: unknown): void {
  if (!target || !path) return;
  var parts = path.trim().split('.');
  if (parts[0] === '$value' || parts[0] === '$result') parts.shift();
  if (parts.length === 0) return;
  var cur = target;
  for (var i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/**
 * input_mapping 应用：{ 参数名: '$value.token' } → { 参数名: 解析值 }
 */
export function applyInputMapping(
  mapping: Record<string, string> | undefined | null,
  value?: unknown,
  result?: unknown,
): Record<string, unknown> {
  var out: Record<string, unknown> = {};
  if (!mapping) return out;
  var ctx = { value: value, result: result };
  for (var key in mapping) {
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      out[key] = resolvePath(ctx, mapping[key]);
    }
  }
  return out;
}

/**
 * output_mapping 应用：{ '$value.claims': '$result' } → 把 result 写回 value 副本
 * value 为 null/undefined 时以 {} 为基底；深拷贝避免污染原值
 */
export function applyOutputMapping(
  mapping: Record<string, string> | undefined | null,
  value: unknown,
  result: unknown,
): unknown {
  if (!mapping) return value;
  var base: any;
  try {
    base = value == null ? {} : JSON.parse(JSON.stringify(value));
  } catch (e) {
    base = {};
  }
  var ctx = { value: value, result: result };
  for (var targetPath in mapping) {
    if (Object.prototype.hasOwnProperty.call(mapping, targetPath)) {
      setPath(base, targetPath, resolvePath(ctx, mapping[targetPath]));
    }
  }
  return base;
}

// ─────────────────────────────────────────────────────────────
// L4.5 异常匹配
// ─────────────────────────────────────────────────────────────

/**
 * 异常匹配：按声明顺序返回第一个 condition 命中的异常声明
 * 求值上下文：result（handler 返回值或异常对象）
 */
export function matchError(
  errors: ErrorDeclLike[] | undefined | null,
  result: unknown,
): ErrorDeclLike | null {
  if (!errors || errors.length === 0) return null;
  for (var i = 0; i < errors.length; i++) {
    if (evalCondition(errors[i].condition, undefined, result)) return errors[i];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 通用：状态快照
// ─────────────────────────────────────────────────────────────

/**
 * 生成状态快照字符串（用于轮询对比检测变化）
 * 循环引用 / BigInt 等序列化失败时返回 null（该轮跳过）
 */
export function makeSnapshot(data: unknown): string | null {
  try {
    return JSON.stringify(data);
  } catch (e) {
    return null;
  }
}
