/**
 * detect：版本升级契约差 · 共享检测编排（供 upgrade_cli / upgrade_rewrite_cli 复用）
 *
 * 把"按子项目扫描"的编排逻辑从 CLI 抽出来：
 *   1. 工具链声明（阶段 A）→ 每个子项目声明什么运行时版本
 *   2. 语言特性契约差（阶段 B）→ 用了超过声明版本的语言特性
 *   3. 废弃/移除 API（阶段 C）→ 用了目标版本已移除/废弃的 API
 *
 * 边界规则：
 *   - 每个声明的扫描目录 = 该子项目目录；根目录声明（"."）只扫根自身源码，
 *     跳过嵌套子项目目录，避免重复报告。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  scanToolchains,
  parseToolchainVersion,
  type ToolchainDeclaration,
  type ToolchainScan,
  type ToolName,
} from './toolchain.js';
import { scanFeatureHits, type FeatureHit } from './features.js';
import { scanRemovedApis, type RemovedHit } from './removed.js';

export const FEATURE_EXTS: Record<ToolName, string[]> = {
  java: ['.java'],
  go: ['.go'],
  node: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
};

/** 声明版本 → 检测的目标边界（JDK 主版本 / go minor / node major） */
export function declaredToFeatureVersion(tool: ToolName, declaredVersion: string): number | null {
  const info = parseToolchainVersion(tool, declaredVersion);
  if (!info) return null;
  if (tool === 'go') return info.minor ?? info.major;
  return info.major;
}

/** 各子项目根目录（相对 root；"." = 根目录本身） */
export function projectDirs(declarations: ToolchainDeclaration[]): Set<string> {
  return new Set(declarations.map((d) => d.projectDir));
}

/** 目录 dir 之下需要跳过的嵌套子项目根（相对 dir） */
export function nestedProjectDirs(dir: string, allDirs: Set<string>): Set<string> {
  const prefix = dir === '.' ? '' : `${dir}/`;
  const out = new Set<string>();
  for (const p of allDirs) {
    if (p === '.' || p === dir) continue;
    if (p.startsWith(prefix)) out.add(p.slice(prefix.length));
  }
  return out;
}

/**
 * 收集 dir 下指定扩展名的源码文件（跳过构建产物/依赖目录）。
 * @param excludeRelDirs 相对 dir 的子目录路径集合，命中则不深入（按子项目边界隔离）
 */
export function collectSourceFiles(
  dir: string,
  exts: string[],
  excludeRelDirs?: Set<string>
): Array<{ rel: string; content: string }> {
  const out: Array<{ rel: string; content: string }> = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', 'bin', 'vendor', '.gradle']);
  const stack: Array<{ abs: string; rel: string }> = [{ abs: dir, rel: '' }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(abs, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skip.has(e.name) || e.name.startsWith('.')) continue;
        if (excludeRelDirs?.has(relPath)) continue;
        stack.push({ abs: full, rel: relPath });
      } else if (e.isFile()) {
        if (!exts.includes(path.extname(e.name).toLowerCase())) continue;
        try {
          out.push({ rel: relPath, content: fs.readFileSync(full, 'utf-8') });
        } catch {
          // 读失败跳过
        }
      }
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/** 某声明的源码扫描输入（路径为相对该子项目） */
export interface DeclarationFiles {
  declaration: ToolchainDeclaration;
  boundary: number | null;
  files: Array<{ path: string; content: string }>;
}

/** 对每条声明装配扫描输入（含嵌套子项目隔离） */
export function filesForDeclarations(root: string, declarations: ToolchainDeclaration[]): DeclarationFiles[] {
  const allDirs = projectDirs(declarations);
  return declarations.map((d) => {
    const boundary = declaredToFeatureVersion(d.tool, d.declaredVersion);
    const dir = path.join(root, d.projectDir === '.' ? '' : d.projectDir);
    const excluded = nestedProjectDirs(d.projectDir, allDirs);
    const files = collectSourceFiles(dir, FEATURE_EXTS[d.tool], excluded).map((f) => ({ path: f.rel, content: f.content }));
    return { declaration: d, boundary, files };
  });
}

/** 一次契约差扫描的完整结果 */
export interface ContractScanResult {
  root: string;
  scan: ToolchainScan;
  /** 阶段 B：按声明的语言特性超标命中 */
  features: Array<{ declaration: ToolchainDeclaration; boundary: number; hits: FeatureHit[] }>;
  /** 阶段 C：按声明的废弃/移除 API 命中 */
  removed: Array<{ declaration: ToolchainDeclaration; boundary: number; hits: RemovedHit[] }>;
}

/** 一键扫描：工具链盘点 + 语言特性 + 废弃/移除 API */
export function runContractScan(root: string): ContractScanResult {
  const scan = scanToolchains(root);
  const inputs = filesForDeclarations(root, scan.declarations);
  const features: ContractScanResult['features'] = [];
  const removed: ContractScanResult['removed'] = [];
  for (const { declaration: d, boundary, files } of inputs) {
    if (boundary == null) continue;
    const fh = scanFeatureHits(files, boundary);
    if (fh.length > 0) features.push({ declaration: d, boundary, hits: fh });
    const rh = scanRemovedApis(files, boundary);
    if (rh.length > 0) removed.push({ declaration: d, boundary, hits: rh });
  }
  return { root, scan, features, removed };
}
