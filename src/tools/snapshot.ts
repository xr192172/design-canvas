/**
 * 版本快照工具
 *
 * 让 LLM 和用户能够保存 DSL 的"时间点快照"，
 * 随时回滚到之前的设计状态。
 *
 * 存储路径：.design-canvas/snapshots/<feature>/<timestamp>_<label>.json
 *
 * 与 undo/redo 的区别：
 * - undo/redo 是浏览器端的细粒度操作历史（拖拽、编辑等）
 * - snapshot 是服务端的设计里程碑（"v1 评审通过"、"重构前备份"等）
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, saveDSL } from '../storage.js';
import { getStorageRoot } from '../storage.js';
import type { DesignDSL } from '../dsl/types.js';

/** 快照存储目录 */
function getSnapshotsDir(feature: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error(`非法 feature 名: "${feature}"`);
  }
  return path.join(getStorageRoot(), 'snapshots', feature);
}

/** 生成快照文件名 */
function snapshotFileName(label: string, timestamp: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_').slice(0, 50);
  return `${timestamp}_${safeLabel}.json`;
}

export interface SaveSnapshotInput {
  feature: string;
  label: string;
  description?: string;
}

export interface SnapshotInfo {
  id: string;
  feature: string;
  label: string;
  description?: string;
  timestamp: string;
  file: string;
  node_count: number;
  edge_count: number;
  status: string;
}

export interface SaveSnapshotResult {
  message: string;
  feature: string;
  snapshot_id: string;
  label: string;
  timestamp: string;
}

/** 保存快照 */
export function saveSnapshot(input: SaveSnapshotInput): SaveSnapshotResult {
  const { feature, label, description } = input;

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = getSnapshotsDir(feature);
  fs.mkdirSync(dir, { recursive: true });

  const fileName = snapshotFileName(label, timestamp);
  const filePath = path.join(dir, fileName);

  const snapshot = {
    ...JSON.parse(JSON.stringify(dsl)),
    _snapshot: {
      label,
      description: description || '',
      timestamp,
      saved_at: new Date().toISOString(),
    },
  };

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');

  const nodeCount = dsl.geometry?.nodes?.length ?? 0;
  const edgeCount = dsl.geometry?.edges?.length ?? 0;

  return {
    message: [
      `快照已保存: ${label}`,
      `feature: ${feature}`,
      `时间: ${timestamp}`,
      `节点: ${nodeCount}, 边: ${edgeCount}`,
      `状态: ${dsl.status ?? 'draft'}`,
      `文件: ${filePath}`,
    ].join('\n'),
    feature,
    snapshot_id: timestamp,
    label,
    timestamp,
  };
}

export interface ListSnapshotsInput {
  feature: string;
}

export interface ListSnapshotsResult {
  message: string;
  feature: string;
  snapshots: SnapshotInfo[];
}

/** 列出 feature 的所有快照 */
export function listSnapshots(input: ListSnapshotsInput): ListSnapshotsResult {
  const { feature } = input;
  const dir = getSnapshotsDir(feature);

  if (!fs.existsSync(dir)) {
    return {
      message: `feature "${feature}" 暂无快照`,
      feature,
      snapshots: [],
    };
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const snapshots: SnapshotInfo[] = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(content);
      const snap = data._snapshot || {};
      snapshots.push({
        id: snap.timestamp || file.replace('.json', ''),
        feature,
        label: snap.label || file,
        description: snap.description || '',
        timestamp: snap.timestamp || '',
        file,
        node_count: data.geometry?.nodes?.length ?? 0,
        edge_count: data.geometry?.edges?.length ?? 0,
        status: data.status ?? 'draft',
      });
    } catch {
      // 跳过无法解析的文件
    }
  }

  // 按时间倒序排列（最新的在前）
  snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const lines: string[] = [];
  lines.push(`feature "${feature}" 的快照 (${snapshots.length} 个):`);
  lines.push('');
  for (const s of snapshots) {
    lines.push(`  [${s.timestamp}] ${s.label}`);
    if (s.description) lines.push(`    说明: ${s.description}`);
    lines.push(`    节点: ${s.node_count}, 边: ${s.edge_count}, 状态: ${s.status}`);
  }

  return {
    message: lines.join('\n'),
    feature,
    snapshots,
  };
}

export interface RollbackSnapshotInput {
  feature: string;
  snapshot_id: string;
}

export interface RollbackSnapshotResult {
  message: string;
  feature: string;
  snapshot_id: string;
  restored_to: string;
}

/** 回滚到指定快照 */
export function rollbackSnapshot(input: RollbackSnapshotInput): RollbackSnapshotResult {
  const { feature, snapshot_id } = input;
  const dir = getSnapshotsDir(feature);

  if (!fs.existsSync(dir)) {
    throw new Error(`feature "${feature}" 没有快照`);
  }

  // 查找匹配的快照文件
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let targetFile: string | null = null;
  let targetData: DesignDSL | null = null;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(content);
      const snap = data._snapshot || {};
      if (snap.timestamp === snapshot_id || file.includes(snapshot_id)) {
        targetFile = file;
        targetData = data;
        break;
      }
    } catch {
      // 跳过
    }
  }

  if (!targetFile || !targetData) {
    throw new Error(`快照 "${snapshot_id}" 不存在，使用 list_snapshots 查看可用快照`);
  }

  const snap = (targetData as any)._snapshot || {};

  // 回滚前先保存当前状态为"回滚前"快照
  const currentDsl = getDSL(feature);
  if (currentDsl) {
    const rollbackTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rollbackLabel = '回滚前自动备份';
    const rollbackFile = path.join(dir, snapshotFileName(rollbackLabel, rollbackTimestamp));
    const rollbackSnapshot = {
      ...JSON.parse(JSON.stringify(currentDsl)),
      _snapshot: {
        label: rollbackLabel,
        description: `回滚到 ${snap.label} 前的自动备份`,
        timestamp: rollbackTimestamp,
        saved_at: new Date().toISOString(),
      },
    };
    fs.writeFileSync(rollbackFile, JSON.stringify(rollbackSnapshot, null, 2), 'utf-8');
  }

  // 移除快照元数据后恢复 DSL
  const restored = JSON.parse(JSON.stringify(targetData));
  delete restored._snapshot;
  saveDSL(restored as DesignDSL);

  const nodeCount = restored.geometry?.nodes?.length ?? 0;
  const edgeCount = restored.geometry?.edges?.length ?? 0;

  return {
    message: [
      `已回滚到快照: ${snap.label || snapshot_id}`,
      `feature: ${feature}`,
      `快照时间: ${snap.timestamp || snapshot_id}`,
      `节点: ${nodeCount}, 边: ${edgeCount}`,
      `状态: ${restored.status ?? 'draft'}`,
      '',
      '当前状态已自动备份为"回滚前自动备份"快照',
    ].join('\n'),
    feature,
    snapshot_id,
    restored_to: snap.label || snapshot_id,
  };
}

export interface DeleteSnapshotInput {
  feature: string;
  snapshot_id: string;
}

export interface DeleteSnapshotResult {
  message: string;
  feature: string;
  snapshot_id: string;
}

/** 删除指定快照 */
export function deleteSnapshot(input: DeleteSnapshotInput): DeleteSnapshotResult {
  const { feature, snapshot_id } = input;
  const dir = getSnapshotsDir(feature);

  if (!fs.existsSync(dir)) {
    throw new Error(`feature "${feature}" 没有快照`);
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let targetFile: string | null = null;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(content);
      const snap = data._snapshot || {};
      if (snap.timestamp === snapshot_id || file.includes(snapshot_id)) {
        targetFile = file;
        break;
      }
    } catch {
      // 跳过
    }
  }

  if (!targetFile) {
    throw new Error(`快照 "${snapshot_id}" 不存在`);
  }

  fs.unlinkSync(path.join(dir, targetFile));

  return {
    message: `已删除快照: ${snapshot_id} (${targetFile})`,
    feature,
    snapshot_id,
  };
}
