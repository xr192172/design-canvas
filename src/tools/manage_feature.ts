/**
 * manage_feature：feature 生命周期统一分发器（路线图序号 2 收敛）
 *
 * 聚合 create_feature / clone_feature / create_from_template / list 为单工具，
 * 通过 action 分发。list 复用 storage.listFeatures。
 */

import { createFeature, cloneFeature } from './feature_ops.js';
import { createFromTemplate } from './templates.js';
import { listFeatures as listStoredFeatures, deleteFeature } from '../storage.js';

export const MANAGE_ACTIONS = ['create', 'clone', 'template', 'list', 'delete'] as const;
export type ManageAction = (typeof MANAGE_ACTIONS)[number];

export interface ManageFeatureInput {
  action: ManageAction;
  args: Record<string, unknown>;
}

export interface ManageFeatureResult {
  message: string;
  data?: unknown;
}

export function manageFeature(input: ManageFeatureInput): ManageFeatureResult {
  const { action, args } = input;
  const str = (k: string): string | undefined => {
    const x = args[k];
    return typeof x === 'string' ? x : undefined;
  };

  switch (action) {
    case 'create': {
      const feature = req('feature');
      const r = createFeature({ feature, title: str('title') });
      return { message: r.message };
    }
    case 'clone': {
      const r = cloneFeature({
        source_feature: req('source_feature'),
        target_feature: req('target_feature'),
        title: str('title'),
      });
      return { message: r.message };
    }
    case 'template': {
      const r = createFromTemplate({
        template_id: req('template_id'),
        feature: req('feature'),
        title: str('title'),
      });
      return { message: r.message };
    }
    case 'list': {
      const dsls = listStoredFeatures();
      if (dsls.length === 0) return { message: '尚无已设计的 feature', data: [] };
      const lines = dsls.map((d, i) => {
        const fileCount = d.semantic?.files?.length ?? 0;
        const invariantCount = d.semantic?.multi_file_invariants?.length ?? 0;
        const status = d.status ?? 'draft';
        return `${i + 1}. ${d.feature} (${status}, ${fileCount} 文件, ${invariantCount} 不变式) [${d.id}]`;
      });
      return {
        message: ['已设计的 feature：', ...lines].join('\n'),
        data: dsls.map((d) => ({ id: d.id, feature: d.feature, status: d.status })),
      };
    }
    case 'delete': {
      const feature = req('feature');
      deleteFeature(feature);
      return { message: `已删除 feature: ${feature}（设计存档 + 实际快照 + 活态视图）`, data: { feature } };
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`未知 manage_feature action: ${exhaustive as string}`);
    }
  }

  function req(k: string): string {
    const x = args[k];
    if (typeof x !== 'string' || x.length === 0) {
      throw new Error(`manage_feature action="${action}" 缺少必填参数 "${k}"`);
    }
    return x;
  }
}