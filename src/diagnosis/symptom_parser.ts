/**
 * symptom_parser —— 症状解析（诊断流水线第 1 步，确定性）
 *
 * 把用户给的"症状"（报错 / stack trace / 测试失败输出 / 行为描述）解析成结构化产物：
 *   - error_type：识别出的错误类型（TypeError / Cannot find module / panic …）
 *   - locations：  从报错里直接提取的 文件:行（含 stack frame / Python Traceback / TS 编译错误）
 *   - symbols：    提取的候选符号名（identifier / 限定名）
 *   - keywords：   去停用词后的兜底分词（供 FTS/语义检索）
 *
 * 支持形态：
 *   - TS/JS 运行时：TypeError / ReferenceError / SyntaxError / "xxx is not a function" …
 *   - Node 模块：   Cannot find module 'xxx'
 *   - TS 编译：     "error TS2307: Cannot find module 'xxx'"（含 file.ts(12,5) 形态）
 *   - Go：          panic: … / src/main.go:23: syntax error / stack main.main() 行
 *   - Python：      Traceback + File "x.py", line N, in func
 *   - 测试失败：    FAIL tests/x.test.ts / AssertionError: …
 *
 * 纯函数，不读文件、不查库——只做文本层解析。调用方（candidate_locator）拿
 * locations/symbols/keywords 去 cache.db 定位。
 */

import type { SymptomParsed } from './contract.js';

// ─────────────────────────────────────────────────────────────
// 错误类型识别
// ─────────────────────────────────────────────────────────────

const ERROR_TYPE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // 顺序敏感：TS 编译错误（error TSxxxx: …）优先于其内部嵌套的 "Cannot find module"
  { re: /error TS(\d+):\s*(.+)/, label: 'TS 编译错误' },
  { re: /Cannot find module ['"]([^'"]+)['"]/, label: 'Cannot find module' },
  { re: /Module not found: Can't resolve ['"]([^'"]+)['"]/, label: 'Module not found' },
  { re: /(?:^|[\s(:])([A-Z][A-Za-z]*(?:Error|Exception|AssertionError))(?::|\s|$)/, label: '' }, // 用捕获组当 label
  { re: /^(panic:)\s*(.*)$/m, label: 'panic' },
  { re: /^\s*(failed|FAIL|AssertionError)/m, label: '测试失败' },
];

/** 已知错误类型关键词（无冒号/格式较自由时兜底识别） */
const KNOWN_ERROR_KINDS = new Set([
  'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'EvalError',
  'Error', 'AssertionError', 'AggregateError', 'TypeErrorException', 'ValueError',
  'KeyError', 'IndexError', 'AttributeError', 'ImportError', 'ModuleNotFoundError',
  'ZeroDivisionError', 'UnicodeDecodeError', 'json.decoder.JSONDecodeError',
  'RuntimeError', 'NotImplementedError', 'panic', 'fatal', 'exception',
]);

function detectErrorType(text: string): string | undefined {
  for (const { re, label } of ERROR_TYPE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (label) return label;
    if (m[1]) return m[1];
    if (m[2]) return m[2].split(/[\s:,]/)[0];
    return m[0].trim();
  }
  // 兜底：行内出现已知错误类型名
  const words = text.match(/[A-Za-z][A-Za-z0-9_.]*/g) ?? [];
  for (const w of words) {
    const base = w.split('.').pop() as string;
    if (KNOWN_ERROR_KINDS.has(base)) return base;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────
// 位置提取（文件:行）
// ─────────────────────────────────────────────────────────────

const FILE_LINE_RES =
  // TS 编译：file.ts(12,5): error TS2307
  /([\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|java|rs|rb|vue|svelte|css|scss|json))\((\d+)(?:,\d+)?\)/g;
const COLON_LINE_RES =
  // file.ts:12:5 / C:\path\file.ts:12 / /abs/path/file.py:12
  /((?:[A-Za-z]:[\\/]|\/)?[\w@./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|java|rs|rb|vue|svelte|css|scss|json)):(\d+)(?::\d+)?/g;
const PY_TRACEBACK_RES =
  // File "C:\x\y.py", line 12, in func
  /File "([^"]+)", line (\d+)/g;

/** 路径净化：反斜杠→正斜杠，保留盘符/绝对路径（交上层 candidate_locator 做项目根归一化） */
function sanitizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export function extractLocations(symptom: string): Array<{ file: string; line?: number }> {
  const out: Array<{ file: string; line?: number }> = [];
  const seen = new Set<string>();
  const push = (file: string, line?: number): void => {
    const key = `${file}:${line ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, line });
  };

  let m: RegExpExecArray | null;
  FILE_LINE_RES.lastIndex = 0;
  while ((m = FILE_LINE_RES.exec(symptom)) !== null) push(sanitizePath(m[1]), Number(m[2]));

  PY_TRACEBACK_RES.lastIndex = 0;
  while ((m = PY_TRACEBACK_RES.exec(symptom)) !== null) push(sanitizePath(m[1]), Number(m[2]));

  COLON_LINE_RES.lastIndex = 0;
  while ((m = COLON_LINE_RES.exec(symptom)) !== null) push(sanitizePath(m[1]), Number(m[2]));

  return out;
}

// ─────────────────────────────────────────────────────────────
// 符号提取
// ─────────────────────────────────────────────────────────────

const READING_RES = /reading\s+'([A-Za-z_$][\w$]*)'/g;
const NOT_FUNCTION_RES = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not a function/g;
const NOT_DEFINED_RES = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not defined/g;
const NOT_CONSTRUCTOR_RES = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not a constructor/g;
const STACK_AT_RES = /at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+\(/g;
const PY_IN_RES = /,\s+in\s+([A-Za-z_$][\w$]*)/g;

export function extractSymbols(symptom: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    if (s.length < 2) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };

  let m: RegExpExecArray | null;
  const run = (re: RegExp, pick: (mm: RegExpExecArray) => string) => {
    re.lastIndex = 0;
    while ((m = re.exec(symptom)) !== null) push(pick(m));
  };
  run(READING_RES, (mm) => mm[1]);
  run(NOT_FUNCTION_RES, (mm) => mm[1]);
  run(NOT_DEFINED_RES, (mm) => mm[1]);
  run(NOT_CONSTRUCTOR_RES, (mm) => mm[1]);
  run(STACK_AT_RES, (mm) => mm[1]);
  run(PY_IN_RES, (mm) => mm[1]);
  return out;
}

// ─────────────────────────────────────────────────────────────
// 关键词（去停用词分词）
// ─────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'in', 'on',
  'at', 'to', 'for', 'with', 'from', 'by', 'as', 'that', 'this', 'these', 'those', 'and',
  'or', 'but', 'not', 'no', 'so', 'if', 'then', 'else', 'when', 'while', 'it', 'its',
  'you', 'your', 'my', 'our', 'their', 'has', 'have', 'had', 'do', 'does', 'did', 'can',
  'could', 'should', 'would', 'will', 'may', 'might', 'must', 'error', 'errors', 'failed',
  'failure', 'expected', 'actual', 'received', 'line', 'at', 'test', 'tests', 'file',
  'files', 'expect', 'got', 'type', 'undefined', 'null', 'true', 'false', 'function',
  'module', 'export', 'import', 'class', 'value', 'property', 'cannot', 'read', 'find',
  'resolve', 'calling', 'called', 'call', 'throw', 'thrown', 'stack', 'trace', 'runtime',
  'exception', 'panic', 'panic:', 'assert', 'assertion', 'equal', 'tobe', 'match',
  'expected:', 'actual:', 'cannot', 'reading', 'there', 'than', 'into', 'over', 'under',
]);

/** 绝对路径/URL 的噪声剥离——但只剥目录，保留文件名（basename）：
 *  若把整段路径抹成空格，文件名（如 agent_demo.mjs 里的 agent_demo）这个最强
 *  线索会一起丢失（"哪个文件出错"恰恰是最有用的搜索目标）。
 *  做法：命中段替换为其 basename（去扩展名），目录组成词随之消失，避免污染 FTS
 *  符号匹配（曾把症状路径 "Microsoft Edge" 的 Edge 误匹配成符号）。
 *
 *  三类匹配：
 *   - 文件类绝对路径（盘符 / POSIX / file:///）：允许内部空格，以已知源码扩展名结尾
 *   - file:// URL：无扩展名门槛（cache.db 之类也剥），允许内部空格（之前 [^\s…] 遇空格就断）
 *   - http(s) URL：无空格，剥到 query 之前 */
const ABS_FILE_RES =
  /(?:[A-Za-z]:[\\/]|file:\/\/\/|\/(?!\/))(?:[^，。；：\s""''（）()<>'"]+(?:[ ][^，。；：\s""''（）()<>'"]+)*)\.(?:ts|tsx|js|jsx|mjs|cjs|go|py|java|rs|rb|vue|svelte|css|scss|json)\b/gi;
const FILE_URL_RES = /file:\/\/[^，。；：\s""''（）()<>'"]+(?:[ ][^，。；：\s""''（）()<>'"]+)*/gi;
const HTTP_URL_RES = /https?:\/\/[^，。；：\s""''（）()<>'"]+/gi;

/** 取命中串的 basename：去扩展名 / query / 尾部标点；空则返回空格占位 */
function basenameOf(matched: string): string {
  const segs = matched.split(/[\\/]+/);
  let base = segs[segs.length - 1] ?? '';
  base = base.split(/[?#]/)[0].replace(/\.[A-Za-z0-9]+$/, '');
  base = base.replace(/[，。；：""''()<>'"]+$/, '');
  return base || ' ';
}

function stripAbsPaths(symptom: string): string {
  return symptom
    .replace(ABS_FILE_RES, basenameOf)
    .replace(FILE_URL_RES, basenameOf)
    .replace(HTTP_URL_RES, basenameOf);
}

/** 分词：保留 标识符 / 数字 / 中文词，去停用词与单字符，长度≥2 */
export function extractKeywords(symptom: string): string[] {
  const cleaned = stripAbsPaths(symptom);
  const tokens = cleaned.match(/[A-Za-z_$][\w$]*|[\u4e00-\u9fa5]{2,}|\d{2,}/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (key.length < 2) continue; // 单字符（x/y/z）对符号检索是噪声
    if (STOPWORDS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 总入口
// ─────────────────────────────────────────────────────────────

export function parseSymptom(symptom: string): SymptomParsed {
  const text = (symptom ?? '').trim();
  return {
    error_type: detectErrorType(text),
    locations: extractLocations(text),
    symbols: extractSymbols(text),
    keywords: extractKeywords(text),
  };
}
