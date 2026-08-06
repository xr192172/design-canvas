/**
 * trace_exec 真实执行引擎测试（数据流"真实流转"）
 *
 * 覆盖：
 * - TS 纯函数链：真实输入 → 真实输出（含依赖函数注入）
 * - 调用外部函数 → unsupported + 原因
 * - 执行异常 → error + 原因
 * - 链式传递：上一步真实 out → 下一步 in
 * - Python：exec 子进程（本机无 python 时标注，不失败）
 * - Go：go run 单文件（本机无 go 工具链时标注，不失败）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { traceExecChain } from '../../src/tools/trace_exec';

let tmpDir: string;

function writeFixture(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace_exec_'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────
// TS：纯函数链真实执行
// ─────────────────────────────────────────────────────────────

const TS_FIXTURE = `export function processUser(token: string, tags: string[]): string {
  const clean = sanitize(token);
  if (clean.length > 3) {
    return 'long:' + clean;
  }
  return 'short:' + clean;
}

function sanitize(s: string): string {
  return s.trim().toLowerCase();
}
`;

describe('trace_exec - TS 真实执行', () => {
  it('纯函数链：真实输入 → 真实输出（依赖函数 sanitize 注入执行）', async () => {
    const f = writeFixture('user.ts', TS_FIXTURE);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'processUser', file_path: f }],
      input_value: { token: '  AbCd ', tags: [] },
    });
    expect(result.steps[0].status).toBe('ok');
    // trim + toLowerCase → 'abcd'，length 4 > 3 → 'long:abcd'
    expect(result.steps[0].out_value).toBe('long:abcd');
  });

  it('真实判定走向：短 token 走 short 分支', async () => {
    const f = writeFixture('user.ts', TS_FIXTURE);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'processUser', file_path: f }],
      input_value: { token: 'ab', tags: [] },
    });
    expect(result.steps[0].status).toBe('ok');
    expect(result.steps[0].out_value).toBe('short:ab');
  });

  it('调用外部函数（import 引入）→ unsupported + 原因', async () => {
    const f = writeFixture('ext.ts', `import fs from 'node:fs';
export function readAndLen(p: string): number {
  return fs.readFileSync(p).length;
}
`);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'readAndLen', file_path: f }],
      input_value: { p: 'x' },
    });
    expect(result.steps[0].status).toBe('unsupported');
    expect(result.steps[0].note).toContain('外部');
  });

  it('执行异常 → error + 原因', async () => {
    const f = writeFixture('boom.ts', `export function boom(x: number): number {
  if (x === 0) {
    throw new Error('zero');
  }
  return 100 / x;
}
`);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'boom', file_path: f }],
      input_value: 0,
    });
    expect(result.steps[0].status).toBe('error');
    expect(result.steps[0].note).toContain('zero');
  });

  it('链式传递：上一步真实 out → 下一步 in', async () => {
    const f1 = writeFixture('a.ts', `export function a(x: number): number { return x * 2; }\n`);
    const f2 = writeFixture('b.ts', `export function b(y: number): number { return y + 1; }\n`);
    const result = await traceExecChain({
      steps: [
        { node_id: 'n1', func_name: 'a', file_path: f1 },
        { node_id: 'n2', func_name: 'b', file_path: f2 },
      ],
      input_value: { x: 21 },
    });
    expect(result.steps[0].status).toBe('ok');
    expect(result.steps[0].out_value).toBe(42);
    expect(result.steps[1].in_value).toBe(42); // 真实值传递，不是 mock
    expect(result.steps[1].out_value).toBe(43);
  });

  it('函数不存在 → unsupported', async () => {
    const f = writeFixture('user.ts', TS_FIXTURE);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'Ghost', file_path: f }],
      input_value: { token: 'x', tags: [] },
    });
    expect(result.steps[0].status).toBe('unsupported');
    expect(result.steps[0].note).toContain('不存在');
  });

  it('链中断：前置步骤未真实执行 → 后续步骤标注"链已中断"而非错误执行', async () => {
    const f1 = writeFixture('ext.ts', `import fs from 'node:fs';
export function readLen(p: string): number {
  return fs.readFileSync(p).length;
}
`);
    const f2 = writeFixture('b.ts', `export function b(y: number): number { return y + 1; }\n`);
    const result = await traceExecChain({
      steps: [
        { node_id: 'n1', func_name: 'readLen', file_path: f1 },
        { node_id: 'n2', func_name: 'b', file_path: f2 },
      ],
      input_value: { p: 'x' },
    });
    expect(result.steps[0].status).toBe('unsupported');
    expect(result.steps[0].note).toContain('外部');
    // 后续步骤不假装执行：标注链已中断，in_value 为空
    expect(result.steps[1].status).toBe('unsupported');
    expect(result.steps[1].note).toContain('链已中断');
    expect(result.steps[1].out_value).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────
// Python / Go（子进程执行；环境缺失时标注而非失败）
// ─────────────────────────────────────────────────────────────

const PY_FIXTURE = `def classify(score: int) -> str:
    if score >= 60:
        return 'pass'
    return 'fail'
`;

describe('trace_exec - Python 真实执行', () => {
  it('exec 子进程执行：真实输入 → 真实判定走向', async () => {
    const f = writeFixture('grade.py', PY_FIXTURE);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'classify', file_path: f }],
      input_value: { score: 85 },
    });
    if (result.steps[0].status === 'error') {
      expect(result.steps[0].note).toContain('无法启动'); // 本机无 python
    } else {
      expect(result.steps[0].status).toBe('ok');
      expect(result.steps[0].out_value).toBe('pass');
    }
  });
});

const GO_FIXTURE = `package main

func Half(n int) int {
	if n >= 10 {
		return n / 2
	}
	return n
}
`;

describe('trace_exec - Go 真实执行', () => {
  it('go run 单文件（基本类型参数）', async () => {
    const f = writeFixture('half.go', GO_FIXTURE);
    const result = await traceExecChain({
      steps: [{ node_id: 'n1', func_name: 'Half', file_path: f }],
      input_value: { n: 10 },
    });
    if (result.steps[0].status === 'error') {
      expect(result.steps[0].note).toContain('无法启动'); // 本机无 go 工具链
    } else {
      expect(result.steps[0].status).toBe('ok');
      expect(result.steps[0].out_value).toBe(5);
    }
  });
});
