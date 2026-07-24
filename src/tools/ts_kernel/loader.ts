/**
 * 动态加载器
 *
 * 动态 import 已安装的 tree-sitter 语言包。
 * 失败时返回 null，调用方走降级路径。
 *
 * 关键：
 *   - 首次访问才 import（懒加载）
 *   - 缓存 Parser 实例（每个 ext 一个）
 *   - 失败记录一次 warning，不再重试（避免启动日志刷屏）
 */

import type Parser from 'tree-sitter';
import { LanguageEntry } from './languages.js';

type Language = unknown;
type ParserInstance = Parser;

const parserCache = new Map<string, ParserInstance>();
const failedPks = new Set<string>();
const failedWarned = new Set<string>();

/**
 * 动态加载 tree-sitter 语言包。
 * 返回 Parser.Language，失败返回 null。
 *
 * 错误处理：
 *   - 包未安装 → 返回 null，不抛
 *   - 包损坏/版本不兼容 → 返回 null，记录 warning
 *   - 同一包只记录一次 warning
 */
export async function loadLanguage(lang: LanguageEntry): Promise<Language | null> {
  if (failedPks.has(lang.pkg)) return null;

  // 尝试动态 import
  try {
    const mod = await import(`tree-sitter-${lang.pkg}`);
    // 部分包导出 default，部分导出命名
    const language = (mod as { default?: unknown }).default ?? mod;

    // tree-sitter-typescript 特殊处理（导出 { typescript, tsx }；
    // 真实 Node ESM 下 CJS 命名导出不可见，{typescript, tsx} 位于 default 内）
    if (lang.pkg === 'typescript' || lang.pkg === 'tsx') {
      const ns = mod as { typescript?: unknown; tsx?: unknown; default?: { typescript?: unknown; tsx?: unknown } };
      const bag = (ns.typescript || ns.tsx) ? ns : (ns.default ?? ns);
      const picked = (lang.pkg === 'tsx' ? bag.tsx : bag.typescript) ?? null;
      if (!picked) throw new Error(`tree-sitter-${lang.pkg} 导出结构中未找到 ${lang.pkg} 语言对象`);
      return picked as Language;
    }

    return language as Language;
  } catch (e) {
    if (!failedWarned.has(lang.pkg)) {
      console.warn(`[ts_kernel] load tree-sitter-${lang.pkg} failed: ${(e as Error).message}`);
      failedWarned.add(lang.pkg);
    }
    failedPks.add(lang.pkg);
    return null;
  }
}

/**
 * 获取/创建 Parser 实例（按 ext 缓存）。
 * 返回 null 表示该语言不可用。
 */
export async function getParser(ext: string, lang: LanguageEntry): Promise<ParserInstance | null> {
  if (parserCache.has(ext)) return parserCache.get(ext)!;

  const language = await loadLanguage(lang);
  if (!language) return null;

  try {
    // 动态 import tree-sitter core
    const { default: TreeSitter } = await import('tree-sitter');
    const parser = new TreeSitter();
    (parser as { setLanguage: (l: unknown) => void }).setLanguage(language);
    parserCache.set(ext, parser);
    return parser;
  } catch (e) {
    if (!failedWarned.has('core')) {
      console.warn(`[ts_kernel] tree-sitter core init failed: ${(e as Error).message}`);
      failedWarned.add('core');
    }
    return null;
  }
}

/** 清理缓存（测试用） */
export function clearLoaderCache(): void {
  parserCache.clear();
  failedPks.clear();
  failedWarned.clear();
}
