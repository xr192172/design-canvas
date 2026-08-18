/**
 * edit_code：符号级语义编辑（Agent 第一性编辑路径）
 *
 * 设计动机（2026-08-18 狗食结论）：AI 用 old_string 文本匹配改代码，
 * 行号漂移 / 同名函数 / 相似代码块都会改错位置。既然 ts_kernel 已能
 * 定位"哪个文件、哪个函数、第几行、什么签名"，编辑也应按符号定位：
 * AI 只给 文件 + 符号名 + 新代码，工具重新解析当前文件、按 AST 符号
 * 边界替换——不信 AI 的行号，不信 AI 的 old_string。
 *
 * 安全设计：
 * - 替换后 re-parse 整个文件，解析失败 → 报错不写盘（防缩进/括号破坏）
 * - replace 的新代码必须解析出同名符号（防粘贴错函数）
 * - 同名多候选 → 报错列出候选（签名+行号），AI 传 parent 消歧后重试
 * - 写盘后自动 syncFile 重建该文件索引（新鲜度闭环：编辑即索引更新）
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseFileFull, parseAstRoot, type ParsedSymbol } from './ts_kernel/index.js';
import { syncFile } from '../db/symbols.js';
import { getProjectCacheDb } from '../db/db.js';

export type EditCodeOp = 'replace' | 'insert' | 'delete';

export interface EditCodeArgs {
  /** 项目根目录（索引归属，编辑后重建该文件的 cache.db 索引） */
  project_dir: string;
  /** 目标文件（相对 project_dir 或绝对路径） */
  file: string;
  op: EditCodeOp;
  /**
   * 目标符号。replace/delete：按 qualified_name 优先、短名兜底匹配；
   * insert：插入到该符号之后（缺省 = 文件末尾）。
   * Go 方法用短名 + parent（receiver 类型）消歧。
   */
  symbol?: string;
  /** 符号父级（类名 / Go receiver 类型名），同名消歧用 */
  parent?: string;
  /** replace/insert 的新代码（完整符号定义；delete 不需要） */
  code?: string;
}

interface LineOp {
  startIdx: number; // 0-based 半开区间起点
  count: number; // 删除行数
  insert: string[]; // 插入行（含终止符）
}

/** 按行分割并保留每行的终止符 */
function splitKeepEnds(content: string): string[] {
  const lines = content.split(/(?<=\n)/);
  // 末尾无换行时最后元素是残段；有换行时最后元素是 ''——去掉空尾
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function detectEol(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/** 新代码规范化为文件行尾风格，每行带终止符 */
function normalizeCode(code: string, eol: string): string[] {
  const normalized = code.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  // 结尾空元素（code 以 \n 结尾产生）丢弃——由调用方决定是否补空行
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l, i) => (i < parts.length - 1 ? l + eol : l + eol));
}

function isBlankLine(line: string): boolean {
  return line.trim() === '' || line === '';
}

/**
 * 语法错误门：tree-sitter 是容错解析器，语法破坏不抛错、只置 rootNode.hasError。
 * 编辑后 hasError 由 false→true（新引入语法错误）→ 拒绝；
 * 原本就有错的文件（true→true）放行但提示，给 AI 顺手修复的机会（true→false 正常放行）。
 */
async function hasSyntaxError(filePath: string, content: string): Promise<boolean> {
  const ast = await parseAstRoot(filePath, content);
  return ast?.root.hasError === true;
}

/** 符号匹配：qualified_name 精确 > name 精确；parent 提供时必须相等 */
function matchSymbols(symbols: ParsedSymbol[], symbol: string, parent?: string): {
  qnHits: ParsedSymbol[];
  nameHits: ParsedSymbol[];
} {
  const qnHits = symbols.filter(
    (s) => s.qualified_name === symbol && (!parent || s.parent === parent),
  );
  const nameHits = symbols.filter(
    (s) => s.name === symbol && (!parent || s.parent === parent),
  );
  return { qnHits, nameHits };
}

function describeSymbol(s: ParsedSymbol): string {
  return `${s.qualified_name} (${s.kind}, ${s.signature || s.name}, L${s.start_line}-${s.end_line}${s.parent ? `, parent=${s.parent}` : ''})`;
}

/** 压缩连续 ≥2 空行为 1 空行（delete 后清理） */
function squeezeBlankRuns(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (isBlankLine(l) && out.length > 0 && isBlankLine(out[out.length - 1])) continue;
    out.push(l);
  }
  return out;
}

export async function editCode(args: EditCodeArgs): Promise<{ message: string }> {
  const { op } = args;
  const projectRoot = path.resolve(args.project_dir);
  const absPath = path.isAbsolute(args.file) ? args.file : path.resolve(projectRoot, args.file);
  const relPath = path.relative(projectRoot, absPath).split(path.sep).join('/');

  if ((op === 'replace' || op === 'delete') && !args.symbol) {
    throw new Error(`${op} 需要 symbol（目标符号名或 qualified_name）`);
  }
  if (op === 'replace' || op === 'insert') {
    if (!args.code || !args.code.trim()) throw new Error(`${op} 需要 code（新代码）`);
  }

  const fileExists = fs.existsSync(absPath);
  if (!fileExists && op !== 'insert') {
    throw new Error(`文件不存在: ${absPath}（insert 可创建新文件，replace/delete 不行）`);
  }

  // ── insert 新文件：直接写入 + 索引 ──
  if (!fileExists && op === 'insert') {
    const eol = '\n';
    const lines = normalizeCode(args.code!, eol);
    const content = lines.join('');
    const reparsed = await parseFileFull(absPath, content);
    if (reparsed.error) throw new Error(`新文件内容解析失败（不写盘）: ${reparsed.error}`);
    if (await hasSyntaxError(absPath, content)) {
      throw new Error('新文件内容含语法错误（hasError=true，不写盘）。请检查 code 的括号/缩进/引号。');
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    const sync = await syncFile(getProjectCacheDb(projectRoot), projectRoot, absPath);
    return {
      message:
        `✓ 已创建 ${relPath}（${reparsed.symbols.length} 符号）并重建索引（${sync.status}）\n` +
        reparsed.symbols.map((s) => `  + ${describeSymbol(s)}`).join('\n'),
    };
  }

  const original = fs.readFileSync(absPath, 'utf8');
  const eol = detectEol(original);
  const lines = splitKeepEnds(original);
  const parsed = await parseFileFull(absPath, original);
  if (parsed.error) throw new Error(`目标文件当前就解析失败（先修文件再编辑）: ${parsed.error}`);
  const baselineHasError = await hasSyntaxError(absPath, original);

  let lineOp: LineOp;

  if (op === 'insert') {
    const codeLines = normalizeCode(args.code!, eol);
    let at: number; // 插入点（行索引，该行之前插）
    if (args.symbol) {
      const { qnHits, nameHits } = matchSymbols(parsed.symbols, args.symbol, args.parent);
      const hits = qnHits.length > 0 ? qnHits : nameHits;
      if (hits.length === 0) {
        throw new Error(
          `插入锚点符号未找到: ${args.symbol}。文件符号:\n` +
            parsed.symbols.map((s) => `  ${describeSymbol(s)}`).join('\n'),
        );
      }
      if (hits.length > 1) {
        throw new Error(
          `插入锚点不唯一（${hits.length} 候选），传 parent 消歧:\n` +
            hits.map((s) => `  ${describeSymbol(s)}`).join('\n'),
        );
      }
      at = hits[0].end_line; // 符号最后一行的下一行
    } else {
      at = lines.length; // 文件末尾
    }
    // 插入块前后保证空行分隔（Go/TS 函数间无空行会破坏可读性甚至编译）
    const block: string[] = [];
    if (at > 0 && !isBlankLine(lines[at - 1] ?? '')) block.push(eol);
    block.push(...codeLines);
    if (!isBlankLine(lines[at] ?? '')) block.push(eol);
    lineOp = { startIdx: at, count: 0, insert: block };
  } else {
    // replace / delete：定位目标符号
    const { qnHits, nameHits } = matchSymbols(parsed.symbols, args.symbol!, args.parent);
    let hits = qnHits.length > 0 ? qnHits : nameHits;
    if (hits.length === 0 && args.parent) {
      // parent 消歧失败时提示无 parent 的命中
      const { qnHits: q2, nameHits: n2 } = matchSymbols(parsed.symbols, args.symbol!);
      const alt = [...qnHits, ...nameHits, ...q2, ...n2];
      if (alt.length > 0) {
        throw new Error(
          `symbol=${args.symbol} + parent=${args.parent} 无命中，但去掉 parent 有 ${alt.length} 候选:\n` +
            alt.map((s) => `  ${describeSymbol(s)}`).join('\n'),
        );
      }
    }
    if (hits.length === 0) {
      throw new Error(
        `符号未找到: ${args.symbol}。文件符号:\n` +
          parsed.symbols.map((s) => `  ${describeSymbol(s)}`).join('\n'),
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `符号不唯一（${hits.length} 候选），传 parent 消歧:\n` +
          hits.map((s) => `  ${describeSymbol(s)}`).join('\n'),
      );
    }
    const target = hits[0];
    const startIdx = target.start_line - 1;
    const count = target.end_line - target.start_line + 1;
    lineOp = {
      startIdx,
      count,
      insert: op === 'delete' ? [] : normalizeCode(args.code!, eol),
    };
  }

  // ── 应用行操作 ──
  const newLines = [...lines];
  newLines.splice(lineOp.startIdx, lineOp.count, ...lineOp.insert);
  let newContent = newLines.join('');
  if (op === 'delete') {
    newContent = squeezeBlankRuns(splitKeepEnds(newContent)).join('');
    if (newContent && !newContent.endsWith(eol)) newContent += eol;
  }

  // ── 安全校验：re-parse，失败不写盘 ──
  const reparsed = await parseFileFull(absPath, newContent);
  if (reparsed.error) {
    throw new Error(
      `编辑后文件解析失败，已放弃（未写盘）: ${reparsed.error}\n` +
        '常见原因：新代码缩进/括号不完整、class 方法缩进层级错。请检查 code 后重试。',
    );
  }
  const afterHasError = await hasSyntaxError(absPath, newContent);
  const syntaxRepaired = baselineHasError && !afterHasError;
  if (!baselineHasError && afterHasError) {
    throw new Error(
      '编辑引入了语法错误（hasError false→true），已放弃（未写盘）。\n' +
        '常见原因：新代码括号/引号不闭合、缩进层级错、Go 少了 return。请检查 code 后重试。',
    );
  }
  if (op === 'replace') {
    const newName = reparsed.symbols.some(
      (s) => s.qualified_name === args.symbol || s.name === args.symbol ||
        (args.parent && s.name === args.symbol && s.parent === args.parent),
    );
    if (!newName) {
      throw new Error(
        `替换后未找到同名符号 ${args.symbol}（疑似粘贴了别的函数），已放弃（未写盘）。\n` +
          '新代码解析出的符号:\n' +
          reparsed.symbols.map((s) => `  ${describeSymbol(s)}`).join('\n'),
      );
    }
  }

  // ── 写盘 + 索引重建（新鲜度闭环） ──
  fs.writeFileSync(absPath, newContent, 'utf8');
  const sync = await syncFile(getProjectCacheDb(projectRoot), projectRoot, absPath);

  const before = parsed.symbols.length;
  const after = reparsed.symbols.length;
  const diffNote =
    sync.symbol_diff
      ? `（符号 diff: +${sync.symbol_diff.added} -${sync.symbol_diff.removed} ~${sync.symbol_diff.changed}）`
      : '';
  const repairNote = syntaxRepaired ? '（顺手修复了原文件的语法错误 ✓）' : '';

  if (op === 'delete') {
    const delSym = args.symbol!;
    return {
      message:
        `✓ 已删除 ${relPath} 的 ${delSym}（L${lineOp.startIdx + 1} 起 ${lineOp.count} 行），` +
        `符号 ${before} → ${after}，索引已重建（${sync.status}）${diffNote}${repairNote}`,
    };
  }
  if (op === 'insert') {
    const anchor = args.symbol ? `（锚点 ${args.symbol} 之后）` : '（文件末尾）';
    return {
      message:
        `✓ 已插入 ${relPath}${anchor}，符号 ${before} → ${after}，索引已重建（${sync.status}）${diffNote}\n` +
        `新符号:\n` + reparsed.symbols
          .filter((s) => !parsed.symbols.some((o) => o.qualified_name === s.qualified_name && o.start_line === s.start_line))
          .map((s) => `  + ${describeSymbol(s)}`)
          .join('\n'),
    };
  }
  return {
    message:
      `✓ 已替换 ${relPath} 的 ${args.symbol}（原 L${lineOp.startIdx + 1}-${lineOp.startIdx + lineOp.count}，` +
      `${lineOp.count} 行 → ${lineOp.insert.length} 行），索引已重建（${sync.status}）${diffNote}\n` +
      `文件符号: ${before} → ${after}`,
  };
}
