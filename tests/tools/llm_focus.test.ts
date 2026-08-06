/**
 * llm_focus 测试：LLM 关键节点选择
 * 覆盖：
 * - 无配置 → 启发式降级（判定节点优先）+ llm=false
 * - mock LLM 返回 → 解析 JSON 选点 + llm=true
 * - LLM 返回不在清单里的 node_id → 过滤
 * - LLM 调用失败 → 降级启发式 + note
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickKeyNodes, loadLlmConfig, configFilePath } from '../../src/tools/llm_focus';

const CHAIN = [
  { node_id: 'n1', label: '① sanitize', func_name: 'sanitize', description: 'sanitize(s)', is_judgement: false, is_cross: false },
  { node_id: 'n2', label: '② 校验', func_name: 'validate', description: 'branch · if (s.length > 3)', is_judgement: true, is_cross: false },
  { node_id: 'n3', label: '③ getDSL·→storage.ts', func_name: 'getDSL', description: '跨文件调用：storage.ts', is_judgement: false, is_cross: true },
  { node_id: 'n4', label: '④ 完成', func_name: 'finalize', description: 'finalize()', is_judgement: false, is_cross: false },
];

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_focus_'));
  process.env.DESIGN_CANVAS_HOME = tmpHome;
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});
afterEach(() => {
  delete process.env.DESIGN_CANVAS_HOME;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('llm_focus', () => {
  it('无配置 → 启发式降级：判定节点优先，llm=false', async () => {
    expect(loadLlmConfig()).toBeNull();
    const r = await pickKeyNodes(null, CHAIN, { max: 2 });
    expect(r.llm).toBe(false);
    expect(r.key_nodes[0].node_id).toBe('n2'); // 判定点优先
    expect(r.key_nodes.length).toBeLessThanOrEqual(2);
    expect(r.note).toContain('未配置');
  });

  it('config 文件加载：apiKey/model/baseURL 读取', () => {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true });
    fs.writeFileSync(configFilePath(), JSON.stringify({ llm: { apiKey: 'sk-test', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' } }));
    const cfg = loadLlmConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.apiKey).toBe('sk-test');
    expect(cfg!.model).toBe('deepseek-chat');
    expect(cfg!.baseURL).toBe('https://api.deepseek.com/v1');
  });

  it('mock LLM 返回 → 解析 JSON 选点，llm=true', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ key_nodes: [{ node_id: 'n3', reason: '跨文件边界' }, { node_id: 'n2', reason: '分流判定' }] }) } }],
      }),
    });
    vi.stubGlobal('fetch', fakeFetch);
    const r = await pickKeyNodes(
      { apiKey: 'k', model: 'm', baseURL: 'https://x/v1' },
      CHAIN,
      { max: 5 },
    );
    expect(r.llm).toBe(true);
    expect(r.key_nodes.map((k) => k.node_id)).toEqual(['n3', 'n2']);
    expect(r.key_nodes[0].reason).toBe('跨文件边界');
    const body = JSON.parse(String(fakeFetch.mock.calls[0][1].body));
    expect(body.model).toBe('m');
  });

  it('LLM 返回不在清单里的 node_id → 过滤后为空，降级启发式 + note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ key_nodes: [{ node_id: 'ghost', reason: 'x' }] }) } }] }),
    }));
    const r = await pickKeyNodes({ apiKey: 'k', model: 'm', baseURL: 'https://x/v1' }, CHAIN);
    expect(r.llm).toBe(true);
    // LLM 未返回有效节点 → 降级启发式（判定节点优先），并注明原因
    expect(r.key_nodes[0].node_id).toBe('n2');
    expect(r.note).toContain('未返回有效节点');
  });

  it('LLM 调用失败 → 降级启发式 + note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const r = await pickKeyNodes({ apiKey: 'k', model: 'm', baseURL: 'https://x/v1' }, CHAIN);
    expect(r.llm).toBe(false);
    expect(r.key_nodes[0].node_id).toBe('n2');
    expect(r.note).toContain('调用失败');
  });
});
