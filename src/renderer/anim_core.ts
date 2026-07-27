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
 * - L4.5 异常语义：matchError / isErrorResult / classifyError
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
// L4 函数绑定辅助
// ─────────────────────────────────────────────────────────────

/**
 * 从 API signature 解析函数名
 * 兼容形式：
 *   "Compose() (string, error)"        → "Compose"
 *   "SectionQueue.Push(section *Section)" → "Push"
 *   "func Authenticate(token string) (*Claims, error)" → "Authenticate"
 *   "DraftZone.AddDraft(content string) (int, error)"  → "AddDraft"
 */
export function parseApiName(signature: string | undefined | null): string {
  if (!signature) return '';
  var s = String(signature).trim();
  s = s.replace(/^func\s+/, '');
  // 方法接收者形式：func (r *SectionQueue) Push(...) → Push
  s = s.replace(/^\([^)]*\)\s*/, '');
  var parenIdx = s.indexOf('(');
  if (parenIdx > 0) s = s.substring(0, parenIdx);
  var parts = s.trim().split('.');
  var name = parts[parts.length - 1] || '';
  return name.trim();
}

/**
 * 格式化 handler 调用参数为短字符串（用于浮层展示）
 * { token: "abc123", n: 4 } → "token=\"abc123\", n=4"（单值超 maxLen 截断）
 */
export function formatHandlerArgs(
  args: Record<string, unknown>,
  maxLen?: number,
): string {
  var limit = maxLen || 16;
  var parts: string[] = [];
  for (var key in args) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    var v = args[key];
    var s: string;
    try {
      s = JSON.stringify(v);
    } catch (e) {
      s = String(v);
    }
    if (s == null) s = String(v);
    if (s.length > limit) s = s.substring(0, limit - 1) + '…';
    parts.push(key + '=' + s);
  }
  return parts.join(', ');
}

/**
 * 格式化任意值为短字符串（用于 IO 浮层输出预览、步进器数据展示）
 * 对象/数组走 JSON.stringify，超 maxLen 截断；null/undefined → ''
 */
export function formatValueShort(v: unknown, maxLen?: number): string {
  if (v === null || v === undefined) return '';
  var limit = maxLen || 32;
  var s: string;
  if (typeof v === 'string') {
    s = v;
  } else {
    try {
      s = JSON.stringify(v);
    } catch (e) {
      s = String(v);
    }
  }
  if (s == null) s = String(v);
  if (s.length > limit) s = s.substring(0, limit - 1) + '…';
  return s;
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

/**
 * 结果是否"看起来像异常"（L4.5 未声明异常检测的判定约定）
 *
 * 约定（与 L5 live 模式的异常对象结构对齐）：
 * - result.error != null  → 业务/系统错误对象（如 { error: { code: 401 } }）
 * - result.panic === true → panic 级故障（如 { panic: true, message: 'nil pointer' }）
 *
 * 非对象 / null / 正常业务数据 → false
 */
export function isErrorResult(result: unknown): boolean {
  if (result == null || typeof result !== 'object') return false;
  var r = result as Record<string, unknown>;
  if (r.error != null) return true;
  if (r.panic === true) return true;
  return false;
}

/** 异常分类结果（L4.5） */
export interface ErrorClassification {
  /**
   * none       —— 正常结果（或未命中任何异常形态），走正常流
   * declared   —— 命中 errors 声明，按声明的 severity 处理
   * undeclared —— 结果像异常但未命中任何声明 → 未声明异常警报（发现 bug）
   */
  kind: 'none' | 'declared' | 'undeclared';
  /** kind === 'declared' 时命中的声明 */
  decl?: ErrorDeclLike;
}

/**
 * 异常分类（L4.5 核心判定）：
 * 1. 先按声明顺序匹配 errors
 * 2. 未命中但结果像异常 → undeclared（无论 errors 是否为空）
 * 3. 否则 → none
 */
export function classifyError(
  errors: ErrorDeclLike[] | undefined | null,
  result: unknown,
): ErrorClassification {
  var decl = matchError(errors, result);
  if (decl) return { kind: 'declared', decl: decl };
  if (isErrorResult(result)) return { kind: 'undeclared' };
  return { kind: 'none' };
}

// ─────────────────────────────────────────────────────────────
// D3 注入回放：预设场景构造 + 形状质检（纯逻辑单源，MCP 工具与浏览器面板共用）
// ─────────────────────────────────────────────────────────────

/** 数据形状 schema（与 AnimationValueSchema 结构对齐，此处独立声明避免 import） */
export interface ValueSchemaLike {
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'integer' | 'null';
  label?: string;
  properties?: Record<string, ValueSchemaLike>;
  items?: ValueSchemaLike;
  required?: string[];
  enum?: (string | number)[];
  description?: string;
}

/**
 * 从 condition 提取字符串字面量（如 'BUDGET_EXCEEDED'）作为错误码候选
 */
export function extractStringLiterals(condition: string | undefined | null): string[] {
  var out: string[] = [];
  if (!condition) return out;
  var re = /'([^'\\]*)'|"([^"\\]*)"/g;
  var m: RegExpExecArray | null;
  while ((m = re.exec(condition)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return out;
}

/**
 * 预设场景候选注入值：condition 字面量 × 字段形态（code / message / 裸字符串），其次常见形态
 * 真实工程教训：condition 可能是 message 子串匹配（indexOf）或裸字符串比较（result.error === 'EOF'），
 * 只会构造 code 字段的值永远命中不了这类声明
 */
export function presetCandidates(decl: ErrorDeclLike): unknown[] {
  var literals = extractStringLiterals(decl.condition);
  var out: unknown[] = [];
  for (var i = 0; i < literals.length; i++) {
    var lit = literals[i];
    out.push({ error: { code: lit, message: decl.type } });
    out.push({ error: { code: decl.type, message: lit } });
    out.push({ error: { message: lit } });
    out.push({ error: lit });
  }
  out.push(
    { error: { code: decl.type, message: decl.type } },
    { error: { code: decl.type } },
    { panic: true, message: decl.type },
    { error: { type: decl.type } },
    { error: decl.type },
  );
  return out;
}

/**
 * 为 errors 声明自动构造注入值；都不命中 condition 时返回首选形态 + hit=false
 */
export function buildPresetValue(decl: ErrorDeclLike): { value: unknown; hit: boolean } {
  var candidates = presetCandidates(decl);
  for (var i = 0; i < candidates.length; i++) {
    if (evalCondition(decl.condition, undefined, candidates[i])) {
      return { value: candidates[i], hit: true };
    }
  }
  return { value: candidates[0], hit: false };
}

/**
 * 轻量形状校验（AnimationValueSchema 子集：type / properties / required / items / enum）
 * 与 ajv(strict:false) 语义对齐：label 等非标关键字忽略；返回违例列表（空 = 通过）
 * 违例格式："/tokens: 期望 integer，实际 string"（路径与 ajv instancePath 同风格）
 */
export function validateValueSchema(schema: ValueSchemaLike | undefined | null, value: unknown): string[] {
  var violations: string[] = [];

  function typeName(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  }

  function typeOk(t: string, v: unknown): boolean {
    switch (t) {
      case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
      case 'array': return Array.isArray(v);
      case 'string': return typeof v === 'string';
      case 'number': return typeof v === 'number';
      case 'integer': return typeof v === 'number' && isFinite(v as number) && Math.floor(v as number) === v;
      case 'boolean': return typeof v === 'boolean';
      case 'null': return v === null;
      default: return true;
    }
  }

  function walk(s: ValueSchemaLike, v: unknown, path: string): void {
    if (!s || typeof s !== 'object') return;
    if (s.type && !typeOk(s.type, v)) {
      violations.push(path + ': 期望 ' + s.type + '，实际 ' + typeName(v));
      return; // 类型不匹配不再深入（避免级联垃圾违例）
    }
    if (s.enum && s.enum.length > 0) {
      var hit = false;
      for (var i = 0; i < s.enum.length; i++) {
        if (s.enum[i] === v) { hit = true; break; }
      }
      if (!hit) {
        violations.push(path + ': 取值 ' + formatValueShort(v, 24) + ' 不在枚举 (' + s.enum.join('|') + ')');
      }
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      var obj = v as Record<string, unknown>;
      if (s.required) {
        for (var r = 0; r < s.required.length; r++) {
          var key = s.required[r];
          if (!Object.prototype.hasOwnProperty.call(obj, key)) {
            violations.push(path + '/' + key + ': 缺少必填字段');
          }
        }
      }
      if (s.properties) {
        for (var k in s.properties) {
          if (Object.prototype.hasOwnProperty.call(s.properties, k) &&
              Object.prototype.hasOwnProperty.call(obj, k)) {
            walk(s.properties[k], obj[k], path + '/' + k);
          }
        }
      }
    }
    if (Array.isArray(v) && s.items) {
      for (var i = 0; i < v.length; i++) {
        walk(s.items, v[i], path + '/' + i);
      }
    }
  }

  walk(schema as ValueSchemaLike, value, '/');
  return violations;
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
