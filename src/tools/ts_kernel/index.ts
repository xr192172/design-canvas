/**
 * ts_kernel 公开入口
 */
export {
  parseFile,
  parseFileFull,
  parseAstRoot,
  isSupported,
  listSupportedLanguages,
  listSupportedExtensions,
  _reset,
  findLanguageByExt,
  isLanguageInstalled,
} from './kernel.js';

export type { ParsedSymbol, ParsedImport, ParsedCall, ParsedFile, LanguageEntry, SyntaxNodeLike } from './kernel.js';
export type { LanguageEntry as LanguageMeta } from './languages.js';
