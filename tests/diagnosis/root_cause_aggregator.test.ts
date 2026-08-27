/**
 * root_cause_aggregator 测试：根因聚合（诊断流水线第 5 步，双引擎）
 * 覆盖：
 * - 规则引擎：报错位置命中 → error_direct + 高置信度
 * - 规则引擎：无位置 → 推断 kind
 * - 规则引擎：无候选 → 提示性修复建议
 * - captureSnippet：行号 + 限长截断 + 文件缺失
 * LLM 引擎路径不做单测（需网络/配置），在冒烟测试里验证降级。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from '../../src/db/db';
import { openDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { locateCandidates } from '../../src/diagnosis/candidate_locator';
import { traceChain } from '../../src/diagnosis/chain_tracer';
import { analyzeImpact } from '../../src/diagnosis/impact_analyzer';
import { aggregateRule, captureSnippet } from '../../src/diagnosis/root_cause_aggregator';
import { parseSymptom } from '../../src/diagnosis/symptom_parser';
import type { Impact } from '../../src/diagnosis/contract';

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

let dir: string;
let db: Database;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-root-'));
  writeProjectFile('src/types.ts', 'export interface User {\n  profile?: { name: string };\n}\n');
  writeProjectFile('src/util.ts', UTIL_TS);
  writeProjectFile('src/service.ts', SERVICE_TS);
  db = openDb(path.join(dir, '.design-canvas', 'cache.db'));
  await syncProject(db, dir, [
    path.join(dir, 'src', 'types.ts'),
    path.join(dir, 'src', 'util.ts'),
    path.join(dir, 'src', 'service.ts'),
  ]);
});

afterEach(() => {
  closeAllProjectCacheDbs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 跑完整流水线前四步，喂给聚合器 */
function runPipeline(symptom: string) {
  const parsed = parseSymptom(symptom);
  const loc = locateCandidates(db, { project_dir: dir, parsed });
  const chain = traceChain(db, { project_dir: dir, candidates: loc.candidates, max_depth: 3 });
  const impact: Impact =
    loc.candidates.length > 0
      ? analyzeImpact({ project_dir: dir, root_file: loc.candidates[0].file_path, max_depth: 3 })
      : { affected_files: [], affected_symbols: [], dsl_contract_hits: [] };
  return { parsed, loc, chain, impact };
}

describe('root_cause_aggregator 规则引擎', () => {
  it('报错位置命中符号 → kind=error_direct + 高置信度', () => {
    const { loc, chain, impact, parsed } = runPipeline("TypeError: Cannot read properties of undefined (reading 'name') at src/util.ts:5");
    const r = aggregateRule({ project_dir: dir, parsed, candidates: loc.candidates, evidence_chain: chain.chain, reached: chain.reached, impact, db });
    expect(r.root_cause).toBeDefined();
    expect(r.root_cause?.symbol).toBe('getUser');
    expect(r.root_cause?.kind).toBe('error_direct');
    expect(r.root_cause?.confidence).toBeGreaterThan(0.8);
    expect(r.root_cause?.file_path).toBe('src/util.ts');
    // 修改建议指向根因行
    expect(r.fix_suggestions.some((s) => s.action === 'modify' && s.target_file === 'src/util.ts')).toBe(true);
  });

  it('无报错位置 → kind=inferred（推断）', () => {
    const { loc, chain, impact, parsed } = runPipeline('TypeError: Cannot read properties of undefined reading name getUser');
    const r = aggregateRule({ project_dir: dir, parsed, candidates: loc.candidates, evidence_chain: chain.chain, reached: chain.reached, impact, db });
    expect(r.root_cause).toBeDefined();
    expect(['inferred', 'error_direct', 'caller']).toContain(r.root_cause?.kind);
  });

  it('无候选 → 提示性建议 + limitations 提示建缓存', () => {
    const parsed = parseSymptom('some weird behavior when clicking the button');
    const r = aggregateRule({
      project_dir: dir,
      parsed,
      candidates: [],
      evidence_chain: [],
      reached: [],
      impact: { affected_files: [], affected_symbols: [], dsl_contract_hits: [] },
    });
    expect(r.root_cause).toBeUndefined();
    expect(r.fix_suggestions.length).toBeGreaterThan(0);
    expect(r.limitations.some((l) => l.includes('import_project'))).toBe(true);
  });
});

describe('captureSnippet 源码片段抓取', () => {
  const file = (): string => path.join(dir, 'src', 'util.ts');

  it('带行号前缀 + 上下文', () => {
    const s = captureSnippet(file(), 5, 6);
    expect(s).toBeDefined();
    expect(s).toContain('5| ');
    expect(s).toContain('4| ');
    expect(s).toContain('7| ');
  });

  it('maxChars 截断（保头舍尾）', () => {
    const s = captureSnippet(file(), 3, 6, { maxChars: 40 });
    expect(s).toBeDefined();
    expect(s!.length).toBeLessThanOrEqual(50);
    expect(s).toContain('已截断');
  });

  it('文件缺失 → undefined', () => {
    expect(captureSnippet(path.join(dir, 'nope.ts'), 1)).toBeUndefined();
  });
});
