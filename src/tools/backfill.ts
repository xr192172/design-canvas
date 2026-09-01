/**
 * backfill 工具实现
 *
 * 代码回填 scaffold：LLM 写完代码后，自动解析实现文件中的 API 签名，
 * 更新到 DSL semantic.files[].actual_apis。
 *
 * 职责归属（对账语义，不跨界）：
 * - expected_apis：设计侧契约，只由设计流产生（import 设计模式 / scaffold /
 *   edit_dsl 决策 / 决策卡），backfill 一律不写、不覆盖
 * - actual_apis：实现侧事实，由 backfill / import 实际代码解析回填
 * - 报告区分「预期缺失」（expected 有 / actual 无）vs「实现新增」（actual 有 /
 *   expected 无），与 consistency 的 red/blue 语义一致
 *
 * 工作流：
 *   scaffold 生成骨架 → LLM 填充实现 → backfill_scaffold 解析实际代码 → DSL 更新
 *   → check_status 推断状态 → render_design 可视化差异
 *
 * 支持语言：.go / .ts / .py / .js（优先 tree-sitter AST，fallback 正则）
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, SemanticFile, ExpectedApi } from '../dsl/types.js';
import { getDSL, saveDSL } from '../storage.js';
import { parseFileSymbols, isSupportedFile } from './ast_parser.js';

export interface BackfillInput {
  /** feature 名 */
  feature: string;
  /** scaffold 输出根目录，默认 <cwd>/scaffold/<feature> */
  scaffold_dir?: string;
}

export interface BackfillUpdate {
  id: string;
  actual_count: number;
  expected_count: number;
  matched: string[];
  missing: string[];
  extra: string[];
}

export interface BackfillResult {
  message: string;
  feature: string;
  updates: BackfillUpdate[];
}

// ─────────────────────────────────────────────────────────────
// 语言推断
// ─────────────────────────────────────────────────────────────

type Lang = 'go' | 'ts' | 'py' | 'js' | 'unknown';

function detectLang(filePath: string): Lang {
  if (filePath.endsWith('.go')) return 'go';
  if (filePath.endsWith('.ts')) return 'ts';
  if (filePath.endsWith('.py')) return 'py';
  if (filePath.endsWith('.js')) return 'js';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────
// 提取函数名（用于对比 expected / actual）
// ─────────────────────────────────────────────────────────────

function extractFuncName(signature: string): string {
  const match = signature.match(/(?:\w+\.)?(\w+)\s*\(/);
  return match ? match[1] : signature;
}

// ─────────────────────────────────────────────────────────────
// 各语言解析器（正则 fallback，当 tree-sitter kernel 不可用时使用）
// ─────────────────────────────────────────────────────────────

function parseGo(content: string): ExpectedApi[] {
  const apis: ExpectedApi[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('func ')) continue;
    // func (r *Receiver) MethodName(args) returnType {
    // func FuncName(args) returnType {
    const match = line.match(
      /^func\s+(?:\(([^)]+)\)\s+)?(\w+)\s*\(([^)]*)\)(?:\s*(\S.*))?\s*\{/,
    );
    if (!match) continue;
    const [, receiver, name, args, ret] = match;
    let signature: string;
    if (receiver) {
      const receiverMatch = receiver.match(/(?:\*\s*)?(\w+)$/);
      const receiverType = receiverMatch ? receiverMatch[1] : receiver;
      signature = `${receiverType}.${name}(${args})${ret ? ' ' + ret.trim() : ''}`;
    } else {
      signature = `${name}(${args})${ret ? ' ' + ret.trim() : ''}`;
    }
    apis.push({ signature, notes: `line ${i + 1}` });
  }
  return apis;
}

function parseTsJs(content: string, _isTs: boolean): ExpectedApi[] {
  const apis: ExpectedApi[] = [];
  const lines = content.split('\n');
  let currentClass: string | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 追踪 class / 简单 brace depth
    const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
    if (classMatch) {
      currentClass = classMatch[1];
      braceDepth = 1; // 假设 class 行后面有 {
      continue;
    }

    if (currentClass) {
      braceDepth += (trimmed.match(/\{/g) || []).length;
      braceDepth -= (trimmed.match(/\}/g) || []).length;
      if (braceDepth <= 0) {
        currentClass = null;
        braceDepth = 0;
      }
    }

    // export async function name(args): returnType {
    // function name(args) {
    const funcMatch = trimmed.match(
      /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/,
    );
    if (funcMatch) {
      const [, name, args, ret] = funcMatch;
      const signature = ret ? `${name}(${args}): ${ret.trim()}` : `${name}(${args})`;
      apis.push({ signature, notes: `line ${i + 1}` });
      continue;
    }

    // class 内方法
    if (currentClass) {
      const methodMatch = trimmed.match(
        /^(?!if|while|for|switch|catch)(\w+)\s*\(([^)]*)\)(?:\s*:\s*([^{]+))?\s*\{/,
      );
      if (methodMatch) {
        const [, name, args, ret] = methodMatch;
        const signature = ret
          ? `${currentClass}.${name}(${args}): ${ret.trim()}`
          : `${currentClass}.${name}(${args})`;
        apis.push({ signature, notes: `line ${i + 1}` });
      }
    }
  }
  return apis;
}

function parsePy(content: string): ExpectedApi[] {
  const apis: ExpectedApi[] = [];
  const lines = content.split('\n');
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();

    // class ClassName:
    const classMatch = stripped.match(/^class\s+(\w+)(?:\([^)]*\)?:\s*|\s*:)/);
    if (classMatch) {
      currentClass = classMatch[1];
      continue;
    }

    // 结束 class（缩进回到全局级别）
    if (
      currentClass &&
      stripped.length > 0 &&
      !stripped.startsWith(' ') &&
      !stripped.startsWith('\t') &&
      !stripped.startsWith('#')
    ) {
      if (!stripped.startsWith('def ') && !stripped.startsWith('class ')) {
        currentClass = null;
      }
    }

    // def name(args) -> returnType:
    const defMatch = stripped.match(/^def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
    if (!defMatch) continue;
    let [, name, args, ret] = defMatch;
    if (args.startsWith('self')) {
      args = args.replace(/^self\s*,?\s*/, '');
    }
    let signature: string;
    if (currentClass) {
      signature = ret
        ? `${currentClass}.${name}(${args}) -> ${ret.trim()}`
        : `${currentClass}.${name}(${args})`;
    } else {
      signature = ret ? `${name}(${args}) -> ${ret.trim()}` : `${name}(${args})`;
    }
    apis.push({ signature, notes: `line ${i + 1}` });
  }
  return apis;
}

async function parseFile(filePath: string): Promise<ExpectedApi[]> {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');

  // 优先用 ts_kernel（tree-sitter AST）解析
  if (isSupportedFile(filePath)) {
    try {
      const symbols = await parseFileSymbols(filePath, content);
      if (symbols.length > 0) {
        return symbols
          .filter((s) => s.kind === 'function' || s.kind === 'method')
          .map((s) => {
            let sig = s.signature;
            // TS/JS/Python 方法名加上 parent 前缀（kernel signature 不包含）
            if (
              (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.py')) &&
              s.parent &&
              !sig.includes(`${s.parent}.`)
            ) {
              sig = `${s.parent}.${sig}`;
            }
            return {
              signature: sig,
              notes: `line ${s.start_line}`,
            };
          });
      }
    } catch {
      // kernel 解析失败，回退到正则
    }
  }

  // fallback：正则轻量解析
  const lang = detectLang(filePath);
  switch (lang) {
    case 'go':
      return parseGo(content);
    case 'ts':
      return parseTsJs(content, true);
    case 'js':
      return parseTsJs(content, false);
    case 'py':
      return parsePy(content);
    default:
      return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────

export async function backfillScaffold(input: BackfillInput): Promise<BackfillResult> {
  const { feature, scaffold_dir } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在，请先使用 create_feature 或 render_design 创建`);
  }
  if (!dsl.semantic || !dsl.semantic.files || dsl.semantic.files.length === 0) {
    throw new Error(`feature "${feature}" 没有 semantic.files，无法回填代码`);
  }

  const baseDir = scaffold_dir
    ? path.resolve(scaffold_dir)
    : path.join(process.cwd(), 'scaffold', feature);

  const updates: BackfillUpdate[] = [];

  for (const file of dsl.semantic.files) {
    const fullPath = path.join(baseDir, file.path);
    const actualApis = await parseFile(fullPath);

    const expectedNames = new Set((file.expected_apis || []).map((a) => extractFuncName(a.signature)));
    const actualNames = new Set(actualApis.map((a) => extractFuncName(a.signature)));

    const matched = [...expectedNames].filter((n) => actualNames.has(n));
    const missing = [...expectedNames].filter((n) => !actualNames.has(n));
    const extra = [...actualNames].filter((n) => !expectedNames.has(n));

    file.actual_apis = actualApis;

    updates.push({
      id: file.id,
      actual_count: actualApis.length,
      expected_count: expectedNames.size,
      matched,
      missing,
      extra,
    });
  }

  saveDSL(dsl);

  const lines = [
    `代码回填完成：feature "${feature}"`,
    '',
    '各文件对比结果：',
    ...updates.flatMap((u) => [
      `  ${u.id}: 期望 ${u.expected_count} 个 API，实际 ${u.actual_count} 个`,
      `    已实现: ${u.matched.length}${u.matched.length > 0 ? ' (' + u.matched.join(', ') + ')' : ''}`,
      `    未实现: ${u.missing.length}${u.missing.length > 0 ? ' (' + u.missing.join(', ') + ')' : ''}`,
      `    新增  : ${u.extra.length}${u.extra.length > 0 ? ' (' + u.extra.join(', ') + ')' : ''}`,
    ]),
    '',
    'DSL 已更新，actual_apis 已回填。调用 render_design 重新渲染可查看差异。',
  ];

  return {
    message: lines.join('\n'),
    feature,
    updates,
  };
}
