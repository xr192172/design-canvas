/**
 * dead_statements 语句级死代码检测/删除/验证闭环测试
 *
 * 覆盖：
 *   - 检测（纯）：Go return/break/panic 后不可达；TS return/throw 后不可达；嵌套块；
 *     Go labeled（goto 目标）阻挡；TS 提升声明名被可达代码引用阻挡 / 只在死区引用则放行。
 *   - 删除（纯）：按行区间裁剪，changed/removed 正确，无 run 不改。
 *   - 执行器：write=false 只报告；write=true 落盘；verify 闭环（基线绿→改后绿落盘 /
 *     基线失败拒改 / 改后回归回滚 / 无变更）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { detectUnreachableRunsInSource, applyReachabilityRuns, flagDeadStatements, removeDeadStatements } from '../../src/tools/dead_statements';

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
  const dir = path.join(os.tmpdir(), `dstmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function spy(seq: ('pass' | 'fail')[]) {
  let i = 0;
  return vi.fn(() => {
    const s = seq[Math.min(i++, seq.length - 1)];
    return s === 'pass' ? { status: 'pass' as const, at: 't' } : { status: 'fail' as const, at: 't', detail: 'boom' };
  });
}

describe('detectUnreachableRunsInSource · Go', () => {
  it('return 后不可达表达式 → 检出正确行区间', async () => {
    const src = ['package p', '', 'func f(n int) int {', '\treturn n', '\tprintln(1)', '\tprintln(2)', '}'].join('\n');
    const runs = await detectUnreachableRunsInSource(src, 'go');
    expect(runs).toHaveLength(1);
    expect(runs[0].category).toBe('unreachable');
    expect(runs[0].start).toBe(5);
    expect(runs[0].end).toBe(6);
  });

  it('break 后同块不可达', async () => {
    const src = ['package p', '', 'func f() {', '\tfor {', '\t\tbreak', '\t\tprintln(1)', '\t}', '}'].join('\n');
    const runs = await detectUnreachableRunsInSource(src, 'go');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(6);
    expect(runs[0].end).toBe(6);
  });

  it('panic(...) 视为终止语句 → 其后不可达', async () => {
    const src = ['package p', '', 'func f() {', '\tpanic("x")', '\tprintln(1)', '}'].join('\n');
    const runs = await detectUnreachableRunsInSource(src, 'go');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(5);
  });

  it('带标签语句（goto 目标）阻挡：其后不可达也不删', async () => {
    const src = ['package p', '', 'func f() {', '\treturn 0', 'again:', '\tprintln(1)', '}'].join('\n');
    const runs = await detectUnreachableRunsInSource(src, 'go');
    expect(runs).toHaveLength(0);
  });

  it('无终止语句 → 无 run', async () => {
    const src = ['package p', '', 'func f() {', '\tprintln(1)', '\tprintln(2)', '}'].join('\n');
    expect(await detectUnreachableRunsInSource(src, 'go')).toHaveLength(0);
  });
});

describe('detectUnreachableRunsInSource · TS', () => {
  it('return 后不可达 → 检出', async () => {
    const src = 'function f(n: number): number {\n  return n;\n  console.log(1);\n}\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(3);
    expect(runs[0].end).toBe(3);
  });

  it('throw 后不可达', async () => {
    const src = 'function f() {\n  throw new Error("x");\n  console.log(1);\n}\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(3);
  });

  it('嵌套块：仅块内不可达，外层继续活', async () => {
    const src = 'function f() {\n  if (a) {\n    return 1;\n    console.log(1);\n  }\n  console.log(2);\n}\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(4);
    expect(runs[0].end).toBe(4);
  });

  it('提升声明名被可达代码引用 → 阻挡（不删）', async () => {
    const src = 'function f() {\n  return 1;\n  const dead = 2;\n}\nfunction g() { return dead; }\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(0); // dead 被 g 引用，整体不删
  });

  it('提升声明名只在死区自引用 → 放行', async () => {
    const src = 'function f() {\n  return 1;\n  const dead = dead2;\n  const dead2 = 3;\n}\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(1);
  });

  it('不可达表达式（非取代声明）删除', async () => {
    const src = 'function f() {\n  return 1;\n  func(1);\n}\n';
    const runs = await detectUnreachableRunsInSource(src, 'ts');
    expect(runs).toHaveLength(1);
    expect(runs[0].start).toBe(3);
  });
});

describe('applyReachabilityRuns · 删除', () => {
  it('按行区间删除；changed/removed 正确', () => {
    const src = 'function f(n) {\n  return n;\n  console.log(1);\n  console.log(2);\n}\n';
    const r = applyReachabilityRuns(src, [{ category: 'unreachable', stmt_type: 'expression_statement', start: 3, end: 4, snippet: 'console.log(1)' }]);
    expect(r.changed).toBe(true);
    expect(r.removed).toBe(2);
    expect(r.output).not.toContain('console.log');
    expect(r.output).toContain('return n');
  });

  it('无 run → 不变', () => {
    const src = 'const a = 1;\n';
    const r = applyReachabilityRuns(src, []);
    expect(r.changed).toBe(false);
    expect(r.output).toBe(src);
  });
});

describe('removeDeadStatements · 执行器与闭环', () => {
  function tsFixture() {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf-8');
    const f = path.join(dir, 'src.ts');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'export function f(n: number): number {\n  return n;\n  const constant = 1;\n  console.log("unused");\n}\n', 'utf-8');
    return { dir, f, read: () => fs.readFileSync(f, 'utf-8') };
  }

  it('write=false 只报告，不写盘', async () => {
    const { dir, f, read } = tsFixture();
    const reports = await flagDeadStatements({ project_dir: dir });
    const r = removeDeadStatements({ project_dir: dir, files: reports, write: false });
    expect(r.files_changed).toBe(1);
    expect(r.statements_removed).toBe(2);
    expect(read()).toContain('const constant'); // 未落盘
  });

  it('write=true 落盘；verify=否 → 只执行不验证', async () => {
    const { dir, read } = tsFixture();
    const reports = await flagDeadStatements({ project_dir: dir });
    const r = removeDeadStatements({ project_dir: dir, files: reports, write: true });
    expect(r.verification).toBeUndefined();
    expect(read()).not.toContain('const constant');
    expect(read()).not.toContain('console.log("unused")');
    expect(read()).toContain('return n');
  });

  it('write=true + verify 闭环：基线绿+改后绿 → applied_verified 落盘', async () => {
    const { dir, read } = tsFixture();
    const reports = await flagDeadStatements({ project_dir: dir });
    const r = removeDeadStatements({
      project_dir: dir,
      files: reports,
      write: true,
      verify: { commands: [{ label: 't', cmd: 'true', args: [] }] },
      verifyImpl: spy(['pass', 'pass']),
    });
    expect(r.verification?.outcome).toBe('applied_verified');
    expect(read()).not.toContain('const constant');
  });

  it('write=true + 基线失败 → baseline_fail，一个都不改', async () => {
    const { dir, read } = tsFixture();
    const reports = await flagDeadStatements({ project_dir: dir });
    const r = removeDeadStatements({ project_dir: dir, files: reports, write: true, verify: true, verifyImpl: spy(['fail']) });
    expect(r.verification?.outcome).toBe('baseline_fail');
    expect(r.files_changed).toBe(0);
    expect(read()).toContain('const constant');
  });

  it('write=true + 改后回归 → 回滚到原位', async () => {
    const { dir, read } = tsFixture();
    const before = read();
    const reports = await flagDeadStatements({ project_dir: dir });
    const r = removeDeadStatements({ project_dir: dir, files: reports, write: true, verify: true, verifyImpl: spy(['pass', 'fail']) });
    expect(r.verification?.outcome).toBe('regression_rolled_back');
    expect(read()).toBe(before);
  });

  it('无 run（无死代码）→ no_change，不落盘', async () => {
    const { dir, read } = tsFixture();
    const r = removeDeadStatements({
      project_dir: dir,
      files: [{ file: 'src.ts', lang: 'ts', runs: [] }],
      write: true,
      verify: true,
      verifyImpl: spy(['pass']),
    });
    expect(r.verification?.outcome).toBe('no_change');
    expect(r.files_changed).toBe(0);
  });
});