/**
 * diff_impact —— 变更影响分析
 *
 * 给定一组已变更文件，沿 SQLite 缓存中的调用边（kind='call'）追溯，
 * 找出"这次改动波及了哪些符号/文件"，聚合到 DSL 文件级节点。
 *
 * 借 Understand Anything 的 /understand-diff；数据源是已完成的基础设施：
 *   - 序号 1：SQLite 符号缓存（cache.db）
 *   - 序号 3：调用边（同文件 + 跨文件，symbols.ts 写入）
 *
 * 只读，不修改 DSL。与 consistency_check（"这文件对不对"）正交——
 * 本工具回答"这个改动波及谁"。
 *
 * 关键映射：SQLite 调用边是符号级，DSL 渲染图主要是文件级节点。
 * 在符号级图上做有向 BFS，再按 file_path 聚合回 DSL 文件节点。
 */

import path from 'node:path';
import { getDSL } from '../storage.js';
import { getProjectCacheDb, type Database } from '../db/db.js';

export type ImpactDirection = 'callers' | 'callees' | 'both';

export interface DiffImpactInput {
  feature: string;
  /** 被分析项目的根目录（其下 .design-canvas/cache.db 是符号缓存） */
  project_dir: string;
  /** 已变更文件（相对项目根的路径，或绝对路径） */
  changed: string[];
  /** 追溯方向：callers=谁调用受影响（默认）/ callees=受影响调用了谁 / both=双向 */
  direction?: ImpactDirection;
  /** 最大追溯深度，默认 3 */
  max_depth?: number;
}

export interface ImpactedSymbol {
  id: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  /** 0=直接改动，>0=经调用边间接波及 */
  depth: number;
  role: 'changed' | 'caller' | 'callee';
}

export interface ImpactedFile {
  /** 相对项目根的 posix 路径 */
  path: string;
  /** 对应的 DSL 文件节点 id（feature 图里存在时才给） */
  dsl_node_id?: string;
  depth: number;
  direct: boolean;
  symbol_count: number;
}

export interface DiffImpactResult {
  feature: string;
  project_dir: string;
  changed: string[];
  direction: ImpactDirection;
  max_depth: number;
  impacted_files: ImpactedFile[];
  impacted_symbols: ImpactedSymbol[];
  /** 已知警告（如缓存无调用边 / changed 文件不在缓存） */
  warnings: string[];
  has_call_edges: boolean;
  message: string;
}

/** 空结果（无法打开缓存等场景） */
function emptyResult(
  feature: string,
  project_dir: string,
  changed: string[],
  direction: ImpactDirection,
  max_depth: number,
  warnings: string[],
  message: string,
): DiffImpactResult {
  return {
    feature,
    project_dir,
    changed,
    direction,
    max_depth,
    impacted_files: [],
    impacted_symbols: [],
    warnings,
    has_call_edges: false,
    message,
  };
}

/** 相对项目根归一化（接受相对或绝对路径，统一成 posix rel） */
function toRel(root: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.join(root, p);
  return path.relative(root, abs).split(path.sep).join('/');
}

/** 与 import_project 的 fileNodeId 一致的 DSL 文件节点 id 生成 */
function dslFileNodeId(rel: string): string {
  return `file_${rel.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function diffImpact(input: DiffImpactInput): DiffImpactResult {
  const { feature, project_dir, changed, direction = 'callers', max_depth = 3 } = input;
  const root = path.resolve(project_dir);
  const warnings: string[] = [];

  const dsl = getDSL(feature);
  if (!dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  // 语义文件路径 → DSL 文件节点 id 的权威映射（来自 feature 的 semantic.files）。
  // 不用字符串拼接 file_<rel>：feature 生成时 rel 基准可能不是项目根（如 self_analyze 以 src/ 为根）。
  const semanticFiles = dsl.semantic?.files ?? [];
  const semanticPathToNodeId = new Map<string, string>();
  for (const f of semanticFiles) {
    if (f.path) semanticPathToNodeId.set(f.path, f.id);
  }
  const semanticPaths = new Set(semanticPathToNodeId.keys());

  // 变更文件归一化去重（展示用，相对项目根）
  const changedRels = [...new Set(changed.map((c) => toRel(root, c)))];

  // 把"相对项目根的路径"解析到语义基准路径（缓存 file_path 与语义 path 同基准）：
  // 精确 → 去 src/ 前缀 → 尾段匹配。无 semantic 时回退原样。
  const resolveSemanticPath = (rel: string): string | undefined => {
    if (semanticPaths.has(rel)) return rel;
    const stripped = rel.startsWith('src/') ? rel.slice(4) : undefined;
    if (stripped && semanticPaths.has(stripped)) return stripped;
    const base = rel.split('/').pop();
    return base && semanticPaths.has(base) ? base : undefined;
  };

  // 打开缓存连接（失败降级为提示性空结果）
  let db: Database;
  try {
    db = getProjectCacheDb(root);
  } catch (e) {
    return emptyResult(
      feature, root, changedRels, direction, max_depth,
      [`无法打开缓存 ${path.join(root, '.design-canvas', 'cache.db')}：${(e as Error).message}。请先对该项目运行 import_project 建缓存。`],
      `变更影响分析失败：无法打开符号缓存。请先对该项目运行 import_project。`,
    );
  }

  // 是否有调用边
  const callCount = (db.prepare("SELECT COUNT(*) c FROM edges WHERE kind='call'").get() as { c: number }).c;
  if (callCount === 0) {
    warnings.push('缓存中没有调用边（kind=call）。请先对该项目运行 import_project 建立符号缓存。');
  }

  // 缓存路径直探：历史库可能与当前 project_dir 基准不一致（如以 src/ 为根建的库），
  // 语义映射（feature semantic.files）覆盖不到时，直接到 files 表按多形式探测兜底。
  const probeCachePath = (rel: string): string | undefined => {
    const candidates = rel.startsWith('src/') ? [rel, rel.slice(4)] : [rel];
    for (const c of candidates) {
      const hit = db.prepare('SELECT 1 FROM files WHERE path = ? LIMIT 1').get(c);
      if (hit) return c;
    }
    return undefined;
  };
  const changedSemantic = changedRels.map((rel) => {
    const sem = resolveSemanticPath(rel);
    return { rel, sem, cachePath: probeCachePath(sem ?? rel) ?? sem ?? rel };
  });

  // ── 直接受影响符号（changed 文件里的所有符号，depth=0）──
  const direct: ImpactedSymbol[] = [];
  for (const { rel, cachePath } of changedSemantic) {
    const rows = db
      .prepare(
        "SELECT id, name, qualified_name, start_line FROM nodes WHERE file_path = ? AND kind != 'file' ORDER BY start_line, id",
      )
      .all(cachePath) as Array<{ id: string; name: string; qualified_name: string; start_line: number }>;
    if (rows.length === 0) {
      warnings.push(`变更文件 ${rel} 不在缓存中（可能未同步、删除了符号，或非受支持语言）。`);
    }
    for (const r of rows) {
      direct.push({
        id: r.id,
        name: r.name,
        qualified_name: r.qualified_name,
        file_path: r.id.split('#')[0] ?? cachePath,
        start_line: r.start_line,
        depth: 0,
        role: 'changed',
      });
    }
  }

  // 加载调用边，建正/反向邻接表
  const callerOf = new Map<string, string[]>(); // target → callers
  const calleeOf = new Map<string, string[]>(); // source → callees
  const allEdges = db.prepare('SELECT source, target FROM edges WHERE kind = ?').all('call') as Array<{
    source: string;
    target: string;
  }>;
  for (const e of allEdges) {
    let cs = callerOf.get(e.target);
    if (!cs) {
      cs = [];
      callerOf.set(e.target, cs);
    }
    cs.push(e.source);
    let cl = calleeOf.get(e.source);
    if (!cl) {
      cl = [];
      calleeOf.set(e.source, cl);
    }
    cl.push(e.target);
  }
  // 注意：不 close db——getProjectCacheDb 返回的是连接池连接，由池统一管理
  //（测试隔离用 closeAllProjectCacheDbs；此处复用，避免与 import_project 缓存路径互踩）

  // ── 符号级有向 BFS（按 direction 追溯，深度 ≤ max_depth）──
  const reached = new Map<string, number>(); // symbolId → depth
  const roles = new Map<string, ImpactedSymbol['role']>();
  for (const s of direct) {
    reached.set(s.id, 0);
    roles.set(s.id, 'changed');
  }

  let frontier = direct.map((s) => s.id);
  for (let depth = 1; depth <= max_depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const expand = (adj: Map<string, string[]>, role: ImpactedSymbol['role']) => {
        for (const t of adj.get(id) || []) {
          if (reached.has(t)) continue;
          reached.set(t, depth);
          roles.set(t, role);
          next.push(t);
        }
      };
      if (direction === 'callers' || direction === 'both') expand(callerOf, 'caller');
      if (direction === 'callees' || direction === 'both') expand(calleeOf, 'callee');
    }
    frontier = next;
  }

  // ── 组装受影响符号（含直接 + 间接）──
  const impacted_symbols: ImpactedSymbol[] = [];
  for (const [id, depth] of reached) {
    // 符号 id 即 "<file>#<qualified_name>"，qualified_name 从缓存查全
    const file = id.split('#')[0];
    const qn = id.slice(file.length + 1);
    const meta = db
      .prepare('SELECT name, qualified_name, start_line FROM nodes WHERE id = ?')
      .get(id) as { name: string; qualified_name: string; start_line: number } | undefined;
    impacted_symbols.push({
      id,
      name: meta?.name ?? qn,
      qualified_name: meta?.qualified_name ?? qn,
      file_path: file,
      start_line: meta?.start_line ?? 0,
      depth,
      role: roles.get(id) ?? 'changed',
    });
  }
  impacted_symbols.sort((a, b) => a.depth - b.depth || a.file_path.localeCompare(b.file_path) || a.start_line - b.start_line);

  // ── 聚合到文件级 ──
  const fileMeta = new Map<string, { depth: number; direct: boolean; count: number }>();
  for (const s of impacted_symbols) {
    const m = fileMeta.get(s.file_path) || { depth: Infinity, direct: false, count: 0 };
    if (s.depth === 0) m.direct = true;
    if (s.depth < m.depth) m.depth = s.depth;
    m.count++;
    fileMeta.set(s.file_path, m);
  }
  // 直接改动但无符号的文件（如空文件）也计入直接受影响
  for (const rel of changedRels) {
    if (!fileMeta.has(rel)) fileMeta.set(rel, { depth: 0, direct: true, count: 0 });
  }

  const dslNodeIds = new Set((dsl.geometry.nodes || []).map((n) => n.id));
  const impacted_files: ImpactedFile[] = [...fileMeta.entries()]
    .map(([file, m]) => {
      // 优先用语义映射（缓存 file_path == 语义 path）；无 semantic 时回退字符串拼接
      let dslId = semanticPathToNodeId.get(file);
      if (!dslId) {
        const fallback = dslFileNodeId(file);
        if (dslNodeIds.has(fallback)) dslId = fallback;
      }
      return {
        path: file,
        dsl_node_id: dslId && dslNodeIds.has(dslId) ? dslId : undefined,
        depth: m.depth,
        direct: m.direct,
        symbol_count: m.count,
      };
    })
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  // ── 文本报告 ──
  const dirLabel = direction === 'callers' ? '谁调用受影响' : direction === 'callees' ? '受影响调用了谁' : '双向调用';
  const lines: string[] = [];
  lines.push(`=== 变更影响分析 - ${feature} ===`);
  lines.push(`  项目: ${root}`);
  lines.push(`  变更文件 (${changedRels.length}): ${changedRels.join(', ')}`);
  lines.push(`  方向: ${dirLabel} | 最大深度: ${max_depth} | 调用边: ${allEdges.length} 条`);
  lines.push('');
  if (impacted_files.length === 0) {
    lines.push('未分析出受影响范围（无变更文件或缓存无调用边）。');
  } else {
    const directFiles = impacted_files.filter((f) => f.direct);
    const indirectFiles = impacted_files.filter((f) => !f.direct);
    if (directFiles.length > 0) {
      lines.push('【直接受影响】');
      for (const f of directFiles) {
        lines.push(`  - ${f.path}${f.symbol_count ? ` (${f.symbol_count} 符号)` : ''}`);
      }
      lines.push('');
    }
    if (indirectFiles.length > 0) {
      lines.push(`【间接波及（${dirLabel}）】`);
      for (const f of indirectFiles) {
        lines.push(`  - ${f.path} (深度 ${f.depth}${f.symbol_count ? `, ${f.symbol_count} 符号` : ''})`);
      }
      lines.push('');
    }
    lines.push(`【受影响符号明细】`);
    for (const s of impacted_symbols) {
      lines.push(`  - ${s.file_path}#${s.qualified_name} (深度 ${s.depth}, ${s.role})`);
    }
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('【警告】');
    for (const w of warnings) lines.push(`  ⚠️ ${w}`);
    lines.push('');
  }

  return {
    feature,
    project_dir: root,
    changed: changedRels,
    direction,
    max_depth,
    impacted_files,
    impacted_symbols,
    warnings,
    has_call_edges: callCount > 0,
    message: lines.join('\n'),
  };
}