/**
 * impact_report —— 变更影响报告：生成、落盘、按序号读取
 *
 * watch_project 变更回调（Step 2）的落地形态：
 *   - runImpactReport：基于符号缓存跑 diffImpact，全文落盘 <project>/.design-canvas/impact/rp-<seq>.json，
 *     返回一行摘要（推送用，不膨胀上下文）
 *   - readImpactReport：按 seq 取全文（LLM 看到摘要后需要深挖时调用）
 *   - listImpactReports：最近 N 条摘要
 *
 * 序号即版本号：进程重启后从目录扫描继续递增，报告可追溯。
 * 摘要行是"推送"的全部内容——MCP 无服务端推送，watch status 时 piggyback 带回。
 */

import fs from 'node:fs';
import path from 'node:path';
import { diffImpact, type DiffImpactResult, type ImpactDirection } from './diff_impact.js';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

/** 报告摘要（落盘元数据 + 推送行） */
export interface ImpactReportSummary {
  seq: number;
  created_at: string;
  /** 本次变更文件（相对项目根） */
  changed_files: string[];
  direction: ImpactDirection;
  max_depth: number;
  /** 直接受影响文件数（depth=0） */
  direct_files: number;
  /** 间接波及文件数（depth>0） */
  indirect_files: number;
  /** 直接受影响符号数 */
  direct_symbols: number;
  /** 间接波及符号数 */
  indirect_symbols: number;
  /** 波及文件清单（相对项目根 posix，direct+indirect；Impact Ledger 对比用） */
  impacted_file_paths: string[];
  /** 符号级实际变更（v3）：changed 符号 qualified_name 去重（cap 20） */
  changed_symbols: string[];
  /** 全部变更文件均无实质符号变更（注释/空白/格式）——波及清单为空 */
  no_real_change: boolean;
  /** 一行推送摘要 */
  summary_line: string;
}

/** 落盘的报告全文 */
export interface ImpactReportFile {
  summary: ImpactReportSummary;
  /** diffImpact 完整可读报告（多行文本） */
  message: string;
  /** diffImpact 原始结构化结果（impacted_files/impacted_symbols/warnings） */
  result: DiffImpactResult;
}

export interface RunImpactReportInput {
  project_dir: string;
  /** 可选：提供时报告内附带 DSL 文件节点映射；缺省纯缓存分析 */
  feature?: string;
  changed: string[];
  direction?: ImpactDirection;
  max_depth?: number;
}

// ─────────────────────────────────────────────────────────────
// 落盘布局与序号分配
// ─────────────────────────────────────────────────────────────

function impactDir(projectRoot: string): string {
  return path.join(projectRoot, '.design-canvas', 'impact');
}

function reportPath(projectRoot: string, seq: number): string {
  return path.join(impactDir(projectRoot), `rp-${String(seq).padStart(6, '0')}.json`);
}

/** 扫描目录取最大序号；空目录返回 0。进程重启后序号继续递增，不覆盖历史 */
function nextSeq(projectRoot: string): number {
  const dir = impactDir(projectRoot);
  let max = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = /^rp-(\d{6})\.json$/.exec(name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {
    // 目录不存在 → 从 1 开始
  }
  return max + 1;
}

// ─────────────────────────────────────────────────────────────
// 摘要行
// ─────────────────────────────────────────────────────────────

function hhmmss(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 一行推送摘要（v3 带符号级信息）：
 *   - 无实质变更：`[影响#12] 14:32:05 改 src/b.ts → 无实质符号变更（注释/格式），未计入波及 · ...`
 *   - 有实质变更：`[影响#12] 14:32:05 改 src/b.ts(b) → 直接1符号，波及2文件/4符号(both) · ...`
 *     变更符号 ≤3 个时列名，>3 列 `+N符号`。
 */
function buildSummaryLine(s: Omit<ImpactReportSummary, 'summary_line'>): string {
  const filesPart =
    s.changed_files.length <= 1
      ? (s.changed_files[0] ?? '无')
      : `${s.changed_files[0]}(+${s.changed_files.length - 1})`;
  const symSuffix =
    s.changed_symbols.length === 0
      ? ''
      : s.changed_symbols.length <= 3
        ? `(${s.changed_symbols.join(',')})`
        : `(+${s.changed_symbols.length}符号)`;
  if (s.no_real_change) {
    return `[影响#${s.seq}] ${hhmmss(s.created_at)} 改 ${filesPart} → 无实质符号变更（注释/格式），未计入波及 · watch action=impact seq=${s.seq}`;
  }
  const indirectPart =
    s.indirect_files > 0 ? `波及${s.indirect_files}文件/${s.indirect_symbols}符号` : '无间接波及';
  return `[影响#${s.seq}] ${hhmmss(s.created_at)} 改 ${filesPart}${symSuffix} → 直接${s.direct_symbols}符号，${indirectPart}(${s.direction}) · watch action=impact seq=${s.seq}`;
}

// ─────────────────────────────────────────────────────────────
// 对外 API
// ─────────────────────────────────────────────────────────────

/** 生成影响报告：跑 diffImpact → 落盘 → 返回摘要。失败抛错（调用方 watch 记 error 不阻断监听） */
export function runImpactReport(input: RunImpactReportInput): ImpactReportSummary {
  const root = path.resolve(input.project_dir);
  const result = diffImpact({
    feature: input.feature,
    project_dir: root,
    changed: input.changed,
    direction: input.direction,
    max_depth: input.max_depth,
  });

  const directFiles = result.impacted_files.filter((f) => f.direct).length;
  const indirectFiles = result.impacted_files.length - directFiles;
  const directSymbols = result.impacted_symbols.filter((s) => s.depth === 0).length;
  const indirectSymbols = result.impacted_symbols.length - directSymbols;

  const seq = nextSeq(root);
  const changedSymbols = [...new Set(result.symbol_diffs.flatMap((d) => d.changed))].slice(0, 20);
  const noRealChange =
    result.symbol_diffs.length > 0 &&
    result.symbol_diffs.every((d) => d.granularity === 'symbol' && d.changed.length === 0 && d.removed.length === 0);
  const base = {
    seq,
    created_at: new Date().toISOString(),
    changed_files: [...input.changed],
    direction: result.direction,
    max_depth: result.max_depth,
    direct_files: directFiles,
    indirect_files: indirectFiles,
    direct_symbols: directSymbols,
    indirect_symbols: indirectSymbols,
    impacted_file_paths: result.impacted_files.map((f) => f.path),
    changed_symbols: changedSymbols,
    no_real_change: noRealChange,
  };
  const summary: ImpactReportSummary = { ...base, summary_line: buildSummaryLine(base) };

  const file: ImpactReportFile = { summary, message: result.message, result };
  fs.mkdirSync(impactDir(root), { recursive: true });
  fs.writeFileSync(reportPath(root, seq), JSON.stringify(file, null, 2), 'utf-8');
  return summary;
}

/** 按序号读报告全文；不存在抛错 */
export function readImpactReport(projectDir: string, seq: number): ImpactReportFile {
  const p = reportPath(path.resolve(projectDir), seq);
  if (!fs.existsSync(p)) {
    throw new Error(`影响报告 #${seq} 不存在（${p}）。可用 listImpactReports 查看已有序号。`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ImpactReportFile;
}

/** 最近 limit 条报告摘要（新→旧）。无报告返回空数组 */
export function listImpactReports(projectDir: string, limit = 10): ImpactReportSummary[] {
  const root = path.resolve(projectDir);
  const dir = impactDir(root);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^rp-\d{6}\.json$/.test(n));
  } catch {
    return [];
  }
  names.sort((a, b) => parseInt(b.slice(3, 9), 10) - parseInt(a.slice(3, 9), 10));
  const out: ImpactReportSummary[] = [];
  for (const n of names.slice(0, limit)) {
    try {
      const f = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf-8')) as ImpactReportFile;
      out.push(f.summary);
    } catch {
      // 单个损坏文件跳过，不影响列表
    }
  }
  return out;
}
