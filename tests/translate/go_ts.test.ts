/**
 * go_ts —— Go→TS 最小切片测试（vitest）
 *
 * 覆盖：萃取（func/struct）、typeMap 薄表（标量/切片/指针）、语义不可机械
 * 翻译的如实标注（error / 多返回值）、骨架结构闸、端到端管道。
 */

import { describe, it, expect } from 'vitest';
import { extractGo } from '../../src/translate/go_extractor.js';
import { mapGoType, renderTsSkeleton } from '../../src/translate/ts_codegen.js';
import { verifySkeletons } from '../../src/translate/verify.js';
import { translateGoToTs } from '../../src/translate/pairs.js';
import { buildHolePrompt } from '../../src/translate/prompts.js';
import type { TransUnit } from '../../src/translate/unit.js';

const GO_SRC = `package calc

func Add(a, b int) int {
\treturn a + b
}

func Greet(name string) {
\tprintln("hi " + name)
}

func Sum(xs []int) int {
\ttotal := 0
\tfor _, x := range xs {
\t\ttotal += x
\t}
\treturn total
}

func Read() (string, error) {
\treturn "", nil
}

type User struct {
\tName string
\tAge  int
}
`;

async function unitsOf(src: string): Promise<TransUnit[]> {
  return (await extractGo('/tmp/calc.go', src)).units;
}

describe('go_extractor：萃取顶层 func / struct', () => {
  it('萃取出纯函数与结构体单元', async () => {
    const units = await unitsOf(GO_SRC);
    expect(units.length).toBeGreaterThanOrEqual(5);
    const add = units.find((u) => u.name === 'Add');
    expect(add?.kind).toBe('func');
    expect(add?.result).toBe('int');
    expect(add?.params).toEqual([
      { name: 'a', type: 'int' },
      { name: 'b', type: 'int' },
    ]);
    const user = units.find((u) => u.name === 'User');
    expect(user?.kind).toBe('type');
    expect(user?.fields).toEqual([
      { name: 'Name', type: 'string' },
      { name: 'Age', type: 'int' },
    ]);
  });

  it('无返回值函数 result 为 null，func 恒为孔', async () => {
    const unused = await unitsOf(GO_SRC);
    const greet = unused.find((u) => u.name === 'Greet');
    expect(greet?.result).toBeNull();
    expect(greet?.bodyHole).toBe(true);
  });
});

describe('ts_codegen：typeMap 薄表 + 确定性骨架', () => {
  it('标量类型 1:1 映射', () => {
    expect(mapGoType('int').ts).toBe('number');
    expect(mapGoType('string').ts).toBe('string');
    expect(mapGoType('float64').ts).toBe('number');
    expect(mapGoType('bool').ts).toBe('boolean');
    expect(mapGoType('[]int').ts).toBe('number[]');
    expect(mapGoType('*User').ts).toBe('User');
  });

  it('语义不可机械翻译如实标注（error / 多返回值 / chan）', () => {
    expect(mapGoType('error').degree).toBe('unsupported');
    expect(mapGoType('(string, error)').degree).toBe('unsupported');
  });

  it('chan → Channel<T>（直译），方向单/双向都可', () => {
    expect(mapGoType('chan int').degree).toBe('direct');
    expect(mapGoType('chan int').ts).toBe('Channel<number>');
    expect(mapGoType('<-chan string').ts).toBe('Channel<string>');
    expect(mapGoType('chan<- int').ts).toBe('Channel<number>');
  });

  it('纯函数骨架：签名锁定，body 留孔', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const skel = renderTsSkeleton(add);
    expect(skel).toContain('export function Add(a: number, b: number): number {');
  });

  it('不可机械翻译的语义被写进单元约束', async () => {
    const read = (await unitsOf(GO_SRC)).find((u) => u.name === 'Read')!;
    renderTsSkeleton(read);
    // 多返回值现映射为 TS 元组（string, error）→ [string, Error | null]
    expect(read.skeleton).toContain('export function Read(): [string, Error | null] {');
    expect(read.constraints.join(' ')).toContain('多返回值'); // error 分量仍标不可机械翻译
  });

  it('struct → interface 完整生成（非孔）', async () => {
    const user = (await unitsOf(GO_SRC)).find((u) => u.name === 'User')!;
    const skel = renderTsSkeleton(user);
    expect(skel).toBe(`export interface User {\n  Name: string;\n  Age: number;\n}`);
    expect(user.bodyHole).toBe(false);
  });
});

describe('verify：骨架静态闸', () => {
  it('生成的骨架全部通过 .ts 解析闸 + 结构闸', async () => {
    const units = await unitsOf(GO_SRC);
    for (const u of units) u.skeleton = renderTsSkeleton(u);
    const issues = await verifySkeletons(units);
    expect(issues).toEqual([]);
  });

  it('语法闸拦截"签名被破坏"的骨架', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    add.skeleton = 'export function Broken(x: number {';
    const issues = await verifySkeletons([add]);
    expect(issues.some((i) => i.gate === 'syntax')).toBe(true);
  });

  it('结构闸拦截函数名漂移', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    add.skeleton = 'export function Wrong(a: number, b: number): number {}';
    const issues = await verifySkeletons([add]);
    expect(issues.some((i) => i.gate === 'structure')).toBe(true);
  });
});

describe('prompts：单孔 LLM 指令锁定签名', () => {
  it('prompt 含锁定骨架与源证据，不含自由翻译指令', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    renderTsSkeleton(add);
    const p = buildHolePrompt(add);
    expect(p).toContain('export function Add');
    expect(p).toContain('return a + b');
    expect(p).toContain('不得改动函数签名');
  });
});

describe('pairs：端到端管道', () => {
  it('translateGoToTs 产出一份可解析的目标源码', async () => {
    const r = await translateGoToTs('calc.go', GO_SRC);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.output).toContain('export function Add(a: number, b: number): number');
    expect(r.output).toContain('export interface User');
    expect(r.holePrompts.length).toBeGreaterThanOrEqual(4);
  });
});

describe('方法(receiver)：Go 语义覆盖', () => {
  const GO_SRC_METHOD = `package svc
type User struct {
\tName string
}
func (u *User) Greet(n string) string {
\treturn u.Name + " " + n
}
`;
  it('萃取到方法单元：receiver 作首参，命名带类型前缀', async () => {
    const units = await unitsOf(GO_SRC_METHOD);
    const greet = units.find((u) => u.name === 'User_Greet');
    expect(greet).toBeTruthy();
    expect(greet?.kind).toBe('func');
    expect(greet?.params?.[0]).toEqual({ name: 'u', type: 'User' });
  });

  it('方法骨架：receiver 参数映射为 User，body 留孔且验证通过', async () => {
    const units = await unitsOf(GO_SRC_METHOD);
    const greet = units.find((u) => u.name === 'User_Greet')!;
    renderTsSkeleton(greet);
    expect(greet.skeleton).toContain('export function User_Greet(u: User, n: string): string {');
    const issues = await verifySkeletons([greet]);
    expect(issues).toEqual([]);
  });
});

describe('多返回值→TS 元组：Go 语义覆盖', () => {
  it('(int, bool) → [number, boolean] 机械直接映射', () => {
    expect(mapGoType('(int, bool)').degree).toBe('direct');
    expect(mapGoType('(int, bool)').ts).toBe('[number, boolean]');
  });

  it('(string, error) → [string, Error | null]，error 分量仍标不可机械翻译', () => {
    const m = mapGoType('(string, error)');
    expect(m.ts).toBe('[string, Error | null]');
    expect(m.degree).toBe('unsupported');
    expect(m.note).toContain('多返回值');
  });

  it('(int)(单个括号) 不误当元组', () => {
    expect(mapGoType('(int)').degree).toBe('unsupported');
  });
});

describe('接口 + named 类型别名：Go 语义覆盖', () => {
  const GO_SRC_TYPES = `package s
type Greeter interface {
\tGreet(n string) string
\tScore(v int) (bool, error)
}
type MyInt int
type Names []string
`;
  it('接口萃取方法签名（含单返回与多返回）', async () => {
    const units = await unitsOf(GO_SRC_TYPES);
    const g = units.find((u) => u.name === 'Greeter');
    expect(g?.typeKind).toBe('interface');
    const names = (g?.methods ?? []).map((m) => m.name);
    expect(names).toEqual(['Greet', 'Score']);
    expect(g?.methods?.[0].params).toEqual([{ name: 'n', type: 'string' }]);
    expect(g?.methods?.[1].result).toBe('(bool, error)');
  });

  it('接口骨架：方法签名映射为 callable 字段', async () => {
    const units = await unitsOf(GO_SRC_TYPES);
    const g = units.find((u) => u.name === 'Greeter')!;
    renderTsSkeleton(g);
    expect(g.skeleton).toContain('export interface Greeter');
    expect(g.skeleton).toContain('  Greet(n: string): string;');
    expect(g.skeleton).toContain('  Score(v: number): [boolean, Error | null];');
    const issues = await verifySkeletons([g]);
    expect(issues).toEqual([]);
  });

  it('named 别名：type MyInt int → export type MyInt = number', async () => {
    const units = await unitsOf(GO_SRC_TYPES);
    const my = units.find((u) => u.name === 'MyInt');
    expect(my?.typeKind).toBe('alias');
    expect(my?.aliasType).toBe('int');
    renderTsSkeleton(my!);
    expect(my?.skeleton).toBe('export type MyInt = number;');
  });

  it('named 数组别名：[]string → string[]，且验证闸通过', async () => {
    const units = await unitsOf(GO_SRC_TYPES);
    const names = units.find((u) => u.name === 'Names')!;
    renderTsSkeleton(names);
    expect(names.skeleton).toBe('export type Names = string[];');
    const issues = await verifySkeletons([names]);
    expect(issues).toEqual([]);
  });
});

describe('Go 泛型：Go 语义覆盖', () => {
  const GO_SRC_GEN = `package g
type Pair[T any] struct {
\tFirst  T
\tSecond T
}
type Slice[T any] []T
func Max[T comparable](a, b T) T {
\tif a > b { return a }
\treturn b
}
`;
  it('泛型函数：typeParams=[T]，类型引用透传为 T', async () => {
    const units = await unitsOf(GO_SRC_GEN);
    const max = units.find((u) => u.name === 'Max');
    expect(max?.typeParams).toEqual(['T']);
    renderTsSkeleton(max!);
    expect(max?.skeleton).toContain('export function Max<T>(a: T, b: T): T {');
    const issues = await verifySkeletons([max!]);
    expect(issues).toEqual([]);
  });

  it('泛型 struct：interface Pair<T>，字段 T 透传', async () => {
    const units = await unitsOf(GO_SRC_GEN);
    const pair = units.find((u) => u.name === 'Pair')!;
    renderTsSkeleton(pair);
    expect(pair.skeleton).toBe('export interface Pair<T> {\n  First: T;\n  Second: T;\n}');
  });

  it('泛型别名：type Slice<T> = T[]', async () => {
    const units = await unitsOf(GO_SRC_GEN);
    const slice = units.find((u) => u.name === 'Slice')!;
    renderTsSkeleton(slice);
    expect(slice.skeleton).toBe('export type Slice<T> = T[];');
    const issues = await verifySkeletons([slice]);
    expect(issues).toEqual([]);
  });
});

describe('并发语义：chan/defer/go/select', () => {
  const GO_SRC_CONC = `package con
func Produce(ch chan int) {
\tch <- 42
\tdefer close(ch)
\tgo process()
}
func process() { select {} }
`;
  it('chan 参数 → Channel<number>，translateGoToTs 输出前置通道垫片', async () => {
    const r = await translateGoToTs('con.go', GO_SRC_CONC);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('export class Channel<T>');
    expect(r.output).toContain('Produce(ch: Channel<number>) {');
  });

  it('函数体含 defer/go/select/<- → 约束里写映射提示（不硬猜语义）', async () => {
    const units = await unitsOf(GO_SRC_CONC);
    const produce = units.find((u) => u.name === 'Produce')!;
    const all = produce.constraints.join(' ');
    expect(all).toContain('defer');
    expect(all).toContain('go 语句');
    expect(all).toContain('通道收发');
    const process = units.find((u) => u.name === 'process')!;
    expect(process.constraints.join(' ')).toContain('select');
  });
});