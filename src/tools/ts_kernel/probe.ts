/**
 * 探测 node_modules 中已安装的 tree-sitter 语言包
 *
 * 扫描 node_modules/tree-sitter-* 目录，找出已安装的语言包。
 * 返回已注册的语言列表（与 languages.ts 对齐）。
 *
 * 关键：使用 fs 同步扫描 + package.json 读取，避免对未装包做 require 报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGES, findLanguageByExt, LanguageEntry } from './languages.js';

/** 缓存扫描结果（启动时一次扫，后续零开销） */
let probeCache: Set<string> | null = null;
let nodeModulesRoots: string[] | null = null;

/**
 * 定位 node_modules 根目录。
 *
 * 优先从 process.cwd() 向上找（老行为），再回退到本模块自身位置向上找——
 * MCP client（TRAE/Claude Desktop/Cursor 等）常以用户目录为 cwd 启动 stdio 子进程，
 * 若只依赖 cwd，将找不到项目根的 node_modules，导致语言包探测为空、import_project 无法解析。
 * 从模块位置（dist/src/tools/ts_kernel/probe.js）向上 4 级即项目根，与 cwd 无关，任何 client 下都稳定。
 */
function getAllNodeModulesRoots() : string[] {
if (nodeModulesRoots !== null) {
  return nodeModulesRoots;
}
const roots = new Set();
let dir = process.cwd();
while (dir !== path.dirname(dir)) {
  const c = path.join(dir, 'node_modules');
  if (fs.existsSync(c)) roots.add(c);
  dir = path.dirname(dir);
}
let modDir = path.dirname(fileURLToPath(import.meta.url));
while (modDir !== path.dirname(modDir)) {
  const c = path.join(modDir, 'node_modules');
  if (fs.existsSync(c)) roots.add(c);
  modDir = path.dirname(modDir);
}
if (roots.size === 0) roots.add(path.join(process.cwd(), 'node_modules'));
nodeModulesRoots = [...roots];
return nodeModulesRoots;
}

function scanInstalledPackages() {
const installed = new Set();
for (const root of getAllNodeModulesRoots()) {
  if (!fs.existsSync(root)) continue;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name === '@tree-sitter') {
      const subEntries = fs.readdirSync(path.join(root, '@tree-sitter'), { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory()) installed.add(`@tree-sitter/${sub.name}`);
      }
    }
    else if (entry.isDirectory() && entry.name.startsWith('tree-sitter-')) {
      installed.add(entry.name.replace('tree-sitter-', ''));
    }
  }
}
return installed;
}

/** 探测已安装的语言 */
export function probeInstalledLanguages(): LanguageEntry[] {
  if (probeCache === null) {
    const installed = scanInstalledPackages();
    probeCache = installed;
  }

  return LANGUAGES.filter((lang) => probeCache!.has(lang.pkg));
}

/** 检查某语言是否已安装 */
export function isLanguageInstalled(pkgName: string): boolean {
  if (probeCache === null) {
    probeCache = scanInstalledPackages();
  }
  return probeCache.has(pkgName);
}

/** 检查某扩展名是否支持（且已安装） */
export function isExtSupported(ext: string): LanguageEntry | null {
  const lang = findLanguageByExt(ext);
  if (!lang) return null;
  if (!isLanguageInstalled(lang.pkg)) return null;
  return lang;
}

/** 强制重置缓存（用于测试或配置变更后） */
export function resetProbeCache(): void {
  probeCache = null;
}

/** 获取所有可用扩展名 */
export function listSupportedExts(): string[] {
  return probeInstalledLanguages().flatMap((l) => l.exts);
}
