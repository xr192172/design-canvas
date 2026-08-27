/**
 * cross_repo —— 跨项目符号索引（项目杂交的地基）
 *
 * 把单仓的"顶层符号索引"提到两仓级：对两个项目根各建一次顶层符号集合，然后：
 *   1. 求交（同名符号）→ 冲突清单：
 *      - 同名不同签 = 真冲突（杂交前需改名/错位）
 *      - 同名同签   = 双胞胎（语义重复，可去重一个）
 *   2. 求差（只在一方）→ aOnly / bOnly = 迁移范围：搬过去不会撞名的安全候选
 *
 * 供 rename_symbol / package_migration / impact_analysis 的跨项目版复用，
 * 也是 hybrid_precheck 的第一支柱（符号冲突检测）。
 *
 * v1 边界（诚实标注）：
 *   - "顶层符号"复用 impact 的 nameIndex（parent 为空的所有模块级符号），
 *     是"顶层导出"的保守超集：未显式 export 的模块级私有符号也会计入。
 *     对冲突检测这是安全侧（宁多报不漏报），对迁移范围是候选池（可再人工过滤）。
 *   - 签名比较 = kind + 空白归一化后的 signature 字符串（buildSignature 产出）。
 *   - 同仓内重名多定义（TS 重载 / 同名文件）按定义集合整体比较。
 *
 * 跨仓不引入共享状态：两仓各自全量解析一次，纯内存求交/求差。
 */

import { buildImpactGraph } from '../impact/index.js';

// ── 对外类型 ─────────────────────────────────────────────────

/** 一个顶层符号（跨项目集合的最小单元） */
export interface CrossRepoSym {
  name: string;
  kind: string;
  /** 相对该项目根的源码路径 */
  file: string;
  /** qualified_name（顶层符号通常 = name） */
  qn: string;
  signature: string;
}

/** 单仓顶层符号索引 */
export interface ProjectSymbolIndex {
  root: string;
  fileCount: number;
  /** name → 顶层符号定义（同仓内可能重名多定义，如 TS 重载） */
  symbols: Map<string, CrossRepoSym[]>;
}

/** 同名碰撞：两仓都定义了 name */
export interface SymbolCollision {
  name: string;
  a: CrossRepoSym[];
  b: CrossRepoSym[];
  /** 同名同签（双胞胎）→ 非真冲突，可去重；false = 真冲突，需改名 */
  duplicate: boolean;
}

/** 两仓对比报告 */
export interface CrossRepoReport {
  aRoot: string;
  bRoot: string;
  aFiles: number;
  bFiles: number;
  aSymbols: number;
  bSymbols: number;
  /** 同名不同签 → 真冲突（杂交前需改名/错位） */
  conflicts: SymbolCollision[];
  /** 同名同签 → 双胞胎（语义重复，可去重） */
  duplicates: SymbolCollision[];
  /** 只在 A → 迁到 B 的安全候选（求差） */
  aOnly: string[];
  /** 只在 B → 迁到 A 的安全候选（求差） */
  bOnly: string[];
}

// ── 单仓索引 ─────────────────────────────────────────────────

/** 对单个项目根建顶层符号索引（复用 impact 依赖图的 nameIndex，避免重复解析） */
export async function buildProjectIndex(root: string): Promise<ProjectSymbolIndex> {
  const graph = await buildImpactGraph(root);
  const symbols = new Map<string, CrossRepoSym[]>();
  for (const [name, defs] of graph.nameIndex) {
    symbols.set(
      name,
      defs.map((d) => ({
        name,
        kind: d.sym.kind,
        file: d.rel,
        qn: d.sym.qualified_name,
        signature: d.sym.signature,
      })),
    );
  }
  return { root, fileCount: graph.rels.size, symbols };
}

// ── 定义比较（双胞胎 vs 真冲突） ────────────────────────────────

/** 空白归一化：缩进/换行差异不干扰签名相等判断 */
function normSig(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 定义集合的规范化指纹：kind + 归一化签名，排序拼接（容忍同仓多定义/顺序） */
function defFingerprint(defs: CrossRepoSym[]): string {
  return defs
    .map((d) => `${d.kind}:${normSig(d.signature)}`)
    .sort()
    .join('|');
}

/** 同名同签（两边定义指纹一致）→ 双胞胎；否则真冲突 */
function isDuplicate(a: CrossRepoSym[], b: CrossRepoSym[]): boolean {
  return defFingerprint(a) === defFingerprint(b);
}

// ── 两仓对比 ─────────────────────────────────────────────────

/** 对两个项目根建索引并求交/求差 */
export async function compareProjects(aRoot: string, bRoot: string): Promise<CrossRepoReport> {
  const [a, b] = await Promise.all([buildProjectIndex(aRoot), buildProjectIndex(bRoot)]);

  const conflicts: SymbolCollision[] = [];
  const duplicates: SymbolCollision[] = [];
  const aOnly: string[] = [];

  for (const [name, aDefs] of a.symbols) {
    const bDefs = b.symbols.get(name);
    if (!bDefs) {
      aOnly.push(name);
      continue;
    }
    const dup = isDuplicate(aDefs, bDefs);
    const collision: SymbolCollision = { name, a: aDefs, b: bDefs, duplicate: dup };
    if (dup) duplicates.push(collision);
    else conflicts.push(collision);
  }

  const bOnly: string[] = [];
  for (const name of b.symbols.keys()) {
    if (!a.symbols.has(name)) bOnly.push(name);
  }

  conflicts.sort((x, y) => (x.name < y.name ? -1 : 1));
  duplicates.sort((x, y) => (x.name < y.name ? -1 : 1));
  aOnly.sort();
  bOnly.sort();

  return {
    aRoot: a.root,
    bRoot: b.root,
    aFiles: a.fileCount,
    bFiles: b.fileCount,
    aSymbols: a.symbols.size,
    bSymbols: b.symbols.size,
    conflicts,
    duplicates,
    aOnly,
    bOnly,
  };
}
