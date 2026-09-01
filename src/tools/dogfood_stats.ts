/**
 * dogfood_stats —— 工具使用"正式统计"（狗食量化）
 *
 * design-canvas 作为 AI 第一性工具的采纳度怎么量？—— 在统一调度咽喉
 * (server_registry registerAllTools) 记录每次工具调用结果，落盘 JSONL：
 *   <dataHome>/.design-canvas/dogfood/usage.jsonl
 *
 * 每条记录 = { ts, tool, action?, ok, ms, err? }
 *   - tool    : 工具名（explore_code / edit_code / get_dsl / ...）
 *   - action  : 参数化工具的子动作（explore_code.search / edit_code.replace ...）
 *   - ok      : handler 是否返回成功（!isError）
 *   - err     : 失败时的错误消息（截断，防撑爆单行）
 *
 * 设计取向：
 *   - 零侵入：记录失败（无目录/无权限）静默吞掉，绝不阻断工具主流程
 *   - 成本：每次调用一次 io append，可忽略
 *   - 只加不减：不提供删除/清空入口（原始日志两层分离：raw 全量 + LLM 聚合）
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDataHome } from '../storage.js';

export interface DogfoodUsage {
  ts: string;
  tool: string;
  /** 参数化工具的子动作：explore_code=action，edit_code=op */
  action?: string;
  ok: boolean;
  ms: number;
  /** 失败时的错误消息（截断） */
  err?: string;
}

const MAX_ERR_LEN = 200;

function logDir(): string {
  return path.join(getDataHome(), '.design-canvas', 'dogfood');
}
function logFile(): string {
  return path.join(logDir(), 'usage.jsonl');
}

/** 记录一次工具调用（失败静默，不阻断主流程）。 */
export function recordDogfoodUsage(u: DogfoodUsage): void {
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(logFile(), JSON.stringify(u) + '\n', 'utf-8');
  } catch {
    /* 记录失败不影响工具主流程 */
  }
}

/** 子动作明细统计。 */
export interface DogfoodActionStat {
  calls: number;
  ok: number;
  failed: number;
}

export interface DogfoodToolStat {
  tool: string;
  calls: number;
  ok: number;
  failed: number;
  /** 按子动作聚合（explore_code.action / edit_code.op）；无子动作的记在 key='—' */
  by_action: Record<string, DogfoodActionStat>;
}

export interface DogfoodSnapshot {
  file: string;
  total: number;
  /** 聚合口径至少覆盖这些"第一性"工具才叫正式统计 */
  tools: DogfoodToolStat[];
}

function emptyAction(): DogfoodActionStat {
  return { calls: 0, ok: 0, failed: 0 };
}

/** 读取日志聚合出统计快照。 */
export function snapshotDogfoodStats(): DogfoodSnapshot {
  const file = logFile();
  const tools = new Map<string, DogfoodToolStat>();

  const ensureTool = (tool: string): DogfoodToolStat => {
    let t = tools.get(tool);
    if (!t) {
      t = { tool, calls: 0, ok: 0, failed: 0, by_action: {} };
      tools.set(tool, t);
    }
    return t;
  };
  const statFor = (t: DogfoodToolStat, action: string): DogfoodActionStat => {
    let a = t.by_action[action];
    if (!a) {
      a = emptyAction();
      t.by_action[action] = a;
    }
    return a;
  };

  try {
    const text = fs.readFileSync(file, 'utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as DogfoodUsage;
        const t = ensureTool(r.tool);
        t.calls++;
        if (r.ok) t.ok++;
        else t.failed++;
        const a = statFor(t, r.action ?? '—');
        a.calls++;
        if (r.ok) a.ok++;
        else a.failed++;
      } catch {
        /* 单行损坏跳过，不阻断聚合 */
      }
    }
  } catch {
    /* 无日志文件 → 空快照 */
  }

  // 稳定排序：工具名 alphabetically；动作名按出现序（保留 object 插入序即可）
  const list = [...tools.values()].sort((x, y) => x.tool.localeCompare(y.tool));
  const total = list.reduce((n, t) => n + t.calls, 0);
  return { file, total, tools: list };
}

/** 人类可读报告（正式统计的默认出口）。 */
export function renderDogfoodSnapshot(s: DogfoodSnapshot): string {
  const lines = [
    `狗食使用统计 · 共 ${s.total} 次工具调用`,
    `  日志: ${s.file}`,
    '',
    '| 工具 | 调用 | 成功 | 失败 | 成功率 |',
    '|---|---|---|---|---|',
  ];
  for (const t of s.tools) {
    const rate = t.calls > 0 ? `${Math.round((t.ok / t.calls) * 100)}%` : '—';
    lines.push(`| ${t.tool} | ${t.calls} | ${t.ok} | ${t.failed} | ${rate} |`);
    // 参数化工具展开子动作明细
    const actions = Object.entries(t.by_action);
    if (actions.length > 1 || (actions.length === 1 && actions[0][0] !== '—')) {
      for (const [act, a] of actions) {
        const ar = a.calls > 0 ? `${Math.round((a.ok / a.calls) * 100)}%` : '—';
        lines.push(`| &nbsp;&nbsp;↳ ${act} | ${a.calls} | ${a.ok} | ${a.failed} | ${ar} |`);
      }
    }
  }
  return lines.join('\n');
}

/** 仅打印聚合口径内工具（explore_code/edit_code/diff_views/get_dsl/render_design/import_project）的简洁口径。 */
export function renderDogfoodSummary(s: DogfoodSnapshot): string {
  const keys = ['explore_code', 'edit_code', 'get_dsl', 'render_design', 'import_project', 'diff_views', 'scaffold', 'backfill_scaffold', 'consistency_check'];
  const lines: string[] = [];
  for (const k of keys) {
    const t = s.tools.find((x) => x.tool === k);
    if (!t) continue;
    const rate = t.calls > 0 ? `${Math.round((t.ok / t.calls) * 100)}%` : '—';
    lines.push(`${k}: ${t.calls} 次 (成功 ${t.ok} / 失败 ${t.failed} / 成功率 ${rate})`);
  }
  return lines.join('\n');
}

/** CLI 入口：node dist/src/tools/dogfood_stats.js [--by-action|--summary] */
export function runDogfoodCLI(argv: string[]): void {
  const summaryOnly = argv.includes('--summary') || argv.includes('-s');
  const s = snapshotDogfoodStats();
  const text = summaryOnly ? renderDogfoodSummary(s) : renderDogfoodSnapshot(s);
  console.log(text);
}

const isMain = import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href;
if (isMain) {
  try {
    runDogfoodCLI(process.argv.slice(2));
  } catch (e) {
    console.error('dogfood-stats:', (e as Error).message);
    process.exitCode = 1;
  }
}