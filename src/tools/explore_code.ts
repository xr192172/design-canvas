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
import type { LayerDef } from './layer_detect.js';
import { guidedTour } from './guided_tour.js';
import { assessLines, buildSplitPreviewDsl } from './monolith.js';
import { injectReplay } from './inject_replay.js';
import { runSimulation, resetSimulation } from './simulation.js';
import { dispatchWatch } from '../daemon/dispatch.js';
import { buildCallGraph } from './derive_chain.js';
import { deriveMindMap } from './derive_mind_map.js';
import fs from 'node:fs';
import path from 'node:path';
import { parseFileFull, type ParsedSymbol } from './ts_kernel/index.js';
import { splitKeepEnds } from './line_utils.js';
import { matchSymbols, describeSymbol } from './edit_code.js';

export const EXPLORE_ACTIONS = [
  'search',
  'read',
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
    case 'read': {
      const r = await readCode(args);
      return { message: r.message, data: r.data };
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
        persist: bool(args, 'persist'),
        layers: args['layers'] as LayerDef[] | undefined,
        check_violations: bool(args, 'check_violations'),
        no_cache: bool(args, 'no_cache'),
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
      // daemon 感知分流：daemon 在则转发（注册表权威在 daemon 进程），不在降级本地（方向 E）
      const r = await dispatchWatch({
        project_dir: requireStr(args, 'project_dir'),
        action: str(args, 'action') as 'start' | 'status' | 'stop' | 'impact' | 'declare' | 'ledger' | undefined,
        feature: str(args, 'feature'),
        debounce_ms: num(args, 'debounce_ms'),
        rebuild_on_change: bool(args, 'rebuild_on_change'),
        rebuild_window_ms: num(args, 'rebuild_window_ms'),
        reconcile_interval_ms: num(args, 'reconcile_interval_ms'),
        diff_on_change: bool(args, 'diff_on_change'),
        impact_on_change: bool(args, 'impact_on_change'),
        seq: num(args, 'seq'),
        files: (args['files'] as string[] | undefined)?.map(String),
        ledger_status: str(args, 'ledger_status') as 'pending' | 'ok' | 'violated' | 'resolved' | 'expired' | 'all' | undefined,
        resolve_id: str(args, 'resolve_id'),
        reason: str(args, 'reason'),
        reviewer: str(args, 'reviewer'),
      });
      return toResult(r, true);
    }
    default: {
      const exhaustive: never = action;
      throw new Error(`未知 explore_code action: ${exhaustive as string}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// action=read：按符号定位或行区间读文件（行号契约见 line_utils）
// ─────────────────────────────────────────────────────────────
//
// 心智流：explore(search/read) → 确认行号 → edit_code。read 是 edit 的
// "先读后改"前置：返回的 start/end/每行行号与 edit_code(op=range) 同基准
// （splitKeepEnds 数组下标 +1 = 真实行号），LLM 可直接把 read 的行号喂给
// edit_code 而不踩行号漂移。
//
// 两种模式（二选一）：
// - 符号模式：symbol（+parent 消歧 / context 附带上下文行）→ AST 定位符号边界读取
// - 行区间模式：start/end（1-based 含端点）→ 原样读取该区间
// 都不给 → 读整个文件。

const READ_PREVIEW_CAP = 500;

async function readCode(args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {
  const file = requireStr(args, 'file');
  const symbol = str(args, 'symbol');
  const parent = str(args, 'parent');
  const start = num(args, 'start');
  const end = num(args, 'end');
  const context = num(args, 'context');
  const projectDirRaw = str(args, 'project_dir');

  const projectRoot = projectDirRaw ? path.resolve(projectDirRaw) : undefined;
  const absPath = path.isAbsolute(file) ? file : projectRoot ? path.resolve(projectRoot, file) : path.resolve(file);

  if (!fs.existsSync(absPath)) throw new Error(`文件不存在: ${absPath}`);
  if (fs.statSync(absPath).isDirectory()) throw new Error(`是目录，不是文件: ${absPath}`);
  if (fs.statSync(absPath).size > 5 * 1024 * 1024) {
    throw new Error(`文件过大（${(fs.statSync(absPath).size / 1024 / 1024).toFixed(1)}MB），read 只读文本源码，请改用项目搜索定位`);
  }

  const original = fs.readFileSync(absPath, 'utf8');
  const lines = splitKeepEnds(original);
  const total = lines.length;
  const relPath = projectRoot ? path.relative(projectRoot, absPath).split(path.sep).join('/') : absPath;

  // ── 确定读取区间 ──
  let rangeStart: number;
  let rangeEnd: number;
  let symbolInfo: ParsedSymbol | undefined;

  if (symbol) {
    // 符号模式：AST 定位（与 edit_code replace/delete 同一 matchSymbols 口径）
    const parsed = await parseFileFull(absPath, original);
    if (parsed.error) throw new Error(`文件解析失败: ${parsed.error}`);
    const { qnHits, nameHits } = matchSymbols(parsed.symbols, symbol, parent);
    const hits = qnHits.length > 0 ? qnHits : nameHits;
    if (hits.length === 0) {
      throw new Error(
        `符号未找到: ${symbol}${parent ? `（parent=${parent}）` : ''}。文件符号:\n` +
          parsed.symbols.map((s) => `  ${describeSymbol(s)}`).join('\n'),
      );
    }
    if (hits.length > 1) {
      throw new Error(
        `符号不唯一（${hits.length} 候选），传 parent 消歧:\n` +
          hits.map((s) => `  ${describeSymbol(s)}`).join('\n'),
      );
    }
    symbolInfo = hits[0];
    rangeStart = symbolInfo.start_line;
    rangeEnd = symbolInfo.end_line;
    if (context && context > 0) {
      rangeStart = Math.max(1, rangeStart - context);
      rangeEnd = Math.min(total, rangeEnd + context);
    }
  } else if (start != null || end != null) {
    // 行区间模式
    if (start == null || end == null) throw new Error('行区间模式需要同时提供 start/end（1-based 含端点）');
    if (start < 1) throw new Error(`start 必须 ≥1，收到 ${start}`);
    if (end < start) throw new Error(`end(${end}) < start(${start})`);
    if (end > total) throw new Error(`end(${end}) 超出文件总行数(${total})`);
    rangeStart = start;
    rangeEnd = end;
  } else {
    rangeStart = 1;
    rangeEnd = total;
  }

  // ── 生成带真实行号的预览（上限截断防爆）──
  const span = rangeEnd - rangeStart + 1;
  const shown = Math.min(span, READ_PREVIEW_CAP);
  const truncated = span > READ_PREVIEW_CAP;
  const width = String(rangeEnd).length;
  const linesOut: string[] = [];
  for (let i = 0; i < shown; i++) {
    const ln = rangeStart + i;
    linesOut.push(String(ln).padStart(width) + '| ' + lines[ln - 1].replace(/\r?\n$/, ''));
  }

  const symbolNote = symbolInfo
    ? `符号 ${symbolInfo.qualified_name}（${symbolInfo.kind}${symbolInfo.signature ? `, ${symbolInfo.signature}` : ''}` +
      `${symbolInfo.parent ? `, parent=${symbolInfo.parent}` : ''}，本体 L${symbolInfo.start_line}-${symbolInfo.end_line}）`
    : '';

  const message = [
    `${relPath} 共 ${total} 行，显示 L${rangeStart}-L${rangeEnd}` +
      (truncated ? `（预览截断，前 ${READ_PREVIEW_CAP} 行）` : '') +
      (symbolNote ? `\n${symbolNote}` : ''),
    '```',
    ...linesOut,
    '```',
  ].join('\n');

  return {
    message,
    data: {
      file: absPath,
      rel_path: relPath,
      total_lines: total,
      start: rangeStart,
      end: rangeEnd,
      truncated,
      symbol: symbolInfo
        ? {
            name: symbolInfo.name,
            qualified_name: symbolInfo.qualified_name,
            kind: symbolInfo.kind,
            signature: symbolInfo.signature,
            parent: symbolInfo.parent,
            start_line: symbolInfo.start_line,
            end_line: symbolInfo.end_line,
          }
        : undefined,
      lines: linesOut,
    },
  };
}