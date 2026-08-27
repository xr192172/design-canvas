/**
 * diagnose 集成测试：造一个带 bug 的 demo 项目，跑完整六步流水线
 *
 * demo 场景：getUser 在 profile 可能为 undefined 时直接解引用 .name，
 * 上层 runService → main 两层调用。症状给"运行时报错 at src/util.ts:5"，
 * 应定位 getUser（kind=error_direct），证据链含上层调用方，影响面含 service.ts。
 *
 * use_llm 固定为 false：只走规则引擎，保证测试确定性、不触发 LLM 网络调用。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { runDiagnosis, formatDiagnoseText } from '../../src/diagnosis/diagnose';

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

const MAIN_TS = `import { runService } from './service';

export function main(): void {
  runService('a');
}
`;

let dir: string;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-diag-'));
  writeProjectFile('package.json', JSON.stringify({ name: 'demo-bug', scripts: { test: 'vitest run', build: 'tsc' } }, null, 2));
  writeProjectFile('tsconfig.json', '{}');
  writeProjectFile('src/types.ts', TYPES_TS);
  writeProjectFile('src/util.ts', UTIL_TS);
  writeProjectFile('src/service.ts', SERVICE_TS);
  writeProjectFile('src/main.ts', MAIN_TS);
  // 模拟 import_project：建立符号缓存
  await syncProject(getProjectCacheDb(dir), dir, [
    path.join(dir, 'src', 'types.ts'),
    path.join(dir, 'src', 'util.ts'),
    path.join(dir, 'src', 'service.ts'),
    path.join(dir, 'src', 'main.ts'),
  ]);
});

afterEach(() => {
  closeAllProjectCacheDbs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('runDiagnosis 端到端', () => {
  it('运行时错误 → 定位 getUser（error_direct）+ 证据链 + 影响面 + 建议', async () => {
    const out = await runDiagnosis({
      project_dir: dir,
      symptom: "TypeError: Cannot read properties of undefined (reading 'name') at src/util.ts:5",
      use_llm: false, // 测试确定性：只走规则引擎，不触发 LLM 网络调用
    });

    // 症状解析
    expect(out.symptom_parsed.error_type).toBe('TypeError');
    expect(out.symptom_parsed.locations).toContainEqual({ file: 'src/util.ts', line: 5 });

    // 候选定位
    expect(out.candidates.some((c) => c.symbol === 'getUser')).toBe(true);

    // 根因
    expect(out.root_cause).toBeDefined();
    expect(out.root_cause?.symbol).toBe('getUser');
    expect(out.root_cause?.file_path).toBe('src/util.ts');
    expect(out.root_cause?.kind).toBe('error_direct');
    expect(out.root_cause?.confidence).toBeGreaterThan(0.8);

    // 证据链：符号命中 + 真正的调用边（call_chain）回溯到上层调用方
    expect(out.evidence_chain[0].type).toBe('symbol_hit');
    expect(out.evidence_chain.some((s) => s.type === 'call_chain' && s.text.includes('runService'))).toBe(true);
    expect(out.evidence_chain.some((s) => s.type === 'call_chain' && s.text.includes('→callees'))).toBe(true);

    // 影响面
    expect(out.impact.affected_files.some((f) => f.path === 'src/service.ts')).toBe(true);
    expect(out.impact.affected_files.some((f) => f.path === 'src/main.ts')).toBe(true);

    // 建议
    expect(out.fix_suggestions.some((s) => s.action === 'modify' && s.target_file === 'src/util.ts')).toBe(true);
    expect(out.verification.some((v) => v.type === 'typecheck')).toBe(true);
    expect(out.verification.some((v) => v.type === 'build')).toBe(true);

    // 文本报告可读
    const text = formatDiagnoseText(out);
    expect(text).toContain('【根因】');
    expect(text).toContain('【证据链】');
    expect(text).toContain('【影响面】');
    expect(text).toContain('【修复建议】');
  }, 60000);

  it('无缓存目录 → 不抛异常，给文件级线索', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-diag-empty-'));
    try {
      const out = await runDiagnosis({ project_dir: emptyDir, symptom: 'something crashed', use_llm: false });
      expect(out.root_cause).toBeUndefined();
      expect(out.limitations.length).toBeGreaterThan(0);
    } finally {
      closeAllProjectCacheDbs();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  }, 60000);
});
