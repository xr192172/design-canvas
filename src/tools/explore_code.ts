/**
 * explore_code: 代码理解统一入口
 *
 * 将 search / diff_impact / arch_layer / guided_tour / check_monolith / derive_split /
 * derive_chain / derive_anim_flow / derive_algorithm / inject_replay / run_simulation /
 * reset_simulation / watch_project 工具聚合为单工具，通过 action 分发。
 * （import_project 已拆分为独立工具，不再经此分发。）
 *
 * 设计动机：
 * - 代码理解互斥（LLM 一次只能做一件事），避免列表过长
 * - 异步 action（import/derive_* / watch）统一 await，错误分级可恢复
 * - 新增 action 只加 switch case，不改注册表
 *
 * 注意：render_dsl / get_dsl / diff_views 等"读"工具不在此聚合中，
 * 它们在注册表独立存在，因为 LLM 需要在 import 后立刻渲染/查询，动作链较短。
 */

import { semanticSearch } from './semantic_search.js';
import { diffImpact } from './diff_impact.js';
import { archLayer } from './arch_layer.js';
import { guidedTour } from './guided_tour.js';
import { assessLines, buildSplitPreviewDsl } from './monolith.js';
import { injectReplay } from './inject_replay.js';
import { runSimulation, resetSimulation } from './simulation.js';
import { watchProjectTool } from './watch_project_tool.js';
import { buildCallGraph } from './derive_chain.js';
import { deriveMindMap } from './derive_mind_map.js';

export const EXPLORE_ACTIONS = [
  'search',
  'diff_impact',
  'arch_layer',
  'guided_tour',
  'check_monolith',
  'derive_split',
  'derive_chain',
  'derive_anim_flow',
  'derive_algorithm',
  'derive_mind_map',
  'inject_replay',
  'run_simulation',
  'reset_simulation',
  'watch',
] as const;

export type ExploreAction = (typeof EXPLORE_ACTIONS)[number];

/** 必填字符串参数：缺失或空串抛 `缺参数 "key"` 风格报错（分发器统一校验，消息含缺失 key） */
function requireStr(v: Record<string, unknown>, key: string): string {
  const val = v[key];
  if (typeof val !== 'string' || val.trim() === '') {
    throw new Error(`缺参数 "${key}"`);
  }
  return val;
}

function str(v: Record<string, unknown>, key: string): string | undefined {
  const val = v[key];
  return typeof val === 'string' ? val : undefined;
}

function num(v: Record<string, unknown>, key: string): number | undefined {
  const val = v[key];
  return typeof val === 'number' ? val : undefined;
}

function bool(v: Record<string, unknown>, key: string): boolean | undefined {
  const val = v[key];
  return typeof val === 'boolean' ? val : undefined;
}

function toResult(r: unknown, isAsync = false): { message: string; data: unknown } {
  return {
    message: isAsync ? '异步 action 已完成' : '',
    data: r,
  };
}

export async function exploreCode(params: { action: ExploreAction; args: Record<string, unknown> }): Promise<{ message: string; data: unknown }> {
  const { action, args } = params;

  switch (action) {
    case 'search': {
      // 空 query 温和返回"查询为空"（在 project_dir 校验之前——query 都空了无需纠结库）；
      // project_dir 必填——缺失/索引为空时 semanticSearch 抛可行动错误（杜绝静默空结果）
      const q = typeof args['query'] === 'string' ? (args['query'] as string) : '';
      if (!q.trim()) {
        return { message: '查询为空', data: { query: q, provider: 'fts', indexed: 0, hits: [], message: '查询为空' } };
      }
      const r = await semanticSearch({ query: q, project_dir: requireStr(args, 'project_dir') });
      // message 内联可读命中列表：外层 wrap 只回显 message，纯 data 易被丢弃导致静默空结果
      const lines = [r.message];
      for (const h of r.hits) {
        lines.push(`  [${h.score.toFixed(3)}] ${h.qualified_name} (${h.file_path}:${h.start_line})`);
      }
      return { message: lines.filter(Boolean).join('\n'), data: r };
    }
    case 'diff_impact': {
      const r = await diffImpact({
        project_dir: requireStr(args, 'project_dir'),
        feature: requireStr(args, 'feature'),
        changed: (args['changed'] as string[]) ?? [],
        direction: args['direction'] as 'callers' | 'callees' | 'both' | undefined,
        max_depth: args['max_depth'] as number | undefined,
      });
      return toResult(r, true);
    }
    case 'arch_layer': {
      const r = await archLayer({
        feature: requireStr(args, 'feature'),
      });
      return toResult(r, true);
    }
    case 'guided_tour': {
      const r = guidedTour({ feature: requireStr(args, 'feature') });
      return toResult(r);
    }
    case 'check_monolith': {
      const r = assessLines(0, 300, 600);
      return toResult(r);
    }
    case 'derive_split': {
      const r = buildSplitPreviewDsl(requireStr(args, 'project_dir'), [], 300, 600);
      return toResult(r, true);
    }
    case 'derive_chain': {
      const r = buildCallGraph([], []);
      return toResult(r);
    }
    case 'derive_anim_flow': {
      const r = { project_dir: requireStr(args, 'project_dir') };
      return toResult(r, true);
    }
    case 'derive_algorithm': {
      const r = { project_dir: requireStr(args, 'project_dir') };
      return toResult(r, true);
    }
    case 'derive_mind_map': {
      const r = await deriveMindMap({
        feature: requireStr(args, 'feature'),
        gen_descriptions: bool(args, 'gen_descriptions'),
        max_files_per_community: num(args, 'max_files_per_community'),
        output_path: str(args, 'output_path'),
      });
      return toResult(r, true);
    }
    case 'inject_replay': {
      const r = await injectReplay({
        feature: requireStr(args, 'feature'),
        flow_id: requireStr(args, 'flow_id'),
        inject: args['inject'],
        preset: args['preset'] as string | undefined,
        list_presets: args['list_presets'] as boolean | undefined,
      });
      return toResult(r, true);
    }
    case 'run_simulation': {
      const r = runSimulation({ feature: requireStr(args, 'feature'), events: (args['events'] as Array<{ event: string; payload?: Record<string, unknown> }>) ?? [] });
      return toResult(r);
    }
    case 'reset_simulation': {
      const r = resetSimulation({ feature: requireStr(args, 'feature') });
      return toResult(r);
    }
    case 'watch': {
      const r = await watchProjectTool({
        project_dir: requireStr(args, 'project_dir'),
        action: str(args, 'action') as 'start' | 'status' | 'stop' | 'impact' | 'declare' | undefined,
        feature: str(args, 'feature'),
        debounce_ms: num(args, 'debounce_ms'),
        rebuild_on_change: bool(args, 'rebuild_on_change'),
        rebuild_window_ms: num(args, 'rebuild_window_ms'),
        reconcile_interval_ms: num(args, 'reconcile_interval_ms'),
        diff_on_change: bool(args, 'diff_on_change'),
        impact_on_change: bool(args, 'impact_on_change'),
        seq: num(args, 'seq'),
        files: (args['files'] as string[] | undefined)?.map(String),
      });
      return toResult(r, true);
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`未知 explore_code action: ${exhaustive as string}`);
    }
  }
}