/**
 * 调用边提取测试（路线图序号 3）：AST 级函数调用边——同文件解析 + 外部/跨文件标记
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseFileFull, _reset } from '../../src/tools/ts_kernel/index';

describe('ts_kernel - 调用边提取', () => {
  beforeEach(() => {
    _reset();
  });

  it('Go：同文件函数调用解析 + 外部调用（fmt.Println）标记 unresolved', async () => {
    const goCode = `
package main

import "fmt"

func main() {
  fmt.Println(hello("world"))
  result := add(1, 2)
  _ = result
}

func hello(name string) string {
  return "hi " + name
}

func add(a, b int) int {
  return a + b
}
`;
    const parsed = await parseFileFull('main.go', goCode);
    const calls = parsed.calls;
    const mainCalls = calls.filter((c) => c.caller === 'main');

    const helloCall = mainCalls.find((c) => c.callee === 'hello');
    expect(helloCall?.resolved).toBe(true);
    expect(helloCall?.callee_qn).toBe('hello');

    const addCall = mainCalls.find((c) => c.callee === 'add');
    expect(addCall?.resolved).toBe(true);

    const fmtCall = mainCalls.find((c) => c.callee_expr === 'fmt.Println');
    expect(fmtCall?.resolved).toBe(false);
    expect(fmtCall?.callee).toBe('Println');

    // 行号落在 main 函数体内
    expect(addCall?.line).toBe(8);
  });

  it('Go：方法调用（receiver.Method）callee 取尾部标识符，方法归属正确', async () => {
    const goCode = `
package main

type Svc struct{}

func (s *Svc) Start() {
  s.helper()
}

func (s *Svc) helper() {
}

func top() {
  s := &Svc{}
  s.Start()
}
`;
    const parsed = await parseFileFull('svc.go', goCode);
    const calls = parsed.calls;

    // Start 调用 helper（同文件方法，Go 方法 qn 不带 receiver）
    const startCalls = calls.filter((c) => c.caller === 'Start');
    const helperCall = startCalls.find((c) => c.callee === 'helper');
    expect(helperCall?.resolved).toBe(true);
    expect(helperCall?.callee_qn).toBe('helper');

    // top 调用 Start（receiver 方法，尾部标识符匹配）
    const topCalls = calls.filter((c) => c.caller === 'top');
    const startFromTop = topCalls.find((c) => c.callee === 'Start');
    expect(startFromTop?.resolved).toBe(true);
  });

  it('TypeScript：函数调用 + this/obj 方法调用 + 泛型调用剥离', async () => {
    const tsCode = `
function process(items: string[]): number {
  const first = pick<string>(items);
  return first.length + normalize(first);
}

function pick<T>(arr: T[]): T {
  return arr[0];
}

class Helper {
  run() {
    this.normalize('x');
  }
  normalize(v: string): string {
    return v.trim();
  }
}
`;
    const parsed = await parseFileFull('a.ts', tsCode);
    const calls = parsed.calls;

    const proc = calls.filter((c) => c.caller === 'process');
    // 泛型调用 pick<string> → callee = pick
    const pickCall = proc.find((c) => c.callee === 'pick');
    expect(pickCall?.resolved).toBe(true);
    expect(pickCall?.callee_qn).toBe('pick');
    const normCall = proc.find((c) => c.callee === 'normalize');
    expect(normCall?.resolved).toBe(true);
    expect(normCall?.callee_qn).toBe('Helper.normalize'); // 同文件首个同名符号

    // this.normalize 归属 Helper.run
    const runCalls = calls.filter((c) => c.caller === 'Helper.run');
    const thisCall = runCalls.find((c) => c.callee_expr === 'this.normalize');
    expect(thisCall?.resolved).toBe(true);
    expect(thisCall?.callee).toBe('normalize');
  });

  it('Python：函数 + attribute 调用 + 内置函数 unresolved', async () => {
    const pyCode = `
def main():
    print(greet("world"))
    total = add(1, 2)
    svc.process(total)

def greet(name):
    return "hi " + name

def add(a, b):
    return a + b
`;
    const parsed = await parseFileFull('m.py', pyCode);
    const calls = parsed.calls.filter((c) => c.caller === 'main');

    const greetCall = calls.find((c) => c.callee === 'greet');
    expect(greetCall?.resolved).toBe(true);

    const addCall = calls.find((c) => c.callee === 'add');
    expect(addCall?.resolved).toBe(true);

    // attribute 调用 svc.process：callee 取尾部标识符，unresolved（外部对象）
    const svcCall = calls.find((c) => c.callee_expr === 'svc.process');
    expect(svcCall?.callee).toBe('process');
    expect(svcCall?.resolved).toBe(false);

    // 内置函数 print：unresolved
    const printCall = calls.find((c) => c.callee_expr === 'print');
    expect(printCall?.resolved).toBe(false);
  });

  it('嵌套具名函数：调用归属最近的函数（不串到外层）', async () => {
    const tsCode = `
function outer(): number {
  function inner(): number {
    return innerHelper();
  }
  return outerHelper() + inner();
}

function innerHelper(): number { return 1; }
function outerHelper(): number { return 2; }
`;
    const parsed = await parseFileFull('nest.ts', tsCode);
    const calls = parsed.calls;

    // outer 调用 outerHelper + inner，不调用 innerHelper
    const outerCalls = calls.filter((c) => c.caller === 'outer');
    expect(outerCalls.some((c) => c.callee === 'outerHelper')).toBe(true);
    expect(outerCalls.some((c) => c.callee === 'inner')).toBe(true);
    expect(outerCalls.some((c) => c.callee === 'innerHelper')).toBe(false);

    // inner 调用 innerHelper（归属正确）
    const innerCalls = calls.filter((c) => c.caller === 'outer.inner');
    const ih = innerCalls.find((c) => c.callee === 'innerHelper');
    expect(ih?.resolved).toBe(true);
  });
});
