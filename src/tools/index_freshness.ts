/**
 * 索引自动保鲜：查询前懒校验，外部改动（git pull / 手动编辑 / 其他 agent）自动增量重同步
 *
 * 背景：符号索引（cache.db files/nodes/edges）只在自己 edit_code 后重建，
 * 外部一改就过期——search 报已删符号、漏新符号，edit 定位漂移。
 * 「第一性工具」的前提是索引永远可信。
 *
 * ★ 冷启 bootstrap（2026-09-14 加，agent IO 层的「零前置」）：
 *   此前空库就直接返回空报告 —— 查询层只能抛"请先 import_project"，
 *   这正是 tool-convergence §5.6 障碍 #2（前置状态成本高）的代码级根因。
 *   现在：**空库 → 就地静默建索引（有界，见 MAX_BOOTSTRAP_FILES）**，
 *   agent 遇到任何项目都能直接读，不需要任何准备动作。
 *   有界 = 诚实：被上限截断时 state='partial' + truncated=true，绝不假装完整。
 *
 * 机制（廉价 stat 优先，重解析按需）：
 *   0. 空库 → bootstrap（走查 + 按上限同步；不阻塞语义：见下）
 *   1. 走查项目文件（复用 import_project 的 walkFiles 规则：跳 node_modules/dist/测试等）
 *   2. 每文件 stat 比对 files 表的 modified_at+size（syncFile 落库时已存 fs mtime/size）
 *      ——不变零成本；变更/新增才走 syncFile（其内部还有 content_hash 二道闸）
 *   3. files 表里磁盘上已不存在的 → removeFile（级联清符号/边）
 *   4. 有重同步时收尾 resolveCrossFileCalls（新 pending 的跨文件调用边解析，幂等）
 *
 * 已知边界（与 import_project 语义一致）：新文件发现走默认收录规则
 * （不含测试/归档）；当初 include_tests=true 导入的测试文件不会被保鲜
 * 重同步，但删除侦测对它们仍然生效（existsSync 判定，不依赖走查集合）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import { syncFile, removeFile, resolveCrossFileCalls, syncProject } from '../db/symbols.js';
import { walkFiles } from './import_project.js';

/** 索引可用性状态（诚实口径：不假装完整） */
export type IndexState =
  /** 索引可用（本轮新建或已有） */
  | 'ready'
  /** 建了但被上限截断 —— 只覆盖部分文件 */
  | 'partial'
  /** 空且没建成（项目无可索引文件 / 明确 opt-out / 内部失败） */
  | 'empty';

export interface FreshnessReport {
  /** 走查比对的文件数 */
  checked: number;
  /** 内容变更重同步的文件数 */
  resynced: number;
  /** 新发现并索引的文件数 */
  added: number;
  /** 磁盘已删除并清缓存的文件数 */
  removed: number;
  /** 解析失败数（下轮再试，不阻断查询） */
  failed: number;
  /** 因超出补全上限而跳过的新增文件数（索引基线失效，建议重新 import_project） */
  skipped_adds: number;
  /** ★ 冷启 bootstrap 本次新索引的文件数（0 = 本轮未冷启） */
  bootstrapped: number;
  /** ★ 冷启是否被上限截断（true 时 state='partial'） */
  truncated: boolean;
  /** ★ 索引状态 */
  state: IndexState;
  ms: number;
}

/** 空报告（保鲜失败时也返回它，查询照常进行） */
function emptyReport(): FreshnessReport {
  return {
    checked: 0,
    resynced: 0,
    added: 0,
    removed: 0,
    failed: 0,
    skipped_adds: 0,
    bootstrapped: 0,
    truncated: false,
    state: 'empty',
    ms: 0,
  };
}

/**
 * 单次保鲜允许补全的新增文件数上限。超过 = 索引基线与项目规模严重脱节
 * （当初 import 被 max_files 截断，或项目大幅扩容）——继续补全等于绕过
 * max_files 守卫的全量导入（狗食实测：633 文件重同步阻塞查询 99 秒）。
 * 此时只做变更重同步与删除清理，新增留给显式 import_project 重建。
 */
const MAX_ADDS_PER_REFRESH = 100;

/**
 * ★ 冷启 bootstrap 的文件上限（默认 2000）。空库首次查询时最多索引这么多文件，
 * 超出 → `state='partial'` + `truncated=true`（诚实标注，绝不假装完整）。
 * 为什么设上限：零前置不能变成"大仓第一次查询卡死"，与 import_project 的 max_files 守卫同一条纪律。
 */
export const MAX_BOOTSTRAP_FILES = 2000;

export interface FreshnessOptions {
  /** 空库时是否就地 bootstrap（默认 true = 零前置）。显式 false 可恢复"只保鲜不冷启"的老语义。 */
  bootstrap?: boolean;
  /** 冷启文件上限（默认 MAX_BOOTSTRAP_FILES） */
  maxFiles?: number;
}

/** 是否发生了任何索引变更（供调用方决定是否在结果中提示） */
export function hasChanges(r: FreshnessReport | null): boolean {
  return !!r && (r.resynced + r.added + r.removed + r.bootstrapped) > 0;
}

/**
 * 校验并修复 <projectRoot> 的符号索引新鲜度。任何内部异常都吞掉返回空报告——
 * 保鲜是尽力而为的增强，绝不能让查询本身失败。
 */
export async function ensureFreshIndex(
  db: Database,
  projectRoot: string,
  opts: FreshnessOptions = {},
): Promise<FreshnessReport> {
  const t0 = Date.now();
  const bootstrap = opts.bootstrap !== false;
  const maxFiles = opts.maxFiles ?? MAX_BOOTSTRAP_FILES;
  try {
    const root = path.resolve(projectRoot);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return emptyReport();

    const rows = db.prepare('SELECT path, modified_at, size FROM files').all() as Array<
      { path: string; modified_at: number; size: number }
    >;

    // ── 冷启（★ 零前置）：空库 → 就地静默建索引，不再把"先 import_project"甩给调用方
    if (rows.length === 0) {
      if (!bootstrap) return emptyReport();
      const absFiles = walkFiles(root, false, false);
      const take = absFiles.slice(0, maxFiles);
      const r = await syncProject(db, root, take);
      const truncated = absFiles.length > take.length;
      const built = r.updated;
      const report = emptyReport();
      report.checked = absFiles.length;
      report.bootstrapped = built;
      report.added = built;
      report.failed = r.failed;
      report.truncated = truncated;
      report.state = built === 0 ? 'empty' : truncated ? 'partial' : 'ready';
      report.ms = Date.now() - t0;
      return report;
    }

    // 磁盘现状：走查（默认规则） + stat
    const absFiles = walkFiles(root, false, false);
    const report = emptyReport();
    report.checked = absFiles.length;

    const known = new Map(rows.map((r) => [r.path, r]));

    // 两遍扫：先 stat 全量分类（未变/变更/新增），新增超限整体跳过（守卫），
    // 再对准许集合做 syncFile——避免"补了一半才发现超限"的半吊子状态
    interface Pending { abs: string; kind: 'resync' | 'add' }
    const pending: Pending[] = [];
    for (const abs of absFiles) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // 竞态消失（走查与 stat 之间被删）→ 走删除侦测路径
      }
      const prev = known.get(rel);
      if (prev && prev.modified_at === Math.round(stat.mtimeMs) && prev.size === stat.size) {
        continue; // 未变：零成本跳过（绝大多数文件走这条）
      }
      pending.push({ abs, kind: prev ? 'resync' : 'add' });
    }

    const addCount = pending.filter((p) => p.kind === 'add').length;
    const allowAdds = addCount <= MAX_ADDS_PER_REFRESH;
    if (!allowAdds) report.skipped_adds = addCount;

    let dirty = false;
    for (const p of pending) {
      if (p.kind === 'add' && !allowAdds) continue;
      const r = await syncFile(db, root, p.abs);
      if (r.status === 'failed') report.failed++;
      else if (r.status === 'updated') {
        // status='skipped'：mtime/size 变但内容同（git checkout 还原）——零变更不计
        dirty = true;
        if (p.kind === 'add') report.added++;
        else report.resynced++;
      }
    }

    // 删除侦测：索引里有、磁盘上没了的 → 清缓存（existsSync 判定，覆盖走查规则外的已索引文件）
    for (const r of rows) {
      if (!fs.existsSync(path.join(root, r.path))) {
        removeFile(db, root, path.join(root, r.path));
        report.removed++;
        dirty = true;
      }
    }

    // 有重同步 → 收尾跨文件调用解析（与 syncProject 收尾一致；幂等，只处理 pending）
    if (dirty) {
      try {
        resolveCrossFileCalls(db, root);
      } catch {
        /* 解析失败不阻断：pending 留待下轮 */
      }
    }
    report.state = report.skipped_adds > 0 ? 'partial' : 'ready';
    report.ms = Date.now() - t0;
    return report;
  } catch {
    return emptyReport();
  }
}

