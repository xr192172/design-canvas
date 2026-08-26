/**
 * capability_matrix —— 「功能 × 语言 × 支持度」能力矩阵（契约层）
 *
 * 为什么需要：tree-sitter 是我们的共享解析根基（LANGUAGES 50+ 语言可解析），
 * 但"每个功能用了哪些语言、支持到几成"此前没有一处登记——多语言逻辑散落在
 * 各工具里按 `ext ===` / `langName` 分支硬编码，补新语言时不知道哪往下补。
 *
 * 本模块做三件事：
 *   1. 契约：一门语言一种支持度（full_ast / partial_ast / regex_fallback / unimplemented），
 *      一个功能一份 CapabilityDecl（default 覆盖多数语言 + overrides 逐语言打补丁）。
 *   2. 语言名单：直接复用 ts_kernel 的 LANGUAGES，不重复登记；新语言加进 LANGUAGES
 *      即自动进入矩阵，无需改这里。
 *   3. 未来功能：只需 `declareCapability()` 登记一份，无需改 audit 主流程——
 *      新功能自动被能力矩阵拾取，"已接契约 vs 未接契约"一目了然。
 *
 * audit(diagnoseCapabilities)：以"已安装语言"为轴，交叉每个已登记功能，
 * 产出：功能 → 每语言支持度 + 缺口(需补)清单。可用于 CLI 自检 & 思维导图渲染。
 *
 * 纯数据 + 纯函数：零副作用、无 IO。testable。
 */

import { LANGUAGES, type LanguageEntry } from './ts_kernel/languages.js';

// ─────────────────────────────────────────────
// 支持度枚举（一门语言对一个功能的具体程度）
// ─────────────────────────────────────────────

export const SUPPORT_LEVELS = ['full_ast', 'partial_ast', 'regex_fallback', 'unimplemented'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

/** 语言 id（以 languages.ts 的 name 为准），加静态类型提示但运行时仍宽容 */
export type LangId = string;

// ─────────────────────────────────────────────
// 契约：功能声明
// ─────────────────────────────────────────────

/** 如何在思维导图/CLI 里展示某种支持度 */
export const SUPPORT_META: Record<SupportLevel, { label: string; badge: string; needWork: boolean }> = {
  full_ast: { label: 'AST 全量', badge: '🟢', needWork: false },
  partial_ast: { label: 'AST 部分', badge: '🟡', needWork: true },
  regex_fallback: { label: '正则回退', badge: '🟠', needWork: true },
  unimplemented: { label: '未实现', badge: '🔴', needWork: true },
};

/**
 * 一个功能的语言支持声明。
 * - supportBy 的 key 必须是 LANGUAGES 里的 name（否则 audit 报未知语言，反向兜底登记笔误）。
 * - default 表示"默认对所有语言的支持度"，overrides 只对少数特殊语言打补丁。
 * - 语义化保存了每种程度，因此 audit 无需推断、不会臆造。
 */
export interface CapabilityDecl {
  /** 稳定功能 id（如 'package_migration'），供检索/渲染复用 */
  id: string;
  /** 人类可读名（中文，展示用） */
  label: string;
  /** 一句话说明这事在补什么（写进报告/导图） */
  desc: string;
  /** 默认支持度（未在 overrides 里点名的语言一律取此值） */
  default: SupportLevel;
  /** 逐语言覆盖（key = LANGUAGES.name，如 'go'/'typescript'/'python'） */
  overrides?: Partial<Record<LangId, SupportLevel>>;
  /** 逐语言备注（可选，写清"为什么部分/回退"） */
  notes?: Partial<Record<LangId, string>>;
}

// ─────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────

const declared = new Map<string, CapabilityDecl>();

/** 登记一个功能（同 id 覆盖）。这是"未来新功能"接进能力矩阵的唯一入口。 */
export function declareCapability(c: CapabilityDecl): void {
  declared.set(c.id, c);
}

/** 取某功能声明（未登记返回 undefined——audit 借此点出"有功能但没接契约"） */
export function getCapability(id: string): CapabilityDecl | undefined {
  return declared.get(id);
}

/** 全部已登记功能（声明顺序） */
export function allCapabilities(): CapabilityDecl[] {
  return [...declared.values()];
}

/** 清空注册表（测试用：isolate 各 it 的登记，避免污染断言） */
export function _resetRegistry(): void {
  declared.clear();
}

/** 某功能对某语言的实际支持度（overrides 优先，否则 default） */
export function levelFor(c: CapabilityDecl, langName: string): SupportLevel {
  return c.overrides?.[langName] ?? c.default;
}

// ─────────────────────────────────────────────
// audit：缺口自检
// ─────────────────────────────────────────────

/** 语言名单直接拉 LANGUAGES（不重复维护） */
export function languageCatalog(): LanguageEntry[] {
  return LANGUAGES;
}

/** 只列出已安装语言（供"哪些语言真的被用起来了"的选址；未装的不产生缺口） */
export function installedLanguages(probe: () => LanguageEntry[]): LanguageEntry[] {
  return probe();
}

export interface CapabilityCell {
  lang: string;
  level: SupportLevel;
  note?: string;
}

export interface CapabilityAuditRow {
  decl: CapabilityDecl;
  /** 每个目标语言的支持度格子（仅登记了语言的交集：非 overrides 的语言取 default） */
  cells: CapabilityCell[];
  /** 缺口：needWork 的格子（AST 部分 / 正则回退 / 未实现） */
  gaps: CapabilityCell[];
  /** 声明里点名了但不在 LANGUAGES 语言名单里 → 登记笔误 */
  unknownLangs: string[];
}

/**
 * 对一组目标语言做缺口自检。
 * @param langs  目标语言（按已安装语言传入即可；可按 name 扁平化为 string[] 的变体见下）
 * @returns 每个功能一行：全量 + 缺口清单 + 登记笔误。
 */
export function diagnoseCapabilities(langNames: string[]): CapabilityAuditRow[] {
  const known = new Set(LANGUAGES.map((l) => l.name));
  return allCapabilities().map((decl) => {
    const overKeys = Object.keys(decl.overrides ?? {});
    const unknownLangs = overKeys.filter((k) => !known.has(k));
    const cells: CapabilityCell[] = langNames.map((lang) => {
      const level = levelFor(decl, lang);
      return { lang, level, note: decl.notes?.[lang] };
    });
    const gaps: CapabilityCell[] = cells.filter((c) => SUPPORT_META[c.level].needWork);
    return { decl, cells, gaps, unknownLangs };
  });
}

/** 便捷：直接传 LanguageEntry[]（内部抽 name） */
export function diagnoseCapabilitiesByEntries(langs: LanguageEntry[]): CapabilityAuditRow[] {
  return diagnoseCapabilities(langs.map((l) => l.name));
}

/** 汇总：所有功能的缺口语言清单（去重、按需排序）——"哪些功能要补、补哪门语言" */
export function aggregateGaps(rows: CapabilityAuditRow[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const langs = row.gaps.map((g) => g.lang);
    if (langs.length && langs.length > 0) out[row.decl.id] = langs;
  }
  return out;
}

/** 渲染成可打印文本块（CLI / 报告用） */
export function renderAuditText(rows: CapabilityAuditRow[], title = '能力矩阵 · 缺口自检'): string {
  const lines: string[] = [title];
  if (rows.length === 0) {
    lines.push('  （暂无功能登记：declareCapability 后才会进入矩阵）');
    return lines.join('\n');
  }
  for (const row of rows) {
    const cellStr = row.cells
      .map((c) => `${c.lang}:${SUPPORT_META[c.level].badge}${SUPPORT_META[c.level].label}`)
      .join('   ');
    lines.push(`• ${row.decl.id}（${row.decl.label}）`);
    lines.push(`    ${cellStr}`);
    if (row.unknownLangs.length) {
      lines.push(`    ⚠️ 登记笔误（不在 LANGUAGES）：${row.unknownLangs.join(', ')}`);
    }
    if (row.gaps.length) {
      const gapStr = row.gaps.map((g) => `${g.lang}(${SUPPORT_META[g.level].label})`).join(', ');
      lines.push(`    🔧 缺口需补：${gapStr}`);
    }
  }
  return lines.join('\n');
}