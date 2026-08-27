/**
 * behavior —— 行为基线（金丝雀测试对比）
 *
 * 从契约（签名骨架）出发给目标函数生成金丝雀 harness，改动前后各跑一次，
 * 对比行为差异——验证"跑得对不对"。动态闸只答"跑得动不炸"，补不了这个缺口：
 * 改完还能跑、但返回值/副作用悄悄变了，只有行为基线能抓到。
 *
 * 工作流（capture → 改代码 → verify）：
 *   1. capture：对目标 .py 文件的目标函数生成 harness，用样例输入跑一次，
 *      记录返回值（规范化 repr）、stdout 痕迹与函数源码快照 → 存为基线 JSON。
 *   2. 用户改动（版本升级 / 重构 / 局部重写）目标代码。
 *   3. verify：用同一份 harness 对"当前磁盘"的目标文件再跑一次，
 *      与基线逐 case 对齐对比 → 判定 same / diff。
 *
 * v1 边界（诚实标注）：
 *   - 仅 Python（金丝雀 harness 直跑解释器；与动态闸 python 适配器同一执行骨架）。
 *   - 目标函数须自包含：harness 顶层 exec 整文件，模块级依赖（常量/其它函数）可用；
 *     跨文件 import 与 import 时副作用不在支持范围（不拦截，留待项目级验证）。
 *   - 返回值对比 = 规范化 repr；set/frozenset 排序化，dict 保留插入序。
 *   - 样例输入由调用方显式提供（capture 的 cases 参数）；不自动生成（v2 可加 fuzz）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** Windows 常只有 python；POSIX 约定 python3（与动态闸 python 适配器一致） */
const PY = process.platform === 'win32' ? 'python' : 'python3';

export type BehaviorVerdict = 'same' | 'diff' | 'error';

/** 金丝雀用例：一个样例输入 */
export interface BehaviorCase {
  name: string;
  args: unknown[];
  kwargs?: Record<string, unknown>;
}

/** 一次行为基线任务（capture 与 verify 共用同一份 spec） */
export interface BehaviorSpec {
  /** 项目根目录（用于把 file 解析为绝对路径 + 定位默认基线目录） */
  project_dir: string;
  /** 相对 project_dir 的目标 .py 文件 */
  file: string;
  /** 目标顶层函数名 */
  function: string;
  /** 样例输入（capture 必需） */
  cases: BehaviorCase[];
  /** 单次运行超时（毫秒，默认 60_000） */
  timeout_ms?: number;
}

/** 单个样例的执行结果 */
export interface BehaviorSampleResult {
  case: string;
  ok: boolean;
  /** ok 时：规范化 repr 的返回值 */
  ret?: string;
  /** !ok 时：异常摘要（Type: message） */
  error?: string;
}

/** 一次 harness 运行（capture 与 verify 共用的可对比载体） */
export interface BehaviorRun {
  file_abs: string;
  /** 目标文件 sha256 前 12 位（信息性：哪个版本产出本快照） */
  file_hash: string;
  /** 目标函数源码快照（inspect.getsource 产物） */
  source: string;
  /** 顶层 exec + 函数调用的 stdout 痕迹（print 副作用也入基线） */
  stdout: string;
  results: BehaviorSampleResult[];
  /** 进程级失败（python 不可用 / 超时 / 函数缺失 / 解析失败）→ 无法对比 */
  error?: string;
}

/** 落盘的基线 */
export interface BehaviorBaseline {
  spec: Omit<BehaviorSpec, 'project_dir'>;
  file_hash: string;
  generated_at: string;
  source: string;
  stdout: string;
  results: BehaviorSampleResult[];
  baseline_path: string;
}

/** 逐 case 的对比条目 */
export interface CaseDiff {
  case: string;
  status: 'same' | 'changed';
  before?: string;
  after?: string;
  before_error?: string;
  after_error?: string;
}

export interface BehaviorDiff {
  verdict: BehaviorVerdict;
  /** 基线里的 case 总数 */
  matched: number;
  /** 变化的 case 数 */
  changed: number;
  details: CaseDiff[];
  message: string;
}

// ── harness 生成 ─────────────────────────────────────────────

/**
 * 生成金丝雀 harness（Python 脚本）。纯函数便于单测。
 * 运行期行为：读 TARGET_FILE 当前磁盘内容 → ast 校验顶层函数存在 →
 * 重定向 stdout 后顶层 exec → 逐 case 调目标函数 → 输出单行 JSON
 * { source, stdout, results }（进程级失败时输出 { error }）。
 * 始终读"当前磁盘"，故 capture 与 verify 用同一份 harness 各自跑即可对比。
 */
export function harnessSource(spec: BehaviorSpec): string {
  const targetAbs = path.resolve(spec.project_dir, spec.file);
  return `# -*- coding: utf-8 -*-
import json, sys, io, ast, inspect, contextlib

TARGET_FILE = ${JSON.stringify(targetAbs)}
FUNC_NAME = ${JSON.stringify(spec.function)}
CASES = ${JSON.stringify(spec.cases)}

def _norm(v):
    # 规范化 repr：set/frozenset 排序化（repr 顺序不稳定）；
    # 其余 str/int/float/bool/None/list/tuple/dict 的 repr 在 3.7+ 确定性稳定（dict 保留插入序）
    if isinstance(v, (set, frozenset)):
        return "set(" + repr(sorted(list(v), key=repr)) + ")"
    return repr(v)

def main():
    try:
        with open(TARGET_FILE, encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        print(json.dumps({"error": "cannot read target file: " + str(e)}))
        return 1
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        print(json.dumps({"error": "target syntax error: " + str(e)}))
        return 1
    names = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if FUNC_NAME not in names:
        print(json.dumps({"error": "top-level function not found: " + FUNC_NAME}))
        return 1
    ns = {}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(src, TARGET_FILE, "exec"), ns)
        results = []
        for c in CASES:
            try:
                r = ns[FUNC_NAME](*c.get("args", []), **c.get("kwargs", {}))
                results.append({"case": c["name"], "ok": True, "ret": _norm(r)})
            except Exception as e:
                results.append({"case": c["name"], "ok": False,
                                "error": type(e).__name__ + ": " + str(e)})
    source = ""
    try:
        source = inspect.getsource(ns[FUNC_NAME])
    except Exception:
        source = "(unavailable)"
    print(json.dumps({"source": source, "stdout": buf.getvalue(), "results": results}))
    return 0

sys.exit(main())
`;
}

// ── harness 执行 ─────────────────────────────────────────────

/** 写临时 harness 并真跑目标文件，解析单行 JSON 输出 */
export function runHarness(spec: BehaviorSpec): BehaviorRun {
  const targetAbs = path.resolve(spec.project_dir, spec.file);
  let content = '';
  try {
    content = fs.readFileSync(targetAbs, 'utf-8');
  } catch {
    // 文件缺失：哈希取空串，进程级失败信息由 harness 自身读不到时给出
  }
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

  const tmp = path.join(os.tmpdir(), `dc-beh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`);
  fs.writeFileSync(tmp, harnessSource(spec), 'utf-8');
  try {
    const r = spawnSync(PY, [tmp], { encoding: 'utf-8', timeout: spec.timeout_ms ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    // 超时被终止时 Node 会同时置 error=ETIMEDOUT 与 signal=SIGTERM —— 必须先判 signal：
    // 超时是"死循环/环境卡顿"的硬信号，归 error；先判 error 会把超时误报成"python 不可用"
    if (r.signal) {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: `运行超时被终止（${r.signal}），疑似死循环` };
    }
    if (r.error) {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: `python 不可用/执行异常: ${r.error.message}` };
    }
    const last = `${r.stdout || ''}`.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    let parsed: { source?: string; stdout?: string; results?: BehaviorSampleResult[]; error?: string };
    try {
      parsed = JSON.parse(last);
    } catch {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: `harness 输出解析失败: ${`${r.stderr || ''}`.trim().slice(0, 300) || '无输出'}` };
    }
    if (parsed.error) {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: parsed.error };
    }
    return {
      file_abs: targetAbs,
      file_hash: hash,
      source: parsed.source ?? '',
      stdout: parsed.stdout ?? '',
      results: parsed.results ?? [],
    };
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Windows 上留给 OS 清理
    }
  }
}

// ── 基线路径规则 ─────────────────────────────────────────────

/** 默认基线路径：<project_dir>/.design-canvas/behavior/<file>__<func>.json */
export function baselinePathFor(project_dir: string, file: string, func: string): string {
  const safe = file.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.[^.]+$/, '');
  return path.join(project_dir, '.design-canvas', 'behavior', `${safe}__${func}.json`);
}

// ── capture / verify ─────────────────────────────────────────

/** capture：真跑一次当前代码，把行为快照落盘为基线 */
export function captureBaseline(spec: BehaviorSpec, baselinePath?: string): BehaviorBaseline {
  if (spec.cases.length === 0) {
    throw new Error('capture 需要至少一个金丝雀用例（cases）：没有样例输入，行为无从定义。');
  }
  const run = runHarness(spec);
  if (run.error) throw new Error(`capture 失败：${run.error}`);
  const bp = path.resolve(baselinePath ?? baselinePathFor(spec.project_dir, spec.file, spec.function));
  const { project_dir: _pd, ...specRest } = spec;
  const baseline: BehaviorBaseline = {
    spec: specRest,
    file_hash: run.file_hash,
    generated_at: new Date().toISOString(),
    source: run.source,
    stdout: run.stdout,
    results: run.results,
    baseline_path: bp,
  };
  fs.mkdirSync(path.dirname(bp), { recursive: true });
  fs.writeFileSync(bp, JSON.stringify(baseline, null, 2), 'utf-8');
  return baseline;
}

export interface VerifyResult {
  baseline: BehaviorBaseline;
  run: BehaviorRun;
  diff: BehaviorDiff;
  baseline_path: string;
}

/** verify：读基线 + 对当前磁盘再跑同一份 harness，逐 case 对比 */
export function verifyBaseline(spec: BehaviorSpec, baselinePath?: string): VerifyResult {
  const bp = path.resolve(baselinePath ?? baselinePathFor(spec.project_dir, spec.file, spec.function));
  if (!fs.existsSync(bp)) {
    throw new Error(`行为基线不存在：${bp}。请先对同一 file+function 执行 capture。`);
  }
  const baseline = JSON.parse(fs.readFileSync(bp, 'utf-8')) as BehaviorBaseline;
  const run = runHarness(spec);
  const before: BehaviorRun = {
    file_abs: run.file_abs,
    file_hash: baseline.file_hash,
    source: baseline.source,
    stdout: baseline.stdout,
    results: baseline.results,
  };
  return { baseline, run, diff: diffRuns(before, run), baseline_path: bp };
}

// ── 纯函数 diff（可单测，不碰进程） ──────────────────────────

/** 对比两次 harness 运行。逐 case 对齐（按 case 名），stdout 痕迹另算一条。 */
export function diffRuns(before: BehaviorRun, after: BehaviorRun): BehaviorDiff {
  if (before.error || after.error) {
    const e = before.error ?? after.error;
    return { verdict: 'error', matched: 0, changed: 0, details: [], message: `存在进程级失败，无法对比：${e}` };
  }
  const details: CaseDiff[] = [];
  const byName = new Map(after.results.map((r) => [r.case, r]));
  for (const b of before.results) {
    const a = byName.get(b.case);
    if (!a) {
      details.push({ case: b.case, status: 'changed', before: b.ok ? b.ret : b.error, before_error: b.ok ? undefined : b.error, after_error: 'verify 未跑该 case' });
      continue;
    }
    if (b.ok !== a.ok) {
      details.push({
        case: b.case, status: 'changed',
        before: b.ok ? b.ret : undefined, before_error: b.ok ? undefined : b.error,
        after: a.ok ? a.ret : undefined, after_error: a.ok ? undefined : a.error,
      });
    } else if (b.ok && b.ret !== a.ret) {
      details.push({ case: b.case, status: 'changed', before: b.ret, after: a.ret });
    } else if (!b.ok && b.error !== a.error) {
      details.push({ case: b.case, status: 'changed', before_error: b.error, after_error: a.error });
    } else {
      details.push({ case: b.case, status: 'same' });
    }
  }
  // stdout 痕迹（print 副作用）也算行为：变了 → 归 diff
  if (before.stdout !== after.stdout) {
    details.push({ case: '(stdout)', status: 'changed', before: before.stdout, after: after.stdout });
  }
  const changed = details.filter((d) => d.status === 'changed').length;
  const matched = before.results.length;
  const verdict: BehaviorVerdict = changed > 0 ? 'diff' : 'same';
  const message =
    verdict === 'same' ? `行为一致：${matched} 个 case 全部 same（含 stdout）` : `行为差异：${changed}/${matched} 个 case 变化`;
  return { verdict, matched, changed, details, message };
}
