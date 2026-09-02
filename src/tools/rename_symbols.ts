/**
 * rename_symbols —— 跨文件符号批量改名（对标脚本效率 + 结构化 diff 预览/验证）
 *
 * 把多个「跨文件符号改名」合成一次调用：
 *   - 先对所有条目按原始文件态 dry_run 计算结构化 diff（old→new，可验证），
 *     任一条目被阻断（撞名/星号转发/非模块级符号）→ 整体不落盘，先给预览报告。
 *   - 全部可落盘时才逐条真落盘，返回每条的 preview(applied)。
 *   - 复用 rename_symbol 的单条原子语义（每条内部：阻断→该条不动）；跨条 clash
 *     在 apply 阶段兜底：若前面改动使后续条目被阻断，立即中止并如实报告已应用条数。
 *
 * 与 rename_many 互补：rename_many 是单文件局部变量批量（作用域隔离）；本工具是
 * 跨文件模块级符号批量（依赖 direction2 的结构化 diff / dry_run）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { renameSymbol, type RenameSymbolInput, type RenameSymbolResult } from './rename_symbol.js';
import { resolveProjectRoot } from './project_root.js';
import { createProtectGuard } from './protect.js';

/** 字面量命中的类别：contract=对外工具注册名(破坏契约需人审)；history=tool-convergence 历史记录(保留原貌)；docs=文档；test=测试断言；code=源码字符串 */
export type LiteralMatchKind = 'contract' | 'history' | 'docs' | 'test' | 'code';

/** 单条字面量的改名决策：apply=可自动替换；review=契约需人审；preserve=历史保留；frozen=冻结行跳过；generated=生成物不落盘 */
export type LiteralDecision = 'apply' | 'review' | 'preserve' | 'frozen' | 'generated';

/** 单个字面量命中的原始信息（扫描产出，不含决策） */
export interface RawLiteralMatch {
  file: string;
  line: number;
  /** needle 在该文件内的字节偏移（可精确定位替换） */
  pos: number;
  /** 命中字面量长度（即 needle 长度） */
  len: number;
  snippet: string;
  kind: LiteralMatchKind;
}

/** 单个字面量命中（含决策与替换名，可落盘/验证） */
export interface LiteralMatch extends RawLiteralMatch {
  decision: LiteralDecision;
  /** 命中的字面量（needle，旧蛇形名） */
  old: string;
  /** 替换后蛇形名（新名；仅 decision=apply 会被写盘） */
  new: string;
}

export interface RenameSymbolsItem {
  /** 定义符号的文件（绝对路径；或相对 cwd / project_dir 路径） */
  file: string;
  /** 旧符号名（模块级声明名/被 import 的远程名） */
  symbol: string;
  /** 新符号名（合法标识符） */
  to: string;
  /** true=符号是文件主导出（文件名=符号名）时联动改文件名（可选） */
  rename_file_if_matching?: boolean;
}

export interface RenameSymbolsResult {
  ok: boolean;
  /** true=本次为纯预览（dry_run=true 或任一条被阻断返回的整体不落盘预览） */
  dryRun?: boolean;
  /** 每个条目的 dry-run 结构化 diff（基于原始文件态；含 ok/blocked 信息） */
  previews: Array<{
    index: number;
    item: RenameSymbolsItem;
    ok: boolean;
    blocked?: string[];
    result?: RenameSymbolResult;
  }>;
  /** 真正落盘的条目（dry_run 时为 []; 部分成功后剩余被阻断时自此据实返回） */
  applied: Array<{ index: number; item: RenameSymbolsItem; result: RenameSymbolResult }>;
  /** 实际落盘文件总数 */
  filesWritten: number;
  /** 整体阻断理由（ok=false 时给出全部） */
  blocked?: string[];
  /** report_literals / apply_literals 时的字面量引用清单：每个旧符号的 snake 变体在项目文本里的命中（含决策与 new 替换名） */
  literals?: Array<{
    index: number;
    item: RenameSymbolsItem;
    needle: string;
    /** 新蛇形名（需要的话，字面量里它替换 needle） */
    toSnake: string;
    matches: LiteralMatch[];
  }>;
  /** apply_literals + 非 dry_run 时，字面量落盘的文件数 */
  literalFilesWritten?: number;
}

export async function renameSymbols(input: {
  /** 可省：传给每条作为统一定位（缺省各条自动定位项目根） */
  project_dir?: string;
  renames: RenameSymbolsItem[];
  /** true=只算全部 dry-run diff 不落盘；默认优先整体校验，全通过才落盘 */
  dry_run?: boolean;
  /** true=额外扫描每个旧符号的 snake 变体在项目文本里的字面量引用（如工具名 render_dsl 在错误提示/README 里的串），返回清单（只扫描，不改动） */
  report_literals?: boolean;
  /** true=在符号改名成功后，自动替换 decision=apply 的字面量（code/docs/test）；contract→需人审、history→保留、冻结行→跳过，均不写盘。dry_run 下只预览不入盘。 */
  apply_literals?: boolean;
}): Promise<RenameSymbolsResult> {
  const { renames, dry_run } = input;
  const projectDir = typeof input.project_dir === 'string' && input.project_dir ? input.project_dir : undefined;
  const blocked: string[] = [];

  if (!renames || renames.length === 0) return { ok: false, dryRun: true, previews: [], applied: [], filesWritten: 0, blocked: ['批量列表为空'] };

  // 跨条目基础校验：同 file+symbol 重复
  const seenKeys = new Set<string>();
  for (const it of renames) {
    const key = `${it.file}\u0000${it.symbol}`;
    if (seenKeys.has(key)) blocked.push(`重复条目：${it.file} 的 ${it.symbol}`);
    seenKeys.add(key);
  }
  if (blocked.length > 0) return { ok: false, dryRun: true, previews: [], applied: [], filesWritten: 0, blocked };

  // report_literals：扫描每个旧符号 snake 变体的字面量命中（只报告不改动）
  const rootDir = (() => {
    if (projectDir) return projectDir;
    if (renames[0]?.file) {
      try {
        return resolveProjectRoot(renames[0].file);
      } catch {
        return undefined;
      }
    }
    return undefined;
  })();
  let literals: RenameSymbolsResult['literals'];
  let literalFilesWritten = 0;
  const wantLiteral = input.report_literals === true || input.apply_literals === true;
  if (wantLiteral && rootDir) {
    const guard = createProtectGuard(rootDir);
    // 预览计划（对当前盘态命中做决策，供 dry_run/阻断预览/最终报告）
    literals = buildLiteralPlan(rootDir, renames, guard);
  }

  // 阶段 1：全部 dry_run 预览（基于原始文件态，不落盘）
  const previews: RenameSymbolsResult['previews'] = [];
  let allOk = true;
  for (let i = 0; i < renames.length; i++) {
    const item = renames[i];
    const result = await renameSymbol({ project_dir: projectDir, file: item.file, symbol: item.symbol, to: item.to, rename_file_if_matching: item.rename_file_if_matching === true, dry_run: true });
    previews.push({ index: i, item: item, ok: result.ok, blocked: result.ok ? undefined : result.blocked, result: result });
    if (!result.ok) allOk = false;
  }

  // 任一阻断 → 整体不落盘，给预览报告
  if (!allOk) return { ok: false, dryRun: true, previews, applied: [], filesWritten: 0, blocked: ['至少一个条目被阻断→整体未落盘'], literals };

  // dry_run 显式要求 → 只预览
  if (dry_run === true) return { ok: true, dryRun: true, previews, applied: [], filesWritten: 0, literals };

  // 阶段 2：全部通过 → 逐条真落盘（串行；前面改动导致后续阻断则中止并据实报告）
  const applied: RenameSymbolsResult['applied'] = [];
  let filesWritten = 0;
  for (let i = 0; i < renames.length; i++) {
    const item = renames[i];
    const result = await renameSymbol({ project_dir: projectDir, file: item.file, symbol: item.symbol, to: item.to, rename_file_if_matching: item.rename_file_if_matching === true, dry_run: false });
    if (!result.ok) {
      return {
        ok: false,
        previews,
        applied,
        filesWritten,
        blocked: [`条目 ${i}（${item.file} 的 ${item.symbol}→${item.to}）实际落盘时被阻断：${(result.blocked || []).join('；')}。已应用 ${applied.length} 条，之后条目未执行`],
        literals,
        literalFilesWritten,
      };
    }
    filesWritten += result.filesWritten;
    applied.push({ index: i, item: item, result: result });
  }

  // apply_literals：符号已全落盘 → 重新扫盘态（偏移对符号改动后的真值），只替换 decision=apply 的字面量。
  // contract→需人审、history→保留、冻结行→跳过，均不写盘；decision 明细随 literals 返回供复核。
  if (input.apply_literals === true && rootDir) {
    const guard = createProtectGuard(rootDir);
    const fresh = buildLiteralPlan(rootDir, renames, guard);
    literalFilesWritten = applyLiteralPlan(fresh).filesWritten;
    literals = fresh;
  }

  return { ok: true, previews, applied, filesWritten, ...(literalFilesWritten ? { literalFilesWritten } : {}), literals };
}

// ──────────────── 字面量引用扫描（只报告，不改动） ────────────────

/** camelCase/PascalCase → snake_case。如 'renderDesign' → 'render_design'。 */
export function camelToSnake(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toLowerCase();
}

/** 按文件名/行内容判定字面量命中的类别（契约名 / 历史记录 / 文档 / 测试 / 源码） */
function classifyLiteral(file: string, lineText: string, needle: string): LiteralMatchKind {
  const rel = file.split(path.sep).join('/');
  // 对外工具注册名：server_registry 里 `name: 'needle'`（改名会破坏 MCP 调用契约 → 需人审）
  if (/server_registry/i.test(rel) && new RegExp(`name:\\s*['"\`]${needle}['"\`]`).test(lineText)) return 'contract';
  // 历史决策记录：tool-convergence 等，改名应保留原貌
  if (/tool-convergence|docs\/plans/i.test(rel)) return 'history';
  // 文档类：README / AGENTS / CONTRIBUTING / skill / issue 模板
  if (/README|AGENTS|CONTRIBUTING|ISSUE_TEMPLATE|SKILL\.md|docs\//i.test(rel)) return 'docs';
  // 测试断言
  if (/tests\/|\.test\.|\.spec\./i.test(rel)) return 'test';
  return 'code';
}

/** 在 projectDir 下扫描所有常见文本文件，返回 needle 列表的命中（含字节偏移，非二进制/非编译产物） */
export function scanLiteralOccurrences(
  projectDir: string,
  needles: string[],
): Array<{ needle: string; matches: RawLiteralMatch[] }> {
  const result: Array<{ needle: string; matches: RawLiteralMatch[] }> = [];
  if (needles.length === 0) return result;

  // 只扫描常见可读扩展名（排除二进制/编译产物）
  const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.vue', '.py', '.go', '.java', '.sh', '.mjs']);
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.github']);

  const files: string[] = [];
  function walk(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (entry.isFile() && SCAN_EXTS.has(path.extname(entry.name))) {
          files.push(path.join(dir, entry.name));
        }
      }
    } catch { /* 权限/临时目录跳过 */ }
  }
  walk(projectDir);

  // 对每个 needle 逐文件扫描全部出现点（含字节偏移）
  for (const needle of needles) {
    if (!needle) continue;
    const matches: RawLiteralMatch[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        const lineStart: number[] = [0];
        for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lineStart.push(i + 1);
        const lines = content.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const text = lines[li];
          let idx = text.indexOf(needle);
          while (idx >= 0) {
            const pos = lineStart[li] + idx;
            matches.push({
              file: f,
              line: li + 1,
              pos,
              len: needle.length,
              snippet: text.trim().substring(0, 120),
              kind: classifyLiteral(f, text, needle),
            });
            idx = text.indexOf(needle, idx + needle.length);
          }
        }
      } catch { /* 跳过无法读的文件 */ }
    }
    result.push({ needle, matches });
  }

  return result;
}

// ──────────────── 字面量改名决策 + 落盘（补全闭环） ────────────────

/** 单个字面量命中 → 改名决策：生成物不落盘；contract 契约需人审；history 历史保留；冻结行跳过；其余可自动替换 */
function decideLiteral(kind: LiteralMatchKind, frozen: boolean, isGenerated: boolean): LiteralDecision {
  if (isGenerated) return 'generated';
  if (kind === 'contract') return 'review';
  if (kind === 'history') return 'preserve';
  if (frozen) return 'frozen';
  return 'apply';
}

/**
 * 构建字面量改名计划：对每个 renames 条目，扫其蛇形旧名的全部命中，并为每处算决策与替换名。
 * @param guard 冻结行保护守卫（可空）；为空则无冻结/生成物判定。
 */
export function buildLiteralPlan(
  rootDir: string,
  renames: RenameSymbolsItem[],
  guard?: { isFrozen(absFile: string, src: string, pos: number): boolean; isGeneratedFile(absFile: string): boolean } | null,
): RenameSymbolsResult['literals'] {
  const needles = [...new Set(renames.map((i) => camelToSnake(i.symbol)).filter(Boolean))];
  const scanned = scanLiteralOccurrences(rootDir, needles);
  const contentCache = new Map<string, string>();
  const contentOf = (f: string): string => {
    let c = contentCache.get(f);
    if (c === undefined) {
      try {
        c = fs.readFileSync(f, 'utf-8');
      } catch {
        c = '';
      }
      contentCache.set(f, c);
    }
    return c;
  };
  return renames.map((item, index) => {
    const needle = camelToSnake(item.symbol);
    const toSnake = camelToSnake(item.to);
    const hit = scanned.find((s) => s.needle === needle);
    const matches = (hit ? hit.matches : []).map((m) => {
      const frozen = guard ? guard.isFrozen(m.file, contentOf(m.file), m.pos) : false;
      const isGen = guard ? guard.isGeneratedFile(m.file) : false;
      return { ...m, decision: decideLiteral(m.kind, frozen, isGen), old: needle, new: toSnake };
    });
    return { index, item, needle, toSnake, matches };
  });
}

/** 落盘字面量计划：只写 decision=apply 的命中（code/docs/test；契约/历史/冻结行跳过）。返回写入文件数。 */
export function applyLiteralPlan(plan: RenameSymbolsResult['literals']): { filesWritten: number } {
  const byFile = new Map<string, Array<{ pos: number; len: number; text: string }>>();
  if (!plan) return { filesWritten: 0 };
  for (const item of plan) {
    for (const m of item.matches) {
      if (m.decision !== 'apply') continue;
      let a = byFile.get(m.file);
      if (!a) {
        a = [];
        byFile.set(m.file, a);
      }
      a.push({ pos: m.pos, len: m.len, text: m.new });
    }
  }
  let filesWritten = 0;
  for (const [file, edits] of byFile) {
    let src: string;
    try {
      src = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const sorted = [...edits].sort((a, b) => b.pos - a.pos);
    let out = src;
    for (const e of sorted) out = out.slice(0, e.pos) + e.text + out.slice(e.pos + e.len);
    if (out !== src) {
      fs.writeFileSync(file, out, 'utf-8');
      filesWritten++;
    }
  }
  return { filesWritten };
}