/**
 * query_feature 工具：统一读操作入口
 *
 * 合并原 9 个查询工具（get_dsl / list_features / list_annotations / list_approvals /
 * list_snapshots / list_templates / get_simulation_state / get_approval_history / diff_features），
 * 通过 { query, ...params } 单点调用，减少 LLM 工具选择成本。
 *
 * query 类型与参数映射（同原工具，feature 缺省取当前 feature）：
 *   dsl              → get_dsl          { feature }
 *   features         → list_features    {}
 *   annotations      → list_annotations { feature, node_id?, severity?, unresolved_only? }
 *   approvals        → list_approvals   { feature, status?, assignee? }
 *   approval_history → get_approval_history { feature, annotation_id }
 *   snapshots        → list_snapshots   { feature }
 *   templates        → list_templates   {}
 *   simulation_state → get_simulation_state { feature }
 *   diff             → diff_features    { feature_a, feature_b }
 */

import { getDSL, listFeatures as listStoredFeatures } from '../storage.js';
import { listAnnotations } from './annotation_tools.js';
import { listApprovals, getApprovalHistory } from './approval.js';
import { listSnapshots } from './snapshot.js';
import { listTemplates } from './templates.js';
import { getSimulationState } from './simulation.js';
import { diffFeatures } from './diff.js';

export interface QueryFeatureInput {
  /** 查询类型 */
  query:
    | 'dsl'
    | 'features'
    | 'annotations'
    | 'approvals'
    | 'approval_history'
    | 'snapshots'
    | 'templates'
    | 'simulation_state'
    | 'diff';
  /** feature 名（dsl/annotations/approvals/approval_history/snapshots/simulation_state 必填；features/templates 忽略；diff 用 feature_a/feature_b） */
  feature?: string;
  /** annotations：按节点 ID 过滤 */
  node_id?: string;
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

export function queryFeature(input: QueryFeatureInput): QueryFeatureResult {
  switch (input.query) {
    case 'dsl': {
      const feature = requireFeature(input);
      const dsl = getDSL(feature);
      if (!dsl) throw new Error(`feature "${feature}" 不存在`);
      return {
        message: `feature: ${dsl.feature}\n\n${JSON.stringify(dsl, null, 2)}`,
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

    case 'annotations': {
      const feature = requireFeature(input);
      const r = listAnnotations({
        feature,
        node_id: input.node_id,
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
      const r = diffFeatures({ feature_a: input.feature_a, feature_b: input.feature_b });
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
