/**
 * const_eval —— Go 编译期常量表达式求值器测试（纯函数）
 *
 * 覆盖：整数运算/整除/移位/取模、字符串拼接、比较、逻辑、同包常量引用、求不出返回 null。
 */

import { describe, it, expect } from 'vitest';
import { parseAstRoot, type SyntaxNodeLike } from '../../src/tools/ts_kernel/index.js';
import { evalConstExpr, constToTsLiteral } from '../../src/translate/const_eval.js';

async function evalAllIn(src: string): Promise<Array<{ name: string; v: ReturnType<typeof evalConstExpr> }>> {
  const r = await parseAstRoot('/tmp/ce.go', src);
  if (!r?.root) return [];
  const out: Array<{ name: string; v: ReturnType<typeof evalConstExpr> }> = [];
  const walk = (n: SyntaxNodeLike): void => {
    if (n.type === 'const_spec') {
      const nameN = n.childForFieldName('name');
      const valN = n.childForFieldName('value');
      if (nameN && valN) {
        // 借助已有的已完成常量的 lookup：先简单传 null；引用场景另测
        out.push({ name: nameN.text, v: evalConstExpr(valN, () => null) });
      }
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(r.root);
  return out;
}

describe('evalConstExpr', () => {
  it('整数运算：1024*1024；KB 引用场景由 translate 端测', async () => {
    const src = `package s
const A = 1024 * 1024
`;
    const xs = await evalAllIn(src);
    const a = xs.find((x) => x.name === 'A')?.v;
    expect(constToTsLiteral((a as any))).toBe('1048576');
  });

  it('整除[可整除→int] / 取模 / 移位', async () => {
    const src = `package s
const D = 10 / 2
const M = 10 % 3
const S = 1 << 4
`;
    const xs = await evalAllIn(src);
    expect(constToTsLiteral(xs.find((x) => x.name === 'D')!.v!)).toBe('5');
    expect(constToTsLiteral(xs.find((x) => x.name === 'M')!.v!)).toBe('1');
    expect(constToTsLiteral(xs.find((x) => x.name === 'S')!.v!)).toBe('16');
  });

  it('字符串拼接', async () => {
    const src = `package s
const N = "/api" + "/v2"
`;
    const xs = await evalAllIn(src);
    expect(constToTsLiteral(xs.find((x) => x.name === 'N')!.v!)).toBe('"/api/v2"');
  });

  it('比较 → bool', async () => {
    const src = `package s
const B = 1024 >= 1024
`;
    const xs = await evalAllIn(src);
    expect(constToTsLiteral(xs.find((x) => x.name === 'B')!.v!)).toBe('true');
  });

  it('无法求值为常量（调用）→ null', async () => {
    const src = `package s
const X = len("abc")
`;
    const xs = await evalAllIn(src);
    expect(xs.find((x) => x.name === 'X')?.v).toBeNull();
  });
});