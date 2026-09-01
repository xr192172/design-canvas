/**
 * run_tests —— 测试编排工具自测
 *
 * 在本仓库真实跑一个快速定向 filter，断言结构化结果正确。
 * 不建临时项目（避免无 vitest），直接复用它自身已装的 vitest。
 */
import { describe, it, expect } from 'vitest';
import { runTests } from '../../src/tools/run_tests';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');

describe('runTests', () => {
  it('地带定向 filter → 跑起来、全部通过、返回结构化统计', () => {
    const r = runTests({ project_dir: REPO, filter: 'tests/tools/find_references.test.ts', timeout_ms: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.success).toBe(true);
    expect(r.total).toBeGreaterThan(0);
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(r.total);
    expect(r.filter).toBe('tests/tools/find_references.test.ts');
  });
});