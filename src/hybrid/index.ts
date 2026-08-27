/**
 * hybrid —— 项目杂交预检（融合可行性报告）
 *
 * 站在 cross_repo_symbol_index 之上，把"会不会撞名"扩成三维预检：
 *   1. 符号冲突（symbol）：复用 compareProjects —— 同名不同签 = 真冲突（杂交后互相遮蔽），
 *      同名同签 = 双胞胎（语义重复，可去重一个）。
 *   2. 依赖冲突（dependency）：读取两仓根级 manifest（package.json / go.mod / pyproject.toml /
 *      requirements.txt），同名依赖版本范围不一致 → 冲突；一致 → 共享；仅一方 → 单向依赖。
 *   3. 功能重叠（overlap）：复用双胞胎符号 = 既有代码语义重复（可去重，避免融合后长出两份实现）。
 *
 * 输出 verdict（可直接融合 / 需处理后融合 / 必须先解决符号冲突）+ 各维明细 + 理由清单。
 *
 * v1 边界（诚实标注）：
 *   - 依赖冲突按"版本范围字符串不等"判定（^18 vs ~18 也报冲突，宁多报不漏报）；
 *     不解析语义化版本兼容性，交由人工/后续精确比较。
 *   - manifest 只读两仓根级（不递归子包）：单仓 monorepo 场景不在 v1 内。
 *   - 功能重叠 v1 只取"同名同签双胞胎"这一强信号；语义相近但不同名的弱信号不报。
 *
 * 纯函数（解析/判定）+ 一个 IO 入口（precheckHybrid）：解析函数可单测，判定可单测。
 */

import { compareProjects, type SymbolCollision } from '../cross_repo/index.js';
import { analyzeHealth, type HealthReport } from '../health/index.js';
import fs from 'node:fs';
import path from 'node:path';

// ── 对外类型 ─────────────────────────────────────────────────

/** 一条依赖（来自任一 manifest） */
export interface ManifestDep {
  name: string;
  /** 版本范围原文（^1.2.3 / v1.2.3 / ==2.0 / >=1.5） */
  version: string;
  /** 来源 manifest 名（package.json / go.mod / pyproject.toml / requirements.txt） */
  source: string;
}

/** 依赖对比结果 */
export interface DepCompare {
  /** 同名但版本范围不一致 → 融合前需统一版本 */
  conflicts: ManifestDep[];
  /** 同名且版本一致 → 可共享，无阻碍 */
  shared: ManifestDep[];
  /** 仅 A 声明 → 融合后由 A 带入 */
  aOnly: ManifestDep[];
  /** 仅 B 声明 → 融合后由 B 带入 */
  bOnly: ManifestDep[];
}

/** 融合判定 */
export type HybridVerdict = 'ok' | 'fix' | 'blocked';

/** verdict 人类可读标签（CLI / MCP 展示用） */
export const VERDICT_LABEL: Record<HybridVerdict, string> = {
  ok: '可直接融合',
  fix: '需处理后融合',
  blocked: '必须先解决符号冲突',
};

/** 项目杂交预检报告 */
export interface HybridPrecheckReport {
  aRoot: string;
  bRoot: string;
  // 维度1：符号冲突（复用 cross_repo）
  symbolConflicts: SymbolCollision[];
  // 维度2+3 信号：双胞胎 = 可去重的功能重叠
  symbolDuplicates: SymbolCollision[];
  // 维度2：依赖对比
  deps: DepCompare;
  // 维度4：健康度（两个候选项目的健康体检报告，独立可用，此处仅作选材参考）
  health: { a: HealthReport; b: HealthReport };
  // 判定
  verdict: HybridVerdict;
  /** 人类可读的理由（为什么是这个 verdict + 健康度提醒） */
  reasons: string[];
}

/** 健康度提醒输入（只取评分/等级，供 judgeVerdict 纯函数判定） */
export interface HealthAdvisoryInput {
  aScore: number;
  aGrade: HealthReport['grade'];
  bScore: number;
  bGrade: HealthReport['grade'];
}

// ── manifest 解析（纯函数：输入内容 → 依赖列表） ────────────────

/** 解析 package.json 的 dependencies + devDependencies */
export function parsePackageJsonDeps(content: string): ManifestDep[] {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(content);
  } catch {
    return [];
  }
  const out: ManifestDep[] = [];
  for (const [section] of [
    ['dependencies'],
    ['devDependencies'],
  ] as const) {
    const map = pkg[section];
    if (!map) continue;
    for (const [name, version] of Object.entries(map)) {
      out.push({ name, version: String(version), source: 'package.json' });
    }
  }
  return out;
}

/** 解析 go.mod 的 require（单行 + block，均含 // indirect） */
export function parseGoModDeps(content: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const push = (name: string, version: string): void => {
    const v = version.trim();
    if (name && v) out.push({ name, version: v, source: 'go.mod' });
  };
  // block：require ( ... ) 内每行 `name version`
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(content)) !== null) {
    for (const line of m[1].split('\n')) {
      const t = line.replace(/\/\/.*$/, '').trim();
      if (!t) continue;
      const parts = t.split(/\s+/);
      if (parts.length >= 2) push(parts[0], parts[1]);
    }
  }
  // 单行：require name version
  const singleRe = /require\s+(\S+)\s+(v\S+)/g;
  while ((m = singleRe.exec(content)) !== null) push(m[1], m[2]);
  return out;
}

/** 解析 pyproject.toml 的 [project] dependencies + optional-dependencies */
export function parsePyprojectDeps(content: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const specRe = /^([A-Za-z0-9_.\-]+)\s*(.*)$/;
  // 按 section 分块；dependencies 数组只出现在 [project] 或名字含 dependencies 的 section（optional-dependencies / tool.poetry.dependencies 等）
  for (const part of content.split(/\n\[/)) {
    const header = part.split('\n')[0].trim().replace(/[\[\]]/g, '');
    if (header !== 'project' && !header.includes('dependencies')) continue;
    const arrRe = /^\s*[\w.-]+\s*=\s*\[([\s\S]*?)\]\s*(?:\n|$)/gm;
    let m: RegExpExecArray | null;
    while ((m = arrRe.exec(part)) !== null) {
      for (const line of m[1].split('\n')) {
        const t = line.trim();
        if (!t) continue;
        // 先剥尾逗号，再剥两端引号
        const raw = t.replace(/,$/, '').replace(/^['"]|['"]$/g, '').trim();
        if (!raw) continue;
        const sm = specRe.exec(raw);
        if (sm) out.push({ name: sm[1], version: sm[2].trim() || '*', source: 'pyproject.toml' });
      }
    }
  }
  return out;
}

/** 解析 requirements.txt（name==ver / name>=ver / name~=ver / name (ver)） */
export function parseRequirementsDeps(content: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  for (const line of content.split('\n')) {
    const t = line.replace(/\s*#.*$/, '').trim();
    if (!t) continue;
    const m = /^([A-Za-z0-9_.\-]+)\s*([=<>~!].*)$/.exec(t);
    if (m) out.push({ name: m[1], version: m[2].trim(), source: 'requirements.txt' });
  }
  return out;
}

// ── manifest 读取（IO 入口：读根级 manifest 并合并） ─────────────

const MANIFEST_FILES = ['package.json', 'go.mod', 'pyproject.toml', 'requirements.txt'] as const;

/** 读取一个项目根的全部根级 manifest 依赖（name 去重，先到先得） */
export function readManifestDeps(root: string): ManifestDep[] {
  const merged = new Map<string, ManifestDep>();
  for (const file of MANIFEST_FILES) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, 'utf-8');
    let deps: ManifestDep[] = [];
    if (file === 'package.json') deps = parsePackageJsonDeps(content);
    else if (file === 'go.mod') deps = parseGoModDeps(content);
    else if (file === 'pyproject.toml') deps = parsePyprojectDeps(content);
    else deps = parseRequirementsDeps(content);
    for (const d of deps) {
      if (!merged.has(d.name)) merged.set(d.name, d);
    }
  }
  return [...merged.values()];
}

// ── 依赖对比（纯函数） ─────────────────────────────────────────

const normVer = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** 对比两仓依赖：同名版本一致=shared、不一致=conflicts、仅一方=aOnly/bOnly */
export function compareDeps(aDeps: ManifestDep[], bDeps: ManifestDep[]): DepCompare {
  const conflicts: ManifestDep[] = [];
  const shared: ManifestDep[] = [];
  const aOnly: ManifestDep[] = [];
  const bOnly: ManifestDep[] = [];

  const bByName = new Map(bDeps.map((d) => [d.name, d]));
  const seenB = new Set<string>();

  for (const a of aDeps) {
    const b = bByName.get(a.name);
    if (!b) {
      aOnly.push(a);
      continue;
    }
    seenB.add(a.name);
    if (normVer(a.version) === normVer(b.version)) shared.push(a);
    else conflicts.push({ name: a.name, version: `${a.version} (A) ↔ ${b.version} (B)`, source: `${a.source}+${b.source}` });
  }
  for (const b of bDeps) {
    if (!seenB.has(b.name)) bOnly.push(b);
  }

  const sort = (arr: ManifestDep[]): ManifestDep[] => arr.sort((x, y) => (x.name < y.name ? -1 : 1));
  return { conflicts: sort(conflicts), shared: sort(shared), aOnly: sort(aOnly), bOnly: sort(bOnly) };
}

// ── 融合判定（纯函数） ─────────────────────────────────────────

/**
 * verdict 规则：
 *   - blocked：存在同名不同签符号冲突 —— 不处理会在融合仓互相遮蔽，必须先改名/错位
 *   - fix：无符号冲突，但依赖版本冲突或功能重叠（双胞胎）需处理
 *   - ok：三维全净，可直接融合
 *
 * health 可选：只追加健康度"提醒"理由，不改变 verdict（健康度是选材参考，不是硬闸门）：
 *   - 任一侧 C/D（<75 分）→ 追加"建议先优化健康度再融合"
 *   - 两侧 A/B 且三维全净 → 追加"健康度良好"正向确认
 */
export function judgeVerdict(
  conflictCount: number,
  duplicateCount: number,
  depConflictCount: number,
  health?: HealthAdvisoryInput,
): {
  verdict: HybridVerdict;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (conflictCount > 0) {
    reasons.push(`符号冲突 ${conflictCount} 个（同名不同签，杂交后互相遮蔽，需改名/错位后方可融合）`);
  }
  if (duplicateCount > 0) {
    reasons.push(`功能重叠 ${duplicateCount} 个（同名同签双胞胎，可去重一个，避免两份实现）`);
  }
  if (depConflictCount > 0) {
    reasons.push(`依赖版本冲突 ${depConflictCount} 个（同名依赖版本范围不一致，融合前需统一）`);
  }
  const hasHardIssues = conflictCount > 0 || duplicateCount > 0 || depConflictCount > 0;

  if (health) {
    const aPoor = health.aGrade === 'C' || health.aGrade === 'D';
    const bPoor = health.bGrade === 'C' || health.bGrade === 'D';
    if (aPoor) {
      reasons.push(`健康度提醒：项目 A 健康分 ${health.aScore}（${health.aGrade}），建议先优化健康度（清死代码/拆复杂度/修分层违规）再融合`);
    }
    if (bPoor) {
      reasons.push(`健康度提醒：项目 B 健康分 ${health.bScore}（${health.bGrade}），建议先优化健康度（清死代码/拆复杂度/修分层违规）再融合`);
    }
    if (!hasHardIssues && !aPoor && !bPoor) {
      reasons.push(`健康度良好：A ${health.aScore}（${health.aGrade}）/ B ${health.bScore}（${health.bGrade}），选材质量过关`);
    }
  }

  if (!hasHardIssues && reasons.length === 0) {
    reasons.push('三维预检全净：无符号冲突、无依赖冲突、无功能重叠，可直接融合');
  }
  // 有符号冲突 → blocked（必须改名）；其余（重叠/依赖冲突）→ fix（处理后即可融合）
  const verdict: HybridVerdict = conflictCount > 0 ? 'blocked' : hasHardIssues ? 'fix' : 'ok';
  return { verdict, reasons };
}

// ── 预检入口（IO） ─────────────────────────────────────────────

/** 对两个项目根做杂交预检：符号层复用 cross_repo，叠加依赖对比、功能重叠与健康度（第四查），输出融合判定 */
export async function precheckHybrid(aRoot: string, bRoot: string): Promise<HybridPrecheckReport> {
  const cross = await compareProjects(aRoot, bRoot);
  const deps = compareDeps(readManifestDeps(aRoot), readManifestDeps(bRoot));
  // 第四查：健康度（独立能力，此处作选材参考；不改变三维 verdict，只追加提醒）
  const [healthA, healthB] = await Promise.all([analyzeHealth(aRoot), analyzeHealth(bRoot)]);
  const { verdict, reasons } = judgeVerdict(cross.conflicts.length, cross.duplicates.length, deps.conflicts.length, {
    aScore: healthA.score,
    aGrade: healthA.grade,
    bScore: healthB.score,
    bGrade: healthB.grade,
  });
  return {
    aRoot: cross.aRoot,
    bRoot: cross.bRoot,
    symbolConflicts: cross.conflicts,
    symbolDuplicates: cross.duplicates,
    deps,
    health: { a: healthA, b: healthB },
    verdict,
    reasons,
  };
}
