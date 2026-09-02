/**
 * rename_file —— 文件级智能重命名（防文件悬空）
 *
 * 目标：把"改一个文件的名字（或移动/重命名路径）"做成全仓一致的安全操作。
 * 三步走：算影响面 → 迁移文件 → 自动改写全项目 import/require 引用表并重索引。
 *
 * 复用规范基建（不自己造轮子）：
 *   - resolveImportTarget（db/symbols）判定 import 规范字是否真正解析到被移动文件
 *   - removeFile / syncFile（db/symbols）完成被移动文件及改写文件的索引重建
 *   - parseAstRoot（ts_kernel/kernel）定位 import 源字面量的字节偏移，避免正则误改注释/字符串
 *
 * 保守边界（宁漏不误，与 rename_symbol 同源）：
 *   - 只改写"被移动文件的相对导入"；包名引用 / 解析不到旧文件的引用不碰。
 *   - 一旦目标路径已存在 → 原子阻断，什么都不落盘。
 *   - dry_run 只出影响面报告，不迁移、不改写、不重索引。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { parseAstRoot, type SyntaxNodeLike } from './ts_kernel/kernel.js';
import { resolveImportTarget, syncFile, removeFile } from '../db/symbols.js';
import { getProjectCacheDb, closeProjectCacheDb } from '../db/db.js';
import { createProtectGuard } from './protect.js';

// 扫描范围内源码扩展名：TS 系全量 + Python（相对导入语义与 TS 同构，复用同一相对路径重算逻辑）。
// Go 的 import 是模块包路径（非相对文件路径），移动单文件不改变途径名 → 不纳入扫描。
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.py']);

function walkProjectFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === '.git' || e.name.startsWith('.')) continue;
      walkProjectFiles(p, out);
    } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name))) {
      out.push(p);
    }
  }
}

interface RefEdit {
  importerRel: string;
  importerAbs: string;
  source: string;      // 旧规范字（不带引号）
  toSource: string;    // 新规范字（不带引号）
  pos: number;         // 该字面量在文件内的字节偏移
  len: number;         // 整个 string 节点长度（含引号）
  quote: string;       // 原引用用的引号字符
}

export interface RenameFileInput {
  project_dir: string;
  /** 源文件：相对 project_dir 或绝对路径 */
  from: string;
  /** 目标文件：相对 project_dir 或绝对路径 */
  to: string;
  /** true = 只算影响面，不迁移/不改写/不重索引 */
  dry_run?: boolean;
}

export interface RenameFileResult {
  ok: boolean;
  dryRun: boolean;
  fromRel: string;
  toRel: string;
  moved: boolean;
  /** 逐引用更新明细 */
  references: Array<{ file: string; fromSource: string; toSource: string }>;
  editCount: number;
  /** 无法自动处理、需人工确认的事项（语义变化等） */
  pending: string[];
  blocked?: string[];
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/').split('\\').join('/');
}

/** 被移动文件 → 对某个 importer 的新规范字（保留老引用的扩展名风格） */
function newSpecifier(importerRel: string, oldSource: string, newRelNoExt: string): string {
  const dir = path.posix.dirname(importerRel);
  let rel = path.posix.relative(dir, newRelNoExt);
  if (!rel || rel === '.') rel = '';
  rel = rel.split('\\').join('/');
  if (rel && !rel.startsWith('.')) rel = './' + rel;
  // 保留扩展名风格：老写法带扩展名 → 新写法也带扩展名（如 NodeNext 的 .js 引 .ts）
  const m = oldSource.match(/\.([A-Za-z0-9]+)$/);
  if (m && !rel.endsWith('.' + m[1])) rel += '.' + m[1];
  return rel || '.';
}

/**
 * Python 相对导入解析：
 *   `from .foo import x` → 当前文件目录下的 foo.py
 *   `from ..src.foo import x` → 上一级目录下的 src/foo.py（前导点数量 = 向上爬的层数）
 *   `from . import x` → 当前文件目录这个包本身（__init__.py）
 * 返回值是项目内相对文件路径（含 .py 尾缀），解析不到返回 null。
 */
function resolvePythonTarget(projectRoot: string, fromRel: string, source: string): string | null {
  let dots = 0;
  while (dots < source.length && source[dots] === '.') dots++;
  const rest = source.slice(dots); // ''（纯包）或 'a.b.c'
  let baseDir = path.posix.dirname(fromRel);
  // 前导点数：`from .x` 停在当前包目录；`from ..x` 上溯 1 层 → 爬升 = dots - 1
  for (let i = 1; i < dots; i++) {
    const up = path.posix.dirname(baseDir);
    if (up === baseDir) return null; // 已到项目根仍要上溯 → 逃逸，拒绝
    baseDir = up;
  }
  let base: string;
  if (rest) base = path.posix.join(baseDir, rest.split('.').join('/'));
  else base = baseDir; // from . / from .. → 目录（包）本身
  const candidates = rest
    ? [base + '.py', `${base}/__init__.py`, `${base}/index.py`]
    : [`${base}/__init__.py`, `${base}/index.py`];
  for (const c of candidates) {
    if (c.startsWith('..')) continue; // 不允许逃逸项目根
    if (fs.existsSync(path.join(projectRoot, c))) return c;
  }
  return null;
}

/**
 * Python 相对导入新规范字：把移动后的文件相对位置转成前导点形式。
 *   同目录（src→src/bar.py 引 foo）    ：  .bar
 *   上一级目录（src/entry 引 sub/bar）  ：  ..sub.bar
 *   再上一级（sub/bar 引 src/helper）   ：  ..src.helper
 * 规律：从引者所在目录到目标路径的相对跳数 up 决定前导点 = up + 1。
 */
function newPySpecifier(importerRel: string, newRelNoExt: string): string {
  const dir = path.posix.dirname(importerRel);
  let rel = path.posix.relative(dir, newRelNoExt).split('\\').join('/');
  // 拆出向上跳数（..）
  let up = 0;
  while (rel.startsWith('../')) {
    up++;
    rel = rel.slice(3);
  }
  if (rel === '.' || rel === '') return '.'; // 引者自身目录这种退化情况
  const dots = '.'.repeat(up + 1);
  const modulePart = rel.split('/').join('.');
  return dots + modulePart;
}

/** 提取一个 import 语句源字面量（TS/JS）：返回 { text(含引号), inner, startIndex } 或 null */
function importSourceLiteral(node: SyntaxNodeLike): { startIndex: number; text: string; inner: string } | null {
  const lit = stringLiteral(node.childForFieldName('source'));
  if (lit) return lit;
  // require('./x') / require.resolve('./x')：call_expression 没有 source 字段，需从 arguments 取
  if (node.type === 'call_expression') {
    const fn = node.childForFieldName('function');
    if (fn && /^require(\.resolve)?$/.test(fn.text.trim())) {
      const args = node.childForFieldName('arguments');
      if (args) {
        for (let i = 0; i < args.childCount; i++) {
          const lit2 = stringLiteral(args.child(i));
          if (lit2) return lit2;
        }
      }
    }
  }
  return null;
}

/** string/string_fragment 节点 → { text(含引号), inner, startIndex }，非字符串返回 null */
function stringLiteral(s: SyntaxNodeLike | null): { startIndex: number; text: string; inner: string } | null {
  if (!s || !['string', 'string_fragment'].includes(s.type)) return null;
  const text = s.text;
  if (text.length < 2 || s.startIndex == null) return null;
  const q = text[0];
  if ((q === "'" || q === '"' || q === '`') && text.endsWith(q)) {
    return { startIndex: s.startIndex, text, inner: text.slice(1, -1) };
  }
  return null;
}

/** 深度优先收集所有 import 源字面量（含 require / import()，AST 语言无关地按 import 节点收集） */
function collectImportLiterals(node: SyntaxNodeLike, out: Array<{ node: SyntaxNodeLike; lit: { startIndex: number; text: string; inner: string } | null }>, depth = 0): void {
  if (depth > 300) return;
  if (
    node.type === 'import_statement' ||
    node.type === 'export_statement' ||
    node.type === 'import_expression' ||
    node.type === 'call_expression'
  ) {
    const lit = importSourceLiteral(node);
    if (lit) {
      out.push({ node, lit });
      return;
    }
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectImportLiterals(c, out, depth + 1);
  }
}

/** Python 相对导入字面量：收集 `from .mod import a` / `from . import b` 的模块路径部分（.mod / .） */
function collectPythonImportLiterals(node: SyntaxNodeLike, out: Array<{ node: SyntaxNodeLike; lit: { startIndex: number; text: string; inner: string } | null }>, depth = 0): void {
  if (depth > 300) return;
  if (node.type === 'import_from_statement') {
    // 从文本定位 `from X` 的模块路径（relative_import = .mod / .；非相对则 dotted_name）
    const m = node.text.match(/^\s*from\s+([\w.]+)/);
    const modText = m ? m[1] : null;
    if (modText && modText.startsWith('.')) {
      // 模块路径字节偏移 = 节点起始 + "from " 长度
      const relIdx = 5; // "from " 长度
      const inner = modText;
      if (node.startIndex != null) {
        out.push({
          node,
          lit: { startIndex: node.startIndex + relIdx, text: inner, inner },
        });
      }
      // 后续仍有子节点（import 名），但不再往下找
      return;
    }
    // 非相对 from（from pkg import）→ 包路径，移动单文件不改变 → 忽略
    return;
  }
  if (node.type === 'import_statement') {
    return; // import pkg / import a.b → 包路径，忽略
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectPythonImportLiterals(c, out, depth + 1);
  }
}

export async function renameFile(input: RenameFileInput): Promise<RenameFileResult> {
  const projectRoot = path.resolve(input.project_dir);
  const toAbs = path.isAbsolute(input.to) ? path.resolve(input.to) : path.resolve(projectRoot, input.to);
  const fromAbs = path.isAbsolute(input.from) ? path.resolve(input.from) : path.resolve(projectRoot, input.from);
  const fromRel = toPosix(path.relative(projectRoot, fromAbs));
  const toRel = toPosix(path.relative(projectRoot, toAbs));
  const dryRun = !!input.dry_run;
  const blocked: string[] = [];

  if (fromRel === toRel) {
    blocked.push('源与目标路径相同，无需改名');
    return { ok: false, dryRun, fromRel, toRel, moved: false, references: [], editCount: 0, pending: [], blocked };
  }
  if (!fs.existsSync(fromAbs)) {
    blocked.push(`源文件不存在：${fromRel}`);
  }
  if (fs.existsSync(toAbs)) {
    blocked.push(`目标已存在，拒绝覆盖：${toRel}`);
  }
  if (blocked.length > 0) {
    return { ok: false, dryRun, fromRel, toRel, moved: false, references: [], editCount: 0, pending: [], blocked };
  }

  const toNoExt = toRel.replace(/\.[^.]+$/, '');

  // 1) 枚举项目源码文件
  const files: string[] = [];
  walkProjectFiles(projectRoot, files);

  // 2) 逐个文件扫描：import 源字面量 → 解析到 fromRel 即为一处待改写引用
  const pending: string[] = [];
  const byImporter = new Map<string, { importerAbs: string; items: RefEdit[] }>();
  const guard = createProtectGuard(projectRoot);
  // 被移动文件自身的相对导入需按新位置重锚定（指向同样的绝对目标，否则移入新目录会悬空）
  const ownEdits: Array<{ pos: number; len: number; quote: string; toSource: string }> = [];

  for (const importerAbs of files) {
    const importerRel = toPosix(path.relative(projectRoot, importerAbs));
    const isMoved = importerAbs === fromAbs;
    let content: string;
    try {
      content = fs.readFileSync(importerAbs, 'utf-8');
    } catch {
      continue;
    }
    const parsed = await parseAstRoot(importerAbs, content);
    if (!parsed) continue;
    const isPy = parsed.langName === 'python';
    const lits: Array<{ node: SyntaxNodeLike; lit: { startIndex: number; text: string; inner: string } | null }> = [];
    if (isPy) collectPythonImportLiterals(parsed.root, lits);
    else collectImportLiterals(parsed.root, lits);
    for (const { lit } of lits) {
      if (!lit) continue;
      if (isMoved) {
        // 被移动文件：只重锚定相对导入到原解析目标（新位置→同一文件）
        if (!lit.inner.startsWith('.')) continue;
        const targetRel = isPy ? resolvePythonTarget(projectRoot, importerRel, lit.inner) : resolveImportTarget(projectRoot, importerRel, lit.inner);
        if (!targetRel || targetRel === fromRel) continue;
        const targetNoExt = targetRel.replace(/\.[^.]+$/, '');
        const toSource = isPy ? newPySpecifier(toRel, targetNoExt) : newSpecifier(toRel, lit.inner, targetNoExt);
        if (lit.inner === toSource) continue;
        ownEdits.push({ pos: lit.startIndex, len: lit.text.length, quote: isPy ? '' : lit.text[0], toSource });
        continue;
      }
      const targetRel = isPy ? resolvePythonTarget(projectRoot, importerRel, lit.inner) : resolveImportTarget(projectRoot, importerRel, lit.inner);
      if (targetRel !== fromRel) continue; // 不是指向被移动文件 → 不碰
      // 生成新规范字，保留老引用扩展名风格
      const toSource = isPy ? newPySpecifier(importerRel, toNoExt) : newSpecifier(importerRel, lit.inner, toNoExt);
      if (lit.inner === toSource) continue; // 改完没变化（如原地同目录同核）→ 跳过
      const rec: RefEdit = { importerRel, importerAbs, source: lit.inner, toSource, pos: lit.startIndex, len: lit.text.length, quote: isPy ? '' : lit.text[0] };
      if (!byImporter.has(importerRel)) byImporter.set(importerRel, { importerAbs, items: [] });
      byImporter.get(importerRel)!.items.push(rec);
    }
  }

  const filteredEdits = [...byImporter.values()].flatMap((im) => im.items);
  const editCount = filteredEdits.length;
  const references = filteredEdits.map((e) => ({ file: e.importerRel, fromSource: e.source, toSource: e.toSource }));

  // 目录桶（index/mod）的引用 → 注明语义变化风险
  if (/\/index\.(ts|tsx|js|jsx)$/.test(fromRel)) {
    pending.push(`被移动文件是目录桶 ${fromRel}——原引用可能用 ./dirname 形式，语义已变，请重点复核`);
  }

  // 冻结行保护（原子）：若某 importer 的引用改写会落在保护文件的标记行 → 整笔软阻断，
  // 不产生"跳过某个引用仍让它处移动"的半成状态。主体文件（被移动文件）不套。
  for (const importer of byImporter.values()) {
    if (importer.items.length === 0) continue;
    let src = '';
    try {
      src = fs.readFileSync(importer.importerAbs, 'utf-8');
    } catch {
      continue;
    }
    const g = guard.scan(importer.importerAbs, src, importer.items.map((r) => ({ pos: r.pos, len: r.len, text: r.toSource })));
    if (g.blocked) {
      blocked.push(`质疑：${importer.items[0].importerRel} 的引用命中保护标记行，需解除保护或人工处理后再移动：${g.protectedLines.join(' | ')}`);
    }
  }
  if (blocked.length > 0) {
    return { ok: false, dryRun, fromRel, toRel, moved: false, references, editCount, pending, blocked };
  }

  if (dryRun) {
    return { ok: true, dryRun, fromRel, toRel, moved: false, references, editCount, pending };
  }

  // 3) 原子化执行——先复制，再改写引用，最后删除原文件。
  //    原实现是先 renameSync 再改引用，中途任何一步（文件改写/索引写入）失败
  //    都会导致「文件已走、引用仍指向旧路径、索引悬空」的半完成状态，用户无从回退。
  //    新顺序：复制 → 改引用（原文件仍在，失败零损失）→ 删原文件 + 重索引。
  const toDir = path.dirname(toAbs);
  fs.mkdirSync(toDir, { recursive: true });
  fs.copyFileSync(fromAbs, toAbs);
  const db = getProjectCacheDb(projectRoot);
  let copySucceeded = true;

  try {
    // 4) 改写各引用文件（字节级，逆序防偏移互相影响）
    for (const importer of byImporter.values()) {
      const items = importer.items;
      const content = fs.readFileSync(importer.importerAbs, 'utf-8');
      const sorted = [...items].sort((a, b) => b.pos - a.pos);
      let out = content;
      for (const it of sorted) out = out.slice(0, it.pos) + it.quote + it.toSource + it.quote + out.slice(it.pos + it.len);
      fs.writeFileSync(importer.importerAbs, out, 'utf8');
      await syncFile(db, projectRoot, importer.importerAbs);
    }

    // 5) 被移动文件自身的相对导入按新位置重锚定（对拷贝体做改写）
    if (ownEdits.length > 0) {
      const content = fs.readFileSync(toAbs, 'utf-8');
      const sorted = [...ownEdits].sort((a, b) => b.pos - a.pos);
      let out = content;
      for (const it of sorted) out = out.slice(0, it.pos) + it.quote + it.toSource + it.quote + out.slice(it.pos + it.len);
      fs.writeFileSync(toAbs, out, 'utf8');
    }

    // 6) 全部改写成功后才删除原文件 + 重索引
    fs.unlinkSync(fromAbs);
    removeFile(db, projectRoot, fromAbs);
    await syncFile(db, projectRoot, toAbs);
  } catch (e) {
    // 中途失败回滚：删除第 3 步留下的拷贝，让调用方看到「没挪动」
    try {
      if (fs.existsSync(toAbs)) fs.unlinkSync(toAbs);
    } catch {
      /* 清理失败不影响主错误返回 */
    }
    copySucceeded = false;
    return {
      ok: false, dryRun, fromRel, toRel, moved: false, references, editCount, pending,
      blocked: [`rename_file 中途失败（已回滚拷贝）：${(e as Error).message}`],
    };
  } finally {
    // 保险：如果失败回滚路径上有任何遗留，务必清掉 toAbs
    if (!copySucceeded && fs.existsSync(toAbs)) {
      try { fs.unlinkSync(toAbs); } catch { /* noop */ }
    }
    // 释放本项目缓存连接（Windows 上文件句柄不释放会导致后续删目录 EBUSY；
    // close 幂等，后续需要会重新 openDb）——成功/失败路径都释放
    closeProjectCacheDb(projectRoot);
  }

  return { ok: true, dryRun, fromRel, toRel, moved: true, references, editCount, pending };
}