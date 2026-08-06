/**
 * trace_exec：真实执行引擎（数据流"真实流转"——用户输入 → 链上函数真实执行 → 真实输出）
 *
 * 与静态 mock 推演（dataflow_core.buildDataTrace）互补：
 *   - 静态 mock：无执行环境也能看"处理/判定/分流"结构，输出为 schema 示例值
 *   - 真实执行：喂用户真实输入，纯函数子集真实运行，输出为真实值（可挖逻辑 bug）
 *
 * 纯函数子集边界（诚实标注，不假装能执行）：
 *   - 函数体内调用：同文件符号（递归收集依赖）或内建前缀（Math/JSON/Array…）→ 可执行
 *   - 调用外部/未解析函数、方法（有 receiver）、import 引用 → unsupported（附原因）
 *   - 执行失败（ReferenceError/异常）→ error（附原因）
 *
 * 语言支持梯度：TS/JS（Node 原生）→ Python（子进程 exec，stdlib 可用）→ Go（go run 单文件，仅基本类型参数）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { parseFileFull, type ParsedSymbol } from './ts_kernel/index.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export interface TraceStepSpec {
  /** DSL detail 节点 id */
  node_id: string;
  /** 函数名（顶层函数） */
  func_name: string;
  /** 源文件绝对路径 */
  file_path: string;
}

export interface TraceExecStep {
  node_id: string;
  func_name: string;
  status: 'ok' | 'unsupported' | 'error';
  in_value: unknown;
  out_value: unknown;
  /** unsupported/error 的原因说明 */
  note?: string;
}

export interface TraceExecInput {
  steps: TraceStepSpec[];
  /** 用户输入：对象（参数名→值）或标量（单参数） */
  input_value: unknown;
}

export interface TraceExecResult {
  steps: TraceExecStep[];
}

// ─────────────────────────────────────────────────────────────
// 语言与参数
// ─────────────────────────────────────────────────────────────

type Lang = 'ts' | 'py' | 'go';

function langOf(filePath: string): Lang {
  if (/\.(go)$/.test(filePath)) return 'go';
  if (/\.(py)$/.test(filePath)) return 'py';
  return 'ts';
}

/** 签名 → 参数名列表（ts/py: name: T；go: name T；忽略接收者/可变参数） */
function paramNames(lang: Lang, signature: string): string[] {
  const m = signature.match(/\(([^)]*)\)/);
  if (!m) return [];
  const inner = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
  const names: string[] = [];
  for (const p of parts) {
    // 可变参数/展开符号跳过（*args、...rest）
    if (p.startsWith('*') || p.startsWith('...') || p.startsWith('_')) continue;
    const raw = p.split(':')[0].trim();
    // Go：'n int'（类型在后）→ 名字是空格前 token
    const name = lang === 'go' ? raw.split(/\s+/)[0] : raw;
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

/** 输入值 → 位置参数数组（对象按参数名取值；标量单参） */
function toArgs(names: string[], input: unknown): unknown[] {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    if (names.length === 1 && !(names[0] in (input as Record<string, unknown>))) return [input];
    return names.map((n) => (input as Record<string, unknown>)[n]);
  }
  return [input];
}

// ─────────────────────────────────────────────────────────────
// 纯函数判定 + 依赖收集
// ─────────────────────────────────────────────────────────────

/** 内建纯函数前缀白名单（执行时放行） */
const BUILTIN_PREFIX = new Set([
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'encodeURIComponent', 'decodeURIComponent',
]);

/** 判定调用是否"外部"（需阻断）：
 *  - 无点短调用（len 等内建）→ 放行
 *  - import 包名调用（fs.readFileSync）→ 外部
 *  - 白名单内建前缀（Math.max）→ 放行
 *  - 其余点调用（s.trim() 变量方法链）→ 放行（执行时缺了会 error 标注） */
function isExternalCall(expr: string, pkgNames: Set<string>): boolean {
  if (!expr.includes('.')) return false;
  const head = expr.split(/[.(]/)[0];
  if (BUILTIN_PREFIX.has(head)) return false;
  return pkgNames.has(head);
}

interface ResolvedFn {
  /** 可执行时的函数体文本（入口 + 全部纯依赖） */
  codeText: string;
  entryName: string;
  names: string[];
}

/** 判定符号是否纯函数并可执行；可执行则返回入口 + 依赖代码文本 */
function resolvePure(
  symbol: ParsedSymbol,
  symbols: ParsedSymbol[],
  calls: Array<{ caller: string; callee: string; callee_expr: string; resolved: boolean; callee_qn?: string }>,
  content: string,
  lang: Lang,
  pkgNames: Set<string>,
): { ok: true; fn: ResolvedFn } | { ok: false; reason: string } {
  if (symbol.kind === 'method') return { ok: false, reason: '方法（有 receiver）暂不支持真实执行' };

  // 依赖 BFS：收集本文件内被调用的纯函数
  const byQn = new Map(symbols.map((s) => [s.qualified_name, s]));
  const depTexts: string[] = [];
  const seen = new Set<string>([symbol.qualified_name]);
  const queue: ParsedSymbol[] = [symbol];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    depTexts.push(extractBody(content, cur));
    for (const c of calls) {
      if (c.caller !== cur.qualified_name) continue;
      if (c.resolved && c.callee_qn) {
        const dep = byQn.get(c.callee_qn);
        if (!dep) return { ok: false, reason: `调用无法定位：${c.callee_expr}` };
        if (dep.kind === 'method') return { ok: false, reason: `依赖方法：${c.callee_expr}` };
        if (!seen.has(dep.qualified_name)) {
          seen.add(dep.qualified_name);
          queue.push(dep);
        }
      } else if (isExternalCall(c.callee_expr, pkgNames)) {
        return { ok: false, reason: `调用外部函数：${c.callee_expr}` };
      }
    }
  }

  return {
    ok: true,
    fn: {
      codeText: depTexts.join('\n\n'),
      entryName: symbol.name,
      names: paramNames(lang, symbol.signature),
    },
  };
}

/** 按符号行号范围提取函数体源码 */
function extractBody(content: string, symbol: ParsedSymbol): string {
  const lines = content.split('\n');
  return lines.slice(Math.max(0, symbol.start_line - 1), symbol.end_line).join('\n');
}

// ─────────────────────────────────────────────────────────────
// 语言执行器
// ─────────────────────────────────────────────────────────────

/** TS/JS：transpile 函数体 → new Function 执行（依赖函数同作用域可互相调用） */
function execTs(codeText: string, entryName: string, args: unknown[]): unknown {
  const js = ts.transpileModule(codeText.replace(/^export\s+/gm, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  const fn = new Function('__args__', `${js}\nreturn ${entryName}(...__args__);`);
  return fn(args);
}

function runSubprocess(cmd: string, args: string[], stdin: string, timeoutMs = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill('SIGKILL');
      reject(new Error(`执行超时（${timeoutMs}ms），子进程已终止`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 ${cmd}：${e.message}`));
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error((err || `退出码 ${code}`).trim().slice(0, 200)));
      else resolve(out);
    });
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

/** Python：临时脚本 exec（参数 **kwargs，stdlib 可用），stdin 传输入 JSON */
async function execPy(codeText: string, entryName: string, kwargs: Record<string, unknown>): Promise<unknown> {
  const tmp = path.join(os.tmpdir(), `dc_exec_${Date.now()}_${Math.floor(Math.random() * 1e6)}.py`);
  fs.writeFileSync(
    tmp,
    `${codeText}\nimport json, sys\n_result = ${entryName}(**json.loads(sys.stdin.read()))\nprint(json.dumps(_result, default=str))`,
    'utf-8',
  );
  try {
    const out = await runSubprocess('python', [tmp], JSON.stringify(kwargs));
    return JSON.parse(out.trim());
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 已删 */ }
  }
}

/** Go 字面量（v1：基本类型；复合类型不支持） */
function goLit(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new Error('Go 参数暂支持基本类型（string/number/boolean）');
}

/** Go：生成临时 main.go → go run（需本机 go 工具链） */
async function execGo(codeText: string, entryName: string, args: unknown[]): Promise<unknown> {
  const argLits = args.map(goLit).join(', ');
  const main = [
    'package main',
    '',
    'import (',
    '\t"encoding/json"',
    '\t"fmt"',
    ')',
    '',
    codeText,
    '',
    'func main() {',
    `\tv := ${entryName}(${argLits})`,
    '\tb, _ := json.Marshal(v)',
    '\tfmt.Print(string(b))',
    '}',
  ].join('\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc_go_'));
  try {
    fs.writeFileSync(path.join(dir, 'main.go'), main, 'utf-8');
    const out = await runSubprocess('go', ['run', path.join(dir, 'main.go')], '');
    return JSON.parse(out.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────
// 主入口：链式真实执行
// ─────────────────────────────────────────────────────────────

export async function traceExecChain(input: TraceExecInput): Promise<TraceExecResult> {
  const steps: TraceExecStep[] = [];
  let carry = input.input_value;
  let broken = false;

  for (let i = 0; i < input.steps.length; i++) {
    const spec = input.steps[i];
    const step: TraceExecStep = {
      node_id: spec.node_id,
      func_name: spec.func_name,
      status: 'ok',
      in_value: carry,
      out_value: undefined,
    };

    // 链已中断：数据没有真实流转到本步，如实标注而不假装执行
    if (broken) {
      step.status = 'unsupported';
      step.note = '链已中断：前置步骤未真实执行，数据未流入本步';
      steps.push(step);
      continue;
    }

    // 1. 读文件 + 解析符号
    let content: string;
    try {
      content = fs.readFileSync(spec.file_path, 'utf-8');
    } catch (e) {
      step.status = 'unsupported';
      step.note = `源文件不可读：${(e as Error).message}`;
      steps.push(step);
      carry = undefined;
      broken = true;
      continue;
    }
    const parsed = await parseFileFull(spec.file_path, content);
    if (parsed.error) {
      step.status = 'unsupported';
      step.note = `解析失败：${parsed.error}`;
      steps.push(step);
      carry = undefined;
      broken = true;
      continue;
    }
    const symbol = parsed.symbols.find((s) => s.name === spec.func_name && (s.kind === 'function' || s.kind === 'method'));
    if (!symbol) {
      step.status = 'unsupported';
      step.note = `函数 ${spec.func_name} 不存在于 ${path.basename(spec.file_path)}`;
      steps.push(step);
      carry = undefined;
      broken = true;
      continue;
    }

    // 2. 纯函数判定
    const lang = langOf(spec.file_path);
    // import 包名集合：区分"包调用"（外部）与"变量方法链"（s.trim() 放行）
    // 'node:fs' → 'fs'；'@scope/pkg' → 'pkg'；'lodash' → 'lodash'
    const pkgNames = new Set(
      parsed.imports
        .filter((i) => i.kind === 'package')
        .map((i) => i.source.split(/[/:]/).pop() || i.source),
    );
    const calls = parsed.calls.map((c) => ({
      caller: c.caller,
      callee: c.callee,
      callee_expr: c.callee_expr,
      resolved: c.resolved,
      callee_qn: c.callee_qn,
    }));
    const resolved = resolvePure(symbol, parsed.symbols, calls, content, lang, pkgNames);
    if (!resolved.ok) {
      step.status = 'unsupported';
      step.note = resolved.reason;
      steps.push(step);
      carry = undefined;
      broken = true;
      continue;
    }

    // 3. 真实执行
    try {
      const args = toArgs(resolved.fn.names, carry);
      const value = await execByLang(lang, resolved.fn, args);
      step.out_value = value;
      carry = value;
    } catch (e) {
      step.status = 'error';
      step.note = String((e as Error).message).slice(0, 200);
      carry = undefined;
      broken = true;
    }
    steps.push(step);
  }

  return { steps };
}

async function execByLang(lang: Lang, fn: ResolvedFn, args: unknown[]): Promise<unknown> {
  switch (lang) {
    case 'ts':
      return execTs(fn.codeText, fn.entryName, args);
    case 'py': {
      // 对象输入 → kwargs；标量 → 单键参数
      const kw: Record<string, unknown> = {};
      if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]) && fn.names.length > 1) {
        Object.assign(kw, args[0] as Record<string, unknown>);
      } else {
        fn.names.forEach((n, i) => (kw[n] = args[i]));
      }
      return execPy(fn.codeText, fn.entryName, kw);
    }
    case 'go':
      return execGo(fn.codeText, fn.entryName, args);
    default:
      throw new Error('不支持的执行语言');
  }
}
