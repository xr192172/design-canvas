/**
 * behavior —— 行为基线（金丝雀测试对比）
 *
 * 从契约（签名骨架）出发给目标函数生成金丝雀 harness，改动前后各跑一次，
 * 对比行为差异——验证"跑得对不对"。动态闸只答"跑得动不炸"，补不了这个缺口：
 * 改完还能跑、但返回值/副作用悄悄变了，只有行为基线能抓到。
 *
 * 工作流（capture → 改代码 → verify）：
 *   1. capture：对目标文件的目标函数生成 harness，用样例输入跑一次，
 *      记录返回值（规范化 repr）、stdout 痕迹与函数源码快照 → 存为基线 JSON。
 *   2. 用户改动（版本升级 / 重构 / 局部重写）目标代码。
 *   3. verify：用同一份 harness 对"当前磁盘"的目标文件再跑一次，
 *      与基线逐 case 对齐对比 → 判定 same / diff。
 *
 * 语言支持：
 *   - python（.py）：金丝雀 harness 直跑解释器（顶层 exec 整文件，模块级依赖可用）。
 *   - node 家族（.ts/.tsx/.js/.jsx/.mjs/.cjs）：typescript.transpileModule 转 CJS 后
 *     由 node 子进程整体 require（顶层模块代码运行，等价于 python 的顶层 exec）。
 *
 * v1 边界（诚实标注）：
 *   - 目标函数须自包含：python 顶层 exec 整文件；node 转译后的 CJS 整体 require——
 *     模块级常量/同文件其它函数可用；跨文件 import 不在支持范围（node 侧解析不到即报错、
 *     python 侧不拦截），留待项目级验证。
 *   - 返回值对比 = 规范化 repr；set 排序化（python）、Set/Map 排序化（node），dict/对象保留插入序。
 *   - 样例输入由调用方显式提供（capture 的 cases 参数）；不自动生成（v2 可加 fuzz）。
 *   - node 的 kwargs（JS 无关键字实参概念）以单个尾部 options 对象传入；无 kwargs 则不传。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

/** Windows 常只有 python；POSIX 约定 python3（与动态闸 python 适配器一致） */
const PY = process.platform === 'win32' ? 'python' : 'python3';

/** node 家族扩展名（typescript.transpileModule 转 CJS 后由 node 子进程执行） */
const NODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export type BehaviorLang = 'python' | 'node';

/** 按文件扩展名判定 harness 语言（未知扩展 → 抛错，不静默猜） */
export function langOfFile(file: string): BehaviorLang {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.py') return 'python';
  if (NODE_EXTS.includes(ext)) return 'node';
  throw new Error(`不支持的脚本语言（${ext}）：行为基线支持 .py 与 ${NODE_EXTS.join(' / ')}`);
}

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
  /** 相对 project_dir 的目标文件（.py / .ts / .tsx / .js / .jsx / .mjs / .cjs） */
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
  /** 目标函数源码快照（python: inspect.getsource；node: Function.prototype.toString） */
  source: string;
  /** 顶层 exec + 函数调用的 stdout 痕迹（print/console 副作用也入基线） */
  stdout: string;
  results: BehaviorSampleResult[];
  /** 进程级失败（解释器不可用 / 超时 / 函数缺失 / 解析失败）→ 无法对比 */
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

// ── harness 生成：python ────────────────────────────────────

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

// ── harness 生成：node 家族 ─────────────────────────────────

/**
 * 把目标 TS/JS 源码转成 CommonJS（ts.transpileModule 单文件转译）。
 * 跨文件 import 会留下 require(...) 调用——子进程里解析不到即报错（v1 边界：须自包含）。
 * 返回 { js } 或 { error }（语法/转译失败）。
 */
export function transpileToCjs(abs: string, src: string): { js: string } | { error: string } {
  const out = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: true,
    },
    fileName: abs,
    reportDiagnostics: true,
  });
  const errs = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errs.length > 0) {
    const msg = errs
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n').split('\n')[0])
      .join('; ');
    return { error: `目标文件转译失败: ${msg}` };
  }
  return { js: out.outputText };
}

/**
 * 生成金丝雀 runner（Node .mjs 脚本）。纯函数便于单测。
 * 运行期行为：createRequire 加载 TARGET_CJS（argv[2]，父进程已转译好的 CJS，读"当前磁盘"）→
 * 定位顶层函数 → 重定向 console 后逐 case 调用（async 自动 await；kwargs 以尾部 options 对象传入）→
 * 输出单行 JSON { source, stdout, results }（进程级失败时输出 { error }）。
 */
export function nodeRunnerSource(spec: BehaviorSpec): string {
  return `import { createRequire } from 'node:module';

const FUNC_NAME = ${JSON.stringify(spec.function)};
const CASES = ${JSON.stringify(spec.cases)};

function _sk(x) {
  if (x === null || x === undefined) return '';
  if (x instanceof Date) return x.toISOString();
  return typeof x === 'string' ? x : String(x);
}

function _norm(v) {
  // 规范化 repr：Set/Map 按键排序化（迭代序不稳定）；对象/数组保留插入序（JSON.stringify）
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') {
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return JSON.stringify(v);
  }
  if (t === 'bigint') return v.toString() + 'n';
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return String(v);
  if (t === 'function') return v.toString();
  if (v instanceof Date) return 'Date(' + v.toISOString() + ')';
  if (v instanceof RegExp) return v.toString();
  if (v instanceof Error) return v.name + ': ' + v.message;
  if (v instanceof Set) {
    try {
      return 'Set(' + JSON.stringify([...v].sort((a, b) => (_sk(a) < _sk(b) ? -1 : _sk(a) > _sk(b) ? 1 : 0))) + ')';
    } catch { return String(v); }
  }
  if (v instanceof Map) {
    try {
      return 'Map(' + JSON.stringify([...v.entries()].sort((a, b) => (_sk(a[0]) < _sk(b[0]) ? -1 : _sk(a[0]) > _sk(b[0]) ? 1 : 0))) + ')';
    } catch { return String(v); }
  }
  try { return JSON.stringify(v); } catch { return String(v); }
}

// console 痕迹捕获（模块加载 + 逐 case 调用的 stdout 副作用都入基线）
const _origConsole = {};
for (const k of ['log', 'info', 'warn', 'error', 'debug']) _origConsole[k] = console[k];
let _logs = [];
function _capStart() {
  _logs = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    console[k] = (...a) => {
      _logs.push(a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' '));
    };
  }
}
function _capEnd() {
  for (const k of Object.keys(_origConsole)) console[k] = _origConsole[k];
  return _logs.join('\\n');
}

let mod;
let loadStdout = '';
try {
  _capStart();
  try {
    mod = createRequire(import.meta.url)(process.argv[2]);
  } finally {
    loadStdout = _capEnd();
  }
} catch (e) {
  const msg = String((e && e.message) || e);
  const boundary = /Cannot find module|Cannot use import statement|require is not defined|ERR_UNKNOWN_FILE_EXTENSION/.test(msg);
  process.stdout.write(JSON.stringify({ error: (boundary ? '跨文件 import / 模块解析失败（v1 边界：目标文件须自包含）: ' : '目标文件加载失败: ') + msg }));
  process.exit(1);
}

let fn = null;
if (mod) {
  if (typeof mod[FUNC_NAME] === 'function') fn = mod[FUNC_NAME];
  else if (mod && mod.default) {
    if (typeof mod.default === 'function' && FUNC_NAME === 'default') fn = mod.default;
    else if (mod.default && typeof mod.default[FUNC_NAME] === 'function') fn = mod.default[FUNC_NAME];
  }
}
if (typeof fn !== 'function') {
  process.stdout.write(JSON.stringify({ error: 'top-level function not found: ' + FUNC_NAME }));
  process.exit(1);
}
const source = fn.toString();

const results = [];
_capStart();
try {
  for (const c of CASES) {
    try {
      let r = fn(...(c.args || []), ...(c.kwargs && Object.keys(c.kwargs).length ? [c.kwargs] : []));
      if (r && typeof r.then === 'function') r = await r;
      results.push({ case: c.name, ok: true, ret: _norm(r) });
    } catch (e) {
      results.push({ case: c.name, ok: false, error: ((e && e.name) || 'Error') + ': ' + String((e && e.message) || e) });
    }
  }
} finally {
  const callStdout = _capEnd();
  process.stdout.write(JSON.stringify({ source, stdout: (loadStdout + '\\n' + callStdout).replace(/^\\n/, ''), results }));
}
`;
}

// ── harness 执行 ─────────────────────────────────────────────

/** 写临时 python harness 并真跑目标文件，解析单行 JSON 输出 */
function runPythonHarness(spec: BehaviorSpec): BehaviorRun {
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

/**
 * node 家族：父进程转译 TS/JS → CJS（读"当前磁盘"），写临时 CJS + runner，
 * spawn node 子进程执行，解析单行 JSON 输出。与 python 分支同一份输出契约，diff 共用。
 */
function runNodeHarness(spec: BehaviorSpec): BehaviorRun {
  const targetAbs = path.resolve(spec.project_dir, spec.file);
  let content = '';
  try {
    content = fs.readFileSync(targetAbs, 'utf-8');
  } catch {
    // 文件缺失：哈希取空串，转译空源 → 顶层函数缺失的进程级错误
  }
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);

  const tr = transpileToCjs(targetAbs, content);
  if ('error' in tr) {
    return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: tr.error };
  }

  const tmpBase = `dc-beh-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpCjs = path.join(os.tmpdir(), `${tmpBase}.cjs`);
  const tmpRunner = path.join(os.tmpdir(), `${tmpBase}.mjs`);
  fs.writeFileSync(tmpCjs, tr.js, 'utf-8');
  fs.writeFileSync(tmpRunner, nodeRunnerSource(spec), 'utf-8');
  try {
    const r = spawnSync(process.execPath, [tmpRunner, tmpCjs], { encoding: 'utf-8', timeout: spec.timeout_ms ?? 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (r.signal) {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: `运行超时被终止（${r.signal}），疑似死循环` };
    }
    if (r.error) {
      return { file_abs: targetAbs, file_hash: hash, source: '', stdout: '', results: [], error: `node 不可用/执行异常: ${r.error.message}` };
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
    for (const p of [tmpCjs, tmpRunner]) {
      try {
        fs.rmSync(p, { force: true });
      } catch {
        // Windows 上留给 OS 清理
      }
    }
  }
}

/** 按目标文件语言分支执行 harness */
export function runHarness(spec: BehaviorSpec): BehaviorRun {
  return langOfFile(spec.file) === 'python' ? runPythonHarness(spec) : runNodeHarness(spec);
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
