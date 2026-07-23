/**
 * ts_kernel 公开入口
 */
export {
  parseFile,
  isSupported,
  listSupportedLanguages,
  listSupportedExtensions,
  _reset,
  findLanguageByExt,
  isLanguageInstalled,
} from './kernel.js';

export type { ParsedSymbol, LanguageEntry } from './kernel.js';
export type { LanguageEntry as LanguageMeta } from './languages.js';
