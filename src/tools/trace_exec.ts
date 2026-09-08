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
  /** 宿主链第一步函数的参数名（供前端按名提示多参/无参） */
  entryParams: string[];
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

/** 签名 → 参数名列表（ts/py: name: T；go: name T；忽略接收者/可变参数）。
 *  用"最后一个括号组"取参数——正确跳过 Go 方法接收者 `(r *X)`。 */
function paramNames(lang: Lang, signature: string): string[] {
  const inner = extractParamList(signature);
  const names: string[] = [];
  for (const chunk of splitParams(inner)) {
    const c = chunk.trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
    if (!c || c.startsWith('...') || c.startsWith('_')) continue;
    const mGo = lang === 'go' ? /^([A-Za-z_][\w]*)\s+/.exec(c) : null;
    const mTs = lang !== 'go' ? /^([A-Za-z_$][\w$]*)\s*:/.exec(c) : null;
    const name = (mGo?.[1] ?? mTs?.[1] ?? (/^([A-Za-z_$][\w$]*)$/.exec(c)?.[1]));
    if (name) names.push(name);
  }
  return names;
}

/** 从方法签名头部解析接收者 → {varName, typeName}；无则 null。
 *  两种格式：
 *   - 本工具 Go 解析器输出：`Type.Method(params) ret`（接收者类型前置）→ typeName=Type
 *   - 兜底：字面接收者前缀 `(r *X) Name(...)` → typeName=X */
export function parseReceiver(signature: string): { varName: string; typeName: string } | null {
  const s = signature.trim();
  const m1 = /^([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_][\w]*)\s*\(/.exec(s);
  if (m1) return { varName: 'r', typeName: m1[1] };
  const m2 = /^\(\s*([A-Za-z_][\w]*)\s*\*?\s*([A-Za-z_][\w]*)\s*\)/.exec(s);
  return m2 ? { varName: m2[1], typeName: m2[2] } : null;
}

interface GoField { name: string; type: string; }

/** 在源码里定位 `type <typeName> struct { ... }`，抽取字段。未定位返回 null。 */
function findStruct(content: string, typeName: string): GoField[] | null {
  const re = new RegExp(`\\btype\\s+${typeName}\\s+struct\\s*\\{`);
  const m = re.exec(content);
  if (!m) return null;
  let open = content.indexOf('{', m.index);
  if (open === -1) return null;
  let depth = 1;
  let i = open + 1;
  const end = content.length;
  for (; i < end && depth > 0; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  const block = content.slice(open + 1, i - 1);
  const fields: GoField[] = [];
  for (const line of block.split('\n')) {
    const t = line.replace(/\/\/.*$/, '').trim();
    if (!t) continue;
    // 字段：`Name Type`（跳过嵌入/多行/复杂声明，保守）
    const f = /^([A-Za-z_][\w]*)\s+(.+)$/.exec(t);
    if (f) fields.push({ name: f[1], type: f[2].trim() });
  }
  return fields;
}

/** 字段类型 → Go 零值字面量；无法隔离合成（导入/chan/func/未知标识符）返回 null。 */
function goFieldZero(t: string): string | null {
  const s = t.trim();
  if (/^(string|string)$/.test(s)) return '""';
  if (/^bool$/.test(s)) return 'false';
  if (/^(int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|byte|rune|float32|float64|complex64|complex128)$/.test(s)) return '0';
  if (/^(error|interface\{\}|any|interface)$/.test(s)) return 'nil';
  if (/^(\[\].*|map\[.*|\[\].*\b|\[\].*\w.*|\*[A-Za-z_])$/.test(s)) return 'nil';
  if (s.startsWith('[]') || s.startsWith('map[') || s.startsWith('*') || s === 'nil') return 'nil';
  return null; // 导入类型 / chan / func / 未知标识符
}

/** 单行花括号净配对（+1 每 {，-1 每 }） */
function netBraces(line: string): number {
  let d = 0;
  for (const ch of line) { if (ch === '{') d++; else if (ch === '}') d--; }
  return d;
}

/** 提取 Go 源码中所有顶层 type 声明（struct/interface/别名），大括号平衡到闭合。
 *  供隔离执行带上同文件自定义类型上下文，避免入口函数引用到自定义类型时 undefined。 */
function goTopTypes(content: string): string {
  const lines = content.split('\n');
  const decls: string[] = [];
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const head = lines[i].trim();
    if (/^type\s/.test(head)) {
      let buf = lines[i];
      let depth = netBraces(lines[i]);
      let hasBrace = head.includes('{');
      let j = i;
      while (depth > 0 && j + 1 < N) {
        j++;
        buf += '\n' + lines[j];
        const c = netBraces(lines[j]);
        depth += c;
        if (lines[j].includes('{')) hasBrace = true;
      }
      // 无结尾分号/无大括号的别名单行声明：直接收尾
      if (!hasBrace && depth === 0) { /* 已完成 */ }
      decls.push(buf);
      i = j + 1;
    } else {
      i++;
    }
  }
  return decls.join('\n\n');
}

// ─────────────────────────────────────────────
// 示例入参生成（按签名推类型 → 生成可执行的示例值，免手工拼 JSON）
// ─────────────────────────────────────────────

export interface ExampleParam {
  name: string;
  type?: string;
  /** 该参生成的示例值；不可示例（context/error/receiver 等）为 undefined */
  example?: unknown;
}

/** 取签名里"最后一个括号组"作为参数列表（正确跳过 Go 方法接收者 `(r *X)` 与嵌套类型括号）。 */
function extractParamList(signature: string): string {
  const close = signature.lastIndexOf(')');
  if (close === -1) return '';
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const ch = signature[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return signature.slice(i + 1, close);
    }
  }
  return '';
}

/** 按顶层逗号拆分参数块（depth-aware，忽略类型里的括号/中括号/花括号）。 */
function splitParams(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 类型串 → 示例值（粗粒度按关键词映射；context/error/receiver 无法示例 → undefined） */
function exampleForType(t: string | undefined, name: string): unknown | undefined {
  if (!t) return '';
  const low = t.toLowerCase();
  const nameLow = name.toLowerCase();
  if (nameLow === 'ctx' || nameLow.startsWith('context') || low.includes('context') || /^(error|runtime\.error)$/.test(low)) return undefined;
  if (low.includes('map') || low.includes('object') || low.includes('dict') || low.includes('record')) return {};
  if (low.includes('[') && !low.includes('string') && !low.includes('bool') && !low.includes('int')) return [];
  if (low === 'bool' || low.includes('bool')) return false;
  if (/^(int|uint|byte|float|double|int64|int32|uint64|number|num|size|count|limit|total|max|min|port|$)/.test(low)) return 0;
  if (low === 'string' || low.includes('string') || low.includes('char')) return '';
  return '';
}

/** 由签名生成示例入参对象 + 逐参说明。两种语言命名约定：Go `n type`；TS `n: type`。 */
export function exampleInputFor(signature: string, lang: string): { example: Record<string, unknown>; params: ExampleParam[]; preview: string } {
  const params: ExampleParam[] = [];
  const example: Record<string, unknown> = {};
  const inner = extractParamList(signature);
  for (const chunk of splitParams(inner)) {
    const c = chunk.trim().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/, '').trim();
    if (!c) continue;
    if (c.startsWith('...') || c.startsWith('_')) continue; // 可变参数/丢弃参
    let name = '';
    let type: string | undefined;
    const isGo = lang === 'go';
    const mGo = isGo ? /^([A-Za-z_][\w]*)\s+(.+)$/.exec(c) : null;
    const mTs = !isGo ? /^([A-Za-z_$][\w$]*)\s*:\s*(.+)$/.exec(c) : null;
    if (mGo) { name = mGo[1]; type = mGo[2].trim(); }
    else if (mTs) { name = mTs[1]; type = mTs[2].trim(); }
    else {
      // 无类型（仅名字）
      const bare = /^([A-Za-z_$][\w$]*)$/.exec(c);
      if (bare) name = bare[1];
      else continue;
    }
    const value = exampleForType(type, name);
    params.push({ name, type, example: value });
    if (value !== undefined) example[name] = value;
  }
  let preview: string;
  try { preview = JSON.stringify(example, null, 2); } catch { preview = '{}'; }
  return { example, params, preview };
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
  /** Go 方法：合成的接收者信息（execGo 用来自建实例并调方法） */
  recv?: { typeName: string; structDecl: string; zero: Record<string, string> };
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
  // Go 方法：接收者自包含（字段均为基本/切片/map/指针）时合成零值实例来执行；
  // 非 Go 方法 / 字段含导入·chan·func → 如实标不支持。
  let methodRecv: ResolvedFn['recv'];
  if (symbol.kind === 'method') {
    if (lang !== 'go') return { ok: false, reason: '非 Go 方法暂不支持隔离执行' };
    const recv = parseReceiver(symbol.signature);
    if (!recv) return { ok: false, reason: '无法识别方法接收者' };
    const fields = findStruct(content, recv.typeName);
    if (!fields || fields.length === 0) return { ok: false, reason: `接收者类型 ${recv.typeName} 未定位到 struct，无法合成实例` };
    const zero: Record<string, string> = {};
    for (const f of fields) {
      const z = goFieldZero(f.type);
      if (z === null) return { ok: false, reason: `接收者字段 ${f.name} 类型 ${f.type} 含导入/chan/func，无法隔离合成` };
      zero[f.name] = z;
    }
    const structDecl = `type ${recv.typeName} struct {\n` + fields.map((f) => `\t${f.name} ${f.type}`).join('\n') + `\n}`;
    methodRecv = { typeName: recv.typeName, structDecl, zero };
  }

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
      // Go：带上同文件顶层 type 声明（含方法接收者 struct）作为隔离上下文；
      // TS/Python 依赖已随函数体提取，无需额外 type 上下文。
      codeText: (lang === 'go' ? goTopTypes(content) : '') + '\n\n' + depTexts.join('\n\n'),
      entryName: symbol.name,
      names: paramNames(lang, symbol.signature),
      recv: methodRecv,
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

/** Python：通过 `python -c` 内联脚本执行（参数 **kwargs，stdlib 可用），stdin 传输入 JSON。
 *  不用临时文件：新写临时 py 会被 Defender 等实时扫描间歇性锁住（观测到 15s+），
 *  导致子进程挂起到超时——脚本经 `-c` 直传即绕开文件系统竞态，稳定可复现。 */
async function execPy(codeText: string, entryName: string, kwargs: Record<string, unknown>): Promise<unknown> {
  const script = `${codeText}\nimport json, sys\n_result = ${entryName}(**json.loads(sys.stdin.read()))\nprint(json.dumps(_result, default=str))`;
  const out = await runSubprocess('python', ['-c', script], JSON.stringify(kwargs));
  return JSON.parse(out.trim());
}

/** Go 字面量（v1：基本类型；空切片/空映射→nil；复合/非空复合需类型 hint 暂不支持） */
function goLit(v: unknown): string {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length === 0) return 'nil';
  if (typeof v === 'object' && Object.keys(v).length === 0) return 'nil';
  throw new Error('Go 参数暂支持基本类型与空切片/空映射/空对象（string/number/boolean/null/[]/{}）');
}

/** Go：生成临时 main.go → go run（需本机 go 工具链）。
 *  - 顶层函数：`v := <entry>(args...)`
 *  - 方法（recv 非空）：合成零值接收者实例后调用 `r := <Type>{f0:z0,…}; v := r.<Method>(args...)` */
async function execGo(codeText: string, entryName: string, args: unknown[], recv?: ResolvedFn['recv']): Promise<unknown> {
  const argLits = args.map(goLit).join(', ');
  const call = recv
    ? [
        `\tr := ${recv.typeName}{${Object.entries(recv.zero).map(([k, z]) => `${k}: ${z}`).join(', ')}}`,
        `\tv := r.${entryName}(${argLits})`,
      ].join('\n')
    : `\tv := ${entryName}(${argLits})`;
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
    call,
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
  let entryParams: string[] = [];
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
    // 回流宿主链第一步函数的参数名，供前端按名提示多参/无参
    if (i === 0) entryParams = resolved.fn.names;

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

  return { steps, entryParams };
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
      return execGo(fn.codeText, fn.entryName, args, fn.recv);
    default:
      throw new Error('不支持的执行语言');
  }
}
