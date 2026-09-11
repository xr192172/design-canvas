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
    expect(mapGoType('chan int').degree).toBe('unsupported');
  });

  it('纯函数骨架：签名锁定，body 留孔', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const skel = renderTsSkeleton(add);
    expect(skel).toContain('export function Add(a: number, b: number): number {');
  });

  it('不可机械翻译的语义被写进单元约束', async () => {
    const read = (await unitsOf(GO_SRC)).find((u) => u.name === 'Read')!;
    renderTsSkeleton(read);
    expect(read.skeleton).toContain('export function Read(): unknown {');
    expect(read.constraints.join(' ')).toContain('多返回值');
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