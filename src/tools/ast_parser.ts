/**
 * 兼容层：让旧代码（consistency.ts / backfill.ts）继续用 sync 接口
 *
 * 内部转调 ts_kernel 的 async API。
 * 提供 isSupportedFile() 同步检查扩展名是否支持。
 *
 * 注意：parseFileSymbols 是 async（因为 kernel 内部 lazy-load）。
 * 旧的同步调用方需迁移到 await。
 */

import { isSupported, parseFile, listSupportedLanguages, listSupportedExtensions } from './ts_kernel/index.js';
import type { ParsedSymbol } from './ts_kernel/index.js';

export { parseFile as parseFileSymbolsAsync } from './ts_kernel/index.js';
export type { ParsedSymbol };

/** 同步检查文件是否被支持（只检查扩展名 + 是否已安装） */
export function isSupportedFile(filePath: string): boolean {
  const ext = '.' + (filePath.split('.').pop() || '');
  return isSupported(ext);
}

/** 异步版本（推荐） */
export async function parseFileSymbols(filePath: string, content: string): Promise<ParsedSymbol[]> {
  return parseFile(filePath, content);
}

export { listSupportedLanguages, listSupportedExtensions };
