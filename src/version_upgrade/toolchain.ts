/**
 * toolchain：工具链版本盘点（版本升级契约差检测 · 阶段 A）
 *
 * 老项目重构的第一问：每个子项目分别要什么运行时（JDK 8 / JDK 21 / Node / Go）？
 * 本模块把散落在各构建文件里的"工具链声明"盘点成结构化清单，再对照本机实际运行时，
 * 输出每个子项目的版本匹配状态（ok / missing / mismatch）。
 *
 * 声明来源（子项目根目录内）：
 *   - pom.xml            → java   （<java.version> / maven.compiler.source / maven.compiler.release）
 *   - build.gradle(.kts) → java   （sourceCompatibility / toolchain JavaLanguageVersion.of(n)）
 *   - .nvmrc             → node   （文件内容即版本）
 *   - .tool-versions     → node/java/go（asdf 多行 "tool version"）
 *   - go.mod             → go     （"go 1.21" 指令）
 *   - package.json       → node   （engines.node）
 *
 * 只做"盘点/报告"，不做任何改写——改写是版本升级闭环的后续阶段。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type ToolName = 'java' | 'node' | 'go';

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
// 目录扫描
// ─────────────────────────────────────────────────────────────

/** 跳过的目录（构建产物/依赖/元数据，不视为子项目根） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'out', 'bin',
  '.design-canvas', '.idea', '.vscode', '.next', 'coverage', 'vendor', '.gradle',
]);

/** 找出所有工具链声明文件（含子项目），每个文件产出一条声明 */
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
        if (DECLARATION_FILE_NAMES.has(e.name)) out.push(full);
      }
    }
  }
  return out.sort();
}

/** 声明文件 → 工具 映射 */
const DECLARATION_FILE_NAMES = new Set(['pom.xml', 'build.gradle', 'build.gradle.kts', '.nvmrc', '.tool-versions', 'go.mod', 'package.json']);

/** 工具链声明文件（不含 package.json 时，需校验含 engines.node 才算） */
const TOOL_DECLARATION_RE: Record<string, ToolName> = {
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'java',
  '.nvmrc': 'node',
  '.tool-versions': 'java', // 占位：按行细分
  'go.mod': 'go',
};

// ─────────────────────────────────────────────────────────────
// 各声明文件的解析
// ─────────────────────────────────────────────────────────────

function parsePomXml(content: string): { version: string; raw: string } | null {
  // 优先级：maven.compiler.release > maven.compiler.source > java.version
  const release = content.match(/<maven\.compiler\.release>\s*([\d.]+)\s*<\/maven\.compiler\.release>/);
  if (release) return { version: release[1], raw: `<maven.compiler.release>${release[1]}` };
  const source = content.match(/<maven\.compiler\.source>\s*([\d.]+)\s*<\/maven\.compiler\.source>/);
  if (source) return { version: source[1], raw: `<maven.compiler.source>${source[1]}` };
  const jv = content.match(/<java\.version>\s*([\d.]+(?:_[\d.]+)?)\s*<\/java\.version>/);
  if (jv) return { version: jv[1], raw: `<java.version>${jv[1]}` };
  return null;
}

function parseGradle(content: string): { version: string; raw: string } | null {
  const tc = content.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/);
  if (tc) return { version: tc[1], raw: `JavaLanguageVersion.of(${tc[1]})` };
  const sc = content.match(/sourceCompatibility\s*=\s*['"]?([\d.]+)['"]?/);
  if (sc) return { version: sc[1], raw: `sourceCompatibility = ${sc[1]}` };
  const target = content.match(/targetCompatibility\s*=\s*['"]?([\d.]+)['"]?/);
  if (target) return { version: target[1], raw: `targetCompatibility = ${target[1]}` };
  return null;
}

function parseToolVersions(content: string): Array<{ tool: ToolName; version: string; raw: string }> {
  const map: Record<string, ToolName> = { nodejs: 'node', node: 'node', java: 'java', golang: 'go' };
  const out: Array<{ tool: ToolName; version: string; raw: string }> = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+)\s+([^\s#]+)/);
    if (!m) continue;
    const tool = map[m[1]];
    if (!tool) continue;
    out.push({ tool, version: m[2], raw: line.trim() });
  }
  return out;
}

function parseGoMod(content: string): { version: string; raw: string } | null {
  const m = content.match(/^\s*go\s+([\d.]+)\s*$/m);
  if (!m) return null;
  return { version: m[1], raw: `go ${m[1]}` };
}

function parsePackageJson(content: string): { version: string; raw: string } | null {
  try {
    const j = JSON.parse(content);
    const node = j?.engines?.node;
    if (typeof node === 'string' && node.trim()) return { version: node.trim(), raw: `engines.node = ${node}` };
  } catch {
    // 非法 JSON：忽略
  }
  return null;
}

/** 从声明文件提取工具链声明（可能一条文件产出多条，如 .tool-versions） */
export function parseDeclarationFile(filePath: string): ToolchainDeclaration[] {
  const name = path.basename(filePath);
  const projectDir = path.dirname(filePath);
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  if (name === 'pom.xml') {
    const r = parsePomXml(content);
    return r ? [{ projectDir, tool: 'java', source: name, declaredVersion: r.version, raw: r.raw }] : [];
  }
  if (name === 'build.gradle' || name === 'build.gradle.kts') {
    const r = parseGradle(content);
    return r ? [{ projectDir, tool: 'java', source: name, declaredVersion: r.version, raw: r.raw }] : [];
  }
  if (name === '.nvmrc') {
    const v = content.trim();
    if (!v) return [];
    return [{ projectDir, tool: 'node', source: name, declaredVersion: v, raw: v }];
  }
  if (name === '.tool-versions') {
    return parseToolVersions(content).map((t) => ({ projectDir, tool: t.tool, source: name, declaredVersion: t.version, raw: t.raw }));
  }
  if (name === 'go.mod') {
    const r = parseGoMod(content);
    return r ? [{ projectDir, tool: 'go', source: name, declaredVersion: r.version, raw: r.raw }] : [];
  }
  if (name === 'package.json') {
    const r = parsePackageJson(content);
    return r ? [{ projectDir, tool: 'node', source: name, declaredVersion: r.version, raw: r.raw }] : [];
  }
  return [];
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
// 版本解析与比较
// ─────────────────────────────────────────────────────────────

export interface VersionInfo {
  major: number;
  minor?: number;
}

/** 按工具解析版本字符串为 { major, minor }；解析失败返回 null */
export function parseToolchainVersion(tool: ToolName, v: string): VersionInfo | null {
  const s = String(v).trim().replace(/^v/, '');
  if (tool === 'java') {
    // 1.8 / 1.8.0_292 → major 8；17 / 17.0.9 → major 17
    const m = s.match(/^(?:1\.)?(\d+)/);
    return m ? { major: parseInt(m[1], 10) } : null;
  }
  if (tool === 'go') {
    // 1.21 / 1.21.5 → major 1, minor 21
    const m = s.match(/^(\d+)\.(\d+)/);
    return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
  }
  // node：18 / 18.17 / v18.17.0
  const m = s.match(/^(\d+)(?:\.(\d+))?/);
  return m ? { major: parseInt(m[1], 10), minor: m[2] ? parseInt(m[2], 10) : 0 } : null;
}

/** 判断本机 local 是否满足声明 declared 的版本要求（>= 声明） */
export function versionSatisfies(tool: ToolName, declared: string, local: string): boolean {
  const d = parseToolchainVersion(tool, declared);
  const l = parseToolchainVersion(tool, local);
  if (!d || !l) return false;
  if (tool === 'go') {
    // go：按 major.minor 字典序比较（1.21 < 1.22）
    if (l.major !== d.major) return l.major > d.major;
    return (l.minor ?? 0) >= (d.minor ?? 0);
  }
  return l.major >= d.major;
}

// ─────────────────────────────────────────────────────────────
// 本机运行时探测
// ─────────────────────────────────────────────────────────────

function probeJava(): string | null {
  try {
    const out = execFileSync('java', ['-version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.match(/version\s+"?([\d._]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function probeNode(): string | null {
  try {
    const out = execFileSync('node', ['-v'], { encoding: 'utf-8' });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function probeGo(): string | null {
  try {
    const out = execFileSync('go', ['version'], { encoding: 'utf-8' });
    return out.match(/go([\d.]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** 探测本机 java/node/go 实际版本（未安装返回 null） */
export function probeLocalRuntimes(): RuntimeInfo[] {
  return [
    { tool: 'java', version: probeJava() },
    { tool: 'node', version: probeNode() },
    { tool: 'go', version: probeGo() },
  ];
}

// ─────────────────────────────────────────────────────────────
// 匹配与编排
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
