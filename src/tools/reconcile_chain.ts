/**
 * reconcile_chain —— 中观档工具：按「文件 / 宿主节点」一条命令的真跑 + 查数据 + 对账
 *
 * 定位（design-canvas 工具可用性复盘 2026-08-26，缺口桶 C）：
 *   宏观对账（整项目 contract vs 全量 observe 事件）重，微观（trace-exec 纯函数
 *   子集，一碰真实 I/O 就 unsupported）假——两者之间空着的「按这一条链真跑 +
 *   查这条链真数据 + 对该块」就是本工具。
 *
 * 编排（后工具自动前置 + 缓存跳过）：
 *   1. deriveDetailChain（建链）—— 宿主下已有 detail 链则缓存命中跳过，没有才自动派生
 *   2. 自动发现被观测项目的事件文件（.agent/observe + .design-canvas/observe）
 *   3. queryObserveLog 按链涉及文件过滤 → 这条链的真跑事件
 *   4. judgeEvent 逐事件判定 → 偏差清单（silent-error-discard 等）
 *   5. rebuildChains 从带 trace 的事件重建实测调用链
 *   6. 链路契约匹配：声明链 vs 实测链（子序列语义，与 observe_chain_view 一致）
 *
 * 诚实纪律：工具不产生事实、不伪造事件。该链无任何事件 → not_run=true，明示
 * 「先跑一遍再对账」，绝不降级冒充成品。
 *
 * 探针名近似：observe 事件探针名是 base probe（如 svc.Handle），detail 链是函数名
 * （如 Handle）。链路契约匹配按「basename（裸函数名）」对齐（mode='bare-name'），
 * 输出里如实标注该近似，不做文件级消歧。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL } from '../storage.js';
import { deriveDetailChain } from './derive_chain.js';
import { queryObserveLog } from '../observe/log_query.js';
import { judgeEvent } from '../observe/judge.js';
import { rebuildChains, matchChainDecl, type TSChainObs } from '../observe/chain.js';
import { loadTSEvents, type TSEvent } from '../observe/probe.js';

export interface ReconcileChainInput {
  /** DSL feature 名 */
  feature: string;
  /** 宿主文件节点 id（detail 链挂在它下面） */
  node_id: string;
  /** 被观测项目根目录（其下 .agent/observe/events-*.jsonl 是事件源） */
  project_dir: string;
  /** 显式事件文件列表（缺省自动发现） */
  events_files?: string[];
  /** true 忽略缓存强制重新派生链（默认 false，命中缓存即跳过派生） */
  force?: boolean;
  /** 派生入链函数上限（默认 12，仅在需派生时生效） */
  max_steps?: number;
}

export interface ReconcileChainFunction {
  step: number;
  name: string;
  signature?: string;
  node_id: string;
  file: string;
  is_cross: boolean;
}

export interface ReconcileChainObserved {
  trace_id: string;
  sequence: string[];
  errs: number;
  events: number;
}

export interface ReconcileChainDeviation {
  probe: string;
  time: string;
  rule: string;
  reason: string;
}

export interface ReconcileChainResult {
  feature: string;
  node_id: string;
  host_file: string;
  /** 本次建链方式：derived=新派生；cached=命中缓存复用 */
  derive: 'derived' | 'cached';
  chain: ReconcileChainFunction[];
  events: {
    files: string[];
    chain_events: number;
    total_events: number;
  };
  observed: ReconcileChainObserved[];
  deviations: ReconcileChainDeviation[];
  chain_match: {
    mode: 'bare-name';
    status: 'satisfied' | 'broken' | 'unobserved' | 'no-events';
    matched: number;
    want: string[];
    best_observed?: string[];
  };
  not_run: boolean;
  message: string;
}

// ─────────────────────────────────────────────────────────────
// 工具方法
// ─────────────────────────────────────────────────────────────

/** 自动发现事件文件：.agent/observe + .design-canvas/observe（与 reconcile_effects 对齐） */
function discoverEventFiles(root: string): string[] {
  const out: string[] = [];
  for (const dirRel of ['.agent/observe', '.design-canvas/observe']) {
    const dir = path.join(root, ...dirRel.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('events') && name.endsWith('.jsonl')) {
        out.push(path.join(dir, name));
      }
    }
  }
  return out.sort();
}

/** 定位宿主源文件绝对路径（绝对直用；相对先 project_root，回退 project_root/src） */
function locateHostSource(
  dsl: { semantic?: { files?: Array<{ id: string; path: string }> } },
  nodeId: string,
  projectRoot: string,
): string | null {
  const rel = dsl.semantic?.files?.find((f) => f.id === nodeId)?.path;
  if (!rel) return null;
  if (path.isAbsolute(rel)) return fs.existsSync(rel) ? rel : null;
  const atRoot = path.join(projectRoot, rel);
  if (fs.existsSync(atRoot)) return atRoot;
  const underSrc = path.join(projectRoot, 'src', rel);
  return fs.existsSync(underSrc) ? underSrc : null;
}

/** 宿主下是否已存在 detail 链（缓存命中判据：含 __s 派生前缀的 detail 节点） */
function hasDerivedChain(dsl: {
  geometry: { nodes: Array<{ id: string; host?: string; layer?: string }> };
}, nodeId: string): boolean {
  return dsl.geometry.nodes.some(
    (n) => n.host === nodeId && n.layer === 'detail' && n.id.startsWith(`${nodeId}__s`),
  );
}

/** 从 DSL detail 链读取函数序列（与 serve.ts collectChainInfo 同源解析） */
function readDerivedChain(
  dsl: {
    geometry: { nodes: Array<{ id: string; x?: number; host?: string; layer?: string; label?: string; description?: string }> };
    semantic?: { files?: Array<{ id: string; path: string }> };
  },
  nodeId: string,
  projectRoot: string,
): { chain: ReconcileChainFunction[]; hostFile: string | null } {
  const hostFile = locateHostSource(dsl, nodeId, projectRoot);
  const nodes = dsl.geometry.nodes
    .filter((n) => n.host === nodeId && n.layer === 'detail' && n.id.startsWith(`${nodeId}__s`) && !n.id.includes('__alg_'))
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));

  const chain: ReconcileChainFunction[] = [];
  nodes.forEach((n, i) => {
    const funcName = (n.label || '').replace(/^[①-⑫]|^\d+\.\s*/, '').replace(/·.*$/, '').trim();
    if (!funcName) return;
    let file = hostFile || '';
    const crossM = (n.description || '').match(/跨文件调用：(.+)$/m);
    if (crossM) {
      const t = crossM[1];
      file = path.isAbsolute(t) ? t : [path.join(projectRoot, t), path.join(projectRoot, 'src', t)].find((c) => fs.existsSync(c)) || path.join(projectRoot, t);
    }
    chain.push({
      step: i + 1,
      name: funcName,
      signature: (n.description || '').split('\n')[0] || undefined,
      node_id: n.id,
      file,
      is_cross: n.id.includes('__sx'),
    });
  });
  return { chain, hostFile };
}

/** basename 归一：base probe → 裸函数名（svc.Handle → Handle） */
function bare(s: string): string {
  return s.split(/[./:]/).filter(Boolean).pop() ?? s;
}

// ─────────────────────────────────────────────────────────────
// 主入口：中观档编排
// ─────────────────────────────────────────────────────────────

export async function reconcileChain(input: ReconcileChainInput): Promise<ReconcileChainResult> {
  const { feature, node_id } = input;
  const projectRoot = path.resolve(input.project_dir);

  let dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 create_feature 或 render_dsl`);
  if (!dsl.geometry.nodes.some((n) => n.id === node_id)) {
    throw new Error(`节点 "${node_id}" 不存在于 feature "${feature}"`);
  }

  // ── 后工具自动前置：建链（缓存命中跳过派生）──
  let derive: ReconcileChainResult['derive'] = 'cached';
  if (input.force || !hasDerivedChain(dsl, node_id)) {
    const hostFile = locateHostSource(dsl, node_id, projectRoot);
    if (!hostFile) throw new Error(`节点 "${node_id}" 无对应源文件，无法派生存取链`);
    await deriveDetailChain({
      feature,
      node_id,
      project_root: projectRoot,
      source_path: hostFile,
      max_steps: input.max_steps,
    });
    derive = 'derived';
    const reload = getDSL(feature);
    if (reload) dsl = reload;
  }

  // ── 读链（派生无论走缓存还是新建，统一从 DSL 取权威）──
  const { chain, hostFile } = readDerivedChain(dsl, node_id, projectRoot);
  if (chain.length === 0) {
    throw new Error('宿主节点下无 detail 链节点（自动派生后仍无可推导的函数调用链，或源文件不可解析）');
  }

  // ── 自动发现事件文件 + 按链文件过滤 → 这条链的真跑事件 ──
  const eventFiles = input.events_files?.length ? input.events_files : discoverEventFiles(projectRoot);
  const chainFiles = [...new Set(chain.map((c) => path.basename(c.file) || c.file))];
  const events: TSEvent[] = [];
  let totalEvents = 0;
  const hitFiles: string[] = [];
  for (const ef of eventFiles) {
    if (!fs.existsSync(ef)) continue;
    const q = queryObserveLog(ef, { files: chainFiles, all: true });
    totalEvents += q.total;
    // 命中：重新 load 该文件中命目录入事件（queryObserveLog 只给判定条目，缺 trace 细节）
    if (q.total > 0) {
      hitFiles.push(ef);
      events.push(...loadTSEvents(ef).events);
    }
  }
  const chainFileSet = new Set(chainFiles);
  const chainEvents = events.filter((ev) => {
    const f = typeof ev.fields['file'] === 'string' ? (ev.fields['file'] as string).replaceAll('\\', '/') : '';
    return chainFileSet.has(f) || chainFileSet.has(path.basename(f)) || (f && chainFiles.some((cf) => f.endsWith(cf)));
  });

  const not_run = chainEvents.length === 0;

  // ── 逐事件判定（偏差清单）──
  const deviations: ReconcileChainDeviation[] = chainEvents
    .map((ev) => {
      const v = judgeEvent(ev);
      return v.result === 'deviation'
        ? { probe: ev.probe, time: ev.time, rule: v.rule, reason: v.reason }
        : null;
    })
    .filter((d): d is ReconcileChainDeviation => d !== null);

  // ── 重建实测调用链 + 链路契约匹配 ──
  let observed: ReconcileChainObserved[] = [];
  let chainStatus: ReconcileChainResult['chain_match']['status'] = 'no-events';
  let matched = 0;
  let bestObserved: string[] | undefined;
  const want = chain.map((c) => c.name);

  if (!not_run) {
    const { chains } = rebuildChains(chainEvents);
    observed = chains.map((c) => ({ ...c, sequence: c.sequence.map(bare), errs: c.errs ?? 0 }));
    const obsAsBare: TSChainObs[] = observed;
    const { satisfied, best } = matchChainDecl(want, obsAsBare);
    if (best) {
      matched = best.matched;
      bestObserved = best.chain.sequence;
    }
    chainStatus = !best ? 'unobserved' : satisfied ? 'satisfied' : 'broken';
  }

  // ── 人类可读报告 ──
  const lines = [
    `reconcile_chain 中观档 · feature "${feature}" · 宿主 ${node_id}`,
    `建链：${derive === 'derived' ? '本次自动派生' : '命中缓存，跳过派生'}  |  宿主文件：${hostFile ?? '(未定位)'}`,
    '',
    `声明链（${chain.length} 步）：`,
    ...chain.map((c) => `  ${c.step}. ${c.name}${c.signature ? `  ${c.signature}` : ''}${c.is_cross ? ' ·跨文件' : ''}`),
    '',
    `真跑事件：该链命中 ${chainEvents.length} 条${not_run ? '（无事件 —— 该链尚未真跑，先跑一遍再对账）' : ''}  |  事件文件：${hitFiles.length ? hitFiles.join(', ') : '无'}`,
    ...(observed.length > 0
      ? ['', `实测调用链 ${observed.length} 条：`, ...observed.map((o) => `  trace=${o.trace_id} [${o.sequence.join(' → ')}] errs=${o.errs}`)]
      : []),
    ...(deviations.length > 0
      ? ['', `偏差 ${deviations.length} 条：`, ...deviations.map((d) => `  [${d.rule}] ${d.probe}: ${d.reason}`)]
      : not_run ? [] : ['', '偏差：0 条 ✓']),
    '',
    `链路契约（mode=bare-name 近似匹配）：${chainStatus}`,
    ...(chainStatus === 'satisfied'
      ? ['  ✓ 声明链是实测链的子序列，当前实现与设计一致']
      : chainStatus === 'broken'
        ? [`  ✗ 声明序 [${want.join(' → ')}] 断裂，自第 ${matched + 1} 步 ${want[matched] ?? '?'} 起缺失/乱序（前缀匹配 ${matched}/${want.length}）`, `  最近实测: ${(bestObserved ?? []).join(' → ')}`]
        : chainStatus === 'unobserved'
          ? [`  ✗ 根探针 ${want[0]} 未出现在任何实测链（该链路无调用证据）`]
          : ['  — 暂无事件，未判（不证伪）']),
    '',
    '用途：重构前基线 / 重构后验收对照。该链真跑数据 + 现状偏差，一条命令即可复查。',
  ];

  return {
    feature,
    node_id,
    host_file: hostFile ?? '',
    derive,
    chain,
    events: { files: hitFiles, chain_events: chainEvents.length, total_events: totalEvents },
    observed,
    deviations,
    chain_match: { mode: 'bare-name', status: chainStatus, matched, want, best_observed: bestObserved },
    not_run,
    message: lines.join('\n'),
  };
}