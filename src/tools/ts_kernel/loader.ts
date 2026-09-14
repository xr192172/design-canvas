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
 * 自愈配置（修复"同一 tree-sitter，进程分叉"的根因）：
 * failedPks 不再进程级永久——"import 模块不存在/瞬时环境失败"这类失败打上
 * 失败时间戳，超过 FAIL_RETRY_MS 后允许重试，让"依赖后装即自愈"。
 * 解析/加载类持久错误仍保持缓存（不无限重试刷日志）。仍可用 clearLoaderCache() 强制重置。
 */
const FAIL_RETRY_MS = 30_000;
const failAt = new Map<string, number>(); // lang.pkg -> 首次失败时间戳
// import 模块找不到 → 判定为"瞬时/环境类"，走自愈重试；其它（解析/结构）错误保持缓存。
const isTransient = (e: unknown): boolean =>
  (e as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND' ||
  /Cannot find module|Failed to resolve|ERR_MODULE_NOT_FOUND/.test((e as Error)?.message ?? '');

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
  if (failedPks.has(lang.pkg)) {
    const at = failAt.get(lang.pkg);
    if (!at || Date.now() - at < FAIL_RETRY_MS) return null;
    failedPks.delete(lang.pkg);
    console.warn(`[ts_kernel] retry load tree-sitter-${lang.pkg} after transient failure (${Date.now() - at}ms)`);
  }

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

    // tree-sitter-php 特殊处理（CJS 原生绑定导出 { php, php_only }，Language 在 .php 上）
    if (lang.pkg === 'php') {
      const bag = (mod as { default?: { php?: unknown } }).default ?? mod;
      const picked = (bag as { php?: unknown }).php ?? null;
      if (!picked) throw new Error('tree-sitter-php 导出结构中未找到 php 语言对象');
      return picked as Language;
    }

    return language as Language;
  } catch (e) {
    if (!failedWarned.has(lang.pkg)) {
      console.warn(`[ts_kernel] load tree-sitter-${lang.pkg} failed: ${(e as Error).message}`);
      failedWarned.add(lang.pkg);
    }
    if (isTransient(e)) {
      if (!failAt.has(lang.pkg)) failAt.set(lang.pkg, Date.now());
      return null;
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
  failAt.clear();
  failedWarned.clear();
}

