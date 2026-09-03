/**
 * refactor_report 报表测试
 *
 * 覆盖：
 *   - buildRefactorReport：by_outcome 分桶、rolled_back 单独拎出、changed_files 透传、逐 stage 映射
 *   - 真实 runRefactorPipeline 联动：changed_files 精确到文件；buildReport + writeRefactorReport 落盘
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { runRefactorPipeline, type PipelineResult, type StageResult } from '../../src/tools/refactor_pipeline';
import { buildRefactorReport, writeRefactorReport } from '../../src/tools/refactor_report';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 占用，留给 OS
    }
  }
});
function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function fakeStage(over: Partial<StageResult>): StageResult {
  return { id: 'x', label: 'x', index: 1, outcome: 'applied', files_changed: 1, units_removed: 1, ...over };
}

describe('buildRefactorReport 聚合', () => {
  it('by_outcome 分桶 + rolled_back 单独拎出 + changed_files 透传', () => {
    const res: PipelineResult = {
      ok: false,
      planned_steps: 3,
      total_files_changed: 3,
      total_units_removed: 2,
      baseline: null,
      changed_files: ['src/a.ts', 'src/b.ts'],
      stages: [
        fakeStage({ id: 'dead_imports', outcome: 'applied', files_changed: 1, units_removed: 1 }),
        fakeStage({ id: 'dead_statements', outcome: 'rolled_back', detail: '改后验证失败' }),
        fakeStage({ id: 'spring_mvc_layering', outcome: 'no_change' }),
      ],
    };
    const rep = buildRefactorReport(res);
    expect(rep.ok).toBe(false);
    expect(rep.by_outcome).toEqual({ applied: 1, rolled_back: 1, no_change: 1 });
    expect(rep.rolled_back).toHaveLength(1);
    expect(rep.rolled_back[0].id).toBe('dead_statements');
    expect(rep.rolled_back[0].detail).toBe('改后验证失败');
    expect(rep.changed_files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(rep.stages.map((s) => s.outcome)).toEqual(['applied', 'rolled_back', 'no_change']);
  });
});

describe('真实管线联动', () => {
  it('changed_files 精确到文件；buildReport / writeRefactorReport 可落盘', async () => {
    const dir = tempRoot();
    const target = path.join(dir, 'c.ts');
    fs.writeFileSync(target, 'function g() {\n  return;\n  const ghost = 1;\n}\n', 'utf-8');

    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_statements: { enabled: true } },
      verify: false, // 不验证只落盘 → not_verifiable，改写已写盘
    });

    // chaned_files 暴露了真实改动的文件（相对 cwd 正斜杠）
    expect(res.changed_files).toContain('c.ts');

    const rep = buildRefactorReport(res);
    expect(rep.stages.some((s) => s.id === 'dead_statements')).toBe(true);
    expect(rep.changed_files).toContain('c.ts');

    // 落盘
    const rptPath = path.join(dir, 'refactor_report.json');
    const written = writeRefactorReport(res, rptPath);
    expect(fs.existsSync(written)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(written, 'utf-8')) as { ok: boolean; changed_files: string[] };
    expect(typeof parsed.ok).toBe('boolean');
    expect(parsed.changed_files).toContain('c.ts');
  });
});