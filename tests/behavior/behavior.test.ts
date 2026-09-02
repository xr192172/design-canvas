/**
 * behavior —— 行为基线单元测试
 *
 * 覆盖：
 *   - harness 真跑：capture 夹具 simple.py → 各 case 返回值符合预期（依赖本机 python）
 *   - diffRuns 纯函数：same / 返回值变 / 抛异常变 / stdout 变 / 进程级 error
 *   - 端到端：capture → 改动源码（临时副本）→ verify → verdict=diff；未改 → same
 *   - 基线存取：baselinePathFor 路径规则；verify 无基线 → 报错
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureBaseline,
  verifyBaseline,
  diffRuns,
  runHarness,
  baselinePathFor,
  langOfFile,
  type BehaviorCase,
  type BehaviorRun,
} from '../../src/behavior/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'fixtures', 'simple.py');

const cases = (arr: Array<[string, unknown[]]>): BehaviorCase[] =>
  arr.map(([name, args]) => ({ name, args }));

/** 在系统临时目录建一个可写改的项目副本（capture→改→verify 用） */
function tmpProject(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-beh-test-'));
  fs.writeFileSync(path.join(dir, 'calc.py'), content, 'utf-8');
  return dir;
}

const ORIGINAL = `def add(a, b):
    return a + b
`;

const MODIFIED = `def add(a, b):
    return a + b + 1
`;

describe('behavior: harness 真跑（夹具 simple.py）', () => {
  /** 基线写入系统临时目录，不污染 fixtures */
  const tmpBaseline = (file: string) => path.join(os.tmpdir(), `dc-beh-bl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file);

  it('capture 多维度函数：返回值/结构化/列表/异常全部正确', () => {
    const b = captureBaseline(
      {
        project_dir: path.dirname(fixture),
        file: path.basename(fixture),
        function: 'add',
        cases: cases([['pos', [1, 2]], ['neg', [-5, 3]]]),
      },
      tmpBaseline('simple__add.json'),
    );
    expect(b.results.map((r) => r.ret)).toEqual(['3', '-2']);
    expect(b.results.every((r) => r.ok)).toBe(true);
    expect(b.source).toContain('def add(a, b):');

    const d = captureBaseline(
      {
        project_dir: path.dirname(fixture),
        file: path.basename(fixture),
        function: 'describe_person',
        cases: [
          { name: 'defaults', args: ['tom'], kwargs: {} },
          { name: 'with_tags', args: ['ann'], kwargs: { age: 30, tags: ['b', 'a'] } },
        ],
      },
      tmpBaseline('simple__describe_person.json'),
    );
    expect(d.results[0].ret).toBe(`{'name': 'tom', 'age': 18, 'tags': []}`);
    expect(d.results[1].ret).toBe(`{'name': 'ann', 'age': 30, 'tags': ['a', 'b']}`);

    const e = captureBaseline(
      {
        project_dir: path.dirname(fixture),
        file: path.basename(fixture),
        function: 'pick_evens',
        cases: cases([['mixed', [[1, 2, 3, 4]]]]),
      },
      tmpBaseline('simple__pick_evens.json'),
    );
    expect(e.results[0].ret).toBe('[2, 4]');

    const z = captureBaseline(
      {
        project_dir: path.dirname(fixture),
        file: path.basename(fixture),
        function: 'safe_divide',
        cases: cases([['ok', [6, 2]], ['zero', [1, 0]]]),
      },
      tmpBaseline('simple__safe_divide.json'),
    );
    expect(z.results[0]).toMatchObject({ ok: true, ret: '3.0' });
    expect(z.results[1].ok).toBe(false);
    expect(z.results[1].error).toContain('ZeroDivisionError');
  });

  it('目标函数不存在 → 进程级 error', () => {
    const r = runHarness({
      project_dir: path.dirname(fixture),
      file: path.basename(fixture),
      function: 'not_a_function',
      cases: cases([['x', []]]),
    });
    expect(r.error).toContain('top-level function not found');
  });
});

describe('behavior: diffRuns 纯函数', () => {
  const run = (results: BehaviorRun['results'], extra?: Partial<BehaviorRun>): BehaviorRun => ({
    file_abs: 'x.py', file_hash: 'abc', source: '', stdout: '', results, ...extra,
  });

  it('全部 same → verdict=same', () => {
    const before = run([{ case: 'a', ok: true, ret: '1' }]);
    const after = run([{ case: 'a', ok: true, ret: '1' }]);
    const d = diffRuns(before, after);
    expect(d.verdict).toBe('same');
    expect(d.changed).toBe(0);
    expect(d.matched).toBe(1);
  });

  it('返回值变 → verdict=diff 且给出前后值', () => {
    const before = run([{ case: 'a', ok: true, ret: '1' }]);
    const after = run([{ case: 'a', ok: true, ret: '2' }]);
    const d = diffRuns(before, after);
    expect(d.verdict).toBe('diff');
    expect(d.details[0]).toMatchObject({ case: 'a', status: 'changed', before: '1', after: '2' });
  });

  it('抛异常↔不抛翻转 → verdict=diff', () => {
    const before = run([{ case: 'a', ok: false, error: 'ZeroDivisionError: division by zero' }]);
    const after = run([{ case: 'a', ok: true, ret: '2.0' }]);
    expect(diffRuns(before, after).verdict).toBe('diff');

    // 异常类型/信息变化也算行为变化
    const b2 = run([{ case: 'a', ok: false, error: 'ValueError: bad' }]);
    const a2 = run([{ case: 'a', ok: false, error: 'TypeError: worse' }]);
    expect(diffRuns(b2, a2).verdict).toBe('diff');
  });

  it('stdout 痕迹变 → verdict=diff', () => {
    const before = run([{ case: 'a', ok: true, ret: '1' }], { stdout: 'hello\n' });
    const after = run([{ case: 'a', ok: true, ret: '1' }], { stdout: 'hello world\n' });
    const d = diffRuns(before, after);
    expect(d.verdict).toBe('diff');
    expect(d.details.some((x) => x.case === '(stdout)')).toBe(true);
  });

  it('进程级 error → verdict=error 不可对比', () => {
    const before = run([{ case: 'a', ok: true, ret: '1' }]);
    const after = run([], { error: 'python 不可用' });
    const d = diffRuns(before, after);
    expect(d.verdict).toBe('error');
    expect(d.message).toContain('无法对比');
  });
});

describe('behavior: 端到端 capture → 改代码 → verify', () => {
  it('改动后 verify 报 diff，未改再 verify 报 same', () => {
    const dir = tmpProject(ORIGINAL);
    const spec = { project_dir: dir, file: 'calc.py', function: 'add', cases: cases([['pos', [1, 2]], ['neg', [-5, 3]]]) };

    // capture 基线
    const b = captureBaseline(spec);
    expect(b.results.map((r) => r.ret)).toEqual(['3', '-2']);

    // 未改动 → same
    expect(verifyBaseline(spec).diff.verdict).toBe('same');

    // 改动实现（返回值 +1）→ diff
    fs.writeFileSync(path.join(dir, 'calc.py'), MODIFIED, 'utf-8');
    const v = verifyBaseline(spec);
    expect(v.diff.verdict).toBe('diff');
    expect(v.diff.changed).toBe(2);
    expect(v.diff.details.every((d) => d.status === 'changed')).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('改动函数名 → verify 报进程级 error（函数缺失）', () => {
    const dir = tmpProject(ORIGINAL);
    const spec = { project_dir: dir, file: 'calc.py', function: 'add', cases: cases([['pos', [1, 2]]]) };
    captureBaseline(spec);
    fs.writeFileSync(path.join(dir, 'calc.py'), `def renamed(a, b):\n    return a + b\n`, 'utf-8');
    const v = verifyBaseline(spec);
    expect(v.diff.verdict).toBe('error');
    expect(v.diff.message).toContain('top-level function not found');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('behavior: 基线存取', () => {
  it('baselinePathFor 路径规则', () => {
    const p = baselinePathFor('C:/proj', 'src/util/calc.py', 'add');
    expect(p).toBe(path.join('C:/proj', '.design-canvas', 'behavior', 'src_util_calc__add.json'));
  });

  it('verify 无基线 → 报错', () => {
    const dir = tmpProject(ORIGINAL);
    expect(() =>
      verifyBaseline({ project_dir: dir, file: 'calc.py', function: 'add', cases: cases([['x', [1, 1]]]) }),
    ).toThrow(/基线不存在/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('capture 无 cases → 报错', () => {
    expect(() =>
      captureBaseline({ project_dir: os.tmpdir(), file: 'x.py', function: 'f', cases: [] }),
    ).toThrow(/至少一个金丝雀用例/);
  });
});

describe('behavior: node 家族 harness 真跑（夹具 simple.ts）', () => {
  const tsFixtureDir = path.dirname(fixture);
  const tsFile = 'simple.ts';
  const tmpBaseline = (file: string) => path.join(os.tmpdir(), `dc-beh-ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file);

  it('capture TS 多维度：标量/对象/kwargs-options/数组/async/Set/Map/异常/console 全正确', () => {
    const b = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'add', cases: cases([['pos', [1, 2]], ['neg', [-5, 3]]]) },
      tmpBaseline('simple__add.json'),
    );
    expect(b.results.map((r) => r.ret)).toEqual(['3', '-2']);
    expect(b.results.every((r) => r.ok)).toBe(true);
    expect(b.source).toContain('return a + b');

    const d = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'describePerson', cases: [{ name: 'defaults', args: ['tom'], kwargs: {} }] },
      tmpBaseline('simple__describePerson.json'),
    );
    expect(d.results[0].ret).toBe(`{"name":"tom","age":18,"tags":[]}`);

    // kwargs → 尾部 options 对象（JS 无关键字实参概念，文档化边界）
    const cfg = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'buildConfig', cases: [{ name: 'with_opts', args: ['svc'], kwargs: { retries: 3, debug: true } }] },
      tmpBaseline('simple__buildConfig.json'),
    );
    expect(cfg.results[0].ret).toBe(`{"name":"svc","retries":3,"debug":true}`);

    const e = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'pickEvens', cases: cases([['mixed', [[1, 2, 3, 4]]]]) },
      tmpBaseline('simple__pickEvens.json'),
    );
    expect(e.results[0].ret).toBe('[2,4]');

    const a = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'asyncAdd', cases: cases([['pos', [1, 2]]]) },
      tmpBaseline('simple__asyncAdd.json'),
    );
    expect(a.results[0]).toMatchObject({ ok: true, ret: '3' });

    const s = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'makeSet', cases: cases([['s', ['c', 'a', 'b']]]) },
      tmpBaseline('simple__makeSet.json'),
    );
    expect(s.results[0].ret).toBe('Set(["a","b","c"])');

    const m = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'makeMap', cases: cases([['m', []]]) },
      tmpBaseline('simple__makeMap.json'),
    );
    expect(m.results[0].ret).toBe('Map([["a",1],["b",2]])');

    const z = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'safeDivide', cases: cases([['ok', [6, 2]], ['zero', [1, 0]]]) },
      tmpBaseline('simple__safeDivide.json'),
    );
    expect(z.results[0]).toMatchObject({ ok: true, ret: '3' });
    expect(z.results[1].ok).toBe(false);
    expect(z.results[1].error).toContain('division by zero');

    const o = captureBaseline(
      { project_dir: tsFixtureDir, file: tsFile, function: 'echoOut', cases: cases([['x', ['hi']]]) },
      tmpBaseline('simple__echoOut.json'),
    );
    expect(o.stdout).toContain('echo:hi');
  });

  it('目标函数不存在 → 进程级 error', () => {
    const r = runHarness({ project_dir: tsFixtureDir, file: tsFile, function: 'not_a_function', cases: cases([['x', []]]) });
    expect(r.error).toContain('top-level function not found');
  });

  it('langOfFile：按扩展名分支，未知扩展抛错', () => {
    expect(langOfFile('x.py')).toBe('python');
    expect(langOfFile('x.ts')).toBe('node');
    expect(langOfFile('x.js')).toBe('node');
    expect(langOfFile('x.cjs')).toBe('node');
    expect(() => langOfFile('x.go')).toThrow(/不支持的脚本语言/);
  });
});

describe('behavior: node 端到端 capture → 改代码 → verify', () => {
  const TS_ORIGINAL = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
  const TS_MODIFIED = `export function add(a: number, b: number): number {\n  return a + b + 1;\n}\n`;
  const tmpTs = (content: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-beh-ts-e2e-'));
    fs.writeFileSync(path.join(dir, 'calc.ts'), content, 'utf-8');
    return dir;
  };

  it('改动后 verify 报 diff，未改再 verify 报 same', () => {
    const dir = tmpTs(TS_ORIGINAL);
    const spec = { project_dir: dir, file: 'calc.ts', function: 'add', cases: cases([['pos', [1, 2]], ['neg', [-5, 3]]]) };
    const b = captureBaseline(spec);
    expect(b.results.map((r) => r.ret)).toEqual(['3', '-2']);
    expect(verifyBaseline(spec).diff.verdict).toBe('same');
    fs.writeFileSync(path.join(dir, 'calc.ts'), TS_MODIFIED, 'utf-8');
    const v = verifyBaseline(spec);
    expect(v.diff.verdict).toBe('diff');
    expect(v.diff.changed).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('改动函数名 → verify 报进程级 error（函数缺失）', () => {
    const dir = tmpTs(TS_ORIGINAL);
    const spec = { project_dir: dir, file: 'calc.ts', function: 'add', cases: cases([['pos', [1, 2]]]) };
    captureBaseline(spec);
    fs.writeFileSync(path.join(dir, 'calc.ts'), `export function renamed(a: number, b: number): number {\n  return a + b;\n}\n`, 'utf-8');
    const v = verifyBaseline(spec);
    expect(v.diff.verdict).toBe('error');
    expect(v.diff.message).toContain('top-level function not found');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('跨文件 import → 进程级 error（v1 边界：须自包含）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-beh-ts-import-'));
    fs.writeFileSync(path.join(dir, 'dep.ts'), `export const K = 1;\n`, 'utf-8');
    fs.writeFileSync(path.join(dir, 'main.ts'), `import { K } from './dep';\nexport function f(): number { return K; }\n`, 'utf-8');
    const spec = { project_dir: dir, file: 'main.ts', function: 'f', cases: cases([['x', []]]) };
    const r = runHarness(spec);
    expect(r.error).toBeDefined();
    expect(r.error).toContain('跨文件 import');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
