/**
 * reconcile_brick —— 积木盒动静对账（Brick Harvest Phase 3R-C 工具化）
 *
 * 与 reconcile_effects（DSL 契约对账）的关系：判定规则同源（候选命中观测→
 * origin ast→runtime 转正；候选外新观测补进契约记 incomplete 告警；未触发
 * 保持 ast 不证伪），对账对象从 DSL SemanticFile.contract 换成积木盒
 * contracts.json + manifest.json：
 *
 *   前置链：harvest_from_url 入盒 → go-observe instrument --effects 插桩积木
 *   快照（或临时验证项目）→ 驱动运行产生 events-*.jsonl → 本工具。
 *
 *   输入契约：积木盒 <box>/<brick>/contracts.json（按文件键，含 effects）
 *   输出动作：contracts.json 转正 + runtime 观测字段；
 *            manifest.effect_verification 证据档案（重抽保留字段——
 *            快照可重抽，运行证据只有一份）。
 *
 * target 匹配规则（与 reconcile_effects 一致；3R-4 起探针 target 与静态
 * 候选同构——精确匹配为主，泛型探针名兜底）：
 *   write : 精确匹配（name / name.field / name[] / file:路径表达式）
 *   hold  : 精确匹配（goroutine / ticker / listen:addr / file:路径）；
 *           泛型 file-handle ↔ 静态 file:* 兜底
 *   emit  : 精确匹配（chan:name）
 *
 * 未观测候选归因（gap_note 人工/LLM 判定，机器不臆造）：
 *   not_triggered=观测窗口未覆盖（如轮转阈值未达） / probe_gap=静态候选有
 *   而探针无检测点 / static_only=包级字面量初始化的静态噪声。
 *
 * LLM 不产生事实：本工具只搬运 observe 观测，判定规则全部机械；
 * gap_notes 是调用方提供的归因输入（人工分析），工具如实登记。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { BrickManifest } from '../dsl/contract.js';
import type { EffectTarget } from '../dsl/contract.js';
import { getStorageRoot } from '../storage.js';

export interface ReconcileBrickInput {
  /** 积木目录（含 contracts.json + manifest.json；或传 brick_name + box_dir 让工具拼） */
  brick_dir?: string;
  /** 积木名（与 box_dir 搭配：<box_dir>/<brick_name>） */
  brick_name?: string;
  /** 积木盒根目录（默认 <dataHome>/.design-canvas/bricks；brick_name 模式必填或可默认） */
  box_dir?: string;
  /** 事件文件（缺省自动发现 <brick_dir>/.agent/observe/events-*.jsonl 及验证项目常见位置） */
  events_files?: string[];
  /** 验证项目根目录（自动发现其 .agent/observe/events-*.jsonl） */
  verify_dir?: string;
  /** 未观测候选归因（人工/LLM 分析输入；键=文件名|target，值=归因说明） */
  gap_notes?: Record<string, string>;
  /** 归因之外的已知盲区（写入证据档案 known_blind_spots） */
  known_blind_spots?: string[];
  /** 对账方法描述（写入证据档案 method，如"instrument --effects + golog-verify 驱动"） */
  method?: string;
  /** false=只对账预演不写回（默认 true） */
  write?: boolean;
}

export interface BrickFileReconcileReport {
  /** contracts.json 键（积木内相对路径） */
  brick_path: string;
  /** 观测事件来源文件名（fields.file） */
  observed_from: string;
  observed_events: number;
  confirmed: Array<{ kind: 'write' | 'hold' | 'emit'; target: string }>;
  /** 候选外新观测（补进契约 + incomplete 告警——静态扫描漏了） */
  newly_observed: Array<{ kind: 'write' | 'hold' | 'emit'; target: string; op: string }>;
  /** 未观测候选（保持 ast）+ 已提供归因的带 note */
  unobserved: Array<{ target: string; note?: string }>;
  runtime: { call_count: number; top_callers: string[]; last_seen: string };
}

export interface ReconcileBrickResult {
  brick_dir: string;
  events_files: string[];
  effect_events: number;
  files: BrickFileReconcileReport[];
  /** 契约不完整告警（候选外新观测） */
  incomplete: Array<{ brick_path: string; kind: string; target: string }>;
  stats: { files_matched: number; confirmed: number; newly_observed: number; unobserved: number };
  written: boolean;
  message: string;
}

interface EffectEvent {
  probe: string;
  time: string;
  fields: { file: string; kind: string; target: string; op: string };
}

interface RawEvent {
  probe?: string;
  time?: string;
  fields?: { level?: string; file?: string; kind?: string; target?: string; op?: string };
}

interface FileObservation {
  targets: Map<string, { kind: string; target: string; op: string; count: number }>;
  probes: Map<string, number>;
  total: number;
  lastSeen: string;
}

/** 默认积木盒根：与 harvest_from_url / slim_brick 同源（getStorageRoot；调用方传 box_dir 时以显式为准） */
function defaultBoxDir(): string {
  return path.resolve(path.join(getStorageRoot(), 'bricks'));
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

async function readEffectEvents(files: string[]): Promise<EffectEvent[]> {
  const out: EffectEvent[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
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

/** hold 匹配：精确（3R-4 同构 target）为主，泛型探针名兜底（旧探针兼容） */
function holdMatches(observedTarget: string, candidateTarget: string): boolean {
  if (observedTarget === candidateTarget) return true;
  if (observedTarget === 'file-handle') return candidateTarget.startsWith('file:');
  return false;
}

export async function reconcileBrick(input: ReconcileBrickInput): Promise<ReconcileBrickResult> {
  // ── 定位积木目录 ──
  const brickDir = input.brick_dir
    ? path.resolve(input.brick_dir)
    : input.brick_name
      ? path.resolve(input.box_dir ?? defaultBoxDir(), input.brick_name)
      : (() => {
          throw new Error('需提供 brick_dir 或 brick_name（+可选 box_dir）定位积木');
        })();
  const contractsPath = path.join(brickDir, 'contracts.json');
  const manifestPath = path.join(brickDir, 'manifest.json');
  if (!fs.existsSync(contractsPath)) {
    throw new Error(`积木目录无 contracts.json：${brickDir}（先 harvest_from_url 入盒）`);
  }

  // ── 事件源：显式列表 > verify_dir 自动发现 > brick_dir 自动发现 ──
  const eventsFiles = input.events_files?.length
    ? input.events_files.map((f) => path.resolve(f))
    : [
        ...(input.verify_dir ? discoverEventFiles(path.resolve(input.verify_dir)) : []),
        ...discoverEventFiles(brickDir),
      ];

  const emptyResult = (msg: string): ReconcileBrickResult => ({
    brick_dir: brickDir,
    events_files: eventsFiles,
    effect_events: 0,
    files: [],
    incomplete: [],
    stats: { files_matched: 0, confirmed: 0, newly_observed: 0, unobserved: 0 },
    written: false,
    message: msg,
  });

  if (eventsFiles.length === 0) {
    return emptyResult(
      `未发现事件文件（${input.verify_dir ?? brickDir} 下无 .agent/observe/events-*.jsonl）。` +
        '前置链：instrument --effects 插桩积木快照 → 驱动运行产生观测。',
    );
  }
  const events = await readEffectEvents(eventsFiles);
  if (events.length === 0) {
    return emptyResult(`事件文件中无 level=effect 事件（读 ${eventsFiles.length} 个文件）。需 --effects 插桩后重新运行。`);
  }

  // ── 按观测文件聚合 ──
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

  // ── 对账 contracts.json ──
  const contracts = JSON.parse(fs.readFileSync(contractsPath, 'utf8')) as Record<
    string,
    { effects?: { writes: EffectTarget[]; holds: EffectTarget[]; emits: string[] }; runtime?: Record<string, unknown> }
  >;
  const gapNotes = input.gap_notes ?? {};

  const reports: BrickFileReconcileReport[] = [];
  const incomplete: Array<{ brick_path: string; kind: string; target: string }> = [];
  let confirmedTotal = 0;
  let newlyTotal = 0;
  let unobservedTotal = 0;
  let changed = false;

  for (const [brickPath, contract] of Object.entries(contracts)) {
    const basename = brickPath.split('/').pop()!;
    // 匹配观测文件：contracts 键的 basename（探针 fields.file 是文件名）
    const obsFile =
      byFile.get(basename) ??
      byFile.get(brickPath) ??
      byFile.get(brickPath.replace(/^\//, ''));
    const fx = contract.effects;
    if (!fx) continue;
    if (!obsFile) {
      // 无观测：全部候选进 unobserved（带归因），不算失败
      const unobs = [
        ...fx.writes.filter((w) => w.origin === 'ast').map((w) => ({ target: w.target })),
        ...fx.holds.filter((h) => h.origin === 'ast').map((h) => ({ target: h.target })),
      ].map((u) => ({ ...u, note: gapNotes[`${basename}|${u.target}`] }));
      if (unobs.length > 0) {
        unobservedTotal += unobs.length;
        reports.push({
          brick_path: brickPath,
          observed_from: '',
          observed_events: 0,
          confirmed: [],
          newly_observed: [],
          unobserved: unobs,
          runtime: { call_count: 0, top_callers: [], last_seen: '' },
        });
      }
      continue;
    }

    const confirmed: BrickFileReconcileReport['confirmed'] = [];
    const newly: BrickFileReconcileReport['newly_observed'] = [];
    const confirmedTargets = new Set<string>();

    for (const { kind, target, op } of obsFile.targets.values()) {
      if (kind === 'write') {
        const hit = fx.writes.find((w) => w.target === target);
        if (hit) {
          hit.origin = 'runtime';
          confirmed.push({ kind: 'write', target });
          confirmedTargets.add(`write|${target}`);
        } else {
          fx.writes.push({ target, op: (op as EffectTarget['op']) ?? 'write', origin: 'runtime' });
          newly.push({ kind: 'write', target, op });
        }
      } else if (kind === 'hold') {
        const hit = fx.holds.find((h) => holdMatches(target, h.target));
        if (hit) {
          hit.origin = 'runtime';
          confirmed.push({ kind: 'hold', target: hit.target });
          confirmedTargets.add(`hold|${hit.target}`);
        } else {
          fx.holds.push({ target, op: 'acquire', origin: 'runtime' });
          newly.push({ kind: 'hold', target, op: 'acquire' });
        }
      } else if (kind === 'emit') {
        if (fx.emits.includes(target)) {
          confirmed.push({ kind: 'emit', target });
          confirmedTargets.add(`emit|${target}`);
        } else {
          fx.emits.push(target);
          newly.push({ kind: 'emit', target, op: 'emit' });
        }
      }
    }

    // 未观测候选（保持 ast 不证伪；有归因的带 note）
    const unobserved = [
      ...fx.writes.filter((w) => w.origin === 'ast').map((w) => ({ target: w.target })),
      ...fx.holds.filter((h) => h.origin === 'ast').map((h) => ({ target: h.target })),
    ].map((u) => ({ ...u, note: gapNotes[`${basename}|${u.target}`] }));

    // runtime 观测字段
    const topCallers = [...obsFile.probes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([p, n]) => `${p}×${n}`);
    contract.runtime = {
      call_count: obsFile.total,
      top_callers: topCallers,
      observed_targets: [...confirmedTargets].map((k) => k.split('|')[1]),
      last_seen: obsFile.lastSeen,
    };

    confirmedTotal += confirmed.length;
    newlyTotal += newly.length;
    unobservedTotal += unobserved.length;
    for (const n of newly) incomplete.push({ brick_path: brickPath, kind: n.kind, target: n.target });
    changed = true;

    reports.push({
      brick_path: brickPath,
      observed_from: basename,
      observed_events: obsFile.total,
      confirmed,
      newly_observed: newly,
      unobserved,
      runtime: { call_count: obsFile.total, top_callers: topCallers, last_seen: obsFile.lastSeen },
    });
  }

  // ── 写回（contracts.json + manifest.effect_verification）──
  let written = false;
  if (input.write !== false && (changed || fs.existsSync(manifestPath))) {
    fs.writeFileSync(contractsPath, JSON.stringify(contracts, null, 2), 'utf8');

    // manifest.effect_verification 证据档案（重抽保留字段）
    let manifest: BrickManifest = {} as BrickManifest;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BrickManifest;
      } catch {
        manifest = {} as BrickManifest;
      }
    }
    manifest.effect_verification = {
      verified_at: new Date().toISOString(),
      method: input.method ?? 'go-observe instrument --effects 插桩 + 驱动运行（详见事件文件）',
      events: events.length,
      stats: { confirmed: confirmedTotal, unobserved: unobservedTotal },
      files: reports.map((r) => ({
        file: r.brick_path.split('/').pop()!,
        confirmed: r.confirmed.map((c) => c.target),
        unobserved: r.unobserved,
      })),
      ...(input.known_blind_spots?.length ? { known_blind_spots: input.known_blind_spots } : {}),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    written = true;
  }

  const message =
    `积木对账：${events.length} 条 effect 事件（${eventsFiles.length} 个文件）命中 ${reports.length} 个契约文件——` +
    `候选转正 ${confirmedTotal}（origin→runtime），候选外新观测 ${newlyTotal}${newlyTotal > 0 ? '（已补进契约，需复核 incomplete 告警）' : ''}，` +
    `未观测 ${unobservedTotal}（保持 ast${Object.keys(gapNotes).length > 0 ? '，归因已登记' : ''}）` +
    (written ? `，已写回 ${path.basename(brickDir)}（contracts.json + manifest.effect_verification）` : '（预演未写回）') +
    `。`;

  return {
    brick_dir: brickDir,
    events_files: eventsFiles,
    effect_events: events.length,
    files: reports,
    incomplete,
    stats: { files_matched: reports.length, confirmed: confirmedTotal, newly_observed: newlyTotal, unobserved: unobservedTotal },
    written,
    message,
  };
}
