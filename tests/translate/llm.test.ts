/**
 * llm —— AGNES key 池 HoleTranslator 测试（注入 fetch 桩，不发真请求）
 *
 * 覆盖：单 key 成功填体、429 后轮换到第二把 key 成功、重试耗尽抛错（fillUnit 捕获为
 * error）、loadKeys 去重合并、空池抛错。
 */

import { describe, it, expect } from 'vitest';
import { extractGo } from '../../src/translate/go_extractor.js';
import { renderTsSkeleton } from '../../src/translate/ts_codegen.js';
import { createPooledHoleTranslator, loadKeys, KeyPool, normalizeBody } from '../../src/translate/llm.js';
import { fillUnit } from '../../src/translate/fill.js';
import type { MinimalFetch } from '../../src/translate/llm.js';
import type { TransUnit } from '../../src/translate/unit.js';

const GO_SRC = `package calc
func Add(a, b int) int {
\treturn a + b
}
`;

async function addUnit(): Promise<TransUnit> {
  const units = (await extractGo('/tmp/llm.go', GO_SRC)).units;
  for (const u of units) u.skeleton = renderTsSkeleton(u);
  return units[0];
}

/** 构造按调用序号响应的 fetch 桩：statuses 逐个命中，每个返回给定 content */
function mkFetch(plan: Array<{ status: number; content: string }>): { fetch: MinimalFetch; calls: Array<{ url: string; key: string }> } {
  const calls: Array<{ url: string; key: string }> = [];
  let i = 0;
  const fetch: MinimalFetch = async (_url, init) => {
    const p = plan[Math.min(i, plan.length - 1)];
    i++;
    const url = String(_url);
    const key = (init?.headers?.authorization ?? '').replace(/^Bearer /, '');
    calls.push({ url, key });
    return { status: p.status, json: async () => (p.content ? { choices: [{ message: { content: '  ' + p.content + '  ' } }] } : {}) };
  };
  return { fetch, calls };
}

describe('loadKeys：读 AGNES key 池并去重', () => {
  it('逗号分隔 + 去重 + 合并回退 env', () => {
    const oldA = process.env.KP_A;
    const oldB = process.env.KP_B;
    process.env.KP_A = 'k1, k1 , k2';
    process.env.KP_B = 'k2, k3';
    try {
      expect(loadKeys('KP_A', ['KP_B'])).toEqual(['k1', 'k2', 'k3']);
    } finally {
      if (oldA === undefined) delete process.env.KP_A;
      else process.env.KP_A = oldA;
      if (oldB === undefined) delete process.env.KP_B;
      else process.env.KP_B = oldB;
    }
  });
});

describe('normalizeBody：剥 markdown 代码围栏', () => {
  it('```typescript 围栏 → 取内层', () => {
    expect(normalizeBody('```typescript\n  return a + b\n```')).toBe('return a + b');
  });
  it('无围栏直接返回修剪后文本', () => {
    expect(normalizeBody('  return a + b\n')).toBe('return a + b');
  });
});

describe('KeyPool：round-robin + 冷却', () => {
  it('冷却的 key 暂不返回，恢复后可再用', () => {
    const p = new KeyPool(['a', 'b']);
    const a = p.pick(0);
    expect(p.keys[a]).toBe('a');
    p.cooldown(a, 0, 1000);
    expect(p.pick(0)).toBe(1); // 轮到 b
    expect(p.hasAvailable(0)).toBe(true);
    expect(p.pick(2000)).toBe(0); // a 已恢复
  });
});

describe('createPooledHoleTranslator：轮换填孔', () => {
  it('第一把 key 429 → 冷却换第二把成功', async () => {
    const { fetch, calls } = mkFetch([{ status: 429, content: '' }, { status: 200, content: 'return a + b;' }]);
    const translate = createPooledHoleTranslator({ keys: ['k1', 'k2'], fetchImpl: fetch, cooldownMs: 1 });
    const u = await addUnit();
    // 翻译器直接产出函数体
    const body = await translate({ unit: u, skeleton: u.skeleton, srcSnippet: u.srcSnippet, constraints: u.constraints, prompt: 'x' });
    expect(body).toBe('return a + b;');
    expect(calls.map((c) => c.key)).toEqual(['k1', 'k2']);
    expect(calls[0].url).toContain('/v1/chat/completions');
  });

  it('经 fillUnit 闭环：轮换后成功 → ok', async () => {
    const { fetch } = mkFetch([{ status: 429, content: '' }, { status: 200, content: 'return a + b;' }]);
    const translate = createPooledHoleTranslator({ keys: ['k1', 'k2'], fetchImpl: fetch, cooldownMs: 1 });
    const u = await addUnit();
    const r = await fillUnit(u, translate);
    expect(r?.ok).toBe(true);
    expect(r?.filledSource).toContain('  return a + b;');
  });

  it('全部 key 重试耗尽（全 429）→ 抛错，fillUnit 报 error', async () => {
    const { fetch } = mkFetch([{ status: 429, content: '' }]);
    const translate = createPooledHoleTranslator({ keys: ['k1', 'k2'], fetchImpl: fetch, cooldownMs: 0, maxRetries: 1 });
    const u = await addUnit();
    const r = await fillUnit(u, translate);
    expect(r?.ok).toBe(false);
    expect(r?.error ?? '').toMatch(/冷却|耗尽|返回/);
  });

  it('指向本地 key-pool-proxy（无客户端 key）→ 不抛错，Bearer 用占位', async () => {
    const { fetch, calls } = mkFetch([{ status: 200, content: 'return a + b;' }]);
    const translate = createPooledHoleTranslator({ baseURL: 'http://127.0.0.1:3101', fetchImpl: fetch });
    const u = await addUnit();
    const body = await translate({ unit: u, skeleton: u.skeleton, srcSnippet: u.srcSnippet, constraints: u.constraints, prompt: 'x' });
    expect(body).toBe('return a + b;');
    expect(calls[0].url.startsWith('http://127.0.0.1:3101/v1/')).toBe(true);
  });

  it('空 key 池 → 工厂直接抛错', () => {
    expect(() => createPooledHoleTranslator({ keys: [] })).toThrow(/空 key 池/);
  });
});