/**
 * trace_exec exampleInputFor 测试：按签名生成示例入参（免手工拼 JSON）
 */
import { describe, it, expect } from 'vitest';
import { exampleInputFor } from '../../src/tools/trace_exec';

describe('exampleInputFor', () => {
  it('Go 自由函数：按类型生成示例值', () => {
    const r = exampleInputFor('batchRawEntries(entries []RawEntry, maxBatch int) [][]RawEntry', 'go');
    expect(r.example.entries).toEqual([]);
    expect(r.example.maxBatch).toBe(0);
    expect(r.preview).toContain('entries');
  });

  it('Go 方法：跳过接收者与 context/error，只示例业务参数', () => {
    const r = exampleInputFor('(r *X) Handle(ctx context.Context, payload map[string]any) error', 'go');
    expect(r.example).not.toHaveProperty('ctx');
    expect(r.example).not.toHaveProperty('r');
    expect(r.example.payload).toEqual({});
    const names = r.params.map((p) => p.name);
    expect(names).toContain('payload');
  });

  it('TS 函数：n: type 解析', () => {
    const r = exampleInputFor('add(a: number, b: string, c: boolean) : number', 'ts');
    expect(r.example.a).toBe(0);
    expect(r.example.b).toBe('');
    expect(r.example.c).toBe(false);
  });

  it('无参：返回空例子', () => {
    const r = exampleInputFor('now() string', 'go');
    expect(r.example).toEqual({});
  });
});