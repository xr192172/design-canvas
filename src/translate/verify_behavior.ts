/**
 * verify_behavior —— Go→TS 纯函数行为对拍（"同功能"的真验证，不只是语法对）
 *
 * 复用仓库 behavior 模块的金丝雀 harness：同一批样例输入分别跑 Go 原函数 与 翻译后的
 * TS 函数，用 diffRuns 逐 case 对比输出 → verdict=same/diff。这才是翻译"行为等价"的证明。
 *
 * 边界（诚实标注）：仅适用于自包含纯函数（参数/返回可 JSON 的基本类型为主）。跨文件依赖、
 * 并发/IO/error 传播等不在本切片（由 verify 层的语法/结构闸 + 此处的对拍共同兜底）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHarness, diffRuns, type BehaviorCase, type BehaviorRun, type BehaviorDiff } from '../behavior/index.js';
import type { TranslateParam } from './unit.js';

/** 单参数类型的样例值集（确定性，按 Go 类型分派） */
export function typeSamples(goType: string): unknown[] {
  const t = goType.trim();
  if (/^(int|uint|float|byte|rune)\b/.test(t)) return [0, 1, -1, 5];
  if (t === 'string') return ['', 'abc'];
  if (t === 'bool') return [true, false];
  if (t.startsWith('[')) return [[], [1, 2]];
  return [];
}

function zeroOf(goType: string): unknown {
  const t = goType.trim();
  if (/^(int|uint|float|byte|rune)\b/.test(t)) return 0;
  if (t === 'string') return '';
  if (t === 'bool') return false;
  if (t.startsWith('[')) return [];
  return 0;
}

/**
 * 从参数表生成代表样例：1 个全零 case + 每个参数取一个非平凡值的 case + 1 个合并 case。
 * 有界（≤ N+2），确定性，够做纯函数对拍的冒烟。
 */
export function generateCasesFor(params: TranslateParam[]): BehaviorCase[] {
  const samples = params.map((p) => typeSamples(p.type));
  const zeroArgs = params.map((p) => zeroOf(p.type));
  const out: BehaviorCase[] = [{ name: 'base', args: zeroArgs }];
  params.forEach((p, i) => {
    const s = samples[i];
    if (s.length === 0) return;
    const pick = s[Math.min(1, s.length - 1)];
    const args = zeroArgs.slice();
    args[i] = pick;
    out.push({ name: `param_${p.name}`, args });
  });
  out.push({ name: 'combined', args: params.map((p, i) => (samples[i].length ? samples[i][Math.min(2, samples[i].length - 1)] : zeroOf(p.type))) });
  return out;
}

export interface ParityOptions {
  /** 原始 Go 函数源码（可带/可不带 package 行） */
  goSource: string;
  /** 目标函数名（Go 与 TS 同名） */
  funcName: string;
  /** 翻译后 TS 模块源码（含 export function funcName） */
  tsOutput: string;
  /** 对拍样例；缺省按 params 生成 */
  cases?: BehaviorCase[];
  /** 样例不足时按此参数生成（未给 cases 时用） */
  params?: TranslateParam[];
  /** 测试注入 harness runner */
  runHarnessImpl?: typeof runHarness;
}

export interface ParityResult {
  verdict: BehaviorDiff;
  goRun: BehaviorRun;
  tsRun: BehaviorRun;
}

/** 写临时文件分别跑 Go 原函数 与 TS 翻译函数，逐 case 对拍。 */
export function checkTranslationParity(opts: ParityOptions): ParityResult {
  const run = opts.runHarnessImpl ?? runHarness;
  const cases = opts.cases ?? (opts.params ? generateCasesFor(opts.params) : []);
  if (cases.length === 0) {
    throw new Error('对拍需要至少一个样例 case：请传 cases，或提供 params 让 generateCasesFor 生成。');
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-tr-parity-'));
  try {
    const goSrc = /^\s*package\s/m.test(opts.goSource) ? opts.goSource : `package main\n` + opts.goSource;
    const goFile = path.join(tmp, 'calc.go');
    const tsFile = path.join(tmp, 'calc.ts');
    fs.writeFileSync(goFile, goSrc, 'utf-8');
    fs.writeFileSync(tsFile, opts.tsOutput, 'utf-8');

    const goSpec = { project_dir: tmp, file: 'calc.go', function: opts.funcName, cases, timeout_ms: 120_000 };
    const tsSpec = { project_dir: tmp, file: 'calc.ts', function: opts.funcName, cases, timeout_ms: 120_000 };
    const goRun = run(goSpec);
    const tsRun = run(tsSpec);
    return { verdict: diffRuns(goRun, tsRun), goRun, tsRun };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows 留 OS */
    }
  }
}