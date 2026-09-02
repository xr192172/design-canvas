/**
 * adapters/registry —— 语言适配器注册表（通用内核的唯一入口）
 *
 * 通用内核不 import 任何具体适配器，只经这里按 lang / 扩展名 / 声明文件名取适配器。
 * 新增语言：写一个适配器文件 → 在本文件 import 并加入 adapters 数组即可。
 */

import type { LanguageAdapter, ToolName } from './types.js';
import { javaAdapter } from './java.js';
import { goAdapter } from './go.js';
import { nodeAdapter } from './node.js';
import { pythonAdapter } from './python.js';
import { csharpAdapter } from './csharp.js';
import { cAdapter } from './c.js';

/** 全部已注册适配器（顺序即探测/验证优先级，go 须在 node 前保持既有行为） */
export const adapters: LanguageAdapter[] = [javaAdapter, goAdapter, nodeAdapter, pythonAdapter, csharpAdapter, cAdapter];

/** 语言代号 → 适配器 */
export function adapterForLang(lang: ToolName): LanguageAdapter | undefined {
  return adapters.find((a) => a.lang === lang);
}

/** 源码扩展名 → 适配器（'.java' → javaAdapter） */
export function adapterForExt(ext: string): LanguageAdapter | undefined {
  const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return adapters.find((a) => a.sourceExts.includes(e));
}

/** 声明文件名 → 适配器列表（'.tool-versions' 等多语言共享文件返回多个） */
export function adaptersForFile(name: string): LanguageAdapter[] {
  return adapters.filter((a) => a.declarationFiles.includes(name));
}

/** 内核扫描目录时关注的声明文件全集（去重，含 .tool-versions） */
export const ALL_DECLARATION_FILES: string[] = [
  ...new Set(adapters.flatMap((a) => a.declarationFiles)),
];

/** 各语言默认跳过的构建产物/依赖目录（并入内核默认集） */
export const ADAPTER_SKIP_DIRS: Set<string> = new Set(adapters.flatMap((a) => a.skipDirs ?? []));
