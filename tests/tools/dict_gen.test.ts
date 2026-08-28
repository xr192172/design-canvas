/**
 * dict_gen 伪维基词典 LLM 生成端测试
 *
 * 覆盖：
 *   - ingestTerm dry_run=true：分类+生成但不落库（全局词典不新增）
 *   - ingestTerm dry_run=false：分类+生成并落库（全局词典新增）
 *   - 分类 unknown → 归入 global
 *   - 分类 project → 写入项目词典
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ingestTerm } from '../../src/tools/dict_gen';
import { loadGlobalDict, loadProjectDict, setAllowedProjectRoots } from '../../src/tools/dictionary';

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-dictgen-'));
const projectRoot = path.join(os.tmpdir(), 'dc-dictgen-proj-' + Date.now());

function jsonResp(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as unknown as Response;
}

// 覆盖的 LLM 环境变量：CI / 干净环境无 key，ingestTerm 首行 loadExplainConfig() 会直接抛错。
// 测试用 fetch mock 替代真实外呼，这里用 dummy key 让配置层通过，测试本身与真实 LLM 解耦。
const LLM_ENV_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'AGNES_API_KEY', 'AGNES_BASE_URL', 'AGNES_MODEL', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'];
const savedLlmEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.DESIGN_CANVAS_HOME = dataHome;
  fs.mkdirSync(projectRoot, { recursive: true });
  // 测试使用的临时目录需要显式加入安全白名单
  setAllowedProjectRoots([projectRoot, dataHome, process.cwd()]);
  // 预设 dummy LLM 配置（fetch 已 mock，不会真实请求）；同时备份已有 env 便于还原
  for (const k of LLM_ENV_KEYS) {
    savedLlmEnv[k] = process.env[k];
    if (k.endsWith('_API_KEY')) process.env[k] = process.env[k] ?? 'sk-test-dummy';
  }
});

afterAll(() => {
  for (const k of LLM_ENV_KEYS) {
    if (savedLlmEnv[k] !== undefined) process.env[k] = savedLlmEnv[k];
    else delete process.env[k];
  }
  for (const r of [dataHome, projectRoot]) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function classifyResp(partial: Record<string, unknown>): string {
  return JSON.stringify(partial);
}
function genResp(partial: Record<string, unknown>): string {
  return JSON.stringify(partial);
}
// 按请求体分支：classify 用「词典分类器」，generate 用「伪维基词典词条小编剧」
function branchMock(cls: Record<string, unknown>, gen: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const body = init?.body ?? '';
    const isClassify = body.includes('词典分类器');
    return jsonResp({
      choices: [{ message: { content: isClassify ? classifyResp(cls) : genResp(gen) } }],
    }) as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('ingestTerm dry_run 预览与收录', () => {
  it('dry_run=true 生成预览，但不写入词典', async () => {
    branchMock({ kind: 'global', term: '依赖注入', aliases: ['DI'] }, { newbie: '新人解释', pm: '产品解释', senior: '资深解释' });
    const r = await ingestTerm('依赖注入', projectRoot, 'demo', { save: false });
    expect(r.kind).toBe('global');
    expect(r.entry.newbie).toBe('新人解释');
    // 未落库：全局词典仍为空
    expect(loadGlobalDict()).toEqual([]);
  });

  it('dry_run=false 分类并写入全局词典', async () => {
    branchMock({ kind: 'global', term: '缓存' }, { newbie: '缓存新人', pm: '缓存产品', senior: '缓存资深' });
    const r = await ingestTerm('缓存', projectRoot, 'demo');
    expect(r.kind).toBe('global');
    const all = loadGlobalDict();
    expect(all.find((e) => e.term === '缓存')?.newbie).toBe('缓存新人');
  });

  it('分类 unknown → 归入 global', async () => {
    branchMock({ kind: 'unknown', term: '某未知名词' }, { newbie: 'n', pm: 'p', senior: 's' });
    const r = await ingestTerm('某未知名词', projectRoot, 'demo');
    expect(r.kind).toBe('global');
  });

  it('分类 project → 写入项目词典', async () => {
    branchMock({ kind: 'project', term: 'design_canvas_x' }, { newbie: 'n', pm: 'p', senior: 's' });
    const r = await ingestTerm('design_canvas_x', projectRoot, 'demo');
    expect(r.kind).toBe('project');
    const proj = loadProjectDict(projectRoot);
    expect(proj.find((e) => e.term === 'design_canvas_x')).toBeDefined();
  });
});