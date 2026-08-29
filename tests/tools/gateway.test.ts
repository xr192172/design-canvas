/**
 * gateway 小网关测试
 *
 * 覆盖：
 * - 供应商 CRUD + key 脱敏 + AGNES 环境变量种子引导 + 损坏配置兜底
 * - 用量统计：成功/失败计数、token/费用累计、落盘持久化、reset 清空
 * - 池调度与故障转移：供应商级切换、池内 key 级切换、全失败、maxAttempts、加权轮询
 * - testProvider 连通性（不计入用量）
 * - OpenAI 兼容端点：400 / 503 / 200 / 502
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  maskKey,
  upsertProvider,
  listProvidersMasked,
  deleteProvider,
  hasEnabledProvider,
  ensureSeededFromEnv,
  getStats,
  resetStats,
  chatViaGateway,
  testProvider,
  handleOpenAICompatRequest,
  _resetGatewayCursors,
} from '../../src/tools/gateway';

let tmpHome: string;

function sha1fp(key: string): string {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

function okResponse(content: string, prompt = 10, completion = 5) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: prompt, completion_tokens: completion },
    }),
  };
}

function errResponse(status = 429, text = 'rate limited') {
  return { ok: false, status, text: async () => text };
}

/** fetch 假实现：按 failIf 判定失败（可用 base_url 或 Authorization 区分端点/key） */
function mockFetch(failIf: (url: string, auth: string) => boolean): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async (url: string, init: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? '';
    if (failIf(url, auth)) return errResponse();
    return okResponse('ok', 10, 5);
  });
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_gw_'));
  process.env.DESIGN_CANVAS_HOME = tmpHome;
  delete process.env.AGNES_API_KEY;
  delete process.env.AGNES_BASE_URL;
  delete process.env.AGNES_MODEL;
  _resetGatewayCursors();
});

afterEach(() => {
  delete process.env.DESIGN_CANVAS_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('供应商 CRUD 与 key 脱敏', () => {
  it('maskKey：空串→空、短 key→***、长 key→前3…后4', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('short')).toBe('***');
    expect(maskKey('sk-1234567890abcd')).toBe('sk-…abcd');
  });

  it('upsertProvider 新增：id 规范化、尾部斜杠去除、默认 model 兜底、keys 脱敏', () => {
    const r = upsertProvider({ id: 'My Prov!', base_url: 'https://api.example.com/v1/', keys: ['sk-a', 'sk-b'] });
    expect(r).toEqual({ ok: true });
    const list = listProvidersMasked();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('myprov');
    expect(list[0].base_url).toBe('https://api.example.com/v1');
    expect(list[0].model).toBe('gpt-4o-mini');
    expect(list[0].key_count).toBe(2);
    expect(list[0].keys[0]).toBe(maskKey('sk-a'));
    expect(list[0].keys[0]).not.toContain('sk-a');
  });

  it('upsertProvider 校验：空 id / 空 keys / 空 base_url 拒绝且不落盘', () => {
    expect(upsertProvider({ id: '', base_url: 'x', keys: ['k'] }).ok).toBe(false);
    expect(upsertProvider({ id: 'a', base_url: 'x', keys: [] }).ok).toBe(false);
    expect(upsertProvider({ id: 'a', base_url: '   ', keys: ['k'] }).ok).toBe(false);
    expect(listProvidersMasked()).toHaveLength(0);
  });

  it('upsertProvider 更新已有供应商：改 model/keys 不重复添加', () => {
    upsertProvider({ id: 'agnes', base_url: 'https://a/v1', keys: ['sk-1'] });
    upsertProvider({ id: 'agnes', base_url: 'https://a/v1', keys: ['sk-new'], model: 'flash' });
    const list = listProvidersMasked();
    expect(list).toHaveLength(1);
    expect(list[0].model).toBe('flash');
    expect(list[0].key_count).toBe(1);
  });

  it('deleteProvider：删除成功；删除不存在的供应商报错', () => {
    upsertProvider({ id: 'x', base_url: 'https://x/v1', keys: ['sk-1'] });
    expect(deleteProvider('x').ok).toBe(true);
    expect(deleteProvider('x').ok).toBe(false);
    expect(listProvidersMasked()).toHaveLength(0);
  });

  it('hasEnabledProvider：空/全停用为 false，有启用为 true', () => {
    expect(hasEnabledProvider()).toBe(false);
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'], enabled: false });
    expect(hasEnabledProvider()).toBe(false);
    upsertProvider({ id: 'b', base_url: 'https://b/v1', keys: ['sk-1'], enabled: true });
    expect(hasEnabledProvider()).toBe(true);
  });
});

describe('AGNES 环境变量种子引导', () => {
  it('空配置 + AGNES_API_KEY → 种入 agnes 默认供应商', () => {
    process.env.AGNES_API_KEY = 'sk-env';
    expect(ensureSeededFromEnv()).toBe(true);
    const list = listProvidersMasked();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('agnes');
    expect(list[0].model).toBe('agnes-2.0-flash');
    expect(list[0].base_url).toBe('https://apihub.agnes-ai.com/v1');
    expect(list[0].key_count).toBe(1);
  });

  it('已有供应商时不覆盖、不重复种', () => {
    upsertProvider({ id: 'custom', base_url: 'https://c/v1', keys: ['sk-1'] });
    process.env.AGNES_API_KEY = 'sk-env';
    expect(ensureSeededFromEnv()).toBe(false);
    expect(listProvidersMasked()).toHaveLength(1);
    expect(listProvidersMasked()[0].id).toBe('custom');
  });

  it('无 AGNES_API_KEY → 不种', () => {
    expect(ensureSeededFromEnv()).toBe(false);
    expect(listProvidersMasked()).toHaveLength(0);
  });

  it('损坏的 gateway.json → 按空配置处理，不抛异常', () => {
    const dir = path.join(tmpHome, '.design-canvas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gateway.json'), '{broken json', 'utf-8');
    expect(ensureSeededFromEnv()).toBe(false);
    expect(listProvidersMasked()).toHaveLength(0);
  });
});

describe('用量统计（持久化 + 聚合）', () => {
  it('空统计 → totals 全 0', () => {
    const s = getStats();
    expect(s.per_key).toHaveLength(0);
    expect(s.totals).toEqual({ calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, errors: 0 });
  });

  it('成功调用 → 记 calls/token/费用；key_fp 为指纹而非明文', async () => {
    upsertProvider({
      id: 'agnes',
      base_url: 'https://a/v1',
      keys: ['sk-secret'],
      price_prompt_per_1m: 1,
      price_completion_per_1m: 2,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('hi', 1_000_000, 1_000_000)));
    const r = await chatViaGateway([{ role: 'user', content: 'hi' }]);
    expect(r.content).toBe('hi');
    expect(r.provider_id).toBe('agnes');
    expect(r.key_fp).toBe(sha1fp('sk-secret'));
    expect(r.key_fp).not.toContain('sk-secret');
    const s = getStats();
    expect(s.totals.calls).toBe(1);
    expect(s.totals.prompt_tokens).toBe(1_000_000);
    expect(s.totals.completion_tokens).toBe(1_000_000);
    // cost = 1*1e6/1e6(输入) + 2*1e6/1e6(输出) = 3
    expect(s.totals.cost_usd).toBeCloseTo(3, 5);
    expect(s.totals.errors).toBe(0);
    expect(s.per_key[0].key_fp).toBe(sha1fp('sk-secret'));
  });

  it('同 provider+key 多次调用 → 累加', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('x', 3, 2)));
    await chatViaGateway([{ role: 'user', content: '1' }]);
    await chatViaGateway([{ role: 'user', content: '2' }]);
    const s = getStats();
    expect(s.totals.calls).toBe(2);
    expect(s.totals.prompt_tokens).toBe(6);
    expect(s.per_key).toHaveLength(1);
  });

  it('失败调用 → errors +1、calls 不增；默认 maxAttempts=3 全失败后抛错', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse()));
    await expect(chatViaGateway([{ role: 'user', content: 'x' }])).rejects.toThrow(/所有可用端点均失败/);
    const s = getStats();
    expect(s.totals.errors).toBe(3);
    expect(s.totals.calls).toBe(0);
  });

  it('resetStats → 清空统计', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('x')));
    await chatViaGateway([{ role: 'user', content: 'x' }]);
    expect(getStats().totals.calls).toBe(1);
    resetStats();
    expect(getStats().totals.calls).toBe(0);
    expect(getStats().per_key).toHaveLength(0);
  });
});

describe('池调度与故障转移', () => {
  it('供应商级故障转移：A 失败自动切 B，A 记 error、B 记成功', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a.example/v1', keys: ['sk-a1'] });
    upsertProvider({ id: 'b', base_url: 'https://b.example/v1', keys: ['sk-b1'] });
    vi.stubGlobal('fetch', mockFetch((url) => url.startsWith('https://a.example/')));
    const r = await chatViaGateway([{ role: 'user', content: 'hi' }]);
    expect(r.provider_id).toBe('b');
    const s = getStats();
    expect(s.totals.errors).toBe(1);
    expect(s.totals.calls).toBe(1);
    expect(s.per_key.find((x) => x.provider_id === 'a')?.errors).toBe(1);
    expect(s.per_key.find((x) => x.provider_id === 'b')?.calls).toBe(1);
  });

  it('池内 key 级故障转移：key1 失败自动切 key2，返回 key2 指纹', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-bad', 'sk-good'] });
    vi.stubGlobal('fetch', mockFetch((_url, auth) => auth === 'Bearer sk-bad'));
    const r = await chatViaGateway([{ role: 'user', content: 'hi' }]);
    expect(r.key_fp).toBe(sha1fp('sk-good'));
    const s = getStats();
    expect(s.per_key).toHaveLength(2);
    expect(s.per_key.find((x) => x.key_fp === sha1fp('sk-bad'))?.errors).toBe(1);
    expect(s.per_key.find((x) => x.key_fp === sha1fp('sk-good'))?.calls).toBe(1);
  });

  it('全部端点失败 → 恰好尝试 maxAttempts 次后抛错', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    const f = vi.fn().mockResolvedValue(errResponse());
    vi.stubGlobal('fetch', f);
    await expect(chatViaGateway([{ role: 'user', content: 'x' }], { maxAttempts: 2 })).rejects.toThrow(/所有可用端点均失败/);
    expect(f.mock.calls).toHaveLength(2);
    expect(getStats().totals.errors).toBe(2);
  });

  it('maxAttempts=1 → 一次失败立即抛，不再转移', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    upsertProvider({ id: 'b', base_url: 'https://b/v1', keys: ['sk-2'] });
    const f = vi.fn().mockResolvedValue(errResponse());
    vi.stubGlobal('fetch', f);
    await expect(chatViaGateway([{ role: 'user', content: 'x' }], { maxAttempts: 1 })).rejects.toThrow(/所有可用端点均失败/);
    expect(f.mock.calls).toHaveLength(1);
  });

  it('加权轮询：weight 2:1 → 6 次调用命中 4:2', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-a'], weight: 2 });
    upsertProvider({ id: 'b', base_url: 'https://b/v1', keys: ['sk-b'], weight: 1 });
    const f = vi.fn().mockResolvedValue(okResponse('ok'));
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 6; i++) await chatViaGateway([{ role: 'user', content: 'x' }]);
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.startsWith('https://a/')).length).toBe(4);
    expect(urls.filter((u) => u.startsWith('https://b/')).length).toBe(2);
  });

  it('无可用供应商 → 抛"无可用供应商"错误', async () => {
    await expect(chatViaGateway([{ role: 'user', content: 'x' }])).rejects.toThrow(/无可用供应商/);
  });
});

describe('testProvider 连通性测试（不计入用量）', () => {
  it('供应商不存在 → ok:false + 错误', async () => {
    const r = await testProvider('ghost');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不存在');
  });

  it('成功 → ok:true 带 ms/model，不写用量统计', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'], model: 'm1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('pong')));
    const r = await testProvider('a');
    expect(r.ok).toBe(true);
    expect(r.model).toBe('m1');
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(getStats().totals.calls).toBe(0);
  });

  it('失败 → ok:false 带 HTTP 错误，不写用量统计', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(401, 'unauthorized')));
    const r = await testProvider('a');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
    expect(getStats().totals.errors).toBe(0);
  });
});

describe('OpenAI 兼容端点 /v1/chat/completions', () => {
  it('缺 messages → 400 invalid_request_error', async () => {
    const r = await handleOpenAICompatRequest({} as never);
    expect(r.status).toBe(400);
    expect((r.body as { error: { type: string } }).error.type).toBe('invalid_request_error');
  });

  it('无启用供应商 → 503 gateway_not_configured', async () => {
    const r = await handleOpenAICompatRequest({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(503);
    expect((r.body as { error: { type: string } }).error.type).toBe('gateway_not_configured');
  });

  it('成功 → 200 OpenAI 格式响应（choices/usage/provider_id）', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'], model: 'm1' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse('你好', 7, 3)));
    const r = await handleOpenAICompatRequest({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.5 });
    expect(r.status).toBe(200);
    const b = r.body as Record<string, unknown> & {
      model: string;
      provider_id: string;
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(b.object).toBe('chat.completion');
    expect(b.model).toBe('m1');
    expect(b.provider_id).toBe('a');
    expect(b.choices[0].message.content).toBe('你好');
    expect(b.usage.total_tokens).toBe(10);
  });

  it('上游全部失败 → 502 upstream_error', async () => {
    upsertProvider({ id: 'a', base_url: 'https://a/v1', keys: ['sk-1'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse(500, 'boom')));
    const r = await handleOpenAICompatRequest({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(502);
    expect((r.body as { error: { type: string } }).error.type).toBe('upstream_error');
  });
});
