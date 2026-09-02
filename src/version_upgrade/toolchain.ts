/**
 * toolchain：工具链版本盘点（版本升级契约差检测 · 阶段 A）—— 通用内核
 *
 * 老项目重构的第一问：每个子项目分别要什么运行时（JDK 8 / JDK 21 / Node / Go / Python）？
 * 本模块把散落在各构建文件里的"工具链声明"盘点成结构化清单，再对照本机实际运行时，
 * 输出每个子项目的版本匹配状态（ok / missing / mismatch）。
 *
 * 本文件是**语言无关**的内核：只负责目录扫描、按声明文件名分发解析、本机探测编排、
 * 匹配判断。每种语言的"方言"（声明文件格式、版本比较规则、探测命令）都在
 * adapters/ 的语言适配器里，新增语言不改内核。
 *
 * 只做"盘点/报告"，不做任何改写——改写是版本升级闭环的后续阶段。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  adapters,
  adapterForLang,
  adaptersForFile,
  ALL_DECLARATION_FILES,
  ADAPTER_SKIP_DIRS,
} from './adapters/registry.js';
import type { ToolName } from './adapters/types.js';

export type { ToolName } from './adapters/types.js';
export type { VersionInfo } from './adapters/types.js';

/** 工具链声明：某个子项目需要的运行时版本 */
export interface ToolchainDeclaration {
  projectDir: string; // 声明所在子项目目录（相对 root）
  tool: ToolName;
  source: string; // 声明来源文件名（pom.xml / .nvmrc / go.mod / ...）
  declaredVersion: string; // 声明的版本原文（如 "1.8"、"18"、"1.21"）
  raw: string; // 声明的原始证据行（供报告展示）
}

/** 本机实际运行时 */
export interface RuntimeInfo {
  tool: ToolName;
  version: string | null; // null = 本机未安装该工具链
}

/** 匹配结果 */
export interface RuntimeMatch {
  projectDir: string;
  tool: ToolName;
  declaredVersion: string;
  localVersion: string | null;
  status: 'ok' | 'missing' | 'mismatch';
  note: string;
}

/** 扫描盘点结果 */
export interface ToolchainScan {
  root: string;
  declarations: ToolchainDeclaration[];
  runtimes: RuntimeInfo[];
  matches: RuntimeMatch[];
}

// ─────────────────────────────────────────────────────────────
// 目录扫描（语言无关）
// ─────────────────────────────────────────────────────────────

/** 跳过的目录（构建产物/依赖/元数据，不视为子项目根；含各适配器追加项） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out', 'bin',
  '.design-canvas', '.idea', '.vscode', '.next', 'coverage', 'vendor', '.gradle',
  ...ADAPTER_SKIP_DIRS,
]);

/** 找出所有工具链声明文件（含子项目），文件名集合来自适配器注册表 */
export function collectDeclarationFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (ALL_DECLARATION_FILES.includes(e.name)) out.push(full);
      }
    }
  }
  return out.sort();
}

// ─────────────────────────────────────────────────────────────
// 声明解析（按文件名分发到语言适配器）
// ─────────────────────────────────────────────────────────────

/** 从声明文件提取工具链声明（可能一条文件产出多条，如 .tool-versions 分发给各语言适配器） */
export function parseDeclarationFile(filePath: string): ToolchainDeclaration[] {
  const name = path.basename(filePath);
  const out: ToolchainDeclaration[] = [];
  for (const adapter of adaptersForFile(name)) {
    for (const d of adapter.parseDeclarationFile(filePath)) {
      out.push({ ...d, tool: adapter.lang });
    }
  }
  return out;
}

/** 全量盘点：返回 root 下所有子项目的工具链声明 */
export function scanToolchainDeclarations(root: string): ToolchainDeclaration[] {
  const files = collectDeclarationFiles(root);
  const out: ToolchainDeclaration[] = [];
  for (const f of files) {
    for (const d of parseDeclarationFile(f)) out.push(d);
  }
  // 归一化 projectDir 为相对路径（root 本身记为 "."）
  const rel = root.replace(/[/\\]$/, '');
  return out.map((d) => ({ ...d, projectDir: d.projectDir === rel ? '.' : d.projectDir.slice(rel.length + 1) }));
}

// ─────────────────────────────────────────────────────────────
// 版本解析与比较（委托语言适配器）
// ─────────────────────────────────────────────────────────────

/** 按工具解析版本字符串为 { major, minor }；解析失败返回 null */
export function parseToolchainVersion(tool: ToolName, v: string): { major: number; minor?: number } | null {
  return adapterForLang(tool)?.parseVersion(v) ?? null;
}

/** 判断本机 local 是否满足声明 declared 的版本要求（>= 声明） */
export function versionSatisfies(tool: ToolName, declared: string, local: string): boolean {
  const adapter = adapterForLang(tool);
  if (!adapter) return false;
  return adapter.versionSatisfies(declared, local);
}

// ─────────────────────────────────────────────────────────────
// 本机运行时探测（按适配器注册表遍历）
// ─────────────────────────────────────────────────────────────

function probeRuntime(adapter: { lang: ToolName; probe: { cmd: string; args: string[]; parse: (out: string) => string | null } }): string | null {
  try {
    // 部分工具把版本输出到 stderr（如 java -version），故合并 stdout+stderr 再解析
    const r = spawnSync(adapter.probe.cmd, adapter.probe.args, { encoding: 'utf-8', timeout: 30_000, windowsHide: true });
    if (r.error) return null;
    return adapter.probe.parse(`${r.stdout || ''}\n${r.stderr || ''}`);
  } catch {
    return null;
  }
}

/** 探测本机各语言实际版本（未安装返回 null） */
export function probeLocalRuntimes(): RuntimeInfo[] {
  return adapters.map((a) => ({ tool: a.lang, version: probeRuntime(a) }));
}

// ─────────────────────────────────────────────────────────────
// 匹配与编排（语言无关）
// ─────────────────────────────────────────────────────────────

/** 声明 vs 本机运行时 → 匹配状态 */
export function matchRuntimes(declarations: ToolchainDeclaration[], runtimes: RuntimeInfo[]): RuntimeMatch[] {
  const byTool = new Map<ToolName, RuntimeInfo>();
  for (const r of runtimes) byTool.set(r.tool, r);

  return declarations.map((d) => {
    const local = byTool.get(d.tool);
    const localVersion = local?.version ?? null;
    if (!localVersion) {
      return { projectDir: d.projectDir, tool: d.tool, declaredVersion: d.declaredVersion, localVersion: null, status: 'missing', note: `本机未安装 ${d.tool}，无法构建` };
    }
    const ok = versionSatisfies(d.tool, d.declaredVersion, localVersion);
    return ok
      ? { projectDir: d.projectDir, tool: d.tool, declaredVersion: d.declaredVersion, localVersion, status: 'ok', note: '本机版本满足声明' }
      : { projectDir: d.projectDir, tool: d.tool, declaredVersion: d.declaredVersion, localVersion, status: 'mismatch', note: `需要 ${d.declaredVersion}，本机 ${localVersion}` };
  });
}

/** 一键扫描：盘点声明 + 探测本机 + 匹配 */
export function scanToolchains(root: string): ToolchainScan {
  const declarations = scanToolchainDeclarations(root);
  const runtimes = probeLocalRuntimes();
  const matches = matchRuntimes(declarations, runtimes);
  return { root, declarations, runtimes, matches };
}
