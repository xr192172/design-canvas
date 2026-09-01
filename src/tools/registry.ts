/**
 * 产物注册表（G0）：统一管理 <output> 下的生成产物
 *
 * 背景：此前每个 feature 各生成各的 HTML，散落在 output/ 且互无索引、无语义化。
 * 本模块提供一个 .registry.json 作为"产物目录"：
 *   - 生成产物时自动注册（render_design 写文件后挂钩）
 *   - 人工可打标记/编辑（tags / note / title / status）
 *   - 供 Hub 首页动态渲染产物总览，也为后续跨产物导览（G1）铺路
 *
 * 存储：<dataHome>/output/.registry.json —— 产物是派生物，registory 同样可随时重建，
 * 因此不做保留式迁移（版本落后即整体重写，与 cache.db 策略一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DesignDSL } from '../dsl/types.js';
import { getDataHome } from '../storage.js';

/** 单条产物记录 */
export interface ArtifactEntry {
  /** 相对 output/ 的 posix 路径，如 "self_analyze.html"（唯一键） */
  path: string;
  /** 所属 feature */
  feature?: string;
  /** 标题（生成时自动摘 DSL title，人工可改） */
  title?: string;
  /** 产物类型：feature_diagram / report / example / ... */
  type?: string;
  /** 主要语言：ts / go / py / js / ... */
  language?: string;
  /** 状态：done / in_progress / draft */
  status?: string;
  /** 人工打的标签 */
  tags?: string[];
  /** 人工备注 */
  note?: string;
  created_at?: string;
  updated_at?: string;
}

/** 注册表 JSON 文件路径：<dataHome>/output/.registry.json */
export function registryFilePath(): string {
  return path.join(getDataHome(), 'output', '.registry.json');
}

/** 从文件扩展名推断语言 */
export function inferLanguageFromPath(p: string): string | undefined {
  const map: Record<string, string> = {
    '.ts': 'ts', '.tsx': 'ts', '.js': 'js', '.jsx': 'js',
    '.go': 'go', '.py': 'py', '.vue': 'vue', '.html': 'html', '.css': 'css',
  };
  const ext = path.extname(p).toLowerCase();
  return map[ext];
}

/** 从 DSL 摘取产物元数据（语义化的自动来源） */
export function artifactFromDsl(dsl: DesignDSL, htmlPath: string): Partial<ArtifactEntry> {
  const rel = path.posix.relative('output', htmlPath);
  const entry: Partial<ArtifactEntry> = {
    path: rel.startsWith('..') ? path.basename(htmlPath) : rel,
    feature: dsl.feature,
    title: dsl.title,
    type: dsl.type,
    status: dsl.status,
  };
  // 语言：取 semantic.files 中出现最多的扩展名对应语言
  const counts = new Map<string, number>();
  const files = dsl.semantic?.files ?? [];
  for (const f of files) {
    const lang = inferLanguageFromPath(f.path);
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [lang, n] of counts) {
    if (n > bestN) { bestN = n; best = lang; }
  }
  if (best) entry.language = best;
  return entry;
}

/** 读取全部注册条目（文件不存在返回空数组） */
export function readRegistry(): ArtifactEntry[] {
  const file = registryFilePath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ArtifactEntry[]) : [];
  } catch {
    return [];
  }
}

/** 写回注册表（原子：先写临时文件再 rename） */
function writeRegistry(entries: ArtifactEntry[]): void {
  const file = registryFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 注册/更新一条产物（按 path upsert；已存在则覆盖自动字段、保留人工字段） */
export function registerArtifact(entry: Partial<ArtifactEntry>): ArtifactEntry {
  return registerArtifactTo(registryFilePath(), entry);
}

/** 向指定注册表文件注册/更新一条产物（供隔离目录脚本如 self_analyze 显式写入 cwd/output） */
export function registerArtifactTo(file: string, entry: Partial<ArtifactEntry>): ArtifactEntry {
  const entries = readFileEntries(file);
  const now = new Date().toISOString();
  const idx = entries.findIndex((e) => e.path === entry.path);
  if (idx === -1) {
    const created: ArtifactEntry = {
      path: entry.path as string,
      ...entry,
      created_at: now,
      updated_at: now,
    };
    entries.push(created);
    writeFileEntries(file, entries);
    return created;
  }
  // 已存在：覆盖自动来源字段，但保留人工字段（tags/note/title 若人工改过则保留）
  const prev = entries[idx];
  const merged: ArtifactEntry = {
    ...prev,
    ...entry,
    // 人工字段：新 entry 未显式提供时保留原值
    tags: entry.tags ?? prev.tags,
    note: entry.note ?? prev.note,
    title: entry.title ?? prev.title,
    status: entry.status ?? prev.status,
    updated_at: now,
  };
  entries[idx] = merged;
  writeFileEntries(file, entries);
  return merged;
}

function readFileEntries(file: string): ArtifactEntry[] {
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ArtifactEntry[]) : [];
  } catch {
    return [];
  }
}

function writeFileEntries(file: string, entries: ArtifactEntry[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 局部更新一条产物（人工打标记/编辑）；返回更新后的条目，不存在返回 null */
export function updateArtifact(relPath: string, patch: Partial<ArtifactEntry>): ArtifactEntry | null {
  const entries = readRegistry();
  const idx = entries.findIndex((e) => e.path === relPath);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  entries[idx] = { ...entries[idx], ...patch, updated_at: now };
  writeRegistry(entries);
  return entries[idx];
}