/**
 * list_features 工具实现
 *
 * 列出所有已保存的 feature
 */

import { listFeatures as listStoredFeatures } from '../storage.js';

export interface ListFeaturesInput {
  // 无参数
}

export interface ListFeaturesResult {
  /** 人类可读的列表文本（直接放进 MCP content） */
  message: string;
  count: number;
}

export function listFeatures(): ListFeaturesResult {
  const dsls = listStoredFeatures();
  if (dsls.length === 0) {
    return { message: '尚无已设计的 feature', count: 0 };
  }
  const lines = dsls.map((dsl, i) => {
    const fileCount = dsl.semantic?.files?.length ?? 0;
    const invariantCount = dsl.semantic?.multi_file_invariants?.length ?? 0;
    const status = dsl.status ?? 'draft';
    return `${i + 1}. ${dsl.feature} (${status}, ${fileCount} 文件, ${invariantCount} 不变式) [${dsl.id}]`;
  });
  const message = ['已设计的 feature：', ...lines].join('\n');
  return { message, count: dsls.length };
}
