/**
 * ts_codegen —— Go→TS 机械骨架生成（三段式落地"② 骨架生成"）
 *
 * 职责：把一条 trans_unit（func/type）渲染成**确定性的** TS 骨架。
 *   - func：`export function Name(params): Ret { bodymarker }`（bodymarker=孔）——签名/导出被
 *     焊死，函数体留孔交给 LLM 填（bodyHole）。
 *   - type：`export interface Name { ... }` —— 完整生成，无需 LLM。
 *
 * 类型映射走一张薄表 GO_TO_TS + 语义包裹判断。可机械映射的直接换；
 * 语义不可机械翻译的（error 传播 / chan / func 参数 / 多返回值）如实标
 * `degree='unsupported'` 并进 constraints —— 符合仓库"不猜语义"契约，
 * 绝不硬译。
 */

import { withConstraints, type TransUnit, type TranslateParam } from './unit.js';

/** 标量/名称型 1:1 映射（Go → TS） */
const GO_TO_TS: Record<string, string> = {
  int: 'number',
  int8: 'number',
  int16: 'number',
  int32: 'number',
  int64: 'number',
  uint: 'number',
  uint8: 'number',
  uint16: 'number',
  uint32: 'number',
  uint64: 'number',
  uintptr: 'number',
  byte: 'number',
  rune: 'number',
  float32: 'number',
  float64: 'number',
  string: 'string',
  bool: 'boolean',
  any: 'unknown',
  'interface{}': 'unknown',
};

export interface MappedType {
  /** 机械可映射程度：'direct' 直接可用；'unsupported' 语义不可机械翻译 */
  degree: 'direct' | 'unsupported';
  /** 目标 TS 类型文本 */
  ts: string;
  /** 需并入 constraints 的语义 note；无则省略 */
  note?: string;
}

/**
 * 映射一个 Go 类型到 TS。返回机械可映射程度——让骨架生成与人工审都在
 * 同一本"能机械 / 需 LLM"的账上对齐。
 */
export function mapGoType(goType: string): MappedType {
  const t = (goType || '').trim();
  if (t === '') return { degree: 'direct', ts: 'void' };

  // 切片 `[]T`
  if (t.startsWith('[]')) {
    const inner = mapGoType(t.slice(2));
    return { degree: inner.degree, ts: `${inner.ts}[]`, note: inner.note };
  }
  // 指针 `*T`（Go 指针在切片内按值语义近似）
  if (t.startsWith('*')) {
    const inner = mapGoType(t.slice(1));
    return { degree: inner.degree, ts: inner.ts, note: inner.note };
  }
  // map[K]V（key 只吃首个顶层 ]，值可含嵌套 []，如 `map[string][]int`)
  const mM = /^map\[([^\]]+)\](.+)$/.exec(t);
  if (mM) {
    const k = mapGoType(mM[1]).ts;
    const v = mapGoType(mM[2]).ts;
    return { degree: 'direct', ts: `Map<${k}, ${v}>` };
  }
  // 多返回值 `(T1, T2[, ...])` → TS 元组 `[T1, T2, ...]`（分量各自 mapGoType）
  if (t.startsWith('(') && t.endsWith(')') && /,\s*\S/.test(t)) {
    const parts = splitTopLevel(t.slice(1, -1));
    if (parts.length >= 2) {
      const mapped = parts.map((p) => mapGoType(p.trim()));
      const hasUnsup = mapped.some((m) => m.degree === 'unsupported');
      const pieces = mapped.map((m, i) => (m.note ? `分量${i + 1}: ${m.note}` : null)).filter(Boolean);
      return {
        degree: hasUnsup ? 'unsupported' : 'direct',
        ts: '[' + mapped.map((m) => m.ts).join(', ') + ']',
        note: hasUnsup ? '多返回值含不可机械翻译分量：' + pieces.join('；') : undefined,
      };
    }
  }

  // —— 语义包裹 / 不可机械翻译 ——
  if (t === 'error' || /^error$/.test(t)) {
    return { degree: 'unsupported', ts: 'Error | null', note: 'Go error 值为显式返回语义；TS 无内建对应，需 LLM/人审（映射为 Error | null 或抛异常）' };
  }
  // chan T / <-chan T / chan<- T → Channel<T>（近似垫片，见 channelShimSource）
  const chanM = /^(?:<-)?chan(?:<-)?\s+(.+)$/.exec(t);
  if (chanM) {
    const elem = mapGoType(chanM[1]);
    return {
      degree: 'direct',
      ts: `Channel<${elem.ts}>`,
      note: elem.degree === 'unsupported' ? `chan 元素: ${elem.note}` : 'chan → Channel<T> 垫片（近似；select/阻塞/竞态语义需人工核）',
    };
  }
  if (t.startsWith('func')) {
    return { degree: 'unsupported', ts: '(...args: unknown[]) => unknown', note: '函数类型参数语义需 LLM 换算签名' };
  }
  // 泛型类型实参（Go 用方括号）：`Name[K, V]` / `List[int]` → 逐实参映射成 TS `Name<K, V>`
  const genSB = /^([A-Za-z_][\w.]*)\[([^\]]+)\]$/.exec(t);
  if (genSB) {
    const base = genSB[1].replace(/\./g, '_');
    const args = splitTopLevel(genSB[2]).map((a) => mapGoType(a.trim()));
    const hasUnsup = args.some((a) => a.degree === 'unsupported');
    return { degree: hasUnsup ? 'unsupported' : 'direct', ts: `${base}<${args.map((a) => a.ts).join(', ')}>` };
  }
  // 泛型类型实参 `<A, B>` → 逐实参映射直通
  const genM = /^([A-Za-z_][\w.]*)<(.+)>$/.exec(t);
  if (genM) {
    const base = genM[1].replace(/\./g, '_');
    const args = splitTopLevel(genM[2]).map((a) => mapGoType(a.trim()));
    const hasUnsup = args.some((a) => a.degree === 'unsupported');
    return { degree: hasUnsup ? 'unsupported' : 'direct', ts: `${base}<${args.map((a) => a.ts).join(', ')}>` };
  }
  // 其它复合/含逗号结果（非元组、无法归类）→ 如实标注
  if (t.includes(',') || /^\(/.test(t)) {
    return { degree: 'unsupported', ts: 'unknown', note: '复合结果无法 1:1 映射，需 LLM 设计结果形态' };
  }

  const direct = GO_TO_TS[t];
  if (direct) return { degree: 'direct', ts: direct };
  // 未识别 → 假定是用户类型/结构体名，透传（type 单元已机械生成 interface）
  return { degree: 'direct', ts: t };
}

/** 在括号深度 0 处按逗号切分（`a, (b, c), d` → [a, (b, c), d]） */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function mapParam({ name, type }: TranslateParam, notes: string[]): string {
  const m = mapGoType(type);
  if (m.note) notes.push(`${name}: ${m.note}`);
  return `${name}: ${m.ts}`;
}

/** 类型参数渲染：`['T','U']` → `<T, U>`（空则空串） */
function typeParamString(u: TransUnit): string {
  const tps = u.typeParams ?? [];
  return tps.length ? `<${tps.join(', ')}>` : '';
}

/** Go→TS 翻译附带一次性的通道垫片（只要任一片段用到 Channel 就前置这段）。 */
export function channelShimSource(): string {
  return [
    '/**',
    ' * design-canvas Go→TS 翻译自动附加的通道垫片。',
    ' * 近似实现：用 JS 队列模拟。非 Go 的阻塞/select/缓冲区满语义，并发与竞态需人工核对。',
    ' */',
    'export class Channel<T> {',
    '  private q: T[] = [];',
    '  private waiters: Array<(v: T) => void> = [];',
    '',
    '  send(v: T): Promise<void> {',
    '    this.q.push(v);',
    '    const w = this.waiters.shift();',
    '    if (w && this.q.length) w(this.q.shift() as T);',
    '    return Promise.resolve();',
    '  }',
    '',
    '  receive(): Promise<T> {',
    '    const head = this.q.shift();',
    '    if (head !== undefined) return Promise.resolve(head);',
    '    return new Promise<T>((res) => this.waiters.push(res));',
    '  }',
    '}',
    '',
  ].join('\n');
}

/** 渲染函数单元骨架（签名锁定，body 留孔） */
function renderFuncSkeleton(u: TransUnit): { code: string; notes: string[] } {
  const notes: string[] = [];
  const params = (u.params ?? []).map((p) => mapParam(p, notes)).join(', ');
  let ret = '';
  if (u.result) {
    const m = mapGoType(u.result);
    if (m.note) notes.push(`return: ${m.note}`);
    ret = `: ${m.ts}`;
  }
  const hole =
    u.bodyHole
      ? '\n  // TODO(translate): 待 LLM 翻译 Go 函数体'
      : '';
  return { code: `export function ${u.name}${typeParamString(u)}(${params})${ret} {${hole}\n}`, notes };
}

/** 渲染 type 单元骨架（struct/interface → interface；alias → type 别名；均非孔） */
function renderTypeSkeleton(u: TransUnit): { code: string; notes: string[] } {
  const notes: string[] = [];

  // type 别名：`type MyInt int` → `export type MyInt = number;`
  if (u.typeKind === 'alias') {
    const m = mapGoType(u.aliasType ?? '');
    if (m.note) notes.push(`alias ${u.name}: ${m.note}`);
    return { code: `export type ${u.name}${typeParamString(u)} = ${m.ts};`, notes };
  }

  // interface：方法签名契约 `export interface Greeter {...}`
  if (u.typeKind === 'interface') {
    const lines = (u.methods ?? [])
      .map((mm) => {
        const params = mm.params.map((p) => mapParam(p, notes)).join(', ');
        let ret = 'void';
        if (mm.result) {
          const m = mapGoType(mm.result);
          if (m.note) notes.push(`${mm.name}: ${m.note}`);
          ret = m.ts;
        }
        return `  ${mm.name}(${params}): ${ret};`;
      })
      .join('\n');
    return { code: `export interface ${u.name}${typeParamString(u)} {\n${lines}\n}`, notes };
  }

  // struct → interface（数据字段）
  const fields = (u.fields ?? [])
    .map((f) => {
      const m = mapGoType(f.type);
      if (m.note) notes.push(`${f.name}: ${m.note}`);
      return `  ${f.name}: ${m.ts};`;
    })
    .join('\n');
  return { code: `export interface ${u.name}${typeParamString(u)} {\n${fields}\n}`, notes };
}

/**
 * 确定性生成目标骨架，并把 typeMap 的语义 note 并入单元约束。
 * 幂等：重复调用结果一致；约束用 withConstraints 去重并入。
 */
export function renderTsSkeleton(u: TransUnit): string {
  const { code, notes } = u.kind === 'func' ? renderFuncSkeleton(u) : renderTypeSkeleton(u);
  // 类型约束传递：非 any/interface{} 的 Go 约束 → 写进约束提醒（TS 无等价约束）
  for (const [tp, c] of Object.entries(u.typeParamConstraints ?? {})) {
    if (c.trim() && !['any', 'interface{}'].includes(c.trim())) {
      notes.push(`类型参数 ${tp} 约束为「${c}」：TS 无等价约束，调用方须保证类型满足（或用 近似值域）`);
    }
  }
  if (notes.length > 0) u.constraints = withConstraints(u.constraints, notes);
  u.skeleton = code;
  return code;
}