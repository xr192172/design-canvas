/**
 * 设计一致性检查器
 *
 * 对比 DSL 定义的 expected_apis 与实际代码中的 API 实现，自动检测不一致。
 *
 * 功能：
 *   1. 解析实际代码文件中的函数/方法签名（支持 Go/TypeScript/Python/JavaScript）
 *   2. 对比 DSL 中定义的 expected_apis
 *   3. 生成差异报告：
 *      - ✅ 已实现（green）：expected 与 actual 匹配
 *      - ❌ 缺失（red）：expected 中有，但代码中没有
 *      - ⚠️ 签名不匹配（yellow）：函数存在但参数/返回值不一致
 *      - 🆕 代码新增（blue）：代码中有，但 DSL expected_apis 中没有
 *   4. 支持注释标记定位（<!-- design-canvas:node_id -->）
 *   5. 验证跨文件不变式（multi_file_invariants）
 *
 * 与 backfill_scaffold 的区别：
 *   - backfill_scaffold：从代码提取 actual_apis 回写到 DSL
 *   - consistency：只读检查，生成报告，不修改 DSL
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL, SemanticFile } from '../dsl/types.js';
import { getDSL } from '../storage.js';
import { parseFileSymbols, ParsedSymbol, isSupportedFile } from './ast_parser.js';

export interface ConsistencyResult {
  message: string;
  fileResults: FileConsistency[];
  invariantResults: InvariantResult[];
  summary: {
    total_files: number;
    matched: number;
    missing: number;
    mismatched: number;
    unexpected: number;
    invariant_passed: number;
    invariant_failed: number;
  };
}

export interface FileConsistency {
  file: SemanticFile;
  file_path: string;
  exists: boolean;
  apis: ApiMatch[];
}

export interface ApiMatch {
  expected_signature: string;
  expected_notes?: string;
  actual_signature?: string;
  actual_location?: string;
  status: 'matched' | 'missing' | 'mismatched' | 'unexpected';
  match_score: number;
  reason?: string;
}

export interface InvariantResult {
  invariant: string;
  status: 'passed' | 'failed';
  reason?: string;
}

export interface ConsistencyInput {
  feature: string;
  /** 代码根目录，默认 <cwd>/scaffold/<feature>/ */
  code_dir?: string;
}

// ─────────────────────────────────────────────────────────────
// 代码解析器（已迁移到 ast_parser.ts，使用 tree-sitter）
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// API 匹配算法
// ─────────────────────────────────────────────────────────────

interface ParsedApi {
  signature: string;
  name: string;
  start_line: number;
  end_line?: number;
  kind: string;
}

function extractFuncName(sig: string): string {
  const match = sig.match(/(?:func\s+)?(?:\([^)]+\)\s+)?(\w+)\s*[\(\<]/);
  return match ? match[1] : sig.split(/\s*\(/)[0];
}

function normalizeSignature(sig: string): string {
  return sig.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * 按顶层逗号切分参数列表（跳过 ()[]{}<> 嵌套）。
 * 避免把对象字面量 {file, symbol?, ...} 或泛型 Record<string, ...> 里的逗号误当成参数分隔符。
 */
function splitTopLevelArgs(argsStr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of argsStr) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** 参数名：从 'name: type' / 'name = default' / '?name' / 裸 'name' 中提取标识符 */
function argName(arg: string): string {
  const m = arg.trim().match(/^[?]?\s*([\w$]+)/);
  return m ? m[1] : arg.trim();
}

function compareSignatures(expected: string, actual: string): { score: number; reason?: string } {
  const expectedName = extractFuncName(expected);
  const actualName = extractFuncName(actual);

  if (expectedName !== actualName) {
    return { score: 0, reason: '函数名不匹配' };
  }

  const expectedNorm = normalizeSignature(expected);
  const actualNorm = normalizeSignature(actual);

  if (expectedNorm === actualNorm) {
    return { score: 100 };
  }

  const expectedArgs = expected.match(/\(([^)]*)\)/)?.[1] || '';
  const actualArgs = actual.match(/\(([^)]*)\)/)?.[1] || '';
  const expectedArgList = splitTopLevelArgs(expectedArgs);
  const actualArgList = splitTopLevelArgs(actualArgs);

  if (expectedArgList.length !== actualArgList.length) {
    return { score: 70, reason: `参数数量不匹配：期望 ${expectedArgList.length} 个，实际 ${actualArgList.length} 个` };
  }

  // 参数名对齐：语义契约的形参名应与实现一致（如都叫 args）
  const expNames = expectedArgList.map(argName);
  const actNames = actualArgList.map(argName);
  const nameAligned = expNames.every((n, i) => n === actNames[i]);

  if (nameAligned) {
    // 对象形参契约：期望为对象字面量时，实现应为对象/Record/任意，而非标量
    const expHasObj = /:\s*\{/.test(expectedArgs);
    const actIsObj = /:\s*(\{\s*\}|\{\s*\[|Record\s*<|object)/i.test(actualArgs);
    if (expHasObj && !actIsObj) {
      return { score: 80, reason: `形参类型不匹配：期望对象形参，实际 ${actualArgs}` };
    }

    // 返回类型：仅当两侧都是具体类型（不含语义省略号 ...）时才严格比对
    const expectedRet = expected.split(')')[1]?.trim() || '';
    const actualRet = actual.split(')')[1]?.trim() || '';
    const expConcrete = !!expectedRet && !expectedRet.includes('...');
    const actConcrete = !!actualRet && !actualRet.includes('...');
    const retCompatible =
      !expConcrete ||
      !actConcrete ||
      expectedRet.toLowerCase().includes(actualRet.toLowerCase()) ||
      actualRet.toLowerCase().includes(expectedRet.toLowerCase());
    if (!retCompatible) {
      return { score: 80, reason: `返回类型不匹配：期望 ${expectedRet}，实际 ${actualRet}` };
    }

    // 参数名一致且返回兼容 → 契约满足（即使类型措辞不同）
    return { score: 100 };
  }

  return { score: 90, reason: '签名不完全一致' };
}

// ─────────────────────────────────────────────────────────────
// 不变式验证
// ─────────────────────────────────────────────────────────────

function checkInvariants(dsl: DesignDSL, codeDir: string): InvariantResult[] {
  const results: InvariantResult[] = [];
  const invariants = dsl.semantic?.multi_file_invariants || [];

  for (const invariant of invariants) {
    let passed = true;
    let reason: string | undefined;

    const fileRefMatch = invariant.match(/file:([^\s]+)/);
    if (fileRefMatch) {
      const filePath = path.join(codeDir, fileRefMatch[1]);
      if (!fs.existsSync(filePath)) {
        passed = false;
        reason = `文件不存在: ${filePath}`;
      }
    }

    const funcRefMatch = invariant.match(/func:([^\s]+)/);
    if (funcRefMatch && passed) {
      const funcName = funcRefMatch[1];
      let found = false;
      for (const file of dsl.semantic?.files || []) {
        const fullPath = path.join(codeDir, file.path);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes(funcName)) {
            found = true;
            break;
          }
        }
      }
      if (!found) {
        passed = false;
        reason = `函数不存在: ${funcName}`;
      }
    }

    results.push({
      invariant,
      status: passed ? 'passed' : 'failed',
      reason,
    });
  }

  return results;
}

// ─────────────────────────────────────────────────────────────
// 主函数
// ─────────────────────────────────────────────────────────────

export async function checkConsistency(input: ConsistencyInput): Promise<ConsistencyResult> {
  const { feature, code_dir } = input;

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  if (!dsl.semantic || !dsl.semantic.files || dsl.semantic.files.length === 0) {
    throw new Error(`feature "${feature}" 没有 semantic.files，无法检查一致性`);
  }

  const codeDir = code_dir
    ? path.resolve(code_dir)
    : path.join(process.cwd(), 'scaffold', feature);

  const fileResults: FileConsistency[] = [];
  let matchedCount = 0;
  let missingCount = 0;
  let mismatchedCount = 0;
  let unexpectedCount = 0;

  for (const file of dsl.semantic.files) {
    const fullPath = path.join(codeDir, file.path);
    const exists = fs.existsSync(fullPath);

    const apiMatches: ApiMatch[] = [];
    const expectedApis = file.expected_apis || [];
    const actualApis: ParsedApi[] = [];

    if (exists) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (isSupportedFile(file.path)) {
        const symbols: ParsedSymbol[] = await parseFileSymbols(file.path, content);
        for (const s of symbols) {
          if (s.kind === 'function' || s.kind === 'method') {
            actualApis.push({
              signature: s.signature,
              name: s.name,
              start_line: s.start_line,
              end_line: s.end_line,
              kind: s.kind,
            });
          }
        }
      }
    }

    const matchedNames = new Set<string>();

    for (const expected of expectedApis) {
      const expectedName = extractFuncName(expected.signature);
      const actual = actualApis.find(a => a.name === expectedName);

      if (actual) {
        const comparison = compareSignatures(expected.signature, actual.signature);
        matchedNames.add(expectedName);

        if (comparison.score >= 90) {
          apiMatches.push({
            expected_signature: expected.signature,
            expected_notes: expected.notes,
            actual_signature: actual.signature,
            actual_location: `${file.path}:${actual.start_line}`,
            status: comparison.score === 100 ? 'matched' : 'mismatched',
            match_score: comparison.score,
            reason: comparison.reason,
          });
          if (comparison.score === 100) {
            matchedCount++;
          } else {
            mismatchedCount++;
          }
        } else {
          apiMatches.push({
            expected_signature: expected.signature,
            expected_notes: expected.notes,
            actual_signature: actual.signature,
            actual_location: `${file.path}:${actual.start_line}`,
            status: 'mismatched',
            match_score: comparison.score,
            reason: comparison.reason,
          });
          mismatchedCount++;
        }
      } else {
        apiMatches.push({
          expected_signature: expected.signature,
          expected_notes: expected.notes,
          status: 'missing',
          match_score: 0,
          reason: '代码中未找到该函数',
        });
        missingCount++;
      }
    }

    for (const actual of actualApis) {
      if (!matchedNames.has(actual.name)) {
        apiMatches.push({
          expected_signature: '',
          actual_signature: actual.signature,
          actual_location: `${file.path}:${actual.start_line}`,
          status: 'unexpected',
          match_score: 0,
          reason: 'DSL 中未定义此 API',
        });
        unexpectedCount++;
      }
    }

    fileResults.push({
      file,
      file_path: fullPath,
      exists,
      apis: apiMatches,
    });
  }

  const invariantResults = checkInvariants(dsl, codeDir);
  const invariantPassed = invariantResults.filter(r => r.status === 'passed').length;
  const invariantFailed = invariantResults.filter(r => r.status === 'failed').length;

  // 构建报告消息
  const lines: string[] = [];
  lines.push(`=== 设计一致性检查报告 - ${feature} ===`);
  lines.push('');
  lines.push('【摘要】');
  lines.push(`  文件数: ${fileResults.length}`);
  lines.push(`  ✅ 已实现: ${matchedCount}`);
  lines.push(`  ❌ 缺失: ${missingCount}`);
  lines.push(`  ⚠️ 签名不匹配: ${mismatchedCount}`);
  lines.push(`  🆕 代码新增: ${unexpectedCount}`);
  lines.push(`  不变式通过: ${invariantPassed}/${invariantResults.length}`);
  lines.push('');

  for (const fr of fileResults) {
    lines.push(`【文件】${fr.file.path}`);
    lines.push(`  状态: ${fr.exists ? '存在' : '❌ 不存在'}`);
    if (!fr.exists) continue;

    const matched = fr.apis.filter(a => a.status === 'matched');
    const missing = fr.apis.filter(a => a.status === 'missing');
    const mismatched = fr.apis.filter(a => a.status === 'mismatched');
    const unexpected = fr.apis.filter(a => a.status === 'unexpected');

    if (matched.length > 0) {
      lines.push(`  ✅ 已实现 (${matched.length}):`);
      for (const a of matched) {
        lines.push(`    - ${a.expected_signature}`);
      }
    }

    if (missing.length > 0) {
      lines.push(`  ❌ 缺失 (${missing.length}):`);
      for (const a of missing) {
        lines.push(`    - ${a.expected_signature}${a.expected_notes ? ' (' + a.expected_notes + ')' : ''}`);
      }
    }

    if (mismatched.length > 0) {
      lines.push(`  ⚠️ 签名不匹配 (${mismatched.length}):`);
      for (const a of mismatched) {
        lines.push(`    - 期望: ${a.expected_signature}`);
        lines.push(`      实际: ${a.actual_signature} (${a.actual_location})`);
        if (a.reason) lines.push(`      原因: ${a.reason}`);
      }
    }

    if (unexpected.length > 0) {
      lines.push(`  🆕 代码新增 (${unexpected.length}):`);
      for (const a of unexpected) {
        lines.push(`    - ${a.actual_signature} (${a.actual_location})`);
      }
    }

    lines.push('');
  }

  if (invariantResults.length > 0) {
    lines.push('【跨文件不变式】');
    for (const ir of invariantResults) {
      lines.push(`  ${ir.status === 'passed' ? '✅' : '❌'} ${ir.invariant}`);
      if (ir.reason) lines.push(`    原因: ${ir.reason}`);
    }
    lines.push('');
  }

  lines.push('【建议】');
  if (missingCount > 0) lines.push('  - 实现缺失的 API');
  if (mismatchedCount > 0) lines.push('  - 修正签名不匹配的函数');
  if (unexpectedCount > 0) lines.push('  - 考虑将代码新增的 API 添加到 DSL expected_apis');
  if (invariantFailed > 0) lines.push('  - 修复失败的不变式');
  lines.push('');

  return {
    message: lines.join('\n'),
    fileResults,
    invariantResults,
    summary: {
      total_files: fileResults.length,
      matched: matchedCount,
      missing: missingCount,
      mismatched: mismatchedCount,
      unexpected: unexpectedCount,
      invariant_passed: invariantPassed,
      invariant_failed: invariantFailed,
    },
  };
}
