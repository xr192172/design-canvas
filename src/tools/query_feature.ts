/**
 * query_feature 工具：统一读操作入口
 *
 * 合并原 9 个查询工具（get_dsl / list_features / list_annotations / list_approvals /
 * list_snapshots / list_templates / get_simulation_state / get_approval_history / diff_features），
 * 通过 { query, ...params } 单点调用，减少 LLM 工具选择成本。
 *
 * 细粒度查询（DSL 替代 read/grep/search）：
 *   节点/边/文件级结构化查询，LLM 按需获取 DSL 局部信息，无需全量读取。
 *   - nodes：列出所有节点摘要（id/label/type/layer/status）
 *   - edges：列出所有边摘要（id/from/to/label/type）
 *   - node：获取单个节点详情（需 node_id）
 *   - files：列出所有语义文件摘要（id/path/responsibility/status/lines）
 *   - file：获取单个文件详情（需 file_id，含 expected_apis/actual_apis/deps/symbols）
 *   - calls：查询文件的调用关系（需 file_id + project_dir，显示入/出调用）
 *
 * query 类型与参数映射：
 *   dsl              → get_dsl          { feature }
 *   features         → list_features    {}
 *   nodes            → list_nodes       { feature, layer?, type? }
 *   edges            → list_edges       { feature, layer? }
 *   node             → get_node         { feature, node_id }
 *   files            → list_files       { feature, layer?, status? }
 *   file             → get_file         { feature, file_id }
 *   calls            → get_calls        { feature, file_id, project_dir }
 *   annotations      → list_annotations { feature, node_id?, severity?, unresolved_only? }
 *   approvals        → list_approvals   { feature, status?, assignee? }
 *   approval_history → get_approval_history { feature, annotation_id }
 *   snapshots        → list_snapshots   { feature }
 *   templates        → list_templates   {}
 *   simulation_state → get_simulation_state { feature }
 *   diff             → diff_features    { feature_a, feature_b }
 */

import { getDSLByView, listFeatures as listStoredFeatures } from '../storage.js';
import type { DSLView } from '../storage.js';
import { listAnnotations } from './annotation_tools.js';
import { listApprovals, getApprovalHistory } from './approval.js';
import { listSnapshots } from './snapshot.js';
import { listTemplates } from './templates.js';
import { getSimulationState } from './simulation.js';
import { diffFeatures } from './diff.js';
import type { Node, Edge } from '../dsl/geometry.js';
import type { SemanticFile } from '../dsl/semantic.js';
import { getProjectCacheDb } from '../db/db.js';
import type { Database } from '../db/db.js';

export interface QueryFeatureInput {
  /** 查询类型 */
  query:
    | 'dsl'
    | 'features'
    | 'nodes'
    | 'edges'
    | 'node'
    | 'files'
    | 'file'
    | 'calls'
    | 'annotations'
    | 'approvals'
    | 'approval_history'
    | 'snapshots'
    | 'templates'
    | 'simulation_state'
    | 'diff';
  /** feature 名（dsl/nodes/edges/node/files/file/annotations/approvals/approval_history/snapshots/simulation_state 必填；features/templates 忽略；diff 用 feature_a/feature_b） */
  feature?: string;
  /** node：节点 ID */
  node_id?: string;
  /** file：文件 ID（对应 SemanticFile.id = geometry Node.id） */
  file_id?: string;
  /** nodes：按职责分层过滤（main/error/detail） */
  layer?: 'main' | 'error' | 'detail';
  /** nodes：按节点类型过滤（如 service/module/database/api/queue/ui） */
  type?: string;
  /** files：按架构层过滤（如 api/service/data/ui） */
  file_layer?: string;
  /** files：按实现状态过滤 */
  file_status?: 'draft' | 'in_progress' | 'done';
  /** annotations：按节点 ID 过滤 */
  annotation_node_id?: string;
  /** annotations：按严重程度过滤 */
  severity?: 'info' | 'warning' | 'critical';
  /** annotations：只显示未解决的 */
  unresolved_only?: boolean;
  /** approvals：按状态过滤 */
  status?: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'needs_revision';
  /** approvals：按指派人过滤 */
  assignee?: string;
  /** approval_history：标注 ID */
  annotation_id?: string;
  /** diff：源 feature */
  feature_a?: string;
  /** diff：目标 feature */
  feature_b?: string;
  /** 视图层级：design（默认，活态文件）/ live（实际代码快照，仅 query=dsl/nodes/edges/node/files/file 生效） */
  view?: DSLView;
  /** diff：feature_b 视图层级，默认跟随 view（design）；对比"设计 vs 代码现状"时传 live 以读取实际快照 */
  view_b?: DSLView;
  /** calls：项目根目录（用于打开 cache.db 查询调用关系） */
  project_dir?: string;
}

export interface QueryFeatureResult {
  message: string;
  /** 原始数据（供 LLM 进一步处理） */
  data?: unknown;
}

function requireFeature(input: QueryFeatureInput): string {
  const f = input.feature;
  if (!f) throw new Error(`query "${input.query}" 需要 feature 参数`);
  return f;
}

/** 获取 DSL，支持 design/live 视图 */
function loadDSL(input: QueryFeatureInput) {
  const feature = requireFeature(input);
  const dsl = getDSLByView(feature, input.view ?? 'design');
  if (!dsl) throw new Error(`feature "${feature}" 不存在（视图: ${input.view ?? 'design'}）`);
  return dsl;
}

/** 查询 cache.db 中指定文件的调用关系 */
function queryFileCalls(db: Database, fileId: string, relPath: string): { incoming: Array<{ caller: string; callee: string; line: number; cross: boolean }>; outgoing: Array<{ caller: string; callee: string; line: number; cross: boolean }> } {
  // 前缀匹配：fileId 是文件节点 ID（如 "file_src_tools_a_ts"），
  // 符号节点 ID 为 "file_rel#SymbolName"，用 fileId 前缀匹配 source/target
  const prefix = `${fileId}#`;

  // 入调用：本文件符号被其他文件调用（target 以本文件前缀开头）
  const incoming = db
    .prepare(
      `SELECT e.source, e.target, e.line, e.metadata
       FROM edges e
       WHERE e.kind = 'call' AND e.target LIKE ?`,
    )
    .all(`${prefix}%`) as Array<{ source: string; target: string; line: number; metadata: string | null }>;

  // 出调用：本文件调用其他文件符号（source 以本文件前缀开头）
  const outgoing = db
    .prepare(
      `SELECT e.source, e.target, e.line, e.metadata
       FROM edges e
       WHERE e.kind = 'call' AND e.source LIKE ?`,
    )
    .all(`${prefix}%`) as Array<{ source: string; target: string; line: number; metadata: string | null }>;

  return {
    incoming: incoming.map((e) => ({
      caller: e.source,
      callee: e.target,
      line: e.line,
      cross: e.metadata ? (JSON.parse(e.metadata) as { cross?: boolean }).cross ?? false : false,
    })),
    outgoing: outgoing.map((e) => ({
      caller: e.source,
      callee: e.target,
      line: e.line,
      cross: e.metadata ? (JSON.parse(e.metadata) as { cross?: boolean }).cross ?? false : false,
    })),
  };
}

/** 将符号节点 ID 解析为可读名（"file_rel#SymbolName" → "SymbolName"） */
function symbolNameFromId(nodeId: string): string {
  const hash = nodeId.lastIndexOf('#');
  return hash === -1 ? nodeId : nodeId.slice(hash + 1);
}

/** 将符号节点 ID 解析为来源文件路径（"file_rel#SymbolName" → "rel" 或 "file_rel" → "rel"） */
function filePathFromId(nodeId: string): string {
  const prefix = 'file_';
  if (!nodeId.startsWith(prefix)) return nodeId;
  const afterPrefix = nodeId.slice(prefix.length);
  const hash = afterPrefix.lastIndexOf('#');
  const raw = hash === -1 ? afterPrefix : afterPrefix.slice(0, hash);
  // 反 sanitize：_ 恢复为路径分隔符（import_project 中 sanitize 把非 [a-zA-Z0-9_-] 替换为 _）
  // 但这是不可逆的，只能展示原始 nodeId
  return raw;
}

export function queryFeature(input: QueryFeatureInput): QueryFeatureResult {
  const currentView = input.view ?? 'design';
  const viewTag = `(视图: ${currentView})`;

  switch (input.query) {
    // ── 全量 DSL 摘要：结构化展示，替代原始 JSON 倾倒 ──────────
    case 'dsl': {
      const dsl = loadDSL(input);
      const nodes = dsl.geometry?.nodes ?? [];
      const edges = dsl.geometry?.edges ?? [];
      const files = dsl.semantic?.files ?? [];
      const invariants = dsl.semantic?.multi_file_invariants ?? [];

      const lines: string[] = [
        `══ feature "${dsl.feature}" ${viewTag} ══`,
        `  ID: ${dsl.id} · 状态: ${dsl.status ?? 'draft'}${dsl.version ? ` · 版本: ${dsl.version}` : ''}`,
        '',
        `  ─ 几何层 ─`,
      ];

      // 节点摘要
      if (nodes.length === 0) {
        lines.push('  节点: (无)');
      } else {
        lines.push(`  节点 (${nodes.length}):`);
        nodes.forEach((n) => {
          const layer = n.layer ?? 'main';
          const type = n.type ?? '-';
          const status = n.status ?? '-';
          lines.push(`    [${n.id}] ${n.label ?? n.title ?? n.id} (${type}, ${layer}, ${status})`);
        });
      }

      // 边摘要
      if (edges.length === 0) {
        lines.push('  边: (无)');
      } else {
        lines.push(`  边 (${edges.length}):`);
        edges.forEach((e) => {
          const label = e.label ? ` "${e.label}"` : '';
          lines.push(`    [${e.id}] ${e.from} → ${e.to}${label}`);
        });
      }

      lines.push('', '  ─ 语义层 ─');

      // 文件摘要
      if (files.length === 0) {
        lines.push('  文件: (无)');
      } else {
        lines.push(`  文件 (${files.length}):`);
        files.forEach((f) => {
          const apiCount = f.expected_apis?.length ?? 0;
          const symCount = f.symbols?.length ?? 0;
          const status = f.status ?? '-';
          const layer = f.layer ?? '-';
          lines.push(`    [${f.id}] ${f.path} (${status}, ${layer}, ${apiCount} API, ${symCount} 符号)`);
        });
      }

      // 不变式摘要
      if (invariants.length === 0) {
        lines.push('  不变式: (无)');
      } else {
        lines.push(`  不变式 (${invariants.length}):`);
        invariants.forEach((inv, i) => {
          lines.push(`    ${i + 1}. ${inv}`);
        });
      }

      lines.push('', '  (需要更多细节请使用 nodes/edges/files/file 查询)');

      return {
        message: lines.join('\n'),
        data: dsl,
      };
    }

    case 'features': {
      const dsls = listStoredFeatures();
      if (dsls.length === 0) return { message: '尚无已设计的 feature', data: [] };
      const lines = dsls.map((dsl, i) => {
        const fileCount = dsl.semantic?.files?.length ?? 0;
        const invariantCount = dsl.semantic?.multi_file_invariants?.length ?? 0;
        const status = dsl.status ?? 'draft';
        return `${i + 1}. ${dsl.feature} (${status}, ${fileCount} 文件, ${invariantCount} 不变式) [${dsl.id}]`;
      });
      return {
        message: ['已设计的 feature：', ...lines].join('\n'),
        data: dsls.map((d) => ({ id: d.id, feature: d.feature, status: d.status })),
      };
    }

    // ── 细粒度查询：节点列表 ──────────────────────────────────
    case 'nodes': {
      const dsl = loadDSL(input);
      const nodes = dsl.geometry?.nodes ?? [];
      let filtered = nodes;
      if (input.layer) filtered = filtered.filter((n) => (n.layer ?? 'main') === input.layer);
      if (input.type) filtered = filtered.filter((n) => n.type === input.type);

      if (filtered.length === 0) {
        return { message: `feature "${dsl.feature}" 无匹配节点 ${viewTag}`, data: [] };
      }

      const lines = filtered.map((n, i) => {
        const layer = n.layer ?? 'main';
        const type = n.type ?? '-';
        const status = n.status ?? '-';
        return `${i + 1}. [${n.id}] ${n.label ?? n.title ?? n.id} (type: ${type}, layer: ${layer}, status: ${status})`;
      });
      const summary = `节点总数: ${nodes.length}，匹配: ${filtered.length}`;
      return {
        message: [`feature "${dsl.feature}" 节点列表 ${viewTag}`, summary, '', ...lines].join('\n'),
        data: filtered.map((n) => ({
          id: n.id,
          label: n.label ?? n.title,
          type: n.type,
          layer: n.layer ?? 'main',
          status: n.status,
          swimlane: n.swimlane,
          arch_layer: n.arch_layer,
        })),
      };
    }

    // ── 细粒度查询：边列表 ────────────────────────────────────
    case 'edges': {
      const dsl = loadDSL(input);
      const edges = dsl.geometry?.edges ?? [];
      let filtered = edges;
      if (input.layer) filtered = filtered.filter((e) => (e.layer ?? 'main') === input.layer);

      if (filtered.length === 0) {
        return { message: `feature "${dsl.feature}" 无边 ${viewTag}`, data: [] };
      }

      const lines = filtered.map((e, i) => {
        const type = e.type ?? 'straight';
        const arrow = e.arrow ?? 'forward';
        const layer = e.layer ?? 'main';
        const label = e.label ? ` "${e.label}"` : '';
        return `${i + 1}. [${e.id}] ${e.from} → ${e.to}${label} (type: ${type}, arrow: ${arrow}, layer: ${layer})`;
      });
      const summary = `边总数: ${edges.length}，匹配: ${filtered.length}`;
      return {
        message: [`feature "${dsl.feature}" 边列表 ${viewTag}`, summary, '', ...lines].join('\n'),
        data: filtered.map((e) => ({
          id: e.id,
          from: e.from,
          to: e.to,
          label: e.label,
          type: e.type ?? 'straight',
          arrow: e.arrow ?? 'forward',
          layer: e.layer ?? 'main',
        })),
      };
    }

    // ── 细粒度查询：单个节点详情 ──────────────────────────────
    case 'node': {
      const dsl = loadDSL(input);
      if (!input.node_id) throw new Error('query "node" 需要 node_id 参数');
      const node = (dsl.geometry?.nodes ?? []).find((n) => n.id === input.node_id);
      if (!node) throw new Error(`feature "${dsl.feature}" 中不存在节点 "${input.node_id}"`);

      const lines: string[] = [
        `节点: [${node.id}]`,
        `  标签: ${node.label ?? '-'}`,
        `  标题: ${node.title ?? '-'}`,
        `  类型: ${node.type ?? '-'}`,
        `  职责分层: ${node.layer ?? 'main'}`,
        `  状态: ${node.status ?? '-'}`,
        `  架构层: ${node.arch_layer ?? '-'}`,
        `  泳道: ${node.swimlane ?? '-'}`,
        node.description ? `  描述: ${node.description}` : '',
        `  位置: (${node.x ?? 'auto'}, ${node.y ?? 'auto'}) ${node.width ?? 'auto'}×${node.height ?? 'auto'}`,
        node.sub_dsl ? `  子图: ${node.sub_dsl.feature ?? '（内联 DSL）'}` : '',
      ].filter(Boolean);

      // 如有内容块，展示摘要
      if (node.content) {
        lines.push(`  内容类型: ${node.content.type}`);
        if (node.content.blocks) {
          const blockSummary = node.content.blocks.map((b) => {
            if (b.type === 'text') return `text: ${(b.value ?? '').slice(0, 60)}`;
            if (b.type === 'code') return `code: ${(b.value ?? '').slice(0, 40)}`;
            if (b.type === 'list') return `list (${b.items?.length ?? 0} 项)`;
            return b.type;
          });
          lines.push(`  内容块 (${node.content.blocks.length}): ${blockSummary.join(' | ')}`);
        }
      }

      // 关联的语义文件
      const file = (dsl.semantic?.files ?? []).find((f) => f.id === node.id);
      if (file) {
        lines.push(`  关联文件: ${file.path}`);
        lines.push(`  文件职责: ${file.responsibility}`);
      }

      return {
        message: [`feature "${dsl.feature}" 节点详情 ${viewTag}`, '', ...lines].join('\n'),
        data: node,
      };
    }

    // ── 细粒度查询：文件列表 ──────────────────────────────────
    case 'files': {
      const dsl = loadDSL(input);
      const files = dsl.semantic?.files ?? [];
      let filtered = files;
      if (input.file_layer) filtered = filtered.filter((f) => f.layer === input.file_layer);
      if (input.file_status) filtered = filtered.filter((f) => f.status === input.file_status);

      if (filtered.length === 0) {
        return { message: `feature "${dsl.feature}" 无语义文件 ${viewTag}`, data: [] };
      }

      const lines = filtered.map((f, i) => {
        const apiCount = f.expected_apis?.length ?? 0;
        const actualCount = f.actual_apis?.length ?? 0;
        const symCount = f.symbols?.length ?? 0;
        const status = f.status ?? '-';
        const layer = f.layer ?? '-';
        const linesInfo = f.lines ? ` ${f.lines}行` : '';
        return `${i + 1}. [${f.id}] ${f.path} (${status}, ${layer}, ${apiCount} 预期API/${actualCount} 已实现, ${symCount} 符号${linesInfo})`;
      });
      const summary = `文件总数: ${files.length}，匹配: ${filtered.length}`;
      return {
        message: [`feature "${dsl.feature}" 文件列表 ${viewTag}`, summary, '', ...lines].join('\n'),
        data: filtered.map((f) => ({
          id: f.id,
          path: f.path,
          responsibility: f.responsibility,
          status: f.status,
          layer: f.layer,
          lines: f.lines,
          apiCount: f.expected_apis?.length ?? 0,
          actualCount: f.actual_apis?.length ?? 0,
          symbolCount: f.symbols?.length ?? 0,
        })),
      };
    }

    // ── 细粒度查询：单个文件详情 ──────────────────────────────
    case 'file': {
      const dsl = loadDSL(input);
      if (!input.file_id) throw new Error('query "file" 需要 file_id 参数');
      const file = (dsl.semantic?.files ?? []).find((f) => f.id === input.file_id);
      if (!file) throw new Error(`feature "${dsl.feature}" 中不存在文件 "${input.file_id}"`);

      const lines: string[] = [
        `文件: [${file.id}]`,
        `  路径: ${file.path}`,
        `  职责: ${file.responsibility}`,
        `  状态: ${file.status ?? '-'}`,
        `  架构层: ${file.layer ?? '-'}`,
        file.lines ? `  行数: ${file.lines}` : '',
        '',
      ];

      // 预期 API
      if (file.expected_apis && file.expected_apis.length > 0) {
        lines.push('  预期 API:');
        file.expected_apis.forEach((api, i) => {
          lines.push(`    ${i + 1}. ${api.signature}${api.notes ? ` — ${api.notes}` : ''}`);
        });
      } else {
        lines.push('  预期 API: (无)');
      }

      // 已实现 API
      if (file.actual_apis && file.actual_apis.length > 0) {
        lines.push('');
        lines.push('  已实现 API:');
        file.actual_apis.forEach((api, i) => {
          lines.push(`    ${i + 1}. ${api.signature}${api.notes ? ` — ${api.notes}` : ''}`);
        });
      }

      // 依赖
      if (file.expected_deps && file.expected_deps.length > 0) {
        lines.push('');
        lines.push('  依赖:');
        file.expected_deps.forEach((dep) => lines.push(`    - ${dep}`));
      }

      // 符号表（end_line 可能不存在，做防呆处理）
      if (file.symbols && file.symbols.length > 0) {
        lines.push('');
        lines.push('  符号表:');
        file.symbols.forEach((sym, i) => {
          const range = sym.end_line ? `L${sym.line}-${sym.end_line}` : `L${sym.line}`;
          const sig = sym.signature ? ` — ${sym.signature}` : '';
          lines.push(`    ${i + 1}. ${sym.kind}: ${sym.name} (${range})${sig}`);
        });
      }

      // 行为描述
      if (file.expected_behavior) {
        lines.push('');
        lines.push(`  行为: ${file.expected_behavior}`);
      }

      return {
        message: [`feature "${dsl.feature}" 文件详情 ${viewTag}`, '', ...lines].join('\n'),
        data: file,
      };
    }

    // ── 细粒度查询：调用关系 ──────────────────────────────────
    case 'calls': {
      const dsl = loadDSL(input);
      if (!input.file_id) throw new Error('query "calls" 需要 file_id 参数');
      if (!input.project_dir) throw new Error('query "calls" 需要 project_dir 参数（项目根目录，用于打开 cache.db）');

      const file = (dsl.semantic?.files ?? []).find((f) => f.id === input.file_id);
      if (!file) throw new Error(`feature "${dsl.feature}" 中不存在文件 "${input.file_id}"`);

      // 打开项目 cache.db
      let db: Database;
      try {
        db = getProjectCacheDb(input.project_dir);
      } catch {
        return {
          message: `无法打开项目 cache.db（${input.project_dir}），请先运行 import_project 并传入 cache_db 参数。`,
          data: null,
        };
      }

      const { incoming, outgoing } = queryFileCalls(db, input.file_id, file.path);

      if (incoming.length === 0 && outgoing.length === 0) {
        return {
          message: `feature "${dsl.feature}" 文件 "${file.path}" 无调用关系数据 ${viewTag}（cache.db 中可能尚未索引该文件的调用边）`,
          data: { incoming: [], outgoing: [] },
        };
      }

      const lines: string[] = [
        `══ feature "${dsl.feature}" 文件 "${file.path}" 调用关系 ${viewTag} ══`,
        '',
      ];

      if (outgoing.length > 0) {
        lines.push(`  ─ 出调用（本文件调用其他）${outgoing.length} 条 ─`);
        outgoing.forEach((c, i) => {
          const calleeFn = symbolNameFromId(c.callee);
          const callerFn = symbolNameFromId(c.caller);
          const crossTag = c.cross ? ' [跨文件]' : '';
          lines.push(`    ${i + 1}. L${c.line} ${callerFn} → ${calleeFn}${crossTag}`);
        });
      } else {
        lines.push('  出调用: (无)');
      }

      if (incoming.length > 0) {
        lines.push('');
        lines.push(`  ─ 入调用（其他文件调用本文件）${incoming.length} 条 ─`);
        incoming.forEach((c, i) => {
          const callerFn = symbolNameFromId(c.caller);
          const calleeFn = symbolNameFromId(c.callee);
          const callerFile = filePathFromId(c.caller);
          const crossTag = c.cross ? ' [跨文件]' : '';
          lines.push(`    ${i + 1}. L${c.line} ${callerFn} → ${calleeFn} (来自 ${callerFile})${crossTag}`);
        });
      } else {
        lines.push('', '  入调用: (无)');
      }

      return {
        message: lines.join('\n'),
        data: { incoming, outgoing },
      };
    }

    case 'annotations': {
      const feature = requireFeature(input);
      const r = listAnnotations({
        feature,
        node_id: input.annotation_node_id,
        severity: input.severity,
        unresolved_only: input.unresolved_only,
      });
      return { message: r.message, data: r.annotations };
    }

    case 'approvals': {
      const feature = requireFeature(input);
      const r = listApprovals({ feature, status: input.status, assignee: input.assignee });
      return { message: r.message, data: r.annotations };
    }

    case 'approval_history': {
      const feature = requireFeature(input);
      if (!input.annotation_id) throw new Error('query "approval_history" 需要 annotation_id 参数');
      const r = getApprovalHistory({ feature, annotation_id: input.annotation_id });
      return { message: r.message, data: { current_status: r.current_status, history: r.history } };
    }

    case 'snapshots': {
      const feature = requireFeature(input);
      const r = listSnapshots({ feature });
      return { message: r.message, data: r.snapshots };
    }

    case 'templates': {
      const r = listTemplates();
      return { message: r.message, data: r.templates };
    }

    case 'simulation_state': {
      const feature = requireFeature(input);
      const r = getSimulationState({ feature });
      return { message: r.message, data: { state: r.state, traceCount: r.traceCount } };
    }

    case 'diff': {
      if (!input.feature_a || !input.feature_b) {
        throw new Error('query "diff" 需要 feature_a 和 feature_b 参数');
      }
      const r = diffFeatures({
        feature_a: input.feature_a,
        feature_b: input.feature_b,
        view_a: input.view, // 默认 design
        view_b: input.view_b, // 可选，对比"设计 vs 代码现状"时传 live
      });
      const lines = [
        `diff "${input.feature_a}" → "${input.feature_b}"`,
        `新增 ${r.summary.added} · 删除 ${r.summary.removed} · 修改 ${r.summary.modified}`,
        '',
        ...r.diffs.map((d) => `  [${d.type}] ${d.category} ${d.id}${d.field ? ` (${d.field})` : ''}: ${d.description}`),
      ];
      return { message: lines.join('\n'), data: r };
    }

    default:
      throw new Error(`未知 query 类型: ${(input as { query: string }).query}`);
  }
}