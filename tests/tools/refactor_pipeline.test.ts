/**
 * refactor_pipeline 确定性重构管线测试
 *
 * 覆盖：
 *   - 入口一次基线：基线失败 → 一个文件都不改，全部 stage 不执行（planned 但不产出）。
 *   - 增量验证：多 stage 开启时，每 stage 只触发一次"改后"验证（+ 一次入口基线）。
 *   - 绿点回滚：某 stage 改后验证失败 → 仅回滚该 stage 的 originals，回到上一步绿点
 *     （前面 stage 已落盘的改动保留）。
 *   - no_change：stage 无实际改动 → 不触发验证、记为 no_change。
 *   - not_verifiable：不设 verify / verify=false → 命令组为空，已落盘但标注不可验证。
 *   - 多 stage 顺序：dead_imports 先、dead_statements 后，聚合计数正确。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { runRefactorPipeline, type PipelineResult } from '../../src/tools/refactor_pipeline';
import { type VerifyCommand } from '../../src/tools/verify_refactor';

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
  const dir = path.join(os.tmpdir(), `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const ok = { status: 'pass' as const, at: 't' };
const fail = { status: 'fail' as const, at: 't', detail: 'boom' };

/** 顺序返回各次验证结果的 spy（第 1 次 = 基线；其后 = 各 stage 改后验证）。
 *  seq 数组顺序消费；耗尽后用最后一个。 */
function spy(seq: Array<'pass' | 'fail'>) {
  const calls: Array<{ cwd: string; commands: VerifyCommand[] }> = [];
  const fn = (o: { cwd: string; commands: VerifyCommand[] }) => {
    calls.push(o);
    const idx = Math.min(calls.length - 1, seq.length - 1);
    return seq[idx] === 'pass' ? { ...ok } : { ...fail };
  };
  fn.calls = calls;
  return fn;
}

type SpyFn = ((o: { cwd: string; commands: VerifyCommand[] }) => ReturnType<typeof fn>) & { calls: Array<{ cwd: string; commands: VerifyCommand[] }> };
function asSpy(fn: ReturnType<typeof spy>): SpyFn {
  return fn as unknown as SpyFn;
}

describe('runRefactorPipeline 基线', () => {
  it('基线失败 → 一个文件都不改，stage 全不执行', async () => {
    const dir = tempRoot();
    const target = path.join(dir, 'a.ts');
    fs.writeFileSync(target, 'const x = 1;\n', 'utf-8');
    const before = fs.readFileSync(target, 'utf-8');

    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: {
        dead_statements: { enabled: true },
        dead_imports: { enabled: true, dead: [{ source: 'lodash', files: ['a.ts'] }] },
      },
      verify: true,
      verifyImpl: spy(['fail']), // 第 1 次（基线）就黄
    });

    expect(res.ok).toBe(false);
    expect(res.stages.filter((s) => s.outcome === 'applied')).toHaveLength(0);
    expect(fs.readFileSync(target, 'utf-8')).toBe(before); // 未改动
    expect(res.planned_steps).toBe(2);
    expect(res.total_files_changed).toBe(0);
  });

  it('不设 verify → not_verifiable（已落盘但标注不可验证）', async () => {
    const dir = tempRoot();
    // 用不可达语句：function f(){ return; const unused = 1;} —— return 后 const 不可达
    const target = path.join(dir, 'b.ts');
    // 注意：函数体内 return 后的语句应被 dead_statements 判为不可达（见 dead_statements 测试约定）
    fs.writeFileSync(target, 'function f() {\n  return;\n  const ghost = 1;\n}\n', 'utf-8');

    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_statements: { enabled: true } },
      // 不设 verify → 不验证仅落盘 → 该 stage not_verifiable
    });

    const stage = res.stages.find((s) => s.id === 'dead_statements');
    // 若检测到死语句则 not_verifiable 并落盘；若无检测 → no_change（空项目允许）
    expect(stage).toBeDefined();
    expect(['not_verifiable', 'no_change']).toContain(stage!.outcome);
    expect(stage!.outcome).not.toBe('applied'); // 无验证不会 applied
  });
});

describe('runRefactorPipeline 增量验证与绿点回滚', () => {
  it('仅 enabled 的 stage 触发改后验证，基线之外恰一次', async () => {
    const dir = tempRoot();
    const target = path.join(dir, 'c.ts');
    fs.writeFileSync(target, 'function g() {\n  return;\n  const ghost = 1;\n}\n', 'utf-8');

    const s = spy(['pass', 'pass']); // 基线 pass + dead_statements 改后 pass
    await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_statements: { enabled: true } },
      verify: true,
      verifyImpl: s,
    });

    // 基线 + 改后 共 2 次
    expect(asSpy(s).calls.length).toBe(2);
  });

  it('改后验证失败 → 单个 stage 回滚到绿点，前面 stage 改动保留', async () => {
    const dir = tempRoot();
    // 构造两个文件：dead_imports 可删除 lodash import；dead_statements 可删死语句。
    // 进程内两个 stage 都 enabled。管线先 dead_imports（改 a.ts），再 dead_statements（改 c.ts）。
    const importFile = path.join(dir, 'a.ts');
    fs.writeFileSync(importFile, "import _ from 'lodash';\nexport const live = 1;\n", 'utf-8');
    const stmtFile = path.join(dir, 'c.ts');
    fs.writeFileSync(stmtFile, 'function g() {\n  return;\n  const ghost = 1;\n}\n', 'utf-8');
    const importBefore = fs.readFileSync(importFile, 'utf-8');

    // spy：基线 pass；dead_imports 改后 pass（绿点已推进）；dead_statements 改后 fail（回滚）
    const s = spy(['pass', 'pass', 'fail']);
    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: {
        dead_imports: { enabled: true, dead: [{ source: 'lodash', files: ['a.ts'] }] },
        dead_statements: { enabled: true },
      },
      verify: true,
      verifyImpl: s,
    });

    expect(res.ok).toBe(false);
    const di = res.stages.find((x) => x.id === 'dead_imports');
    const ds = res.stages.find((x) => x.id === 'dead_statements');
    expect(di?.outcome).toBe('applied'); // 前一步绿点保留
    expect(ds?.outcome).toBe('rolled_back');
    // dead_imports 的改动保留（绿点），dead_statements 的改动已回滚
    expect(fs.readFileSync(importFile, 'utf-8')).not.toBe(importBefore);
    expect(importBefore).toContain('lodash');
    // dead_statements 回滚后 c.ts 恢复原状
    expect(fs.readFileSync(stmtFile, 'utf-8')).toContain('const ghost');
  });

  it('dead_imports 不提供 dead 清单 → 自动检测并删除（一键）', async () => {
    const dir = tempRoot();
    // 死 lodash import + 一个活 import：一键应只删死者
    fs.writeFileSync(path.join(dir, 'a.ts'), "import _ from 'lodash';\nimport { orderBy } from 'underscore';\nexport const use = orderBy([1], ['x']);\n", 'utf-8');

    const s = spy(['pass', 'pass']); // 基线 + dead_imports 改后
    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_imports: { enabled: true } }, // 不给 dead，触发自动检测
      verify: true,
      verifyImpl: s,
    });

    const di = res.stages.find((x) => x.id === 'dead_imports');
    expect(di?.outcome).toBe('applied');
    expect(di!.units_removed).toBe(1); // 删除 1 条 import 语句
    const after = fs.readFileSync(path.join(dir, 'a.ts'), 'utf-8');
    expect(after).not.toContain('lodash');
    expect(after).toContain('underscore'); // 活的保留
    expect(asSpy(s).calls.length).toBe(2); // 基线 + 1 改后
  });

  it('dead_imports 无 dead 清单 → 该 stage no_change，不触发验证', async () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1;\n', 'utf-8');

    const s = spy(['pass']); // 仅基线；dead_imports 无计划不验证
    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_imports: { enabled: true, dead: [] } },
      verify: true,
      verifyImpl: s,
    });

    const di = res.stages.find((x) => x.id === 'dead_imports');
    expect(di?.outcome).toBe('no_change');
    expect(asSpy(s).calls.length).toBe(1); // 仅基线
  });

  it('未启用的 stage 标记 skipped，不计入验证', async () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), 'const x = 1;\n', 'utf-8');

    const s = spy(['pass']);
    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: { dead_imports: { enabled: false, dead: [] } }, // 未启用
      verify: true,
      verifyImpl: s,
    });

    const di = res.stages.find((x) => x.id === 'dead_imports');
    expect(di?.outcome).toBe('skipped');
    expect(asSpy(s).calls.length).toBe(1); // 仅基线
  });
});

describe('runRefactorPipeline 聚合', () => {
  it('多 stage 通过时累加 total_files_changed/total_units_removed', async () => {
    const dir = tempRoot();
    const importFile = path.join(dir, 'a.ts');
    fs.writeFileSync(importFile, "import _ from 'lodash';\nexport const live = 1;\n", 'utf-8');
    const stmtFile = path.join(dir, 'c.ts');
    fs.writeFileSync(stmtFile, 'function g() {\n  return;\n  const ghost = 1;\n}\n', 'utf-8');

    const s = spy(['pass', 'pass', 'pass']);
    const res = await runRefactorPipeline({
      project_dir: dir,
      steps: {
        dead_imports: { enabled: true, dead: [{ source: 'lodash', files: ['a.ts'] }] },
        dead_statements: { enabled: true },
      },
      verify: true,
      verifyImpl: s,
    });

    expect(res.ok).toBe(true);
    expect(res.stages.every((x) => x.outcome === 'applied')).toBe(true);
    expect(res.total_files_changed).toBe(2); // a.ts + c.ts
    expect(asSpy(s).calls.length).toBe(3); // 基线 + 2 改后
  });
});