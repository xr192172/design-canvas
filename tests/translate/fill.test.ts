/**
 * fill —— LLM 单孔填充闭环测试（注入桩 translator，无需真实 LLM）
 *
 * 覆盖：spliceBody 拼接（含缩进）、fillUnit 成功/失败（语法闸拦坏函数体）、
 * 空函数体判定、type 非孔跳过、批量逐孔隔离。
 */

import { describe, it, expect } from 'vitest';
import { extractGo } from '../../src/translate/go_extractor.js';
import { renderTsSkeleton } from '../../src/translate/ts_codegen.js';
import { spliceBody, fillUnit, fillUnits, type HoleTranslator } from '../../src/translate/fill.js';
import type { TransUnit } from '../../src/translate/unit.js';

const GO_SRC = `package calc
func Add(a, b int) int {
\treturn a + b
}
type User struct {
\tName string
}
`;

async function unitsOf(src: string): Promise<TransUnit[]> {
  const units = (await extractGo('/tmp/fill.go', src)).units;
  for (const u of units) u.skeleton = renderTsSkeleton(u);
  return units;
}

const simpleFiller: HoleTranslator = () => 'return a + b;';

describe('spliceBody：把函数体拼进锁定骨架', () => {
  it('纯函数骨架首{末}之间插入并缩进两级', () => {
    const skeleton = `export function Add(a: number, b: number): number {
  // TODO(translate): 待 LLM 翻译 Go 函数体
}`;
    const filled = spliceBody(skeleton, 'return a + b;');
    expect(filled).toBe(`export function Add(a: number, b: number): number {
  return a + b;
}`);
  });

  it('骨架无 {} 时原样返回（防御）', () => {
    expect(spliceBody('no braces', 'x')).toBe('no braces');
  });
});

describe('fillUnit：填充 + 重验证闭环', () => {
  it('stub 翻译器填出合法函数体 → ok，验证零 issue', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const r = await fillUnit(add, simpleFiller);
    expect(r?.ok).toBe(true);
    expect(r?.issues).toEqual([]);
    expect(r?.filledSource).toContain('export function Add(a: number, b: number): number {');
    expect(r?.filledSource).toContain('  return a + b;');
  });

  it('坏函数体（语法不完整）→ 语法闸拦截，ok=false', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const r = await fillUnit(add, () => 'return a+');
    expect(r?.ok).toBe(false);
    expect(r?.issues.some((i) => i.gate === 'syntax')).toBe(true);
  });

  it('翻译器返回空体 → 报 error，不误判 ok', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const r = await fillUnit(add, () => '');
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain('空函数体');
  });

  it('type（非孔）单元 → null，不参与填充', async () => {
    const user = (await unitsOf(GO_SRC)).find((u) => u.name === 'User')!;
    const r = await fillUnit(user, simpleFiller);
    expect(r).toBeNull();
  });
});

describe('fillUnits：批量逐孔隔离', () => {
  it('只填 bodyHole 单元，独立验证', async () => {
    const units = await unitsOf(GO_SRC);
    const rs = await fillUnits(units, simpleFiller);
    // 只有 Add 是 func 孔；User 是 type 跳过
    expect(rs).toHaveLength(1);
    expect(rs[0].ok).toBe(true);
  });
});