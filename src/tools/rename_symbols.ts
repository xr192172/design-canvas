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

import { renameSymbol, type RenameSymbolInput, type RenameSymbolResult } from './rename_symbol.js';

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
}

export async function renameSymbols(input: {
  /** 可省：传给每条作为统一定位（缺省各条自动定位项目根） */
  project_dir?: string;
  renames: RenameSymbolsItem[];
  /** true=只算全部 dry-run diff 不落盘；默认优先整体校验，全通过才落盘 */
  dry_run?: boolean;
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

  // 阶段 1：全部 dry_run 预览（基于原始文件态，不落盘）
  const previews: RenameSymbolsResult['previews'] = [];
  let allOk = true;
  for (let i = 0; i < renames.length; i++) {
    const it = renames[i];
    const r = await renameSymbol({ project_dir: projectDir, file: it.file, symbol: it.symbol, to: it.to, rename_file_if_matching: it.rename_file_if_matching === true, dry_run: true });
    previews.push({ index: i, item: it, ok: r.ok, blocked: r.ok ? undefined : r.blocked, result: r });
    if (!r.ok) allOk = false;
  }

  // 任一阻断 → 整体不落盘，给预览报告
  if (!allOk) return { ok: false, dryRun: true, previews, applied: [], filesWritten: 0, blocked: ['至少一个条目被阻断→整体未落盘'] };

  // dry_run 显式要求 → 只预览
  if (dry_run === true) return { ok: true, dryRun: true, previews, applied: [], filesWritten: 0 };

  // 阶段 2：全部通过 → 逐条真落盘（串行；前面改动导致后续阻断则中止并据实报告）
  const applied: RenameSymbolsResult['applied'] = [];
  let filesWritten = 0;
  for (let i = 0; i < renames.length; i++) {
    const it = renames[i];
    const r = await renameSymbol({ project_dir: projectDir, file: it.file, symbol: it.symbol, to: it.to, rename_file_if_matching: it.rename_file_if_matching === true, dry_run: false });
    if (!r.ok) {
      return {
        ok: false,
        previews,
        applied,
        filesWritten,
        blocked: [`条目 ${i}（${it.file} 的 ${it.symbol}→${it.to}）实际落盘时被阻断：${(r.blocked || []).join('；')}。已应用 ${applied.length} 条，之后条目未执行`],
      };
    }
    filesWritten += r.filesWritten;
    applied.push({ index: i, item: it, result: r });
  }

  return { ok: true, previews, applied, filesWritten };
}