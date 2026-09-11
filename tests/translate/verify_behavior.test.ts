/**
 * verify_behavior —— Go→TS 纯函数对拍测试
 *
 * 覆盖：generateCasesFor（样例采样）、checkTranslationParity 的接线（注入桩 runner，
 * 不发真进程）、以及一个真实对拍（go + node 都在时把 Go Add 翻译成 TS 后行为一致）。
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { extractGo } from '../../src/translate/go_extractor.js';
import { renderTsSkeleton } from '../../src/translate/ts_codegen.js';
import { fillUnit } from '../../src/translate/fill.js';
import { generateCasesFor, checkTranslationParity } from '../../src/translate/verify_behavior.js';
import type { BehaviorRun, BehaviorSpec } from '../../src/behavior/index.js';

const GO_SRC = `package calc
func Add(a, b int) int {
\treturn a + b
}
`;

const INT_CASES = generateCasesFor([
  { name: 'a', type: 'int' },
  { name: 'b', type: 'int' },
]);

describe('generateCasesFor：样例采样', () => {
  it('int,int 参数 → base + param_a + param_b + combined 共 4 case', () => {
    const cases = generateCasesFor([
      { name: 'a', type: 'int' },
      { name: 'b', type: 'int' },
    ]);
    expect(cases.map((c) => c.name)).toEqual(['base', 'param_a', 'param_b', 'combined']);
    expect(cases[0].args).toEqual([0, 0]);
    expect(cases[1].args).toEqual([1, 0]);
    expect(cases[2].args).toEqual([0, 1]);
  });

  it('未知类型不崩，保留 base case', () => {
    const cases = generateCasesFor([{ name: 'x', type: 'chan int' }]);
    expect(cases.length).toBeGreaterThanOrEqual(1);
  });
});

describe('checkTranslationParity：接线', () => {
  it('分别对 .go 与 .ts 跑一次 runner，行为一致 → verdict same', () => {
    const calls: string[] = [];
    const runner = (spec: BehaviorSpec): BehaviorRun => {
      calls.push(spec.file);
      const results = [
        { case: 'base', ok: true, ret: '0' },
        { case: 'param_a', ok: true, ret: '1' },
        { case: 'param_b', ok: true, ret: '1' },
        { case: 'combined', ok: true, ret: '-1' },
      ];
      return { file_abs: path.join(spec.project_dir, spec.file), file_hash: 'h', source: '', stdout: '', results };
    };
    const r = checkTranslationParity({ goSource: GO_SRC, funcName: 'Add', tsOutput: 'export function Add(a, b) {}', cases: INT_CASES, runHarnessImpl: runner });
    expect(calls).toEqual(['calc.go', 'calc.ts']);
    expect(r.verdict.verdict).toBe('same');
  });

  it('TS 输出与 Go 不一致（-1 vs 1）→ verdict diff', () => {
    const runner = (spec: BehaviorSpec): BehaviorRun => {
      const isTs = spec.file.endsWith('.ts');
      const base = [
        { case: 'base', ok: true, ret: '0' },
        { case: 'param_a', ok: true, ret: '1' },
        { case: 'param_b', ok: true, ret: '1' },
        { case: 'combined', ok: true, ret: '-1' },
      ];
      const results = isTs ? base.map((b) => (b.case === 'combined' ? { case: 'combined', ok: true, ret: '1' } : b)) : base;
      return { file_abs: path.join(spec.project_dir, spec.file), file_hash: 'h', source: '', stdout: '', results };
    };
    const r = checkTranslationParity({ goSource: GO_SRC, funcName: 'Add', tsOutput: 'export function Add(a, b) {}', cases: INT_CASES, runHarnessImpl: runner });
    expect(r.verdict.verdict).toBe('diff');
  });
});

const goAvailable = (() => {
  try {
    return !spawnSync('go', ['version'], { encoding: 'utf-8' }).error;
  } catch {
    return false;
  }
})();

describe.skipIf(!goAvailable)('真实对拍（go 工具链在位）', () => {
  it('Go Add 翻译成 TS 后，同一批样例输出一致', async () => {
    const units = (await extractGo('/tmp/parity.go', GO_SRC)).units;
    for (const u of units) u.skeleton = renderTsSkeleton(u);
    const add = units.find((u) => u.name === 'Add')!;
    const filled = await fillUnit(add, () => 'return a + b;');
    const tsOutput = filled?.filledSource ?? '';
    expect(tsOutput).toContain('export function Add');

    const params = add.params ?? [];
    const r = checkTranslationParity({ goSource: GO_SRC, funcName: 'Add', tsOutput, params });
    expect(r.verdict.verdict).toBe('same');
    // 逐条核对——确保 Go 与 TS 都真跑了、输出对得上
    const diffEntries = r.verdict.details.filter((d) => d.status === 'changed');
    expect(diffEntries).toEqual([]);
  });
});