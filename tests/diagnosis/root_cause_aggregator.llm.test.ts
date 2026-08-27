/**
 * LLM 引擎验证（T4）：证据不编造边界 + 规则 vs LLM 输出质量
 *
 * 不需要真实 LLM key：用 vi.stubGlobal('fetch') 注入假 LLM 响应，
 * 走真实 callChat → parseLlmJson → 合并路径，确定性验证：
 *
 * 一、证据不编造边界（安全不变量）：
 *   - 根因的 file_path/line/symbol 永远以规则引擎为准；LLM 试图改换
 *     一律被覆盖，只采纳 reasoning/confidence
 *   - 证据链 / 影响面 / 候选 不经 LLM：use_llm 开与关完全一致
 *   - LLM 返回非法 JSON / HTTP 错误 / 无效根因 → 自动降级规则引擎，
 *     附局限说明，不抛异常
 *   - 修复建议校验：target_file 必须真实存在（防幻觉文件）、description
 *     必填、action 白名单、上限 3 条；confidence 钳制 [0,1]
 *
 * 二、规则 vs LLM 输出质量（确定性 oracle）：
 *   - 用合理的 LLM 解读对比规则输出：hybrid 在证据不变量不变前提下，
 *     reasoning 更口语化、confidence 可上调、附源码片段
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { parseSymptom } from '../../src/diagnosis/symptom_parser';
import { locateCandidates } from '../../src/diagnosis/candidate_locator';
import { traceChain } from '../../src/diagnosis/chain_tracer';
import { analyzeImpact } from '../../src/diagnosis/impact_analyzer';
import { aggregateRootCause } from '../../src/diagnosis/root_cause_aggregator';
import { runDiagnosis } from '../../src/diagnosis/diagnose';
import type { Impact } from '../../src/diagnosis/contract';

const TYPES_TS = `export interface User {
  profile?: { name: string };
}
`;

const UTIL_TS = `import { User } from './types';

export function getUser(id: string): User {
  const u: User = { profile: { name: 'default' } };
  return u.profile.name;
}
`;

const SERVICE_TS = `import { getUser } from './util';

export function runService(id: string): void {
  const u = getUser(id);
  console.log(u.profile?.name);
}
`;

const SYMPTOM = "TypeError: Cannot read properties of undefined (reading 'name') at src/util.ts:5";

let dir: string;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

/** 注入假 LLM 响应：content 是 LLM 返回的 JSON 字符串 */
function mockLlm(jsonContent: string, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve({
        ok,
        status,
        json: async () => ({ choices: [{ message: { content: jsonContent } }] }),
        text: async () => jsonContent,
      } as unknown as Response),
    ),
  );
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-llm-'));
  writeProjectFile('src/types.ts', TYPES_TS);
  writeProjectFile('src/util.ts', UTIL_TS);
  writeProjectFile('src/service.ts', SERVICE_TS);
  await syncProject(getProjectCacheDb(dir), dir, [
    path.join(dir, 'src', 'types.ts'),
    path.join(dir, 'src', 'util.ts'),
    path.join(dir, 'src', 'service.ts'),
  ]);
  // 让 loadLlmConfig() 返回非空配置，走真实 LLM 路径
  process.env.LLM_API_KEY = 'sk-test';
  process.env.LLM_MODEL = 'gpt-test';
  process.env.LLM_BASE_URL = 'https://llm.test/v1';
  // 隔离 shell 环境里的真实 AGNES key：loadLlmConfig 无 llm 段会回退 agent.mmd
  // （曾致"未配置"用例触发真实网络调用返回 hybrid，测试失去确定性）
  delete process.env.AGNES_API_KEY;
  delete process.env.AGNES_MODEL;
  delete process.env.AGNES_BASE_URL;
});

afterEach(() => {
  closeAllProjectCacheDbs();
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  // stubGlobal 的 fetch 不会随 restoreAllMocks 卸载，显式卸载防泄漏（教训）
  vi.unstubAllGlobals();
});

/** 跑完整流水线前四步，喂给聚合器 */
function runPipeline(symptom: string) {
  const parsed = parseSymptom(symptom);
  const loc = locateCandidates(getProjectCacheDb(dir), { project_dir: dir, parsed });
  const chain = traceChain(getProjectCacheDb(dir), { project_dir: dir, candidates: loc.candidates, max_depth: 3 });
  const impact: Impact =
    loc.candidates.length > 0
      ? analyzeImpact({ project_dir: dir, root_file: loc.candidates[0].file_path, max_depth: 3 })
      : { affected_files: [], affected_symbols: [], dsl_contract_hits: [] };
  return { parsed, loc, chain, impact };
}

function aggInput(pi: ReturnType<typeof runPipeline>) {
  return {
    project_dir: dir,
    parsed: pi.parsed,
    candidates: pi.loc.candidates,
    evidence_chain: pi.chain.chain,
    reached: pi.chain.reached,
    impact: pi.impact,
    db: getProjectCacheDb(dir),
  };
}

describe('证据不编造边界（LLM 引擎安全不变量）', () => {
  it('LLM 试图改换 file/line/symbol → 一律覆盖为规则引擎定位，只采纳 reasoning/confidence', async () => {
    mockLlm(
      JSON.stringify({
        root_cause: { file_path: 'src/evil.ts', line: 999, symbol: 'evilFunc', reasoning: '幻觉解释', confidence: 0.95 },
        fix_suggestions: [{ target_file: 'src/evil.ts', target_line: 1, action: 'modify', description: '改幻觉文件', rationale: 'r' }],
      }),
    );
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('hybrid');
    // 根因位置以规则引擎为准（getUser @ src/util.ts:5），LLM 的编造被拒
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.root_cause?.file_path).toBe('src/util.ts');
    expect(r.root_cause?.line).toBe(5);
    // reasoning/confidence 被采纳
    expect(r.root_cause?.reasoning).toBe('幻觉解释');
    expect(r.root_cause?.confidence).toBe(0.95);
    // 幻觉文件建议被过滤（target_file 不存在于项目）
    expect(r.fix_suggestions.every((s) => s.target_file !== 'src/evil.ts')).toBe(true);
  });

  it('LLM 返回非法 JSON → 降级规则引擎 + 局限说明，不抛异常', async () => {
    mockLlm('这不是 JSON');
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('rule');
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.root_cause?.file_path).toBe('src/util.ts');
    expect(r.limitations.some((l) => l.includes('LLM 兜底失败'))).toBe(true);
  });

  it('LLM HTTP 错误 → 降级规则引擎 + 局限说明', async () => {
    mockLlm('', false, 500);
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('rule');
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.limitations.some((l) => l.includes('LLM 调用失败 500'))).toBe(true);
  });

  it('LLM 未返回有效根因（缺 symbol）→ 降级规则引擎', async () => {
    mockLlm(JSON.stringify({ root_cause: { reasoning: '没给 symbol' }, fix_suggestions: [] }));
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('rule');
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.limitations.some((l) => l.includes('LLM 兜底失败'))).toBe(true);
  });

  it('修复建议：幻觉文件过滤 + action 白名单 + description 必填 + 上限 3 条', async () => {
    mockLlm(
      JSON.stringify({
        root_cause: { file_path: 'src/util.ts', line: 5, symbol: 'getUser', reasoning: 'r', confidence: 0.8 },
        fix_suggestions: [
          { target_file: 'src/nope.ts', description: '幻觉文件', action: 'modify' }, // 文件不存在 → 过滤
          { target_file: 'src/util.ts', description: '好建议', action: 'bogus' }, // action 非法 → 归为 modify
          { target_file: 'src/util.ts', description: '无 rationale' }, // rationale 缺省 → LLM 建议
          { target_file: 'src/util.ts' }, // description 缺失 → 过滤
          { target_file: 'src/util.ts', description: '第 4 条超限' }, // 过滤后仍 >3 → 截断
          { target_file: 'src/util.ts', description: '第 5 条超限' }, // 过滤后仍 >3 → 截断
        ],
      }),
    );
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('hybrid');
    const sug = r.fix_suggestions;
    expect(sug.length).toBe(3);
    expect(sug.every((s) => s.target_file === 'src/util.ts' && s.description)).toBe(true);
    expect(sug.find((s) => s.description === '好建议')?.action).toBe('modify'); // 白名单外归 modify
    expect(sug.find((s) => s.description === '无 rationale')?.rationale).toBe('LLM 建议');
    expect(sug.some((s) => s.description === '第 4 条超限')).toBe(true); // 前 3 条保留
    expect(sug.some((s) => s.description === '第 5 条超限')).toBe(false); // 超 3 截断
  });

  it('confidence 钳制 [0,1]：越界值拉回', async () => {
    mockLlm(JSON.stringify({ root_cause: { file_path: 'src/util.ts', line: 5, symbol: 'getUser', reasoning: 'r', confidence: 5 } }));
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('hybrid');
    expect(r.root_cause?.confidence).toBe(1);
  });
});

describe('规则 vs LLM 输出质量（确定性 oracle）', () => {
  it('证据链/影响面/候选 不经 LLM：use_llm 开与关完全一致', async () => {
    // LLM 给"合理"的解读
    mockLlm(
      JSON.stringify({
        root_cause: { file_path: 'src/util.ts', line: 5, symbol: 'getUser', reasoning: 'getUser 在 profile 可能为 undefined 时直接解引用 .name，导致运行时报错', confidence: 0.95 },
        fix_suggestions: [{ target_file: 'src/util.ts', target_line: 5, action: 'modify', description: '判空后再访问 profile.name', rationale: '证据链命中' }],
      }),
    );
    const rule = await runDiagnosis({ project_dir: dir, symptom: SYMPTOM, use_llm: false });
    const hybrid = await runDiagnosis({ project_dir: dir, symptom: SYMPTOM, use_llm: true });

    // 引擎标注如实区分
    expect(rule.engine).toBe('rule');
    expect(hybrid.engine).toBe('hybrid');

    // 证据链 / 影响面 / 候选：LLM 碰不到，完全一致
    expect(hybrid.evidence_chain).toEqual(rule.evidence_chain);
    expect(hybrid.impact).toEqual(rule.impact);
    expect(hybrid.candidates).toEqual(rule.candidates);

    // 根因位置不变量：file/line/symbol 一致
    expect(hybrid.root_cause?.file_path).toBe(rule.root_cause?.file_path);
    expect(hybrid.root_cause?.line).toBe(rule.root_cause?.line);
    expect(hybrid.root_cause?.symbol).toBe(rule.root_cause?.symbol);

    // 质量增强：hybrid 附源码片段 + LLM 的人话 reasoning；LLM 的 confidence 值被采纳
    expect(hybrid.root_cause?.source_snippet).toBeDefined();
    expect(hybrid.root_cause?.source_snippet).toContain('return u.profile.name');
    expect(hybrid.root_cause?.reasoning).toContain('直接解引用');
    expect(hybrid.root_cause?.confidence).toBe(0.95);
    // hybrid 建议采用了 LLM 的建议
    expect(hybrid.fix_suggestions.some((s) => s.description.includes('判空后再'))).toBe(true);
  });

  it('未配置 LLM → 规则引擎 + llm_note 明确标注未用 LLM', async () => {
    delete process.env.LLM_API_KEY;
    const r = await aggregateRootCause(aggInput(runPipeline(SYMPTOM)));
    expect(r.engine).toBe('rule');
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.llm_note).toContain('未配置 LLM');
  });
});
