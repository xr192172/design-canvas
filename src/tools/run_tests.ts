/**
 * run_tests —— 测试编排工具（跑测试 → 结构化失败定位）
 *
 * 解决日常缺口：改完代码要确认——此前跑 `npm test` 看长文本再人工 grep 失败。
 * 本品包一层 vitest：跑测试 → 用 json reporter 拿到结构化结果 → 解析失败项
 * （文件 + 用例名 + 断言消息），返回给 LLM 直接定位到代码，而不是让 LLM 读 stdout 大海捞针。
 *
 * 用法：
 *   - filter（推荐）：传单个测试文件/名称 → 快速定向回归（秒级）。
 *   - 省略 filter：跑全量（耗时，适合提交前检查，注意 timeout）。
 *
 * 依赖：目标项目已装 vitest 且在 node_modules 下（本仓库自带）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TestFailure {
  /** 测试文件（import 路径，vitest json 的 suite name） */
  file: string;
  /** 完整用例名 */
  test: string;
  /** 断言失败消息（含堆栈） */
  messages: string[];
}

export interface RunTestsResult {
  ok: boolean;
  /** 是否真的成功（failed === 0 且跑起来了） */
  success: boolean;
  filter?: string;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  failures: TestFailure[];
  /** vitest JSON 产物路径（供深入查看） */
  outputFile?: string;
  /** 运行失败/超时/解析失败时的错误说明 */
  error?: string;
}

export function runTests(input: { project_dir?: string; filter?: string; timeoutMs?: number }): RunTestsResult {
  const cwd = input.project_dir ? path.resolve(input.project_dir) : process.cwd();
  const vitest = path.join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
  // 输出文件放系统临时目录，避免污染项目仓库
  const outFile = path.join(os.tmpdir(), `dc-vitest-${process.pid}-${Date.now()}.json`);
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* 无残留 */
  }
  const args = [vitest, 'run'];
  if (input.filter) args.push(input.filter);
  args.push('--reporter=json', `--outputFile=${outFile}`);
  try {
    // 失败用例 vitest 以非零退出，属预期（catch 里继续读 outputFile）
    execFileSync(process.execPath, args, { cwd, timeout: input.timeoutMs ?? 120_000, stdio: 'pipe' });
  } catch (e: unknown) {
    const err = e as { code?: string };
    if (err && (err.code === 'ETIMEDOUT' || err.code === 'ERR_CHILD_PROCESS_TIMEOUT')) {
      cleanup(outFile);
      return { ok: false, success: false, total: 0, passed: 0, failed: 0, pending: 0, failures: [], error: `测试超时（>${Math.round((input.timeoutMs ?? 120_000) / 1000)}s）` };
    }
    // 其它退出码（含测试失败）→ 继续解析 outputFile
  }
  if (!fs.existsSync(outFile)) {
    cleanup(outFile);
    return { ok: false, success: false, total: 0, passed: 0, failed: 0, pending: 0, failures: [], error: '未能读取 vitest JSON 输出（vitest 是否已安装？）' };
  }
  try {
    const j = JSON.parse(fs.readFileSync(outFile, 'utf-8')) as {
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      testResults?: Array<{ name?: string; assertionResults?: Array<{ fullName?: string; status?: string; failureMessages?: string[] }> }>;
    };
    const failures: TestFailure[] = [];
    for (const tr of j.testResults ?? []) {
      for (const ar of tr.assertionResults ?? []) {
        if (ar.status === 'failed') {
          failures.push({ file: tr.name ?? '', test: ar.fullName ?? '', messages: ar.failureMessages ?? [] });
        }
      }
    }
    const result: RunTestsResult = {
      ok: true,
      success: (j.numFailedTests ?? failures.length) === 0,
      filter: input.filter,
      total: j.numTotalTests ?? failures.length,
      passed: j.numPassedTests ?? 0,
      failed: j.numFailedTests ?? failures.length,
      pending: j.numPendingTests ?? 0,
      failures,
      outputFile: outFile,
    };
    return result;
  } catch {
    cleanup(outFile);
    return { ok: false, success: false, total: 0, passed: 0, failed: 0, pending: 0, failures: [], error: 'vitest JSON 解析失败' };
  }
}

function cleanup(f: string): void {
  try {
    fs.unlinkSync(f);
  } catch {
    /* ignore */
  }
}