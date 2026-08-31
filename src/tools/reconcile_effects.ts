/**
 * reconcile_effects —— 积木契约动静对账（Brick Harvest Phase 2c）
 *
 * "动静结合"主线的合龙动作：
 *   静（extract_contracts，origin='ast'）：AST 扫出的 effects 候选——"疑似"
 *   动（observe effect 探针）：go-observe --effects 插桩，运行时 Capture
 *       {level:'effect', kind, target, op}——"实锤"
 *   对账（本工具）：读 <project>/.agent/observe/events-*.jsonl，按文件聚合 effect
 *   事件，与 DSL 契约（SemanticFile.contract.effects）对账：
 *     - 候选命中观测  → origin: 'ast' 升格 'runtime'（候选转正）
 *     - 观测在候选外  → 新增 EffectTarget(origin:'runtime') + 记入 incomplete
 *                       告警（契约不完整——静态扫描漏了）
 *     - 候选未观测    → 保持 'ast'（不证伪：可能只是观测窗口没触发）
 *   并填充 contract.runtime（call_count / top_callers / observed_targets / last_seen）。
 *
 * target 归一化对照（Go 静态候选 vs effect 探针）：
 *   write : 精确匹配（name / name.field / name[]）
 *   emit  : 精确匹配（chan:name）
 *   hold  : goroutine / ticker 精确；listen / db-pool 前缀（探针不捕获运行时
 *           参数，静态侧有 addr/driver 细节）；探针 file-handle ↔ 静态 file:*
 *
 * LLM 不产生事实：本工具只搬运 observe 观测，判定规则全部机械。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getDSL, saveDSL } from '../storage.js';
import type { EffectTarget } from '../dsl/contract.js';

export interface ReconcileEffectsInput {
  /** 被观测项目根目录（其下 .agent/observe/events-*.jsonl 是事件源） */
  project_dir: string;
  /** DSL feature 名（契约挂在其 SemanticFile.contract） */
  feature: string;
  /** 显式事件文件（缺省自动发现 .agent/observe/events-*.jsonl） */
  events_files?: string[];
  /** false 只对账预演不写回 DSL（默认 true） */
  write_dsl?: boolean;
}

export interface FileReconcileReport {
  /** DSL 语义文件路径 */
  dsl_path: string;
  /** 观测事件来源文件（fields.file，相对项目根） */
  observed_from: string;
  /** 观测到的 (kind,target) 总次数 */
  observed_events: number;
  confirmed: {
    writes: number;
    holds: number;
    emits: number;
  };
  /** 候选外新观测（写入契约并告警） */
  newly_observed: Array<{ kind: 'write' | 'hold' | 'emit'; target: string; op: string }>;
  /** 观测窗口内未触发的 ast 候选数（保持 origin='ast'） */
  unobserved_candidates: number;
  runtime: {
    call_count: number;
    top_callers: string[];
    last_seen: string;
  };
}

export interface ReconcileEffectsResult {
  project_dir: string;
  feature: string;
  events_files: string[];
  /** 读到的 effect 事件总数（过滤后） */
  effect_events: number;
  files: FileReconcileReport[];
  /** 契约不完整告警（候选外观测）汇总 */
  incomplete: Array<{ dsl_path: string; kind: string; target: string }>;
  written_to_dsl: boolean;
  stats: {
    files_matched: number;
    candidates_confirmed: number;
    newly_observed: number;
    unobserved: number;
  };
  message: string;
}

/** 一条 effect 事件的最小形态（observe probe.Event 的子集） */
interface EffectEvent {
  probe: string;
  time: string;
  fields: { file: string; kind: string; target: string; op: string };
}

/** jsonl 原始行（字段可能缺失，解析后收窄为 EffectEvent） */
interface RawEvent {
  probe?: string;
  time?: string;
  fields?: { level?: string; file?: string; kind?: string; target?: string; op?: string };
}

/** 按文件聚合的观测结果 */
interface FileObservation {
  /** (kind|target) → 命中次数 */
  targets: Map<string, { kind: string; target: string; op: string; count: number }>;
  /** probe 名 → 次数（top_callers 用） */
  probes: Map<string, number>;
  total: number;
  lastSeen: string;
}

/** 自动发现事件文件：.agent/observe/events-*.jsonl（含裸 events.jsonl） */
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

/** 流式读 jsonl，只留 effect 事件。坏行跳过（轮转残留/半行写入容忍）。 */
async function readEffectEvents(files: string[]): Promise<EffectEvent[]> {
  const out: EffectEvent[] = [];
  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, 'utf-8'),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      let ev: RawEvent;
      try {
        ev = JSON.parse(t) as RawEvent;
      } catch {
        continue;
      }
      if (
        ev?.fields?.level === 'effect' &&
        ev.fields.file &&
        ev.fields.target &&
        ev.fields.kind &&
        ev.probe &&
        ev.time
      ) {
        out.push({
          probe: ev.probe,
          time: ev.time,
          fields: {
            file: ev.fields.file,
            kind: ev.fields.kind,
            target: ev.fields.target,
            op: ev.fields.op ?? '',
          },
        });
      }
    }
  }
  return out;
}

/** hold 类 target 的对账匹配：探针粒度粗于静态候选（listen 无 addr / file-handle 无路径） */
function holdMatches(observedTarget: string, candidateTarget: string): boolean {
  if (observedTarget === candidateTarget) return true; // goroutine / ticker
  if (observedTarget === 'listen') return candidateTarget.startsWith('listen:');
  if (observedTarget === 'db-pool') return candidateTarget.startsWith('db-pool:');
  if (observedTarget === 'file-handle') return candidateTarget.startsWith('file:');
  return false;
}

export async function reconcileEffects(input: ReconcileEffectsInput): Promise<ReconcileEffectsResult> {
  const root = path.resolve(input.project_dir);
  const eventsFiles = input.events_files?.length
    ? input.events_files.map((f) => path.resolve(f))
    : discoverEventFiles(root);

  if (eventsFiles.length === 0) {
    return {
      project_dir: root,
      feature: input.feature,
      events_files: [],
      effect_events: 0,
      files: [],
      incomplete: [],
      written_to_dsl: false,
      stats: { files_matched: 0, candidates_confirmed: 0, newly_observed: 0, unobserved: 0 },
      message: `未发现事件文件（${path.join(root, '.agent', 'observe')} 下无 events-*.jsonl）。先插桩（instrument --effects）并运行项目产生观测。`,
    };
  }

  const events = await readEffectEvents(eventsFiles);
  if (events.length === 0) {
    return {
      project_dir: root,
      feature: input.feature,
      events_files: eventsFiles,
      effect_events: 0,
      files: [],
      incomplete: [],
      written_to_dsl: false,
      stats: { files_matched: 0, candidates_confirmed: 0, newly_observed: 0, unobserved: 0 },
      message: `事件文件中无 level=effect 事件（读 ${eventsFiles.length} 个文件）。需用 instrument --effects 重新插桩后运行。`,
    };
  }

  // 按观测文件聚合
  const byFile = new Map<string, FileObservation>();
  for (const ev of events) {
    let obs = byFile.get(ev.fields.file);
    if (!obs) byFile.set(ev.fields.file, (obs = { targets: new Map(), probes: new Map(), total: 0, lastSeen: '' }));
    const key = `${ev.fields.kind}|${ev.fields.target}`;
    const t = obs.targets.get(key) ?? { kind: ev.fields.kind, target: ev.fields.target, op: ev.fields.op, count: 0 };
    t.count++;
    obs.targets.set(key, t);
    obs.probes.set(ev.probe, (obs.probes.get(ev.probe) ?? 0) + 1);
    obs.total++;
    if (ev.time > obs.lastSeen) obs.lastSeen = ev.time;
  }

  // DSL 对账
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature "${input.feature}" 不存在`);

  const reports: FileReconcileReport[] = [];
  const incomplete: Array<{ dsl_path: string; kind: string; target: string }> = [];
  let confirmedTotal = 0;
  let newlyTotal = 0;
  let unobservedTotal = 0;
  let changed = false;

  for (const sf of dsl.semantic?.files ?? []) {
    if (!sf.path) continue;
    const candidates = sf.path.startsWith('src/') ? [sf.path, sf.path.slice(4)] : [sf.path];
    const obsFile = candidates.find((c) => byFile.has(c));
    if (!obsFile) continue;
    const obs = byFile.get(obsFile)!;
    if (!sf.contract) continue; // 无契约（未跑 extract_contracts）不对账，只跳过

    const fx = sf.contract.effects;
    let confirmed = { writes: 0, holds: 0, emits: 0 };
    const newly: FileReconcileReport['newly_observed'] = [];
    const confirmedTargets = new Set<string>();

    for (const { kind, target, op, count } of obs.targets.values()) {
      if (kind === 'write') {
        const hit = fx.writes.find((w) => w.target === target);
        if (hit) {
          hit.origin = 'runtime';
          confirmed.writes++;
          confirmedTargets.add(`write|${target}`);
        } else {
          fx.writes.push({ target, op: (op as EffectTarget['op']) ?? 'write', origin: 'runtime' });
          newly.push({ kind: 'write', target, op });
        }
      } else if (kind === 'hold') {
        const hit = fx.holds.find((h) => holdMatches(target, h.target));
        if (hit) {
          hit.origin = 'runtime';
          confirmed.holds++;
          confirmedTargets.add(`hold|${hit.target}`);
        } else {
          fx.holds.push({ target, op: 'acquire', origin: 'runtime' });
          newly.push({ kind: 'hold', target, op: 'acquire' });
        }
      } else if (kind === 'emit') {
        if (fx.emits.includes(target)) {
          confirmed.emits++;
          confirmedTargets.add(`emit|${target}`);
        } else {
          fx.emits.push(target);
          newly.push({ kind: 'emit', target, op: 'emit' });
        }
      }
    }

    // 未观测候选计数（保持 ast——不证伪）
    const unobserved =
      fx.writes.filter((w) => w.origin === 'ast').length +
      fx.holds.filter((h) => h.origin === 'ast').length +
      fx.emits.length -
      [...obs.targets.values()].filter((t) => t.kind === 'emit' && fx.emits.includes(t.target)).length;

    // runtime 字段
    const topCallers = [...obs.probes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, n]) => `${p}×${n}`);
    sf.contract.runtime = {
      call_count: obs.total,
      top_callers: topCallers,
      observed_targets: [...confirmedTargets].map((k) => k.split('|')[1]),
      last_seen: obs.lastSeen,
    };
    sf.contract.provenance = { ...sf.contract.provenance, last_reconciled: new Date().toISOString() };

    confirmedTotal += confirmed.writes + confirmed.holds + confirmed.emits;
    newlyTotal += newly.length;
    unobservedTotal += unobserved;
    for (const n of newly) incomplete.push({ dsl_path: sf.path, kind: n.kind, target: n.target });
    changed = true;

    reports.push({
      dsl_path: sf.path,
      observed_from: obsFile,
      observed_events: obs.total,
      confirmed,
      newly_observed: newly,
      unobserved_candidates: unobserved,
      runtime: {
        call_count: obs.total,
        top_callers: topCallers,
        last_seen: obs.lastSeen,
      },
    });
  }

  let written = false;
  if (input.write_dsl !== false && changed) {
    saveDSL(dsl, 'mcp');
    written = true;
  }

  const message =
    `动静对账：${events.length} 条 effect 事件（${eventsFiles.length} 个文件）命中 ${reports.length} 个契约文件——` +
    `候选转正 ${confirmedTotal}（origin→runtime），候选外新观测 ${newlyTotal}（已补进契约${newlyTotal > 0 ? '，需人工/LLM 复核 incomplete 告警' : ''}），` +
    `未触发候选 ${unobservedTotal}（保持 ast）` +
    (written ? `，已写回 DSL "${input.feature}"` : '') +
    `。`;

  return {
    project_dir: root,
    feature: input.feature,
    events_files: eventsFiles,
    effect_events: events.length,
    files: reports,
    incomplete,
    written_to_dsl: written,
    stats: {
      files_matched: reports.length,
      candidates_confirmed: confirmedTotal,
      newly_observed: newlyTotal,
      unobserved: unobservedTotal,
    },
    message,
  };
}
