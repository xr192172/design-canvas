/**
 * fill —— LLM 单孔填充闭环测试（注入桩 translator，无需真实 LLM）
 *
 * 覆盖：spliceBody 拼接（含缩进）、fillUnit 成功/失败（语法闸拦坏函数体）、
 * 空函数体判定、type 非孔跳过、批量逐孔隔离。
 */

import { describe, it, expect } from 'vitest';
import { extractGo } from '../../src/translate/go_extractor.js';
import { renderTsSkeleton } from '../../src/translate/ts_codegen.js';
import { spliceBody, fillUnit, fillUnits, fillUnitWithRetry, fillUnitsWithRetry, fillUnitsBatched, parseUnitBlocks, type HoleTranslator } from '../../src/translate/fill.js';
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

describe('fillUnitWithRetry：纠错重试', () => {
  it('首次坏函数体 → feedback 注入后第二次成功', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    let calls = 0;
    const retry: HoleTranslator = (ctx) => {
      calls++;
      return ctx.prompt.includes('上次尝试') ? 'return a + b;' : 'return a +'; // 有 feedback 才修正
    };
    const r = await fillUnitWithRetry(add, retry, 2);
    expect(r?.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('重试耗尽仍坏 → 返回最后一次失败结果', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const alwaysBad: HoleTranslator = () => 'return a +';
    const r = await fillUnitWithRetry(add, alwaysBad, 1);
    expect(r?.ok).toBe(false);
    expect(r?.issues.length).toBeGreaterThan(0);
  });

  it('批量 fillUnitsWithRetry 只处理孔', async () => {
    const units = await unitsOf(GO_SRC);
    const rs = await fillUnitsWithRetry(units, simpleFiller, 1);
    expect(rs).toHaveLength(1);
    expect(rs[0].ok).toBe(true);
  });
});

describe('projectNote：项目级调用约定注入单孔 prompt', () => {
  it('buildFillContext 注入 projectNote → ctx 携带 + prompt 含 note', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    const note = '【项目级调用约定】\n- 可直接调用函数：user_GetName\n- receiver 方法请译成 user_GetName(recv, ...)';
    const ctx = (await import('../../src/translate/fill.js')).buildFillContext(add, undefined, note);
    expect(ctx.projectNote).toBe(note);
    expect(ctx.prompt).toContain('user_GetName');
  });

  it('fillUnit 把 projectNote 透传给 translator 的 ctx', async () => {
    const add = (await unitsOf(GO_SRC)).find((u) => u.name === 'Add')!;
    let seen: string | undefined;
    const recorder: HoleTranslator = (ctx) => {
      seen = ctx.projectNote;
      return 'return a + b;';
    };
    const r = await fillUnit(add, recorder, undefined, 'NOTE-X');
    expect(r?.ok).toBe(true);
    expect(seen).toBe('NOTE-X');
  });
});

describe('批量填充（fillUnitsBatched）', () => {
  it('parseUnitBlocks 按 <unit id> 标记确定性切分 raw', () => {
    const raw = [
      '# 说明文字（应被忽略）',
      '<unit id="Abs">',
      'if (a < 0) {',
      '  return -a;',
      '}',
      'return a;',
      '</unit>',
      '<unit id="Num_Double"> return n.Value * 2; </unit>',
    ].join('\n');
    const blocks = parseUnitBlocks(raw);
    expect(blocks.get('Abs')).toContain('return a;');
    expect(blocks.get('Num_Double')).toContain('return n.Value * 2;');
    expect(blocks.size).toBe(2);
  });

  it('一批次填充全部孔：一次调用返回多块，全部 ok', async () => {
    const units = (await extractGo('/tmp/fill.go', 'package calc\nfunc Add(a, b int) int {\n\treturn a + b\n}\nfunc Sub(a, b int) int {\n\treturn a - b\n}\n')).units;
    for (const u of units) u.skeleton = renderTsSkeleton(u);
    let calls = 0;
    const stub = async (ctxs: any[]): Promise<string> =>
      ctxs.map((c: any) => `<unit id="${c.unit.id}">\nreturn 0;\n</unit>`).join('\n') + `<!--call#${++calls}-->`;
    const rs = await fillUnitsBatched(units, stub as any, { batchSize: 5 });
    expect(calls).toBe(1); // 单次调用
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.every((r) => !r.filledSource.includes('TODO'))).toBe(true);
  });

  it('失败子集隔离重试：坏孔只重发自己，好孔不重发', async () => {
    const src = 'package calc\nfunc Abs(a int) int {\n\treturn a\n}\nfunc Add(a, b int) int {\n\treturn a + b\n}\n';
    const units = (await extractGo('/tmp/b.go', src)).units;
    for (const u of units) u.skeleton = renderTsSkeleton(u);
    const failOnce = new Set(['Abs']); // Abs 首轮给坏体
    const served: string[][] = [];
    const stub = async (ctxs: any[]): Promise<string> => {
      served.push(ctxs.map((c: any) => c.unit.id));
      return ctxs
        .map((c: any) => {
          const bad = failOnce.has(c.unit.id) && failOnce.delete(c.unit.id);
          return `<unit id="${c.unit.id}">\n${bad ? 'return a +' : 'return 0;'}\n</unit>`;
        })
        .join('\n');
    };
    const rs = await fillUnitsBatched(units, stub as any, { batchSize: 5, maxRetries: 2 });
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.ok)).toBe(true); // Abs 重试后也过
    // 第一轮整批；第二轮只含 Abs（好孔不加塞）
    expect(served[0].sort()).toEqual(['Abs', 'Add']);
    expect(served[1]).toEqual(['Abs']);
    expect(served).toHaveLength(2);
  });
});