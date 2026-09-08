/**
 * run_narrate 测试：环节旁白解析——吃现成函数注释当"做什么"的人话；无注释诚实返回 null。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { narrateFunc } from '../../src/tools/run_narrate';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narr_')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const w = (n: string, c: string) => { const p = path.join(tmp, n); fs.writeFileSync(p, c, 'utf-8'); return p; };

describe('run_narrate - 环节旁白', () => {
  it('@fnhash 指纹不匹配（函数体已变，注释 stale）→ 诚实不返回过期描述', async () => {
    const f = w('a.ts', `/**
 * 为订单绑定优惠券并计算折后金额
 * @fnhash 1111111111111111111111111111111111111111111111111111111111111111
 */
export function applyCoupon(orderId: number, coupon: string): number {
  return 0;
}
`);
    // 指纹与 body 不匹配 → stale，描述可能过期 → 不做旁白（诚实标注缺失）
    const narr = await narrateFunc(f, 'applyCoupon');
    expect(narr).toBeNull();
  }, 20000);

  it('无注释 → 返回 null（诚实标注，不硬造）', async () => {
    const f = w('b.ts', `export function plainFn(x: number): number { return x * 2; }\n`);
    const narr = await narrateFunc(f, 'plainFn');
    expect(narr).toBeNull();
  }, 20000);

  it('手写无指纹注释 → status ok，可作旁白', async () => {
    const f = w('c.ts', `// 校验请求签名是否合法
export function verifySig(sig: string): boolean { return true; }
`);
    const narr = await narrateFunc(f, 'verifySig');
    expect(narr).toBeTruthy();
    expect(narr).toContain('签名');
  }, 20000);

  it('函数不存在 → null', async () => {
    const f = w('d.ts', `export function real(x: number): number { return x; }\n`);
    expect(await narrateFunc(f, 'ghost')).toBeNull();
  }, 20000);
});