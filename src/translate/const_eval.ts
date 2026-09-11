/**
 * const_eval —— Go 编译期常量表达式求值器（确定性、纯函数）
 *
 * 只处理「语言规范保证唯一结果、无副作用」的常量表达式：整/浮/字符/字符串/布尔字面量、
 * 算术(+ - * / %)、移位(<< >>)、位运算(& | ^)、一元(- + ^ !)、字符串拼接(+)、括号，
 * 以及引用同包其它常量。手工处理不了/非常量（函数调用、类型转换运行时等）→ 返回 null，
 * 交由 LLM/人工（不硬猜，符合设计契约）。
 *
 * 用 BigInt 做整数运算避免溢出；输出 TS 字面量用 constToTsLiteral。
 */

import type { SyntaxNodeLike } from '../tools/ts_kernel/index.js';

export type ConstValue =
  | { kind: 'int'; num: bigint }
  | { kind: 'float'; num: number }
  | { kind: 'string'; str: string }
  | { kind: 'bool'; bool: boolean };

/** 同包其它常量的查找（未定义返回 null） */
export type ConstLookup = (name: string) => ConstValue | null;

const OP = new Set(['+', '-', '*', '/', '%', '<<', '>>', '&', '|', '^', '&&', '||', '==', '!=', '<', '<=', '>', '>=']);
const UNARY = new Set(['+', '-', '^', '!']);

function field(node: SyntaxNodeLike, name: string): SyntaxNodeLike | null {
  try {
    return node.childForFieldName(name) ?? null;
  } catch {
    return null;
  }
}

/** Go 数字字面量 → bigint（支持 _/0x/0o/0b，去前缀后缀） */
function parseGoInt(text: string): bigint | null {
  let t = text.replace(/[iUuLl]+$/, '').replace(/_/g, '');
  let radix = 10;
  if (/^0[xX]/.test(t)) {
    radix = 16;
    t = t.slice(2);
  } else if (/^0[bB]/.test(t)) {
    radix = 2;
    t = t.slice(2);
  } else if (/^0[oO]/.test(t)) {
    radix = 8;
    t = t.slice(2);
  }
  try {
    return BigInt(`0x${t}`.replace(/^0x/, radix === 16 ? '0x' : radix === 8 ? '0o' : radix === 2 ? '0b' : ''));
  } catch {
    return null;
  }
}

function parseGoFloat(text: string): number | null {
  const t = text.replace(/_/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Go 字符串字面量解码（interpreted `".."` 可 JSON.parse 近似；raw `` `..` `` 去反引号） */
function parseGoString(text: string): string | null {
  if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 递归求值；无法归约为常量 → null */
export function evalConstExpr(node: SyntaxNodeLike, lookup: ConstLookup): ConstValue | null {
  if (!node) return null;
  switch (node.type) {
    case 'expression_list':
    case 'parenthesized_expression':
    case 'primary_expression': {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c && ['int_literal', 'float_literal', 'true', 'false', 'interpreted_string_literal', 'raw_string_literal', 'character_literal', 'identifier', 'binary_expression', 'unary_expression', 'parenthesized_expression'].includes(c.type)) {
          return evalConstExpr(c, lookup);
        }
      }
      return null;
    }
    case 'int_literal': {
      const n = parseGoInt(node.text);
      return n === null ? null : { kind: 'int', num: n };
    }
    case 'float_literal': {
      const n = parseGoFloat(node.text);
      return n === null ? null : { kind: 'float', num: n };
    }
    case 'true':
      return { kind: 'bool', bool: true };
    case 'false':
      return { kind: 'bool', bool: false };
    case 'interpreted_string_literal':
    case 'raw_string_literal': {
      const s = parseGoString(node.text);
      return s === null ? null : { kind: 'string', str: s };
    }
    case 'character_literal': {
      // Go 字符字面量 = rune(int)，取码点；'a' → "a" 解码
      const s = parseGoString('"' + node.text.slice(1, -1) + '"');
      if (s === null || s.length === 0) return null;
      return { kind: 'int', num: BigInt(s.codePointAt(0) ?? 0) };
    }
    case 'identifier':
      return lookup(node.text); // 引用同包常量
    case 'unary_expression': {
      const opN = field(node, 'operator');
      const op = opN ? opN.text : scanOp(node, UNARY);
      const operand = field(node, 'operand') || firstExprChild(node);
      if (!op || !operand) return null;
      const v = evalConstExpr(operand, lookup);
      if (!v) return null;
      return applyUnary(op, v);
    }
    case 'binary_expression': {
      const opN = field(node, 'operator');
      const op = opN ? opN.text : scanOp(node, OP);
      const left = field(node, 'left') || firstExprChild(node, 0);
      const right = field(node, 'right') || firstExprChild(node, 1);
      if (!op || !left || !right) return null;
      const l = evalConstExpr(left, lookup);
      const r = evalConstExpr(right, lookup);
      if (!l || !r) return null;
      return applyBinary(op, l, r);
    }
    default:
      return null;
  }
}

/** 在节点直接子节点里找第一个运算符 token（字段缺失时兜底） */
function scanOp(node: SyntaxNodeLike, set: Set<string>): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && set.has(c.type)) return c.type;
  }
  return null;
}

/** 取第 idx 个"表达式"子节点（跳过运算符 token） */
function firstExprChild(node: SyntaxNodeLike, idx = 0): SyntaxNodeLike | null {
  let n = 0;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c || OP.has(c.type) || UNARY.has(c.type)) continue;
    if (n === idx) return c;
    n++;
  }
  return null;
}

function applyUnary(op: string, v: ConstValue): ConstValue | null {
  if (v.kind === 'bool') return op === '!' ? { kind: 'bool', bool: !v.bool } : null;
  if (v.kind === 'string') return op === '+' ? v : null;
  if (v.kind === 'int') {
    if (op === '+') return v;
    if (op === '-') return { kind: 'int', num: -v.num };
    if (op === '^') return { kind: 'int', num: ~v.num };
  }
  if (v.kind === 'float' && v.num === Math.trunc(v.num) && (op === '+' || op === '-')) return { kind: 'float', num: op === '-' ? -v.num : v.num };
  return null;
}

function toBig(v: ConstValue): bigint | null {
  if (v.kind === 'int') return v.num;
  if (v.kind === 'float' && Number.isInteger(v.num)) return BigInt(Math.trunc(v.num));
  return null;
}

function applyBinary(op: string, l: ConstValue, r: ConstValue): ConstValue | null {
  const numOp = (l.kind === 'int' || l.kind === 'float') && (r.kind === 'int' || r.kind === 'float');
  if (numOp) {
    const li = toBig(l);
    const ri = toBig(r);
    if (['+', '-', '*', '&', '|', '^', '<<', '>>'].includes(op)) {
      if (li === null || ri === null) return null;
      if (op === '+') return { kind: 'int', num: li + ri };
      if (op === '-') return { kind: 'int', num: li - ri };
      if (op === '*') return { kind: 'int', num: li * ri };
      if (op === '&') return { kind: 'int', num: li & ri };
      if (op === '|') return { kind: 'int', num: li | ri };
      if (op === '^') return { kind: 'int', num: li ^ ri };
      if (op === '<<' && ri >= 0n && ri < 64n) return { kind: 'int', num: li << ri };
      if (op === '>>' && ri >= 0n && ri < 64n) return { kind: 'int', num: li >> ri };
      return null;
    }
    if (op === '%') {
      if (li === null || ri === null || ri === 0n) return null;
      return { kind: 'int', num: li % ri };
    }
    if (op === '/') {
      if (li === null || ri === null || ri === 0n) return null;
      if (li % ri === 0n) return { kind: 'int', num: li / ri };
      return { kind: 'float', num: Number(li) / Number(ri) };
    }
    // 比较情况落空到下方 comparison 块
  }
  // 字符串：仅 + 拼接
  if (op === '+' && l.kind === 'string' && r.kind === 'string') return { kind: 'string', str: l.str + r.str };
  // 比较（数值/字符串）
  if (['==', '!=', '<', '<=', '>', '>='].includes(op) && l.kind !== 'bool' && r.kind !== 'bool') {
    const eq = cmp(l, r);
    if (eq === null) return null;
    switch (op) {
      case '==':
        return { kind: 'bool', bool: eq === 0 };
      case '!=':
        return { kind: 'bool', bool: eq !== 0 };
      case '<':
        return { kind: 'bool', bool: eq < 0 };
      case '<=':
        return { kind: 'bool', bool: eq <= 0 };
      case '>':
        return { kind: 'bool', bool: eq > 0 };
      case '>=':
        return { kind: 'bool', bool: eq >= 0 };
    }
  }
  // 逻辑 && / ||
  if (op === '&&' && l.kind === 'bool' && r.kind === 'bool') return { kind: 'bool', bool: l.bool && r.bool };
  if (op === '||' && l.kind === 'bool' && r.kind === 'bool') return { kind: 'bool', bool: l.bool || r.bool };
  return null;
}

/** 比较 l 与 r → -1/<, 0/==, 1/>；不可比返回 null */
function cmp(l: ConstValue, r: ConstValue): number | null {
  if ((l.kind === 'int' || l.kind === 'float') && (r.kind === 'int' || r.kind === 'float')) {
    const a = l.kind === 'int' ? l.num : BigInt(Math.trunc(l.num));
    const b = r.kind === 'int' ? r.num : BigInt(Math.trunc(r.num));
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (l.kind === 'string' && r.kind === 'string') return l.str < r.str ? -1 : l.str > r.str ? 1 : 0;
  if (l.kind === 'bool' && r.kind === 'bool') return l.bool === r.bool ? 0 : l.bool ? 1 : -1;
  return null;
}

/** 常量值 → TS 字面量源码 */
export function constToTsLiteral(v: ConstValue): string {
  if (v.kind === 'int') return v.num.toString();
  if (v.kind === 'float') return String(v.num);
  if (v.kind === 'bool') return String(v.bool);
  return JSON.stringify(v.str);
}