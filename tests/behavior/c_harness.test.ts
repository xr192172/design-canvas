/**
 * behavior C harness —— 代码生成纯函数测试（无需 cc/gcc）
 *
 * 覆盖：
 *   - cParamTypes：从源码正则推断参数类型（int / char* / double）
 *   - cArgLiteral：按类型生成强转字面量
 *   - cHarnessSource：生成的 harness 包含 main + 逐 case 的类型化调用
 *   - 工具链不可用路径：本机无 cc/gcc 时 runHarness 返回明确 error（可测）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cParamTypes, cArgLiteral, cHarnessSource, runHarness, type BehaviorCase } from '../../src/behavior/index.js';

const cases = (arr: Array<[string, unknown[]]>): BehaviorCase[] => arr.map(([name, args]) => ({ name, args }));

describe('C harness 代码生成（纯函数，不依赖编译器）', () => {
  it('cParamTypes：推断 int / const char* / double', () => {
    const src = 'int add(int a, int b) { return a + b; }\nconst char* greet(const char* name) { return name; }\ndouble scale(double x) { return x; }\n';
    expect(cParamTypes(src, 'add')).toEqual(['int', 'int']);
    expect(cParamTypes(src, 'greet')).toEqual(['const char*']);
    expect(cParamTypes(src, 'scale')).toEqual(['double']);
  });

  it('cArgLiteral：按类型生成强转字面量', () => {
    expect(cArgLiteral(3, 'int')).toBe('((int) 3)');
    expect(cArgLiteral(3.5, 'double')).toBe('((double) 3.5)');
    expect(cArgLiteral('hi', 'const char*')).toBe('((char*) "hi")');
    expect(cArgLiteral(true, 'bool')).toBe('true');
  });

  it('cHarnessSource：含 main 与逐 case 类型化调用（管道行协议）', () => {
    const src = cHarnessSource(
      { project_dir: '.', file: 'a.c', function: 'add', cases: cases([['one', [1, 2]], ['two', [3, 4]]]) },
      ['int', 'int'],
    );
    expect(src).toContain('#include <stdio.h>');
    expect(src).toContain('add(((int) 1), ((int) 2))');
    // 源码里格式串含 `\n` 两字符转义（C 源码文本）；JS 断言用 \\n 表示单反斜杠
    expect(src).toContain('"one|1|%zu\\n"');
    expect(src).toContain('"two|1|%zu\\n"');
  });
});

describe('C harness 工具链门控', () => {
  const hasCc = (() => {
    try {
      return require('node:child_process').spawnSync('cc', ['--version'], { stdio: 'pipe', windowsHide: true }).status === 0
        || require('node:child_process').spawnSync('gcc', ['--version'], { stdio: 'pipe', windowsHide: true }).status === 0;
    } catch {
      return false;
    }
  })();

  it('本机无 cc/gcc 时 → 明确 error（不静默）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-beh-c-test-'));
    fs.writeFileSync(path.join(dir, 'a.c'), 'int add(int a, int b) { return a + b; }\n', 'utf-8');
    const spec = { project_dir: dir, file: 'a.c', function: 'add', cases: cases([['one', [1, 2]]]) };
    const run = runHarness(spec);
    // 无论有无工具链，都不该崩；无工具链应报不可用
    if (!hasCc) {
      expect(run.error).toBeDefined();
      expect(run.error).toContain('工具链不可用');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasCc)('有 cc/gcc 时反射调用 C 函数返回正确', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-beh-c-test2-'));
    fs.writeFileSync(path.join(dir, 'a.c'), 'int add(int a, int b) { return a + b; }\n', 'utf-8');
    const spec = { project_dir: dir, file: 'a.c', function: 'add', cases: cases([['one', [1, 2]], ['two', [3, 4]]]) };
    const run = runHarness(spec);
    expect(run.error).toBeUndefined();
    expect(run.results.map((r) => r.ret)).toEqual(['3', '7']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});