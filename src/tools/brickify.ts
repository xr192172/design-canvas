/**
 * brickify —— 依赖驱动的积木化管线（全链路：一个文件预处理成一个积木社区）
 *
 * 用户核心洞见（2026-08-24）：拿到一个项目，**先积木化**——每块积木 = 一个功能；
 * 再去识别"一个功能多个相似实现"（同概念散落多份 = 破抽象）与
 * "一个文件塞多个功能"（多概念挤一文件 = 破分离）两种**内聚被打破**的症状；
 * 然后将文件解耦 → 独立成积木；最后按积木的**依赖边做功能社区**聚类，
 * 取代旧的"按目录硬切 + 文件基名相似"启发式，再进思维导图式运算/重构。
 *
 * 原则（反屎山）：只做**投影 + 组装 + 依赖聚类**，解析/分层/死码全部复用既有原子：
 *   - scanSourceFiles() / matchLayer() / sideOfLayer()   ← 复用 feature_map
 *   - enumerateTsSources() / resolveSpecifier()          ← 复用 detect_dead_imports / brick_bag
 *   - getParser() / parseContent()                        ← 复用 ts_kernel AST
 *   新增的只有三段：文件级依赖边、混合文件信号、依赖社区。
 *
 * 能力诚实边界（decline rather than guess）：
 *   - **混合文件检测是"信号级"**：能确定性标出"一个文件里多个无耦合的概念簇"，
 *     但不自动切分文件内部——解耦拆分由人/LLM 确认（文件内符号切分比文件级难一档）。
 *   - 依赖社区用**无向连通分量 + 内聚度**做确定性社区（不引入随机优化），
 *     积木=功能由"目录做种子 + 依赖边校正"定义，不激进自动搬目录。
 *   - 仅工程内相对 import 参与依赖边；裸包名（axios）跨文件不可解析故跳过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanSourceFiles, featureIdOf, sideOfLayer, type FeatureSide } from './feature_map.js';
import { matchLayer } from './layer_detect.js';
import { enumerateTsSources } from './detect_dead_imports.js';
import { resolveSpecifier } from './brick_bag.js';
import { getParser } from './ts_kernel/loader.js';
import { findLanguageByExt, type LanguageEntry } from './ts_kernel/languages.js';
import { parseContent } from './ts_kernel/kernel.js';

export interface BrickifyOptions {
  /** 工程根（死码探测等工作目录） */
  project_dir: string;
  /** 源码根；缺省 = project_dir。其下按依赖聚类 */
  source_root?: string;
}

/** 文件级有向依赖边（from import 方 → to 被 import 方，均为相对 source_root） */
export interface FileDep {
  from: string;
  to: string;
  count: number;
}

/** 混合文件信号：一个文件里多个无耦合概念簇（解耦候选） */
export interface MixedFileSignal {
  file: string;
  /** 检测到的概念簇（每簇 = 一组功能名），>=2 簇即信号 */
  clusters: string[][];
  /** 人话原因 */
  reason: string;
}

/** 功能社区（按积木间依赖边无向连通） */
export interface Community {
  id: string;
  bricks: string[];
  internal_edges: number;
  external_edges: number;
  /** 内聚度 = internal / (internal + external)；1 = 完全自足 */
  cohesion: number;
}

/** 升级版积木（目录种子 + 依赖社区标签 + 混合文件雷达） */
export interface BrickifyBrick {
  id: string;
  files: { frontend: string[]; backend: string[]; shared: string[] };
  total: number;
  dominant: FeatureSide;
  /** 所属功能社区 id（null = 孤立积木，无任何依赖边） */
  community: string | null;
  /** 落在本积木下的混合文件（解耦候选雷达） */
  mixed_files: string[];
}

export interface BrickifyResult {
  bricks: BrickifyBrick[];
  file_deps: FileDep[];
  communities: Community[];
  mixed_files: MixedFileSignal[];
  /** 积木级有向调用边（社区画线的依据） */
  call_edges: Array<{ from: string; to: string; count: number }>;
  meta: { project_dir: string; source_root: string; scanned_files: number; langs: string[] };
  limitations: string[];
}

const TS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

/** 读文件相对 source_root 的源码；失败返回空串（尽力而为） */
function readRel(sourceRoot: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(sourceRoot, ...rel.split('/')), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * ① 文件级依赖边：扫描 source_root 下源文件，复用 enumerateTsSources + resolveSpecifier，
 * 把相对 import 指向的工程内文件解析出来 → 有向边（from import 方 → 被 import 方）。
 */
export function buildFileDeps(sourceRoot: string, rels: string[]): FileDep[] {
  const acc = new Map<string, number>();
  const key = (a: string, b: string): string => `${a}\u0001${b}`;
  for (const rel of rels) {
    if (!TS_EXT.test(rel)) continue;
    const src = readRel(sourceRoot, rel);
    if (!src) continue;
    const dir = rel.split('/').slice(0, -1).join('/');
    for (const spec of enumerateTsSources(src)) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // 仅工程内相对 import
      const target = resolveSpecifier(sourceRoot, dir, spec);
      if (!target || target === rel) continue;
      const k = key(rel, target);
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
  }
  const deps: FileDep[] = [];
  for (const [k, count] of acc) {
    const i = k.indexOf('\u0001');
    deps.push({ from: k.slice(0, i), to: k.slice(i + 1), count });
  }
  deps.sort((a, b) => b.count - a.count || (a.from < b.from ? -1 : 1));
  return deps;
}

// ─────────────────────────────────────────────────────────────
// ② 混合文件信号（AST 顶层概念簇）——信号级，不自动切分
// ─────────────────────────────────────────────────────────────

/** tree-sitter 最小节点面 */
interface NodeLike {
  type: string;
  text: string;
  childCount: number;
  child(i: number): NodeLike | null;
  childForFieldName(f: string): NodeLike | null;
}

/** 词边界标识符引用集（同 ts_slim，误方向=多关联，安全） */
function collectRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*/g)) refs.add(m[0]);
  return refs;
}

const DECL_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
  'lexical_declaration',
]);

function childrenOf(node: NodeLike, type: string): NodeLike[] {
  const out: NodeLike[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && c.type === type) out.push(c);
  }
  return out;
}

/** import_statement → [{local, module}]（local = 本文件绑定名，module = 去引号 specifier） */
function importBindings(node: NodeLike): Array<{ local: string; module: string }> {
  const out: Array<{ local: string; module: string }> = [];
  // 语句上的 string 子节点：最后一个 = module specifier（同 ts_slim.importModule）
  const strings = childrenOf(node, 'string');
  if (strings.length === 0) return out;
  const module = strings[strings.length - 1].text.replace(/^['"]|['"]$/g, '');
  // 遍历 import_clause：default identifier / namespace_import / named_imports
  for (const c of childNodes(node)) {
    if (c.type !== 'import_clause') continue;
    for (const cc of childNodes(c)) {
      if (cc.type === 'identifier') {
        out.push({ local: cc.text, module });
      } else if (cc.type === 'namespace_import') {
        const name = cc.childForFieldName('name');
        if (name) out.push({ local: name.text, module });
      } else if (cc.type === 'named_imports') {
        for (const spec of childNodes(cc)) {
          if (spec.type !== 'import_specifier') continue;
          const name = spec.childForFieldName('name');
          const alias = spec.childForFieldName('alias');
          const local = alias ? alias.text : name ? name.text : null;
          if (local) out.push({ local, module });
        }
      }
    }
  }
  return out.filter((x) => x.local);
}

function childNodes(node: NodeLike | null): NodeLike[] {
  if (!node) return [];
  const out: NodeLike[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) out.push(c);
  }
  return out;
}

/** 顶层声明 → 名字数组（lexical_declaration 多个 declarator）；null = 无法判名 */
function declNamesOf(decl: NodeLike): string[] | null {
  if (decl.type === 'lexical_declaration') {
    const names: string[] = [];
    for (const vd of childNodes(decl)) {
      if (vd.type !== 'variable_declarator') continue;
      const n = vd.childForFieldName('name');
      if (!n || n.type !== 'identifier') return null; // 解构形态，保守
      names.push(n.text);
    }
    return names.length > 0 ? names : null;
  }
  const n = decl.childForFieldName('name');
  return n && n.type !== 'constructor_type' ? [n.text] : null;
}

/**
 * ② 混合文件信号：对每个 TS/JS 文件做 AST 顶层声明聚类——
 *   声明若引用共同 import（用了同一批外部能力）或彼此引用 → 归同簇。
 *   >=2 个概念簇（且总声明>=4）→ 标为"解耦候选"（不自动切分，供人/LLM 确认）。
 */
export async function detectMixedFiles(sourceRoot: string, rels: string[]): Promise<MixedFileSignal[]> {
  const signals: MixedFileSignal[] = [];
  for (const rel of rels) {
    if (!TS_EXT.test(rel)) continue;
    const src = readRel(sourceRoot, rel);
    if (src.length < 60) continue; // 只跳过空壳/片段文件；真正密度判据是下方 declList>=4
    const ext = String(path.extname(rel));
    const lang: LanguageEntry | undefined = findLanguageByExt(ext);
    const parser = lang ? await getParser(ext, lang) : null;
    if (!parser) continue; // 语言包不可用，跳过（不崩溃）
    const tree = parseContent(parser as Parameters<typeof parseContent>[0], src) as unknown as {
      rootNode: NodeLike;
    };
    const root = tree.rootNode;

    const imports: Array<{ local: string; module: string }> = [];
    const declList: Array<{ name: string; text: string }> = [];
    const collectStmt = (node: NodeLike): void => {
      if (node.type === 'import_statement') {
        imports.push(...importBindings(node));
      } else if (DECL_TYPES.has(node.type)) {
        const names = declNamesOf(node);
        if (names) for (const n of names) declList.push({ name: n, text: node.text });
      } else if (node.type === 'export_statement') {
        // export function/class/const/interface… → 声明藏在 declaration 字段
        const decl = node.childForFieldName('declaration');
        if (decl && DECL_TYPES.has(decl.type)) {
          const names = declNamesOf(decl);
          if (names) for (const n of names) declList.push({ name: n, text: decl.text });
        }
        // export { a, b }（无 from）——纯名单重导出：作为「连接器」，不参与概念簇（保守不过度标）
      }
    };
    for (let i = 0; i < root.childCount; i++) {
      const node = root.child(i);
      if (!node) continue;
      if (node.type === 'module') {
        for (const c of childNodes(node)) collectStmt(c);
      } else {
        collectStmt(node);
      }
    }
    if (declList.length < 4) continue;

    // local → module 归组推理：一个 module 多个 local 绑定；声明用到的 local → 该 module
    const localToModules = new Map<string, string[]>();
    for (const im of imports) {
      const arr = localToModules.get(im.local) ?? [];
      if (!arr.includes(im.module)) arr.push(im.module);
      localToModules.set(im.local, arr);
    }

    // 每声明 → 用到的 import modules（词边界） + 引用到的声明名
    const declModules = declList.map((d) => {
      const refs = collectRefs(d.text);
      const mods = new Set<string>();
      for (const [local, ms] of localToModules) {
        if (refs.has(local)) for (const m of ms) mods.add(m);
      }
      return { name: d.name, modules: mods, declRefs: refs };
    });

    // Union-Find 聚类：共享 import module 或彼此引用 → 同簇；裸 import 引用也归同簇
    const parent: number[] = declList.map((_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const union = (a: number, b: number): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    const declNameSet = new Set(declList.map((d) => d.name));
    for (let i = 0; i < declModules.length; i++) {
      for (let j = i + 1; j < declModules.length; j++) {
        const a = declModules[i], b = declModules[j];
        const shared = [...a.modules].some((m) => b.modules.has(m));
        const refAB = [...a.declRefs].filter((r) => declNameSet.has(r) && b.name === r).length > 0
          || [...b.declRefs].filter((r) => declNameSet.has(r) && a.name === r).length > 0;
        if (shared || refAB) union(i, j);
      }
    }
    const byRoot = new Map<number, string[]>();
    for (let i = 0; i < declList.length; i++) {
      const r = find(i);
      const arr = byRoot.get(r) ?? [];
      arr.push(declList[i].name);
      byRoot.set(r, arr);
    }
    const clusters = [...byRoot.values()].filter((c) => c.length > 0);
    if (clusters.length >= 2) {
      signals.push({
        file: rel,
        clusters,
        reason: `顶层 ${declList.length} 个功能被依赖切成 ${clusters.length} 个无耦合概念簇（疑似一文件多功能，解耦候选）`,
      });
    }
  }
  signals.sort((a, b) => a.file.localeCompare(b.file));
  return signals;
}

// ─────────────────────────────────────────────────────────────
// ③ 功能社区（依赖边无向连通分量 + 内聚度）
// ─────────────────────────────────────────────────────────────

class UnionFind {
  private p: number[];
  constructor(n: number) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    if (this.p[x] !== x) this.p[x] = this.find(this.p[x]);
    return this.p[x];
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p[ra] = rb;
  }
}

/** ③ 功能社区：把文件级依赖边聚合到"积木（目录种子）→ 积木"，按无向连通分量为社区，
 *  计算每社区内聚度（内部边 / 内部+外部边）。孤立积木也成单点社区。 */
export function computeCommunities(rels: string[], fileDeps: FileDep[]): Community[] {
  const brickIds = [...new Set(rels.map(featureIdOf))].sort();
  const index = new Map(brickIds.map((id, i) => [id, i]));
  const uf = new UnionFind(brickIds.length);

  // ① 先用所有跨积木依赖边把"彼此可达"的积木并成社区
  for (const d of fileDeps) {
    const a = index.get(featureIdOf(d.from));
    const b = index.get(featureIdOf(d.to));
    if (a === undefined || b === undefined) continue;
    if (a !== b) uf.union(a, b);
  }

  // ② 按社区分组，并把 bricks → 社区根 记录好
  const group = new Map<number, string[]>();
  for (let i = 0; i < brickIds.length; i++) {
    const r = uf.find(i);
    const arr = group.get(r) ?? [];
    arr.push(brickIds[i]);
    group.set(r, arr);
  }
  const brickRoot = new Map<number, number>(); // brick index → 社区根
  for (let i = 0; i < brickIds.length; i++) brickRoot.set(i, uf.find(i));

  // ③ 逐边计数（按"边"而非"端点"）：同社区内的跨砖边算内部，跨社区边算外部
  const internal = new Map<number, number>();
  const external = new Map<number, number>();
  const bump = (m: Map<number, number>, k: number, v: number): void => {
    m.set(k, (m.get(k) ?? 0) + v);
  };
  for (const d of fileDeps) {
    const a = index.get(featureIdOf(d.from));
    const b = index.get(featureIdOf(d.to));
    if (a === undefined || b === undefined) continue;
    const c = d.count;
    if (a === b) {
      bump(internal, brickRoot.get(a) as number, c); // 同砖边 → 归其社区内部
    } else {
      const ra = brickRoot.get(a) as number;
      const rb = brickRoot.get(b) as number;
      if (ra === rb) bump(internal, ra, c); // 跨砖但同社区 → 内部边
      else {
        bump(external, ra, c); // 跨社区 → 各端点社区记一条外部边
        bump(external, rb, c);
      }
    }
  }

  const communities: Community[] = [];
  for (const [r, bricks] of group) {
    bricks.sort();
    const id = bricks[0];
    const gInt = internal.get(r) ?? 0;
    const gExt = external.get(r) ?? 0;
    const total = gInt + gExt;
    communities.push({
      id,
      bricks,
      internal_edges: gInt,
      external_edges: gExt,
      cohesion: total > 0 ? Number((gInt / total).toFixed(3)) : 1,
    });
  }
  communities.sort((a, b) => b.bricks.length - a.bricks.length || a.id.localeCompare(b.id));
  return communities;
}

// ─────────────────────────────────────────────────────────────
// 汇总：全链路一次打通
// ─────────────────────────────────────────────────────────────

/** 全链路：扫描 → 文件依赖边 → 目录种子积木 → 混合文件信号 → 功能社区 → 汇总。 */
export async function buildBrickify(opts: BrickifyOptions): Promise<BrickifyResult> {
  const proj = path.resolve(opts.project_dir);
  const sourceRoot = path.resolve(opts.source_root ?? proj);
  const rels = scanSourceFiles(sourceRoot);
  const langs = new Set<string>();
  for (const rel of rels) {
    if (TS_EXT.test(rel)) langs.add('ts');
    else if (rel.endsWith('.go')) langs.add('go');
    else if (rel.endsWith('.py')) langs.add('py');
  }

  const fileDeps = buildFileDeps(sourceRoot, rels);
  const mixedFiles = await detectMixedFiles(sourceRoot, rels);
  const communities = computeCommunities(rels, fileDeps);

  // 积木（目录种子）→ community 映射
  const brickComm = new Map<string, string>();
  for (const c of communities) for (const b of c.bricks) brickComm.set(b, c.id);
  const commByBrick = new Map<string, Community>();
  for (const c of communities) for (const b of c.bricks) commByBrick.set(b, c);

  // 积木默认字段。
  const seedFiles: Record<string, { frontend: string[]; backend: string[]; shared: string[] }> = {};
  for (const rel of rels) {
    const id = featureIdOf(rel);
    const bucket = seedFiles[id] ?? (seedFiles[id] = { frontend: [], backend: [], shared: [] });
    const side = sideOfLayer(matchLayer(rel));
    (side === 'frontend' ? bucket.frontend : side === 'backend' ? bucket.backend : bucket.shared).push(rel);
  }
  // 积木 → 其下混合文件
  const mixedByBrick = new Map<string, string[]>();
  for (const m of mixedFiles) {
    const id = featureIdOf(m.file);
    const arr = mixedByBrick.get(id) ?? [];
    arr.push(m.file);
    mixedByBrick.set(id, arr);
  }

  const brickIds = Object.keys(seedFiles).sort();
  const bricks: BrickifyBrick[] = brickIds.map((id) => {
    const files = seedFiles[id];
    const total = files.frontend.length + files.backend.length + files.shared.length;
    const dominant: FeatureSide =
      files.frontend.length > files.backend.length && files.frontend.length >= files.shared.length
        ? 'frontend'
        : files.backend.length > files.frontend.length && files.backend.length >= files.shared.length
          ? 'backend'
          : 'shared';
    return {
      id,
      files,
      total,
      dominant,
      community: brickComm.get(id) ?? null,
      mixed_files: mixedByBrick.get(id) ?? [],
    };
  });

  // 积木级有向调用边（社区/画线依据）
  const callAcc = new Map<string, number>();
  for (const d of fileDeps) {
    const a = featureIdOf(d.from), b = featureIdOf(d.to);
    if (a === b) continue;
    const k = `${a}\u0001${b}`;
    callAcc.set(k, (callAcc.get(k) ?? 0) + d.count);
  }
  const call_edges: Array<{ from: string; to: string; count: number }> = [];
  for (const [k, count] of callAcc) {
    const i = k.indexOf('\u0001');
    call_edges.push({ from: k.slice(0, i), to: k.slice(i + 1), count });
  }
  call_edges.sort((x, y) => y.count - x.count);

  return {
    bricks,
    file_deps: fileDeps,
    communities,
    mixed_files: mixedFiles,
    call_edges,
    meta: {
      project_dir: proj,
      source_root: sourceRoot,
      scanned_files: rels.length,
      langs: [...langs].sort(),
    },
    limitations: [
      '积木 = 源码根首层目录做种子，叠加依赖边校正；不自动搬目录（保守）',
      '功能社区 = 积木间依赖边的无向连通分量 + 内聚度；启发式，需人确认边界',
      '混合文件 = AST 顶层声明依赖聚类的"信号级"标记；不自动切分文件内部，解耦拆分需人/LLM 确认',
      '依赖边仅工程内相对 import；裸包名跨文件不可解析故跳过',
    ],
  };
}