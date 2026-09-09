/**
 * 探测已安装的 tree-sitter 语言包：用标准 ESM resolver (import.meta.resolve) 判定，
 * 而非扫 node_modules 目录名。resolve 从【本模块所在包】向上解析，天然定位到
 * design-canvas 自带 node_modules，与进程 cwd 无关——修复深度注入（宿主进程 cwd
 * 非 design-canvas）下被误判"语言未装"→ parseFileFull 0 符号的问题；也让"该用哪个
 * language 包"的判定可复用于 AST 引擎等任何按语言探依赖的场合。
 *
 * resolve 同步、不加载 native（只解析路径）：成功=包可解析，抛 ERR_MODULE_NOT_FOUND=未装。
 */
import { LANGUAGES, findLanguageByExt, LanguageEntry } from './languages.js';

/** 已确认可解析的语言包缓存 */
let loadable = new Set<string>();
/** 已确认不可解析的语言包缓存（避免反复 resolve 失败） */
let unloadable = new Set<string>();

/** 用标准 resolver 判定某 tree-sitter 语言包是否可加载（同步、不加载 native） */
export function isLanguageInstalled(pkgName: string): boolean {
  if (loadable.has(pkgName)) return true;
  if (unloadable.has(pkgName)) return false;
  const meta = import.meta as unknown as { resolve(specifier: string): string };
  try {
    meta.resolve('tree-sitter-' + pkgName);
    loadable.add(pkgName);
    return true;
  } catch {
    unloadable.add(pkgName);
    return false;
  }
}

/** 探测已安装的语言（LANGUAGES 中可解析的子集） */
export function probeInstalledLanguages(): LanguageEntry[] {
  return LANGUAGES.filter((l) => isLanguageInstalled(l.pkg));
}

/** 检查某扩展名是否支持（且对应语言包已安装） */
export function isExtSupported(ext: string): LanguageEntry | null {
  const lang = findLanguageByExt(ext);
  if (!lang) return null;
  if (!isLanguageInstalled(lang.pkg)) return null;
  return lang;
}

/** 强制重置缓存（用于测试或配置变更后） */
export function resetProbeCache(): void {
  loadable.clear();
  unloadable.clear();
}

/** 获取所有可用扩展名 */
export function listSupportedExts(): string[] {
  return probeInstalledLanguages().flatMap((l) => l.exts);
}
