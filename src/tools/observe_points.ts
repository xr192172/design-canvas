/**
 * observe_points —— 观测点推荐器：AST/索引语义 → 「该在哪打日志」的清单
 *
 * 背景（2026-09-14 与用户的设计对齐）：observe 线原有能力「**全量无脑插桩**」或
 * 「人工手写 contractProbes」，两端都不好——全量撑爆存储、手写会腐烂。
 * 本模块补中间那块**唯一缺口：自动产出清单**。
 *
 * ★ 两个关键设计（都是本项目既有教训的直接应用）：
 *
 * ① **单一真相源 = 插桩器本身**：推荐出的 key 不自己拼字符串，而是
 *    对候选文件跑一次 **`instrumentFile(..., { write: false })` dry-run**，
 *    拿它真实生成的站点名（`<mod>.<fn>.enter/.exit/.catch/.io.<op>`）。
 *    ⇒ **推荐的 key 与插桩器能插出来的 key 不可能漂移**（同 capability_map 那条教训：别手抄注册表）。
 *
 * ② **判定前移**（对齐 D 方案与 spill-policy 的"写入前替换"）：
 *    在**采集点**就按分数与预算裁剪，而不是先全量落盘再用环形缓冲挑。
 *
 * 信号（全部来自已有资产；标 (启发式) 的用文本近似，精度有限、如实标注）：
 *   - 高被引用：`edges(kind='call')` 的入度
 *   - 最近真改过：`symbol_diffs.changed`
 *   - 副作用边界：符号 span 内出现 IO 调用名 (启发式)
 *   - 静默吞错：符号 span 内的 catch 块且块内无 throw/console (启发式)
 *   - 复杂度高地：符号行数（span 大小）
 *   - 文件热点：files.modified_at 距今 < 24h
 *
 * 纯计算 + 一次 dry-run 插桩；不写被插桩项目的源码，只在自己的 `.design-canvas/` 下写清单。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import { instrumentFile } from '../observe/instrument.js';

export interface PointReason {
  /** 信号名（人读） */
  signal: string;
  /** 具体依据（数值/片段） */
  detail: string;
  /** 该信号贡献的权重 */
  weight: number;
}

export interface ObservePoint {
  /** 与 `InstrumentOptions.contractProbes` 精确匹配的探针名 */
  key: string;
  file: string;
  symbol: string;
  kind: 'enter' | 'exit' | 'catch' | 'io' | 'deep';
  level: 'core' | 'event' | 'deep';
  score: number;
  reasons: PointReason[];
  /** 同一探针名在符号内出现的次数（>1 时契约清单仍只需一项） */
  occurrences?: number;
}

export interface RecommendOptions {
  maxPoints?: number;
  maxFiles?: number;
  write?: boolean;
  /**
   * ★ 任务定向：只关心某个子系统/主题时传它（如 `conveyor|spill|cache` 或 `packages/conveyor-context`）。
   * 语义：匹配（大小写不敏感）到「文件路径 + 符号名/qualified_name」的候选**加分并优先扫描**。
   * 为什么需要：纯"热点 + 高被引用"会被最近改动的热门文件吃满名额，
   * 而用户往往想看的是**某个特定机理**（如上下文压缩/缓存命中率），不是"最热的那块"。
   */
  focus?: string;
  /** 额外/替代的路径白名单（前缀匹配，posix 分隔） */
  focusPaths?: string[];
}

/** 命中 focus 的加分（够大以进入候选，但不至于压掉其它信号的可解释性） */
const FOCUS_BOOST = 0.25;

export interface RecommendStats {
  filesWalked: number;
  filesScanned: number;
  symbolsScored: number;
  sitesFound: number;
  /** 去重后（同名探针只留一项）的候选数 */
  deduped: number;
  returned: number;
  truncated: number;
  /** 因"每符号/每文件配额"被跳过的数量（防热点文件吃满名额） */
  cappedByDiversity: number;
  ms: number;
}

export interface RecommendResult {
  points: ObservePoint[];
  /** 直接喂给 observe_instrument 的 contractProbes */
  contractProbes: string[];
  /** 清单文件路径（write !== false 时已落盘） */
  pointsFile: string;
  stats: RecommendStats;
  /** 人读摘要 */
  summary: string;
}

/** 信号权重（和为 1.0，便于阅读；score 直接是它们的加权和） */
export const SIGNAL_WEIGHTS = {
  indegree: 0.3,
  recentlyChanged: 0.2,
  io: 0.2,
  silentCatch: 0.15,
  size: 0.1,
  hotFile: 0.05,
} as const;

/** 与插桩器 IO_CALLS 同源的写盘/副作用调用名（启发式文本匹配用） */
const IO_NAMES = [
  'writeFileSync',
  'writeFile',
  'appendFileSync',
  'appendFile',
  'mkdirSync',
  'mkdir',
  'copyFileSync',
  'copyFile',
  'renameSync',
  'rename',
  'unlinkSync',
  'unlink',
  'rmSync',
  'rm',
  'spawn',
  'execSync',
  'execFileSync',
];

const DEFAULT_MAX_POINTS = 40;
const DEFAULT_MAX_FILES = 20;
/** 多样性配额：防一个热点符号/文件吃掉全部名额（按分数排，超配额的跳过） */
const MAX_PER_SYMBOL = 3;
const MAX_PER_FILE = 8;
const HOT_FILE_MS = 24 * 3600 * 1000;
const BIG_SYMBOL_LINES = 40;

interface SymbolRow {
  id: string;
  name: string;
  qualified_name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

/** 入度：指向该节点的 call 边数 */
function indegreeMap(db: Database): Map<string, number> {
  const rows = db
    .prepare("SELECT target, COUNT(*) c FROM edges WHERE kind = 'call' GROUP BY target")
    .all() as Array<{ target: string; c: number }>;
  return new Map(rows.map((r) => [r.target, r.c]));
}

/** 最近真正变过的符号（symbol_diffs.changed 是 JSON array of qualified_name） */
function recentlyChangedSet(db: Database): Set<string> {
  const out = new Set<string>();
  try {
    const rows = db.prepare('SELECT changed FROM symbol_diffs').all() as Array<{ changed: string }>;
    for (const r of rows) {
      try {
        for (const q of JSON.parse(r.changed) as string[]) out.add(q);
      } catch {
        /* 单行坏数据不影响整体 */
      }
    }
  } catch {
    /* 表可能不存在（旧库） */
  }
  return out;
}

function fileMtimes(db: Database): Map<string, number> {
  const rows = db.prepare('SELECT path, modified_at FROM files').all() as Array<{
    path: string;
    modified_at: number;
  }>;
  return new Map(rows.map((r) => [r.path, r.modified_at]));
}

/** 符号 span 内的启发式检查：IO 调用 / 静默吞错 */
function scanSpan(src: string): { io: string[]; silentCatch: number } {
  const io: string[] = [];
  for (const n of IO_NAMES) if (new RegExp(`\\b${n}\\s*\\(`).test(src)) io.push(n);
  let silentCatch = 0;
  const re = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const body = m[1] ?? '';
    if (!/\bthrow\b|\bconsole\.|\breject\b|report|logger|log\(/i.test(body)) silentCatch++;
  }
  return { io, silentCatch };
}

function sliceLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), Math.max(0, endLine)).join('\n');
}

/**
 * 推荐观测点。`write !== false` 时把清单写到 `<root>/.design-canvas/observe-points.json`。
 */
export async function recommendObservePoints(
  db: Database,
  projectRoot: string,
  opts: RecommendOptions = {},
): Promise<RecommendResult> {
  const t0 = Date.now();
  const root = path.resolve(projectRoot);
  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const focusRe = opts.focus ? new RegExp(opts.focus, 'i') : null;
  const focusPaths = (opts.focusPaths ?? []).map((p) => p.replace(/\\/g, '/'));

  const indeg = indegreeMap(db);
  const changed = recentlyChangedSet(db);
  const mtimes = fileMtimes(db);
  const now = Date.now();

  // ── 1. 打分：所有非闭包符号（排除局部闭包：它们不进契约面、观测价值低） ──
  const symbols = db
    .prepare(
      `SELECT id, name, qualified_name, kind, file_path, start_line, end_line
       FROM nodes WHERE kind != 'file' AND is_closure = 0`,
    )
    .all() as unknown as SymbolRow[];

  const textCache = new Map<string, string | null>();
  const readText = (rel: string): string | null => {
    if (textCache.has(rel)) return textCache.get(rel) ?? null;
    let t: string | null = null;
    try {
      t = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      t = null;
    }
    textCache.set(rel, t);
    return t;
  };

  interface Scored {
    sym: SymbolRow;
    score: number;
    reasons: PointReason[];
    files: string;
    focusHit?: boolean;
  }
  const scored: Scored[] = [];
  for (const s of symbols) {
    const reasons: PointReason[] = [];
    let score = 0;

    const inN = indeg.get(s.id) ?? 0;
    if (inN > 0) {
      const w = SIGNAL_WEIGHTS.indegree * Math.min(1, Math.log1p(inN) / Math.log1p(12));
      score += w;
      reasons.push({ signal: '高被引用', detail: `${inN} 处调用边指向它`, weight: Number(w.toFixed(3)) });
    }

    if (changed.has(s.qualified_name)) {
      score += SIGNAL_WEIGHTS.recentlyChanged;
      reasons.push({
        signal: '最近真改过',
        detail: 'symbol_diffs 记录该符号 span hash 变化',
        weight: SIGNAL_WEIGHTS.recentlyChanged,
      });
    }

    const lines = Math.max(0, s.end_line - s.start_line + 1);
    if (lines >= BIG_SYMBOL_LINES) {
      score += SIGNAL_WEIGHTS.size;
      reasons.push({ signal: '复杂度高地', detail: `${lines} 行`, weight: SIGNAL_WEIGHTS.size });
    }

    const mt = mtimes.get(s.file_path);
    if (mt && now - mt < HOT_FILE_MS) {
      score += SIGNAL_WEIGHTS.hotFile;
      reasons.push({ signal: '文件热点', detail: '24h 内改动过', weight: SIGNAL_WEIGHTS.hotFile });
    }

    const text = readText(s.file_path);
    if (text) {
      const span = sliceLines(text, s.start_line, s.end_line);
      const { io, silentCatch } = scanSpan(span);
      if (io.length) {
        score += SIGNAL_WEIGHTS.io;
        reasons.push({ signal: '副作用边界 (启发式)', detail: `span 内出现 ${io.slice(0, 3).join('/')}`, weight: SIGNAL_WEIGHTS.io });
      }
      if (silentCatch > 0) {
        score += SIGNAL_WEIGHTS.silentCatch;
        reasons.push({ signal: '静默吞错 (启发式)', detail: `${silentCatch} 个 catch 块内无 throw/日志`, weight: SIGNAL_WEIGHTS.silentCatch });
      }
    }

    if (score <= 0) continue;

    // ★ 任务定向：命中 focus（路径/符号名）的候选加分 —— 让人能"看某个机理"，而不是"看最热的那块"
    const focusHit =
      (focusRe !== null && focusRe.test(`${s.file_path} ${s.qualified_name} ${s.name}`)) ||
      focusPaths.some((fp) => s.file_path.startsWith(fp));
    if (focusHit) {
      score += FOCUS_BOOST;
      reasons.push({
        signal: '聚焦命中',
        detail: opts.focus ?? focusPaths.join('/'),
        weight: FOCUS_BOOST,
      });
    }

    scored.push({ sym: s, score: Math.min(1, Number(score.toFixed(3))), reasons, files: s.file_path, focusHit });
  }

  scored.sort(
    (a, b) => Number(b.focusHit ?? false) - Number(a.focusHit ?? false) || b.score - a.score || a.sym.id.localeCompare(b.sym.id),
  );

  // ── 2. 取分数最高的若干符号所在文件（预算：不扫全项目）；focus 命中的文件优先 ──
  const fileRank: string[] = [];
  for (const s of scored) if (!fileRank.includes(s.files)) fileRank.push(s.files);
  const filesToScan = fileRank.slice(0, maxFiles);
  const scanSet = new Set(filesToScan);

  // ── 3. ★ 单一真相源：对这些文件 dry-run 插桩，拿真实站点名（key 不可能漂移） ──
  const scoreOfFile = new Map<string, number>();
  const reasonsOfSymbol = new Map<string, PointReason[]>();
  const focusedFiles = new Set<string>();
  for (const s of scored) {
    const key = `${path.basename(s.files).replace('.ts', '')}.${s.sym.name}`;
    const prev = scoreOfFile.get(s.files) ?? 0;
    scoreOfFile.set(s.files, Math.max(prev, s.score));
    if (s.focusHit) focusedFiles.add(s.files);
    if (!reasonsOfSymbol.has(key) || s.score >= (scoreOfFile.get(key) ?? 0)) {
      reasonsOfSymbol.set(key, s.reasons);
    }
  }

  const points: ObservePoint[] = [];
  const pointFocused = new Map<string, boolean>();
  const seen = new Map<string, ObservePoint & { occurrences: number }>();
  let sitesFound = 0;
  for (const rel of filesToScan) {
    const abs = path.join(root, rel);
    const r = await instrumentFile(abs, { write: false, projectRoot: root, backupRoot: root });
    for (const site of r.sites) {
      sitesFound++;
      const kind = site.kind;
      if (kind === 'deep') continue; // 默认不推荐（事件量很大）
      const baseScore = scoreOfFile.get(rel) ?? 0;
      const symName = site.probe.split('.').slice(1, -1).join('.');
      const reasons = reasonsOfSymbol.get(`${path.basename(rel).replace('.ts', '')}.${symName}`) ?? [];
      // catch/io 是"事实性"站点：即使所属符号分数不高也值得（吞错/副作用本身即证据）
      const boost = kind === 'io' ? 0.2 : kind === 'catch' ? 0.1 : 0;
      // ★ 任务定向：聚焦文件里的点同样加分并**在预算里优先**（否则会被热点文件挤出前 N）
      const focusBoost = focusedFiles.has(rel) ? FOCUS_BOOST : 0;
      const score = Math.min(1, Number(((baseScore || 0.3) + boost + focusBoost).toFixed(3)));
      const focused = focusedFiles.has(rel);
      // ⚠️ 两个坑都在这里：
      //   ① `reasons` 是 reasonsOfSymbol 里**共享**的数组引用，直接 push 会按站点数重复累积；
      //   ② 符号级打分时（§1）已经为聚焦命中 push 过一条 ⇒ 这里只在缺失时补，避免重复。
      const alreadyFocused = reasons.some((r) => r.signal === '聚焦命中');
      const pointReasons =
        focused && !alreadyFocused
          ? [...reasons, { signal: '聚焦命中', detail: opts.focus ?? focusPaths.join('/'), weight: FOCUS_BOOST }]
          : reasons;
      if (focused) pointFocused.set(site.probe, true);

      // ★ 去重：同一符号内同类站点的探针名相同（名字里没有行号）⇒ 契约清单只需一项。
      const dup = seen.get(site.probe);
      if (dup) {
        dup.occurrences++;
        continue;
      }
      seen.set(site.probe, {
        key: site.probe,
        file: rel,
        symbol: symName || 'module',
        kind,
        level: (site.level ?? (kind === 'catch' || kind === 'io' ? 'event' : 'core')) as ObservePoint['level'],
        score,
        reasons:
          pointReasons.length > 0
            ? pointReasons
            : [{ signal: kind === 'io' ? '副作用边界' : '静默吞错', detail: '站点自身即证据', weight: boost }],
        occurrences: 1,
      });
    }
  }
  const deduped = [...seen.values()].map((p) =>
    p.occurrences > 1
      ? {
          ...p,
          reasons: [
            ...p.reasons,
            {
              signal: '同符号内多点',
              detail: `${p.occurrences} 处同类站点（探针名相同，契约清单一项即可）`,
              weight: 0,
            },
          ],
        }
      : p,
  );

  // ── 4. 预算裁剪：先按分数，再做**多样性配额**（防一个热点文件吃掉全部名额）──
  //    对齐 D 方案：裁剪在"声明层"做，有语义、可解释；不搞环形缓冲那套事后存储策略。
  deduped.sort(
    (a, b) =>
      Number(pointFocused.get(b.key) ?? false) - Number(pointFocused.get(a.key) ?? false) ||
      b.score - a.score ||
      a.key.localeCompare(b.key),
  );
  const perSymbol = new Map<string, number>();
  const perFile = new Map<string, number>();
  const kept: ObservePoint[] = [];
  let cappedByDiversity = 0;
  for (const p of deduped) {
    if (kept.length >= maxPoints) break;
    const sk = `${p.file}#${p.symbol}`;
    if ((perSymbol.get(sk) ?? 0) >= MAX_PER_SYMBOL || (perFile.get(p.file) ?? 0) >= MAX_PER_FILE) {
      cappedByDiversity++;
      continue;
    }
    perSymbol.set(sk, (perSymbol.get(sk) ?? 0) + 1);
    perFile.set(p.file, (perFile.get(p.file) ?? 0) + 1);
    kept.push(p);
  }
  const truncated = deduped.length - kept.length;

  const pointsFile = path.join(root, '.design-canvas', 'observe-points.json');
  const payload = {
    schema: 'design-canvas/observe-points/v1',
    generatedAt: new Date().toISOString(),
    projectRoot: root,
    contractProbes: kept.map((p) => p.key),
    points: kept,
    stats: {
      filesScanned: filesToScan.length,
      symbolsScored: scored.length,
      sitesFound,
      deduped: deduped.length,
      returned: kept.length,
      truncated,
      cappedByDiversity,
    },
  };
  if (opts.write !== false) {
    fs.mkdirSync(path.dirname(pointsFile), { recursive: true });
    fs.writeFileSync(pointsFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  }

  const byLevel = kept.reduce<Record<string, number>>((m, p) => ((m[p.level] = (m[p.level] ?? 0) + 1), m), {});
  const top = kept.slice(0, 8).map((p) => {
    const why = p.reasons.map((r) => r.signal).join(' + ');
    return `  ${p.score.toFixed(2)}  ${p.key}${why ? `  ← ${why}` : ''}`;
  });
  const summary = [
    `观测点推荐：${scored.length} 个符号参与打分（${filesToScan.length} 个文件 dry-run 插桩，找到 ${sitesFound} 个站点）`,
    opts.focus || focusPaths.length
      ? `聚焦：${opts.focus ?? ''}${focusPaths.length ? ` ${focusPaths.join(', ')}` : ''} —— 命中 ${scored.filter((s) => s.focusHit).length} 个符号（命中者优先扫描并加分）`
      : '',
    `按预算取前 ${kept.length} 个（core ${byLevel['core'] ?? 0} / event ${byLevel['event'] ?? 0}）${truncated ? `，截断 ${truncated} 个` : ''}`,
    truncated ? `（截断按分数 + 每符号≤${MAX_PER_SYMBOL}/每文件≤${MAX_PER_FILE} 的多样性配额，不是随机丢）` : '',
    '',
    '推荐点（分数 / 探针名 / 依据）：',
    ...top,
    kept.length > top.length ? `  …（共 ${kept.length} 个，完整清单见 ${pointsFile}）` : '',
    `清单：${pointsFile}`,
    '用法：把 contractProbes 交给 observe_instrument(action=instrument, contract_probes=[...]) —— 只插这些点。',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    points: kept,
    contractProbes: kept.map((p) => p.key),
    pointsFile,
    stats: {
      filesWalked: fileRank.length,
      filesScanned: filesToScan.length,
      symbolsScored: scored.length,
      sitesFound,
      deduped: deduped.length,
      returned: kept.length,
      truncated,
      cappedByDiversity,
      ms: Date.now() - t0,
    },
    summary,
  };
}
