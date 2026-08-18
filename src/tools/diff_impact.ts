/**
 * diff_impact —— 变更影响分析（v4：多边类型影响图）
 *
 * 给定一组已变更文件，沿 SQLite 缓存中的三类边追溯"这次改动波及谁"：
 *   - kind='call'     符号级：A 调用 B。改 B → A 受影响（波及语义：谁调用受影响）
 *   - kind='type_ref' 符号级：A 引用类型 B（interface/type/class）。改 B → A 受影响
 *                     （call 图对此不可见——改接口签名，引用者全要改）
 *   - kind='import'   文件级：A 导入 B。改 B → A 文件受影响（粗粒度兜底：
 *                     常量/类型别名等未建符号边的依赖也计入）
 *
 * 传播模型：
 *   符号级 BFS（call + type_ref）：源=changed 符号，逐跳附 via_edge 记录首达边类；
 *   文件级 BFS（import）：源=变更文件，只沿 import 链传染文件级，不触发符号级
 *   传染（防 util 文件改动→全项目符号入图的爆炸回归）。
 *
 * 波及面命中 DSL 语义层 API（expected_apis/actual_apis 函数名）时产出
 * dsl_contract_hits——设计契约被代码变更撞上，优先复核。
 *
 * 只读，不修改 DSL。与 consistency_check（"这文件对不对"）正交——
 * 本工具回答"这个改动波及谁"。
 *
 * 关键映射：SQLite 边是符号级（"<file>#<qn>"）或文件级（file 节点 id = rel 路径），
 * DSL 渲染图主要是文件级节点。BFS 后按 file_path 聚合回 DSL 文件节点。
 */

import path from 'node:path';
import { getDSL } from '../storage.js';
import { getProjectCacheDb, type Database } from '../db/db.js';

export type ImpactDirection = 'callers' | 'callees' | 'both';
export type EdgeKind = 'call' | 'type_ref' | 'import';

export interface DiffImpactInput {
  /** 可选：提供时用于 DSL 文件节点映射（dsl_node_id）与语义路径基准；缺省纯缓存分析 */
  feature?: string;
  /** 被分析项目的根目录（其下 .design-canvas/cache.db 是符号缓存） */
  project_dir: string;
  /** 已变更文件（相对项目根的路径，或绝对路径） */
  changed: string[];
  /** 追溯方向：callers=谁调用/引用/导入受影响（默认）/ callees=受影响方 / both=双向 */
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
  /** 0=直接改动，>0=经边间接波及 */
  depth: number;
  role: 'changed' | 'caller' | 'callee';
  /** 首达边类：undefined=直接变更源；call=经调用边；type_ref=经类型引用边 */
  via_edge?: 'call' | 'type_ref';
}

export interface ImpactedFile {
  /** 相对项目根的 posix 路径 */
  path: string;
  /** 对应的 DSL 文件节点 id（feature 图里存在时才给） */
  dsl_node_id?: string;
  depth: number;
  direct: boolean;
  symbol_count: number;
  /** 该文件经何种边类被波及（多值；直接变更文件为空数组） */
  via_edges: EdgeKind[];
}

/** DSL 契约命中：波及符号撞上语义层 API（设计契约被变更波及，优先复核） */
export interface DslContractHit {
  dsl_node_id: string;
  /** 语义层文件路径 */
  path: string;
  /** 命中的 API 签名 */
  api: string;
  /** 命中字段：expected=设计契约 API / actual=代码回填 API */
  api_source: 'expected' | 'actual';
  /** 命中的波及符号（qualified_name@file） */
  matched_symbol: string;
  depth: number;
}

export interface DiffImpactResult {
  feature: string;
  project_dir: string;
  changed: string[];
  direction: ImpactDirection;
  max_depth: number;
  impacted_files: ImpactedFile[];
  impacted_symbols: ImpactedSymbol[];
  /** 每个变更文件的符号级变更明细（v3）：波及源粒度与收敛依据 */
  symbol_diffs: SymbolDiffInfo[];
  /** 波及面 ∩ DSL 语义层 API（feature 给出且命中时） */
  dsl_contract_hits: DslContractHit[];
  /** 已知警告（如缓存无边 / changed 文件不在缓存） */
  warnings: string[];
  has_call_edges: boolean;
  /** 边类计数（v4：分层追溯数据源规模） */
  edge_counts: { call: number; type_ref: number; import: number };
  message: string;
}

/** 符号级变更明细（v3）：
 *  - granularity='symbol'：波及源=changed 符号（added 无既有调用方不做源；
 *    全空=注释/格式变更，不计入波及）
 *  - granularity='file'：回退整文件所有符号做源（note 说明原因）
 */
export interface SymbolDiffInfo {
  /** 相对项目根路径（输入口径） */
  path: string;
  granularity: 'symbol' | 'file';
  added: string[];
  removed: string[];
  changed: string[];
  /** v4：符号级零差异但全文归一化 hash 变了（常量值/字符串/顶层表达式）——符号外实质变更 */
  norm_changed: boolean;
  note?: string;
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
    symbol_diffs: [],
    dsl_contract_hits: [],
    warnings,
    has_call_edges: false,
    edge_counts: { call: 0, type_ref: 0, import: 0 },
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

const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  call: '调用边',
  type_ref: '类型引用',
  import: 'import 依赖',
};

export function diffImpact(input: DiffImpactInput): DiffImpactResult {
  const { feature, project_dir, changed, direction = 'callers', max_depth = 3 } = input;
  const root = path.resolve(project_dir);
  const warnings: string[] = [];

  const dsl = feature ? getDSL(feature) : undefined;
  if (feature && !dsl) {
    throw new Error(`feature "${feature}" 不存在`);
  }

  // 语义文件路径 → DSL 文件节点 id 的权威映射（来自 feature 的 semantic.files）。
  // 不用字符串拼接 file_<rel>：feature 生成时 rel 基准可能不是项目根（如 self_analyze 以 src/ 为根）。
  // feature 缺省时跳过 DSL 映射，纯缓存分析（dsl_node_id 缺失）。
  const semanticFiles = dsl?.semantic?.files ?? [];
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
      feature ?? path.basename(root), root, changedRels, direction, max_depth,
      [`无法打开缓存 ${path.join(root, '.design-canvas', 'cache.db')}：${(e as Error).message}。请先对该项目运行 import_project 建缓存。`],
      `变更影响分析失败：无法打开符号缓存。请先对该项目运行 import_project。`,
    );
  }

  // ── 多边类数据源规模 ──
  const countOf = (kind: string): number =>
    (db.prepare('SELECT COUNT(*) c FROM edges WHERE kind = ?').get(kind) as { c: number }).c;
  const edge_counts = { call: countOf('call'), type_ref: countOf('type_ref'), import: countOf('import') };
  if (edge_counts.call === 0 && edge_counts.type_ref === 0 && edge_counts.import === 0) {
    warnings.push('缓存中没有任何边（call/type_ref/import）。请先对该项目运行 import_project 建立符号缓存。');
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

  // ── 直接受影响符号（v3：优先符号级收敛，回退文件级）──
  // 每个变更文件先查 symbol_diffs：changed 符号做波及源（depth=0）；
  // added 不做源（新符号无既有调用方）；全空 = 注释/格式变更，不计入波及；
  // 含 removed / 无 diff 行 → 保守回退整文件所有符号做源。
  const direct: ImpactedSymbol[] = [];
  const symbol_diffs: SymbolDiffInfo[] = [];
  const collectRows = (rows: Array<{ id: string; name: string; qualified_name: string; start_line: number }>): void => {
    for (const r of rows) {
      direct.push({
        id: r.id,
        name: r.name,
        qualified_name: r.qualified_name,
        file_path: r.id.split('#')[0],
        start_line: r.start_line,
        depth: 0,
        role: 'changed',
      });
    }
  };
  const parseQnList = (j: string): string[] => {
    try {
      return JSON.parse(j) as string[];
    } catch {
      return [];
    }
  };
  for (const { rel, cachePath } of changedSemantic) {
    const diffRow = db
      .prepare('SELECT from_hash, to_hash, added, removed, changed, norm_from, norm_to FROM symbol_diffs WHERE file_path = ?')
      .get(cachePath) as
      | { from_hash: string; to_hash: string; added: string; removed: string; changed: string; norm_from: string; norm_to: string }
      | undefined;
    const filesRow = db.prepare('SELECT content_hash FROM files WHERE path = ?').get(cachePath) as
      | { content_hash: string }
      | undefined;

    if (diffRow && filesRow && diffRow.to_hash === filesRow.content_hash) {
      const added = parseQnList(diffRow.added);
      const removed = parseQnList(diffRow.removed);
      const changed = parseQnList(diffRow.changed);
      // v4：符号级零差异 ≠ 无实质变更——norm hash 变了（常量值/字符串）= 符号外实质变更。
      // 符号数组已有任一差异（added/removed/changed）时，norm 变化可由符号变更解释，
      // 不算符号外变更（否则 added-only 恒 norm_changed，波及面误含变更文件自身）
      const normChanged =
        diffRow.norm_from !== diffRow.norm_to && added.length === 0 && removed.length === 0 && changed.length === 0;
      if (removed.length > 0) {
        // 删除符号的入边已随节点级联消失，无法定位受影响调用方 → 保守按整文件分析
        symbol_diffs.push({ path: rel, granularity: 'file', added, removed, changed, norm_changed: normChanged, note: `含删除符号（${removed.join(', ')}）——入边已消失，保守按文件级分析` });
        const rows = db
          .prepare("SELECT id, name, qualified_name, start_line FROM nodes WHERE file_path = ? AND kind != 'file' ORDER BY start_line, id")
          .all(cachePath) as Array<{ id: string; name: string; qualified_name: string; start_line: number }>;
        if (rows.length === 0) warnings.push(`变更文件 ${rel} 不在缓存中（可能未同步、删除了符号，或非受支持语言）。`);
        collectRows(rows);
      } else if (changed.length > 0) {
        symbol_diffs.push({ path: rel, granularity: 'symbol', added, removed, changed, norm_changed: normChanged });
        const ph = changed.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT id, name, qualified_name, start_line FROM nodes WHERE file_path = ? AND kind != 'file' AND qualified_name IN (${ph}) ORDER BY start_line, id`)
          .all(cachePath, ...changed) as Array<{ id: string; name: string; qualified_name: string; start_line: number }>;
        collectRows(rows);
      } else {
        symbol_diffs.push({
          path: rel, granularity: 'symbol', added, removed, changed, norm_changed: normChanged,
          note: added.length > 0
            ? `仅新增符号（${added.join(', ')}）——无既有调用方，不扩散`
            : normChanged
              ? '无符号级变更但存在符号外实质变更（常量值/字符串/顶层表达式）——波及按文件级（import 层兜底）'
              : '无实质符号变更（注释/空白/格式）——不计入波及',
        });
      }
    } else {
      symbol_diffs.push({ path: rel, granularity: 'file', added: [], removed: [], changed: [], norm_changed: true, note: '无符号级 diff（首次导入/旧缓存/未同步）——按文件级分析' });
      const rows = db
        .prepare("SELECT id, name, qualified_name, start_line FROM nodes WHERE file_path = ? AND kind != 'file' ORDER BY start_line, id")
        .all(cachePath) as Array<{ id: string; name: string; qualified_name: string; start_line: number }>;
      if (rows.length === 0) warnings.push(`变更文件 ${rel} 不在缓存中（可能未同步、删除了符号，或非受支持语言）。`);
      collectRows(rows);
    }
  }

  // ── 加载符号级边（call + type_ref），建正/反向邻接表（附边类）──
  // 两类边同构：source 依赖 target → 改 target 波及 source（callers 侧）。
  interface SymAdjEntry { to: string; kind: 'call' | 'type_ref' }
  const symRev = new Map<string, SymAdjEntry[]>(); // target → 依赖它的 source（callers 方向展开）
  const symFwd = new Map<string, SymAdjEntry[]>(); // source → 它依赖的 target（callees 方向展开）
  const symEdgeRows = db
    .prepare("SELECT source, target, kind FROM edges WHERE kind IN ('call','type_ref')")
    .all() as Array<{ source: string; target: string; kind: 'call' | 'type_ref' }>;
  for (const e of symEdgeRows) {
    let rs = symRev.get(e.target);
    if (!rs) symRev.set(e.target, (rs = []));
    rs.push({ to: e.source, kind: e.kind });
    let fs = symFwd.get(e.source);
    if (!fs) symFwd.set(e.source, (fs = []));
    fs.push({ to: e.target, kind: e.kind });
  }

  // ── 加载文件级 import 边邻接表（file 节点 id = 缓存基准相对路径）──
  const importerOf = new Map<string, string[]>(); // 被导入文件 → 导入它的文件
  const importeeOf = new Map<string, string[]>(); // 导入方 → 被导入的文件
  const importRows = db
    .prepare("SELECT source, target FROM edges WHERE kind = 'import'")
    .all() as Array<{ source: string; target: string }>;
  for (const e of importRows) {
    let im = importerOf.get(e.target);
    if (!im) importerOf.set(e.target, (im = []));
    im.push(e.source);
    let ie = importeeOf.get(e.source);
    if (!ie) importeeOf.set(e.source, (ie = []));
    ie.push(e.target);
  }
  // 注意：不 close db——getProjectCacheDb 返回的是连接池连接，由池统一管理
  //（测试隔离用 closeAllProjectCacheDbs；此处复用，避免与 import_project 缓存路径互踩）

  // ── 符号级 BFS（call + type_ref，附首达边类）──
  const reached = new Map<string, { depth: number; via?: 'call' | 'type_ref' }>();
  const roles = new Map<string, ImpactedSymbol['role']>();
  for (const s of direct) {
    reached.set(s.id, { depth: 0 });
    roles.set(s.id, 'changed');
  }

  let frontier = direct.map((s) => s.id);
  for (let depth = 1; depth <= max_depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const expand = (adj: Map<string, SymAdjEntry[]>, role: ImpactedSymbol['role']) => {
        for (const t of adj.get(id) || []) {
          if (reached.has(t.to)) continue;
          reached.set(t.to, { depth, via: t.kind });
          roles.set(t.to, role);
          next.push(t.to);
        }
      };
      if (direction === 'callers' || direction === 'both') expand(symRev, 'caller');
      if (direction === 'callees' || direction === 'both') expand(symFwd, 'callee');
    }
    frontier = next;
  }

  // ── 文件级 BFS（import 边：只传染文件级，不触发符号级传染）──
  // 叠加规则：import 层是【符号提取盲区的兜底】，不无条件叠加——
  //   - 符号级精准判定（changed 非空）：波及已沿 call/type_ref 符号边传染到真实
  //     依赖方，再叠 import 层会把"只用未变符号的导入方"拉回波及面（虚报回归）
  //   - 仅新增 / 纯注释格式：无波及
  //   - 符号级全空但 norm_changed（常量值/字符串等符号外变更）：唯一启用 import
  //     层的场景——无符号可指，import 依赖是仅剩的波及通道
  //   - 变更符号含顶层 const：常量不是函数调用也不是类型引用，天然没有
  //     call/type_ref 边；导入方的 import 语句本身就是使用它的唯一证据
  //     ——启用 import 层兜底（粗粒度宁多勿漏，与 import 层定位一致）
  const diffByPath = new Map(symbol_diffs.map((d) => [d.path, d]));
  const stmtKinds = db.prepare('SELECT kind FROM nodes WHERE file_path = ? AND name = ?');
  const importSources = new Set<string>();
  for (const { rel, cachePath } of changedSemantic) {
    const d = diffByPath.get(rel);
    if (!d || d.granularity !== 'symbol') continue;
    const noSymbolChange = d.changed.length === 0 && d.added.length === 0 && d.norm_changed;
    const hasConstChange = d.changed.some((name) => {
      const row = stmtKinds.get(rel, name) as { kind: string } | undefined;
      return row?.kind === 'const';
    });
    if (noSymbolChange || hasConstChange) importSources.add(cachePath);
  }
  const importReached = new Map<string, number>(); // file → depth（via='import'）
  let importFrontier: string[] = [];
  for (const cachePath of importSources) {
    importReached.set(cachePath, 0);
    importFrontier.push(cachePath);
  }
  for (let depth = 1; depth <= max_depth && importFrontier.length > 0; depth++) {
    const next: string[] = [];
    for (const f of importFrontier) {
      const expandFiles = (adj: Map<string, string[]>) => {
        for (const t of adj.get(f) || []) {
          if (importReached.has(t)) continue;
          importReached.set(t, depth);
          next.push(t);
        }
      };
      if (direction === 'callers' || direction === 'both') expandFiles(importerOf);
      if (direction === 'callees' || direction === 'both') expandFiles(importeeOf);
    }
    importFrontier = next;
  }

  // ── 组装受影响符号（含直接 + 间接）──
  const impacted_symbols: ImpactedSymbol[] = [];
  for (const [id, info] of reached) {
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
      depth: info.depth,
      role: roles.get(id) ?? 'changed',
      via_edge: info.via,
    });
  }
  impacted_symbols.sort((a, b) => a.depth - b.depth || a.file_path.localeCompare(b.file_path) || a.start_line - b.start_line);

  // ── 聚合到文件级（via_edges = 符号首达边类 ∪ import 波及）──
  const fileMeta = new Map<string, { depth: number; direct: boolean; count: number; via: Set<EdgeKind> }>();
  const mergeFile = (file: string, depth: number, directFlag: boolean, via?: EdgeKind): void => {
    const m = fileMeta.get(file) || { depth: Infinity, direct: false, count: 0, via: new Set<EdgeKind>() };
    if (directFlag) m.direct = true;
    if (depth < m.depth) m.depth = depth;
    if (via) m.via.add(via);
    fileMeta.set(file, m);
  };
  for (const s of impacted_symbols) {
    const m = fileMeta.get(s.file_path) || { depth: Infinity, direct: false, count: 0, via: new Set<EdgeKind>() };
    if (s.depth === 0) m.direct = true;
    if (s.depth < m.depth) m.depth = s.depth;
    if (s.via_edge) m.via.add(s.via_edge);
    m.count++;
    fileMeta.set(s.file_path, m);
  }
  for (const [file, depth] of importReached) {
    // 深度 0 的起点即变更文件本身（direct 语义由符号级/兜底循环补）
    mergeFile(file, depth, depth === 0, depth === 0 ? undefined : 'import');
  }
  // 直接改动但无符号的文件（如空文件/纯常量文件）也计入直接受影响——
  // 除非符号级判定"无实质变更/仅新增"（注释格式调整不该出现在波及清单里）
  const hasRealChange = (rel: string): boolean => {
    const d = diffByPath.get(rel);
    if (!d) return true;
    return d.granularity === 'file' || d.changed.length > 0 || d.norm_changed;
  };
  for (const { rel, cachePath } of changedSemantic) {
    if (!hasRealChange(rel)) continue;
    mergeFile(cachePath, 0, true);
  }

  const dslNodeIds = new Set((dsl?.geometry.nodes || []).map((n) => n.id));
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
        via_edges: [...m.via],
      };
    })
    .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  // ── DSL 契约命中：波及符号（含直接变更）撞上语义层 API ──
  const dsl_contract_hits: DslContractHit[] = [];
  if (semanticFiles.length > 0) {
    const fnNameOf = (sig: string): string | undefined => {
      const head = sig.split('(')[0].trim();
      return head.split('.').pop()?.trim() || undefined;
    };
    // 预索引：语义文件 path → 函数名 → API（expected 优先于 actual）
    for (const sf of semanticFiles) {
      if (!sf.path) continue;
      const apiList: Array<{ sig: string; src: 'expected' | 'actual' }> = [
        ...(sf.expected_apis ?? []).map((a) => ({ sig: a.signature, src: 'expected' as const })),
        ...(sf.actual_apis ?? []).map((a) => ({ sig: a.signature, src: 'actual' as const })),
      ];
      for (const { sig, src } of apiList) {
        const fn = fnNameOf(sig);
        if (!fn) continue;
        const hit = impacted_symbols.find(
          (s) => s.name === fn && resolveSemanticPath(s.file_path) === sf.path,
        );
        if (hit) {
          dsl_contract_hits.push({
            dsl_node_id: sf.id,
            path: sf.path,
            api: sig,
            api_source: src,
            matched_symbol: `${hit.qualified_name}@${hit.file_path}`,
            depth: hit.depth,
          });
        }
      }
    }
    dsl_contract_hits.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  }

  // ── 文本报告 ──
  const dirLabel = direction === 'callers' ? '谁调用/引用/导入受影响' : direction === 'callees' ? '受影响调用了谁' : '双向追溯';
  const lines: string[] = [];
  lines.push(`=== 变更影响分析 - ${feature ?? path.basename(root)} ===`);
  lines.push(`  项目: ${root}`);
  lines.push(`  变更文件 (${changedRels.length}): ${changedRels.join(', ')}`);
  lines.push(`  方向: ${dirLabel} | 最大深度: ${max_depth}`);
  lines.push(`  边: 调用 ${edge_counts.call} | 类型引用 ${edge_counts.type_ref} | import ${edge_counts.import}`);
  lines.push('');
  if (symbol_diffs.length > 0) {
    lines.push('【符号级变更】');
    for (const d of symbol_diffs) {
      const parts: string[] = [];
      if (d.changed.length > 0) parts.push(`改 ${d.changed.join(',')}`);
      if (d.added.length > 0) parts.push(`增 ${d.added.join(',')}`);
      if (d.removed.length > 0) parts.push(`删 ${d.removed.join(',')}`);
      const desc = parts.length > 0 ? parts.join('；') : (d.note ?? '无实质符号变更');
      const noteSuffix = parts.length > 0 && d.note ? `（${d.note}）` : '';
      lines.push(`  - ${d.path}: ${desc}${noteSuffix}`);
    }
    lines.push('');
  }
  if (impacted_files.length === 0) {
    lines.push('未分析出受影响范围（无变更文件或缓存无边）。');
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
      lines.push(`【间接波及（${dirLabel}，按边类分层）】`);
      const byKind = new Map<EdgeKind, ImpactedFile[]>();
      for (const f of indirectFiles) {
        for (const k of f.via_edges.length > 0 ? f.via_edges : (['call'] as EdgeKind[])) {
          let arr = byKind.get(k);
          if (!arr) byKind.set(k, (arr = []));
          arr.push(f);
        }
      }
      for (const kind of ['call', 'type_ref', 'import'] as EdgeKind[]) {
        const arr = byKind.get(kind);
        if (!arr || arr.length === 0) continue;
        lines.push(`  ▸ 经${EDGE_KIND_LABEL[kind]} (${arr.length} 文件):`);
        for (const f of arr) {
          lines.push(`    - ${f.path} (深度 ${f.depth}${f.symbol_count ? `, ${f.symbol_count} 符号` : ''})`);
        }
      }
      lines.push('');
    }
    if (dsl_contract_hits.length > 0) {
      lines.push('【DSL 契约命中】（波及符号撞上设计契约 API——优先复核）');
      for (const h of dsl_contract_hits) {
        lines.push(`  - ${h.path} [${h.dsl_node_id}] ${h.api} ← ${h.matched_symbol} (深度 ${h.depth}, ${h.api_source})`);
      }
      lines.push('');
    }
    lines.push(`【受影响符号明细】`);
    for (const s of impacted_symbols) {
      const via = s.via_edge ? ` via ${s.via_edge}` : '';
      lines.push(`  - ${s.file_path}#${s.qualified_name} (深度 ${s.depth}, ${s.role}${via})`);
    }
    lines.push('');
  }
  if (warnings.length > 0) {
    lines.push('【警告】');
    for (const w of warnings) lines.push(`  ⚠️ ${w}`);
    lines.push('');
  }

  return {
    feature: feature ?? path.basename(root),
    project_dir: root,
    changed: changedRels,
    direction,
    max_depth,
    impacted_files,
    impacted_symbols,
    symbol_diffs,
    dsl_contract_hits,
    warnings,
    has_call_edges: edge_counts.call > 0,
    edge_counts,
    message: lines.join('\n'),
  };
}
