/**
 * chain_tracer —— 调用链追溯（诊断流水线第 3 步）
 *
 * 从候选符号出发，沿 cache.db 三类边（call / type_ref / import）双向 BFS，
 * 重建"报错点 ← 谁调用"与"报错点 → 调用了谁"的证据链：
 *   - callers 方向：谁调用/引用该符号（报错向上传播的路径，也是影响面依据）
 *   - callees 方向：该符号调用了谁（真正的抛错点可能在被调方，如 undefined 属性访问）
 *
 * 关键约束：BFS 种子只取高置信度候选（exact/file/anchor，即 source != 'fts'）。
 * fts 是关键词模糊兜底，命中面太宽；若也当种子，会把整条链上的邻居在 depth 0
 * 就全部"先到"，导致一步调用链都走不出来（邻居全在 reached 里），证据链退化成
 * 只有 symbol_hit。无强候选时再退化用全部候选。
 *
 * 输出按序编号的 EvidenceStep[]，每步记录到达方式（边类）与途经符号/文件。
 * 只读 cache.db，不解析源码。
 */

import path from 'node:path';
import type { Database } from '../db/db.js';
import type { Candidate, EvidenceStep } from './contract.js';

export interface ChainTraceInput {
  project_dir: string;
  candidates: Candidate[];
  max_depth?: number;
}

export interface ChainTraceResult {
  chain: EvidenceStep[];
  /** 追溯到的最可疑符号 id（"<file>#<qn>"），供聚合器判定根因 */
  reached: string[];
  warnings: string[];
}

interface SymAdj { to: string; kind: 'call' | 'type_ref' }
interface FileAdj { to: string; kind: 'import' }

export function traceChain(db: Database, input: ChainTraceInput): ChainTraceResult {
  const { project_dir, candidates, max_depth = 3 } = input;
  const root = path.resolve(project_dir);
  const warnings: string[] = [];
  const chain: EvidenceStep[] = [];
  const step = (type: EvidenceStep['type'], text: string): void => {
    chain.push({ step: chain.length + 1, type, text });
  };

  // ── 加载三类边邻接表（与 diff_impact 同构）──
  const symRev = new Map<string, SymAdj[]>(); // target → callers（依赖它的 source）
  const symFwd = new Map<string, SymAdj[]>(); // source → callees（它依赖的 target）
  const edgeRows = db
    .prepare("SELECT source, target, kind FROM edges WHERE kind IN ('call','type_ref')")
    .all() as Array<{ source: string; target: string; kind: 'call' | 'type_ref' }>;
  for (const e of edgeRows) {
    let rs = symRev.get(e.target);
    if (!rs) symRev.set(e.target, (rs = []));
    rs.push({ to: e.source, kind: e.kind });
    let fs = symFwd.get(e.source);
    if (!fs) symFwd.set(e.source, (fs = []));
    fs.push({ to: e.target, kind: e.kind });
  }
  const importerOf = new Map<string, FileAdj[]>(); // 被导入文件 → 导入方
  const importeeOf = new Map<string, FileAdj[]>(); // 导入方 → 被导入文件
  const importRows = db
    .prepare("SELECT source, target FROM edges WHERE kind = 'import'")
    .all() as Array<{ source: string; target: string }>;
  for (const e of importRows) {
    let im = importerOf.get(e.target);
    if (!im) importerOf.set(e.target, (im = []));
    im.push({ to: e.source, kind: 'import' });
    let ie = importeeOf.get(e.source);
    if (!ie) importeeOf.set(e.source, (ie = []));
    ie.push({ to: e.target, kind: 'import' });
  }

  if (edgeRows.length === 0) {
    warnings.push('缓存中没有 call/type_ref 边——调用链无法追溯。请先对该项目运行 import_project 建立符号缓存。');
  }

  const labelOf = (id: string): string => {
    const file = id.split('#')[0];
    const qn = id.slice(file.length + 1);
    const meta = db.prepare('SELECT name, kind FROM nodes WHERE id = ?').get(id) as { name: string; kind: string } | undefined;
    return meta ? `${meta.name}${meta.kind !== 'function' && meta.kind !== 'method' ? ` [${meta.kind}]` : ''} (${file})` : `${qn} (${file})`;
  };

  // ── 从候选符号双向 BFS ──
  const allSources = candidates.slice(0, 5).map((c) => `${c.file_path}#${c.qualified_name}`);
  if (allSources.length === 0) {
    step('rule', '无可追溯的候选符号（缓存未命中或未建立）。');
    return { chain, reached: [], warnings };
  }
  // 种子只取高置信度候选；fts 模糊命中的候选保留在候选列表与 symbol_hit 里，
  // 但不作为 BFS 起点（否则链上邻居在 depth 0 被全部"先到"，一步都走不出来）。
  const strong = candidates
    .slice(0, 5)
    .filter((c) => c.source !== 'fts')
    .map((c) => `${c.file_path}#${c.qualified_name}`);
  const seeds = strong.length > 0 ? strong : allSources;

  const reached = new Map<string, number>(); // symbol id → depth
  for (const s of seeds) reached.set(s, 0);
  step('symbol_hit', `候选符号命中：${allSources.map(labelOf).join('；')}`);

  const pushHop = (id: string, via: string, dir: string): void => {
    step('call_chain', `[${dir}] 经${via}到达 ${labelOf(id)}`);
  };

  let frontier = [...seeds];
  for (let depth = 1; depth <= max_depth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const t of symRev.get(id) ?? []) {
        if (reached.has(t.to)) continue;
        reached.set(t.to, depth);
        pushHop(t.to, t.kind === 'call' ? '调用边' : '类型引用', 'callers←');
        next.push(t.to);
      }
      for (const t of symFwd.get(id) ?? []) {
        if (reached.has(t.to)) continue;
        reached.set(t.to, depth);
        pushHop(t.to, t.kind === 'call' ? '调用边' : '类型引用', '→callees');
        next.push(t.to);
      }
    }
    frontier = next;
  }

  // 文件级 import 线索（符号边摸不到时的粗粒度兜底，只记一步）
  if (reached.size === 0) {
    const files = new Set(candidates.map((c) => c.file_path));
    for (const f of files) {
      for (const imp of importerOf.get(f) ?? []) {
        step('import', `[callers←] 经 import 依赖：${f} 被 ${imp.to} 导入`);
      }
      for (const imp of importeeOf.get(f) ?? []) {
        step('import', `[→callees] 经 import 依赖：${f} 导入了 ${imp.to}`);
      }
    }
  }

  return { chain, reached: [...reached.keys()], warnings };
}
