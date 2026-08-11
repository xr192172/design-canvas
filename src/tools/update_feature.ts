/**
 * update_feature：统一写操作入口
 *
 * 将原 16 个写操作工具（add/update/delete node/edge/file/api、
 * set_node_semantic、batch_move/update_style/delete、update_status）
 * 整合为单个工具，通过 operations 列表批量提交。
 *
 * 特性：
 * - 批量操作按顺序执行，任一失败自动回滚到操作前状态（原子性）
 * - 每个操作路由到现有原子操作实现，行为与单独调用完全一致
 * - node 额外支持 move（相对平移 dx/dy），替代 batch_move_nodes
 * - edge 支持 update（删除后按合并数据重建，原子 ops 无独立 updateEdge）
 */

import { getDSL, saveDSL } from '../storage.js';
import type { EditResult } from './edit_result.js';
import { addNode, updateNode, deleteNode } from './node_ops.js';
import type { AddNodeInput, UpdateNodeInput } from './node_ops.js';
import { addEdge, deleteEdge } from './edge_ops.js';
import type { AddEdgeInput } from './edge_ops.js';
import { addFile, updateFile, deleteFile } from './file_ops.js';
import type { AddFileInput, UpdateFileInput } from './file_ops.js';
import { addExpectedApi, updateExpectedApi, deleteExpectedApi, setNodeSemantic } from './api_ops.js';
import { updateStatus } from './status_tools.js';
import { addAnnotationByTool, resolveAnnotation } from './annotation_tools.js';
import { submitApproval, reviewAnnotation } from './approval.js';
import { saveSnapshot, rollbackSnapshot, deleteSnapshot } from './snapshot.js';
import { dagLayout, forceLayout, gridAlign } from './dag_layout.js';
import { resetSimulation } from './simulation.js';
import type { DiagramStatus } from '../dsl/types.js';

// ─────────────────────────────────────────────────────────────
// 类型定义
// ─────────────────────────────────────────────────────────────

export interface FeatureOperation {
  /**
   * 操作类型：
   * - 通用：add / update / delete / move（move 仅 node，相对平移）
   * - annotation：resolve（关闭标注）
   * - approval：submit（提交审批） / review（审批决策）
   * - snapshot：save（保存快照） / rollback（回滚） / delete（删除快照）
   * - layout：apply（自动布局，data.algo=dag|force|grid）
   * - simulation：reset（重置仿真状态）
   */
  op:
    | 'add'
    | 'update'
    | 'delete'
    | 'move'
    | 'resolve'
    | 'submit'
    | 'review'
    | 'save'
    | 'rollback'
    | 'apply'
    | 'reset';
  /**
   * 目标类型：
   * - node / edge / file：几何层节点、边、语义层文件
   * - api：语义文件的预期 API（id 为所属 file_id，data.signature 定位）
   * - binding：节点与文件绑定（仅 update，id 为 node_id，data.file_id 必填）
   * - status：节点状态更新（仅 update，id 为 node_id，data.status 必填；同步 file 状态并重算 feature 状态）
   * - annotation：标注（op=add 加标注 data.text/severity/type/author/node_id；op=resolve 关闭 data.annotation_id/resolution_note）
   * - approval：审批（op=submit data.annotation_id/assignee/submitter/comment；op=review data.annotation_id/decision/reviewer/comment）
   * - snapshot：版本快照（op=save data.label/description；op=rollback/delete data.snapshot_id）
   * - layout：自动布局（op=apply data.algo=dag|force|grid + 各算法参数）
   * - simulation：仿真（op=reset 重置到初始状态）
   */
  type:
    | 'node'
    | 'edge'
    | 'file'
    | 'api'
    | 'binding'
    | 'status'
    | 'annotation'
    | 'approval'
    | 'snapshot'
    | 'layout'
    | 'simulation';
  /** 目标 ID：node_id / edge_id / file_id（api 类型为所属 file_id）；annotation/approval/snapshot/layout/simulation 用 data 传参，本字段可空 */
  id?: string;
  /** 操作数据（add/update/move 时按目标类型提供对应字段） */
  data?: Record<string, unknown>;
}

export interface UpdateFeatureInput {
  feature: string;
  operations: FeatureOperation[];
}

// ─────────────────────────────────────────────────────────────
// 主入口
// ─────────────────────────────────────────────────────────────

export function updateFeature(input: UpdateFeatureInput): EditResult {
  const { feature, operations } = input;

  if (!operations || operations.length === 0) {
    throw new Error('operations 不能为空');
  }

  const original = getDSL(feature);
  if (!original) {
    throw new Error(`feature "${feature}" 不存在，请先使用 create_feature 创建`);
  }
  // 深拷贝备份，供失败回滚（剔除活态文件可能带入的 _sync 元数据）
  const backup = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
  delete backup._sync;

  const results: string[] = [];
  try {
    for (const [i, op] of operations.entries()) {
      const result = applyOperation(feature, op);
      // 取原子操作返回消息首行作为摘要
      const summary = result.message.split('\n')[0];
      results.push(`  [${i + 1}/${operations.length}] ${summary}`);
    }
  } catch (e) {
    // 回滚到操作前状态
    saveDSL(backup as never);
    throw new Error(
      `操作 ${results.length + 1}/${operations.length} 失败，已回滚全部 ${results.length} 个已应用变更\n` +
      `失败原因: ${(e as Error).message}`,
    );
  }

  return {
    message: [
      `已对 feature "${feature}" 应用 ${operations.length} 个操作（全部成功）:`,
      ...results,
    ].join('\n'),
    feature,
  };
}

// ─────────────────────────────────────────────────────────────
// 操作路由
// ─────────────────────────────────────────────────────────────

function applyOperation(feature: string, op: FeatureOperation): EditResult {
  switch (op.type) {
    case 'node':
      return applyNodeOp(feature, op);
    case 'edge':
      return applyEdgeOp(feature, op);
    case 'file':
      return applyFileOp(feature, op);
    case 'api':
      return applyApiOp(feature, op);
    case 'binding': {
      if (op.op !== 'update') throw new Error('binding 仅支持 update 操作');
      if (!op.id) throw new Error('binding.update 需要 id（node_id）');
      if (!op.data?.file_id) throw new Error('binding.update 需要 data.file_id');
      return setNodeSemantic({
        feature,
        node_id: op.id,
        file_id: op.data.file_id as string,
        sync_status: op.data.sync_status as boolean | undefined,
      });
    }
    case 'status': {
      if (op.op !== 'update') throw new Error('status 仅支持 update 操作');
      if (!op.id) throw new Error('status.update 需要 id（node_id）');
      if (!op.data?.status) throw new Error('status.update 需要 data.status');
      return updateStatus({
        feature,
        node_id: op.id,
        status: op.data.status as DiagramStatus,
      });
    }
    case 'annotation':
      return applyAnnotationOp(feature, op);
    case 'approval':
      return applyApprovalOp(feature, op);
    case 'snapshot':
      return applySnapshotOp(feature, op);
    case 'layout':
      return applyLayoutOp(feature, op);
    case 'simulation':
      return applySimulationOp(feature, op);
    default:
      throw new Error(`未知操作类型: ${op.type satisfies never}`);
  }
}

// ─────────────────────────────────────────────────────────────
// annotation：op=add 加标注 / op=resolve 关闭标注
// ─────────────────────────────────────────────────────────────

function applyAnnotationOp(feature: string, op: FeatureOperation): EditResult {
  const data = op.data ?? {};
  switch (op.op) {
    case 'add': {
      if (!data.text) throw new Error('annotation.add 需要 data.text');
      const r = addAnnotationByTool({
        feature,
        text: data.text as string,
        node_id: data.node_id as string | undefined,
        type: data.type as 'comment' | 'question' | 'issue' | 'suggestion' | 'approval' | undefined,
        severity: data.severity as 'info' | 'warning' | 'critical' | undefined,
        author: data.author as string | undefined,
      });
      return { message: r.message, feature };
    }
    case 'resolve': {
      if (!data.annotation_id) throw new Error('annotation.resolve 需要 data.annotation_id');
      const r = resolveAnnotation({
        feature,
        annotation_id: data.annotation_id as string,
        resolution_note: data.resolution_note as string | undefined,
      });
      return { message: r.message, feature };
    }
    default:
      throw new Error(`annotation 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// approval：op=submit 提交审批 / op=review 审批决策
// ─────────────────────────────────────────────────────────────

function applyApprovalOp(feature: string, op: FeatureOperation): EditResult {
  const data = op.data ?? {};
  switch (op.op) {
    case 'submit': {
      if (!data.annotation_id) throw new Error('approval.submit 需要 data.annotation_id');
      const r = submitApproval({
        feature,
        annotation_id: data.annotation_id as string,
        assignee: data.assignee as string | undefined,
        submitter: data.submitter as string | undefined,
        comment: data.comment as string | undefined,
      });
      return { message: r.message, feature };
    }
    case 'review': {
      if (!data.annotation_id) throw new Error('approval.review 需要 data.annotation_id');
      if (!data.decision) throw new Error('approval.review 需要 data.decision');
      if (!data.reviewer) throw new Error('approval.review 需要 data.reviewer');
      const r = reviewAnnotation({
        feature,
        annotation_id: data.annotation_id as string,
        decision: data.decision as 'approve' | 'reject' | 'request_revision',
        reviewer: data.reviewer as string,
        comment: data.comment as string | undefined,
      });
      return { message: r.message, feature };
    }
    default:
      throw new Error(`approval 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// snapshot：op=save 保存 / op=rollback 回滚 / op=delete 删除
// ─────────────────────────────────────────────────────────────

function applySnapshotOp(feature: string, op: FeatureOperation): EditResult {
  const data = op.data ?? {};
  switch (op.op) {
    case 'save': {
      if (!data.label) throw new Error('snapshot.save 需要 data.label');
      const r = saveSnapshot({
        feature,
        label: data.label as string,
        description: data.description as string | undefined,
      });
      return { message: r.message, feature };
    }
    case 'rollback': {
      if (!data.snapshot_id) throw new Error('snapshot.rollback 需要 data.snapshot_id');
      const r = rollbackSnapshot({ feature, snapshot_id: data.snapshot_id as string });
      return { message: r.message, feature };
    }
    case 'delete': {
      if (!data.snapshot_id) throw new Error('snapshot.delete 需要 data.snapshot_id');
      const r = deleteSnapshot({ feature, snapshot_id: data.snapshot_id as string });
      return { message: r.message, feature };
    }
    default:
      throw new Error(`snapshot 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// layout：op=apply 自动布局（data.algo=dag|force|grid + 各算法参数）
// ─────────────────────────────────────────────────────────────

function applyLayoutOp(feature: string, op: FeatureOperation): EditResult {
  const data = op.data ?? {};
  const algo = data.algo ?? 'dag';
  switch (algo) {
    case 'dag': {
      const r = dagLayout({
        feature,
        direction: data.direction as 'horizontal' | 'vertical' | undefined,
        h_gap: data.h_gap as number | undefined,
        v_gap: data.v_gap as number | undefined,
        width: data.width as number | undefined,
        respect_swimlanes: data.respect_swimlanes as boolean | undefined,
      });
      return { message: r.message, feature };
    }
    case 'force': {
      const r = forceLayout({
        feature,
        repulsion: data.repulsion as number | undefined,
        stiffness: data.stiffness as number | undefined,
        damping: data.damping as number | undefined,
        iterations: data.iterations as number | undefined,
        node_radius: data.node_radius as number | undefined,
        width: data.width as number | undefined,
        height: data.height as number | undefined,
      });
      return { message: r.message, feature };
    }
    case 'grid': {
      const r = gridAlign({ feature, grid_size: data.grid_size as number | undefined });
      return { message: r.message, feature };
    }
    default:
      throw new Error(`layout 未知算法: ${algo as string}`);
  }
}

// ─────────────────────────────────────────────────────────────
// simulation：op=reset 重置仿真状态
// ─────────────────────────────────────────────────────────────

function applySimulationOp(feature: string, op: FeatureOperation): EditResult {
  if (op.op !== 'reset') throw new Error(`simulation 不支持操作: ${op.op}`);
  const r = resetSimulation({ feature });
  return { message: r.message, feature };
}

// ─────────────────────────────────────────────────────────────
// node：add / update / delete / move
// ─────────────────────────────────────────────────────────────

function applyNodeOp(feature: string, op: FeatureOperation): EditResult {
  const { id, data } = op;
  if (!id) throw new Error('node 操作需要 id');
  switch (op.op) {
    case 'add':
      return addNode({ feature, node_id: id, ...data } as AddNodeInput);
    case 'update':
      return updateNode({ feature, node_id: id, ...data } as UpdateNodeInput);
    case 'delete':
      return deleteNode({ feature, node_id: id });
    case 'move': {
      // 相对平移（替代 batch_move_nodes，逐个 node 一条 move 操作）
      const dx = (data?.dx as number) ?? 0;
      const dy = (data?.dy as number) ?? 0;
      const dsl = getDSL(feature);
      if (!dsl) throw new Error(`feature "${feature}" 不存在`);
      const node = dsl.geometry.nodes.find(n => n.id === id);
      if (!node) throw new Error(`节点 "${id}" 不存在`);
      node.x = (node.x ?? 0) + dx;
      node.y = (node.y ?? 0) + dy;
      saveDSL(dsl);
      return { message: `已移动节点: ${id} (dx=${dx}, dy=${dy})`, feature };
    }
    default:
      throw new Error(`node 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// edge：add / update / delete（update = 合并数据后删除重建）
// ─────────────────────────────────────────────────────────────

function applyEdgeOp(feature: string, op: FeatureOperation): EditResult {
  const { id, data } = op;
  if (!id) throw new Error('edge 操作需要 id');
  switch (op.op) {
    case 'add':
      if (!data?.from || !data?.to) throw new Error('edge.add 需要 data.from 和 data.to');
      return addEdge({ feature, edge_id: id, ...data } as unknown as AddEdgeInput);
    case 'delete':
      return deleteEdge({ feature, edge_id: id });
    case 'update': {
      const dsl = getDSL(feature);
      if (!dsl) throw new Error(`feature "${feature}" 不存在`);
      const existing = (dsl.geometry.edges ?? []).find(e => e.id === id);
      if (!existing) throw new Error(`边 "${id}" 不存在`);
      const merged = { ...existing, ...(data ?? {}) };
      deleteEdge({ feature, edge_id: id });
      return addEdge({
        feature,
        edge_id: id,
        from: merged.from,
        to: merged.to,
        label: merged.label,
        edge_type: merged.type,
        arrow: merged.arrow,
        layer: merged.layer,
      });
    }
    default:
      throw new Error(`edge 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// file：add / update / delete
// ─────────────────────────────────────────────────────────────

function applyFileOp(feature: string, op: FeatureOperation): EditResult {
  const { id, data } = op;
  if (!id) throw new Error('file 操作需要 id');
  switch (op.op) {
    case 'add':
      if (!data?.path || !data?.responsibility) {
        throw new Error('file.add 需要 data.path 和 data.responsibility');
      }
      return addFile({ feature, file_id: id, ...data } as unknown as AddFileInput);
    case 'update':
      return updateFile({ feature, file_id: id, ...data } as UpdateFileInput);
    case 'delete':
      return deleteFile({ feature, file_id: id });
    default:
      throw new Error(`file 不支持操作: ${op.op}`);
  }
}

// ─────────────────────────────────────────────────────────────
// api：add / update / delete（id = 所属 file_id，data.signature 定位）
// ─────────────────────────────────────────────────────────────

function applyApiOp(feature: string, op: FeatureOperation): EditResult {
  const { id, data } = op;
  if (!id) throw new Error('api 操作需要 id（所属 file_id）');
  switch (op.op) {
    case 'add':
      if (!data?.signature) throw new Error('api.add 需要 data.signature');
      return addExpectedApi({
        feature,
        file_id: id,
        signature: data.signature as string,
        notes: data.notes as string | undefined,
      });
    case 'update':
      if (!data?.signature) throw new Error('api.update 需要 data.signature（原签名）');
      return updateExpectedApi({
        feature,
        file_id: id,
        signature: data.signature as string,
        new_signature: data.new_signature as string | undefined,
        notes: data.notes as string | undefined,
      });
    case 'delete':
      if (!data?.signature) throw new Error('api.delete 需要 data.signature');
      return deleteExpectedApi({
        feature,
        file_id: id,
        signature: data.signature as string,
      });
    default:
      throw new Error(`api 不支持操作: ${op.op}`);
  }
}
