/**
 * impact_ledger_store —— Impact Ledger 持久化（declare 落盘 + violated entry 审计链）
 *
 * 生命周期：
 *   pending ──(被匹配的影响报告消费)──▶ ok      （实际波及 ⊆ 预告面，安静）
 *          └─(消费且有计划外扩散)──────▶ violated（证据：unexpected_files + matched_seq）
 *   violated ──(resolve 过门)─────────▶ resolved（reviewer + reason 记入，审计不可改）
 *   pending ──(超 TTL 24h 未消费)─────▶ expired（防跨会话陈旧预告误报）
 *
 * 落盘：<project>/.design-canvas/impact/ledger.json（与影响报告 rp-*.json 同目录）。
 * 历史封顶：pending/violated 永不裁剪，其余（ok/resolved/expired）保留最近 100 条。
 *
 * 与 verification gate 的关系（对齐 go-observe proposal.go 的"提案-审批-证据"语义）：
 *   - violated entry 即"实际改动超出预告"的证据——matched_seq 指向 rp-<seq>.json 全文
 *   - resolve 是过门动作：reviewer + reason 写入 resolution，未处理的 violated 是债务
 *     （watch status 播报计数），处理动作本身留痕
 *   - 全部状态变迁持久化，偏差率（violated/已消费）可从 ledger 直接统计——
 *     DSL evolution loop（方向 D）的数据源
 */

import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────

export type LedgerEntryStatus = 'pending' | 'ok' | 'violated' | 'resolved' | 'expired';

export interface LedgerEntry {
  id: string;
  created_at: string;
  /** 声明打算修改的文件（相对项目根 posix） */
  declared_files: string[];
  /** 预期波及面（排序数组落盘；内存使用方转 Set） */
  expected_files: string[];
  status: LedgerEntryStatus;
  /** 被哪次影响报告消费 */
  consumed_at?: string;
  /** 证据链：消费本条的影响报告序号（rp-<seq>.json 全文可查） */
  matched_seq?: number;
  /** violated 证据：计划外波及文件清单 */
  unexpected_files?: string[];
  /** 消费时实际波及面快照（审计用） */
  actual_files?: string[];
  /** resolve 过门记录（violated → resolved 时写入） */
  resolution?: { at: string; reviewer: string; reason: string };
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
}

/** 消费定损（doWork 逐条产出） */
export interface ConsumeVerdict {
  id: string;
  status: 'ok' | 'violated';
  /** 本条预告面之外的实际波及 */
  unexpected: string[];
  /** 实际波及全量快照 */
  actual: string[];
  seq: number;
}

// ─────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────

/** pending 声明的存活窗口：超过即 expired（预告是短期意图，跨天残留只产噪音） */
export const LEDGER_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

/** 已结条目（ok/resolved/expired）的保留条数上限；pending/violated 永不裁剪 */
const LEDGER_CLOSED_CAP = 100;

// ─────────────────────────────────────────────────────────────
// 读写
// ─────────────────────────────────────────────────────────────

function ledgerPath(projectRoot: string): string {
  return path.join(projectRoot, '.design-canvas', 'impact', 'ledger.json');
}

/** 读全部条目（新→旧）。文件缺失/损坏返回空（缓存派生物语义，不阻塞调用方） */
export function loadLedger(projectRoot: string): LedgerEntry[] {
  try {
    const f = JSON.parse(fs.readFileSync(ledgerPath(projectRoot), 'utf-8')) as LedgerFile;
    if (!Array.isArray(f.entries)) return [];
    return f.entries;
  } catch {
    return [];
  }
}

/** 落盘（裁剪后）。pending/violated 全保留，已结条目保留最近 LEDGER_CLOSED_CAP 条 */
export function saveLedger(projectRoot: string, entries: LedgerEntry[]): void {
  const open = entries.filter((e) => e.status === 'pending' || e.status === 'violated');
  const closed = entries
    .filter((e) => e.status !== 'pending' && e.status !== 'violated')
    .sort((a, b) => (a.consumed_at ?? a.created_at) < (b.consumed_at ?? b.created_at) ? 1 : -1)
    .slice(0, LEDGER_CLOSED_CAP);
  const file: LedgerFile = { version: 1, entries: [...open, ...closed] };
  fs.mkdirSync(path.dirname(ledgerPath(projectRoot)), { recursive: true });
  fs.writeFileSync(ledgerPath(projectRoot), JSON.stringify(file, null, 2), 'utf-8');
}

// ─────────────────────────────────────────────────────────────
// 生命周期操作
// ─────────────────────────────────────────────────────────────

let idSeq = 0;

/** declare 落盘：追加一条 pending，返回完整条目 */
export function appendDeclaration(projectRoot: string, declaredFiles: string[], expectedFiles: string[]): LedgerEntry {
  const entry: LedgerEntry = {
    id: `decl-${Date.now().toString(36)}-${String(++idSeq).padStart(3, '0')}`,
    created_at: new Date().toISOString(),
    declared_files: [...declaredFiles],
    expected_files: [...expectedFiles].sort(),
    status: 'pending',
  };
  const entries = loadLedger(projectRoot);
  entries.unshift(entry);
  saveLedger(projectRoot, entries);
  return entry;
}

/** doWork 消费定损：逐条 pending → ok/violated，带证据（matched_seq + 快照）落盘 */
export function markConsumed(projectRoot: string, verdicts: ConsumeVerdict[]): void {
  if (verdicts.length === 0) return;
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  const entries = loadLedger(projectRoot);
  const now = new Date().toISOString();
  let touched = false;
  for (const e of entries) {
    const v = byId.get(e.id);
    if (!v || e.status !== 'pending') continue; // 不存在/已消费的跳过（幂等）
    e.status = v.status;
    e.consumed_at = now;
    e.matched_seq = v.seq;
    e.actual_files = [...v.actual];
    if (v.status === 'violated') e.unexpected_files = [...v.unexpected];
    touched = true;
  }
  if (touched) saveLedger(projectRoot, entries);
}

/**
 * 恢复跨会话 pending 声明（进程重启后 watch/declare 时调用）：
 * TTL 内的 pending 返回给调用方回填内存；超时的改 expired 落盘（不返回）。
 * excludeIds 排除内存已有的（防重复回填）。
 */
export function recoverPending(
  projectRoot: string,
  excludeIds: Set<string>,
  now: Date = new Date(),
): { entries: LedgerEntry[]; expired: number } {
  const entries = loadLedger(projectRoot);
  const cutoff = now.getTime() - LEDGER_PENDING_TTL_MS;
  const out: LedgerEntry[] = [];
  let expired = 0;
  let changed = false;
  for (const e of entries) {
    if (e.status !== 'pending') continue;
    if (new Date(e.created_at).getTime() < cutoff) {
      e.status = 'expired';
      e.consumed_at = now.toISOString();
      expired++;
      changed = true;
    } else if (!excludeIds.has(e.id)) {
      out.push(e);
    }
  }
  if (changed) saveLedger(projectRoot, entries);
  return { entries: out, expired };
}

/**
 * resolve 违规（verification gate 过门）：violated → resolved，记录 reviewer + reason。
 * reason 必填——过门必须留修复说明（对齐 proposal 的 VerifiedBy 语义）。
 */
export function resolveViolation(projectRoot: string, id: string, reviewer: string, reason: string): LedgerEntry {
  const entries = loadLedger(projectRoot);
  const e = entries.find((x) => x.id === id);
  if (!e) {
    throw new Error(`ledger 条目 ${id} 不存在（watch action=ledger 查看清单）`);
  }
  if (e.status !== 'violated') {
    throw new Error(`ledger 条目 ${id} 状态为 ${e.status}，只有 violated 可 resolve`);
  }
  if (!reason.trim()) {
    throw new Error('resolve 需要 reason：说明计划外扩散的原因与处理方式（过门留痕）');
  }
  e.status = 'resolved';
  e.resolution = { at: new Date().toISOString(), reviewer, reason };
  saveLedger(projectRoot, entries);
  return e;
}

/** 查询：status 缺省返回待办视角（pending+violated）；'all' 返回全部（新→旧） */
export function listLedger(projectRoot: string, status?: LedgerEntryStatus | 'all'): LedgerEntry[] {
  const all = loadLedger(projectRoot);
  if (!status) return all.filter((e) => e.status === 'pending' || e.status === 'violated');
  if (status === 'all') return all;
  return all.filter((e) => e.status === status);
}

/** 未处理违规数（watch status 债务播报用） */
export function countOpenViolations(projectRoot: string): number {
  return loadLedger(projectRoot).filter((e) => e.status === 'violated').length;
}
