/**
 * rename_files —— 批量文件级重命名 + import 引用改写（对标 rename_symbols 的批处理模式）
 *
 * 把多个「文件重命名/移动」合成一次调用，复用 rename_file 的单条原子语义：
 *   - 先对所有条目按原始文件态 dry_run 算影响面（rename_file dry_run 返回 blocked/references），
 *     任一条被阻断（源缺失 / 目标已存在 / 命中冻结行）→ 整体不落盘，先给预览报告。
 *   - 全部可落盘时才逐条真落盘，返回每条 preview(applied)。
 *   - apply 阶段串行：一条引用改写成功可能使后续条目的影响面变化；若后续被阻断，
 *     立即中止并如实报告已应用条数。
 *
 * 与 rename_symbols 对称：rename_symbols 批量「模块级符号」，本品批量「文件路径」。
 * 消除"70 个文件改名 = 70 次调用"（障碍 #3 粒度太细）。
 *
 * 冻结行保护 / 生成物识别：逐条内部走 rename_file，天然继承（body 文件不套 / importer 命中冻结行 → 该条阻断）。
 */

import { renameFile, type RenameFileResult } from './rename_file.js';
import { resolveProjectRoot } from './project_root.js';

export interface FileRenameItem {
  /** 源文件：相对 project_dir 或绝对路径 */
  from: string;
  /** 目标文件：相对 project_dir 或绝对路径 */
  to: string;
}

export interface RenameFilesResult {
  ok: boolean;
  /** true=本次为纯预览（dry_run=true，或任一条被阻断返回的整体不落盘预览） */
  dryRun?: boolean;
  previews: Array<{
    index: number;
    from: string;
    to: string;
    ok: boolean;
    blocked?: string[];
    result?: RenameFileResult;
  }>;
  /** 真正落盘的条目（dry_run 时为 []; 部分成功后剩余被阻断时自此据实返回） */
  applied: Array<{ index: number; from: string; to: string; result: RenameFileResult }>;
  /** 累计引用改写处数（跨条可能重复计入同一 importer 的多次命中） */
  filesWritten: number;
  /** 整体阻断理由（ok=false 时给出全部） */
  blocked?: string[];
}

export async function renameFiles(input: {
  /** 目标项目根（可选；缺省各条自动定位；统一定位时传） */
  project_dir?: string;
  renames: FileRenameItem[];
  /** true=只算全部 dry-run 影响面不落盘；默认优先整体校验，全通过才落盘 */
  dry_run?: boolean;
}): Promise<RenameFilesResult> {
  const { renames, dry_run } = input;
  // rename_file 强制要求 project_dir（它不像 rename_symbol 会自动定位根），这里在批量层做一次根解析兜底
  const projectDir = (() => {
    if (typeof input.project_dir === 'string' && input.project_dir) return input.project_dir;
    if (renames?.[0]?.from) {
      try {
        return resolveProjectRoot(renames[0].from);
      } catch {
        /* fallthrough */
      }
    }
    return process.cwd();
  })();
  const blocked: string[] = [];

  if (!renames || renames.length === 0) return { ok: false, dryRun: true, previews: [], applied: [], filesWritten: 0, blocked: ['批量列表为空'] };

  // 跨条目基础校验：同 from 重复（同一源文件不能改名两次）
  const fromSet = new Set<string>();
  for (const it of renames) {
    if (fromSet.has(it.from)) blocked.push(`重复源文件：${it.from}`);
    fromSet.add(it.from);
  }
  if (blocked.length > 0) return { ok: false, dryRun: true, previews: [], applied: [], filesWritten: 0, blocked };

  // 阶段 1：全部 dry_run 预览（基于原始文件态，不落盘）
  const previews: RenameFilesResult['previews'] = [];
  let allOk = true;
  for (let i = 0; i < renames.length; i++) {
    const item = renames[i];
    const result = await renameFile({ project_dir: projectDir, from: item.from, to: item.to, dry_run: true });
    previews.push({ index: i, from: item.from, to: item.to, ok: result.ok, blocked: result.ok ? undefined : result.blocked, result });
    if (!result.ok) allOk = false;
  }

  // 任一阻断 → 整体不落盘，给预览报告
  if (!allOk) return { ok: false, dryRun: true, previews, applied: [], filesWritten: 0, blocked: ['至少一个条目被阻断→整体未落盘'] };

  // dry_run 显式要求 → 只预览
  if (dry_run === true) return { ok: true, dryRun: true, previews, applied: [], filesWritten: 0 };

  // 阶段 2：全部通过 → 逐条真落盘（串行；前面改动导致后续阻断则中止并据实报告）
  const applied: RenameFilesResult['applied'] = [];
  let filesWritten = 0;
  for (let i = 0; i < renames.length; i++) {
    const item = renames[i];
    const result = await renameFile({ project_dir: projectDir, from: item.from, to: item.to, dry_run: false });
    if (!result.ok) {
      return {
        ok: false,
        previews,
        applied,
        filesWritten,
        blocked: [`条目 ${i}（${item.from}→${item.to}）实际落盘时被阻断：${(result.blocked || []).join('；')}。已应用 ${applied.length} 条，之后条目未执行`],
      };
    }
    filesWritten += result.references.length;
    applied.push({ index: i, from: item.from, to: item.to, result });
  }

  return { ok: true, previews, applied, filesWritten };
}