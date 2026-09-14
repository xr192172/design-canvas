/**
 * file_snapshot —— 代码文件的"落盘前快照 + 一键回滚"（治"不可撤回"）
 *
 * 出处：aider（每轮自动 commit + `/undo`）。对齐本项目设计原则 6：
 * **危险的不是"能力"，是"不可撤回"** —— 应最大化能力 + 让动作可撤回。
 * 本项目已有 dry_run / 结构化 diff / 原子落盘 / 单次失败回滚，但**跨调用撤不掉**：
 * 一次 edit_code / rename 落了盘，下一次想反悔只能靠 git 或手改。
 *
 * ⚠️ 命名区分（别重造 / 别撞车）：
 *   已有 `src/tools/snapshot.ts` 是 **DSL feature 快照**（设计状态里程碑，存
 *   `.design-canvas/snapshots/<feature>/`）；本模块管的是 **代码文件**，
 *   存 `.design-canvas/code-snapshots/` —— 两者目录与 API 都分开，互不干扰。
 *
 * 为什么不用 git：
 *   - 项目未必是 git 仓（`import_project` 常在非 git 目录上跑）；
 *   - 替用户 commit / stash 会污染他的工作区与历史（"撤回"不该改变用户仓库状态）；
 *   - 影子副本**只存被改动的那几个文件**（KB 级），与 git 完全解耦。
 *
 * 存储：`<projectRoot>/.design-canvas/code-snapshots/<id>/{meta.json,files/<rel>}`
 * 保留：默认最近 20 份（`MAX_FILE_SNAPSHOTS`），建新快照时清理更旧的。
 *
 * 纯 fs、零依赖。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 快照里单个文件的记录 */
export interface FileSnapshotEntry {
  /** 相对项目根的路径（posix 分隔符） */
  rel: string;
  /** 快照时该文件是否存在（false = 这次改动新建的 → 回滚时应删除） */
  existed: boolean;
  /** 快照时字节数（existed=false 时 0） */
  bytes: number;
}

export interface FileSnapshotMeta {
  id: string;
  createdAt: string;
  /** 谁触发、改了什么（人读，如 `edit_code:src/a.ts`） */
  reason: string;
  files: FileSnapshotEntry[];
}

/** 默认保留份数 */
export const MAX_FILE_SNAPSHOTS = 20;

export function fileSnapshotsDir(root: string): string {
  return path.join(path.resolve(root), '.design-canvas', 'code-snapshots');
}

function normalizeRel(root: string, file: string): string | null {
  const abs = path.isAbsolute(file) ? file : path.resolve(root, file);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null; // 根外 → 不快照（诚实跳过）
  return rel.split(path.sep).join('/');
}

function makeId(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 建快照：把 `files` 里**当前存在**的文件各存一份副本。
 * 调用时机 = 改动**落盘之前**（这是"可撤回"的全部秘密）。
 */
export function createFileSnapshot(
  root: string,
  opts: { reason: string; files: readonly string[] },
): FileSnapshotMeta {
  const absRoot = path.resolve(root);
  const id = makeId();
  const snapDir = path.join(fileSnapshotsDir(absRoot), id);
  const filesDir = path.join(snapDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const seen = new Set<string>();
  const entries: FileSnapshotEntry[] = [];
  for (const f of opts.files ?? []) {
    const rel = normalizeRel(absRoot, f);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    const abs = path.join(absRoot, rel);
    let existed = false;
    let bytes = 0;
    try {
      const st = fs.statSync(abs);
      existed = st.isFile();
      bytes = existed ? st.size : 0;
    } catch {
      existed = false;
    }
    if (existed) {
      const dest = path.join(filesDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
    entries.push({ rel, existed, bytes });
  }

  const meta: FileSnapshotMeta = {
    id,
    createdAt: new Date().toISOString(),
    reason: opts.reason,
    files: entries,
  };
  fs.writeFileSync(path.join(snapDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  pruneFileSnapshots(absRoot);
  return meta;
}

/** 列快照（新 → 旧） */
export function listFileSnapshots(root: string): FileSnapshotMeta[] {
  const dir = fileSnapshotsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((id) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8')) as FileSnapshotMeta;
      } catch {
        return null;
      }
    })
    .filter((m): m is FileSnapshotMeta => !!m)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** 取单个快照 */
export function getFileSnapshot(root: string, id: string): FileSnapshotMeta | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(fileSnapshotsDir(root), id, 'meta.json'), 'utf8'),
    ) as FileSnapshotMeta;
  } catch {
    return null;
  }
}

export interface RollbackResult {
  ok: boolean;
  message: string;
  /** 恢复原内容的文件（相对路径） */
  restored: string[];
  /** 因"快照时不存在"被删除的文件 */
  removed: string[];
  /** 未能恢复的（诚实上报） */
  failed: string[];
  snapshot?: FileSnapshotMeta;
}

/**
 * 回滚到某份快照（`id` 省略或 `'latest'` = 最近一份）。
 * 语义：`existed=true` → 写回原内容；`existed=false` → 删除该文件（它本是这次改动新建的）。
 * @param filter.file 只回滚单个文件（相对路径或绝对路径）
 */
export function rollbackFileSnapshot(
  root: string,
  id?: string,
  filter?: { file?: string },
): RollbackResult {
  const absRoot = path.resolve(root);
  const list = listFileSnapshots(absRoot);
  if (!list.length) {
    return {
      ok: false,
      message: `没有可用代码快照（${fileSnapshotsDir(absRoot)}）`,
      restored: [],
      removed: [],
      failed: [],
    };
  }
  const meta = id && id !== 'latest' ? getFileSnapshot(absRoot, id) : list[0];
  if (!meta) {
    return { ok: false, message: `代码快照不存在：${id}`, restored: [], removed: [], failed: [] };
  }

  const only = filter?.file ? normalizeRel(absRoot, filter.file) : null;
  if (only && !meta.files.some((e) => e.rel === only)) {
    return {
      ok: false,
      message: `快照 ${meta.id} 里没有文件 ${only} —— 可用文件：${meta.files.map((e) => e.rel).join(', ') || '（空）'}`,
      restored: [],
      removed: [],
      failed: [],
      snapshot: meta,
    };
  }

  const restored: string[] = [];
  const removed: string[] = [];
  const failed: string[] = [];

  for (const e of meta.files) {
    if (only && e.rel !== only) continue;
    const abs = path.join(absRoot, e.rel);
    if (e.existed) {
      const src = path.join(fileSnapshotsDir(absRoot), meta.id, 'files', e.rel);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.copyFileSync(src, abs);
        restored.push(e.rel);
      } catch {
        failed.push(e.rel);
      }
    } else {
      try {
        if (fs.existsSync(abs)) fs.rmSync(abs);
        removed.push(e.rel);
      } catch {
        failed.push(e.rel);
      }
    }
  }

  const parts = [`已回滚代码快照 ${meta.id}（${meta.reason}）`, `恢复 ${restored.length} 个文件`];
  if (removed.length) parts.push(`删除 ${removed.length} 个本次新建的文件`);
  if (failed.length) parts.push(`⚠ 未恢复 ${failed.length} 个：${failed.slice(0, 5).join(', ')}`);
  return { ok: failed.length === 0, message: parts.join('；'), restored, removed, failed, snapshot: meta };
}

/** 清理超出保留份数的旧快照（返回删除份数） */
export function pruneFileSnapshots(root: string, max = MAX_FILE_SNAPSHOTS): number {
  const dir = fileSnapshotsDir(root);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const old of listFileSnapshots(root).slice(max)) {
    try {
      fs.rmSync(path.join(dir, old.id), { recursive: true, force: true });
      n++;
    } catch {
      /* 删不掉不影响主流程 */
    }
  }
  return n;
}

/**
 * 便捷包装：**落盘前先存一份**，调用方拿到 meta 后可把它连同结果一起返回给 agent。
 * 目标文件列表为空时返回 null（不建空快照）。
 */
export function snapshotBeforeWrite(
  root: string,
  reason: string,
  files: readonly string[],
): FileSnapshotMeta | null {
  const list = (files ?? []).filter(Boolean);
  if (!list.length) return null;
  try {
    return createFileSnapshot(root, { reason, files: list });
  } catch {
    return null; // 快照失败绝不阻断主流程（可撤回是增强，不是前提）
  }
}
