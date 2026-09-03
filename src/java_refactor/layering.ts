/**
 * java_refactor/layering —— 按 Spring MVC 分层（Java 专属，收敛进 Java 重构执行器）
 *
 * 分层语义：类型级注解 → controller/service/repository/entity/config。
 *   @RestController/@Controller → controller，@Service → service，@Repository/@Mapper → repository，
 *   @Entity/@Table → entity，@Configuration/@Component → config。
 *
 * 两块：
 *  1) planSpringLayering —— 只读分析：扫注解 → 归层 → 推断根包 → 每层目标包（干净、可测）。
 *  2) buildSpringMvcLayeringPlan —— 落盘计划（纯计算，不写盘）：对每个归层文件算迁移后
 *     物理路径 + 内容改写（改 package 声明 + 全项目把该类型的 `import 旧包.T` 改写为新包），
 *     产出 RunningChangePlan 交给 runRefactorPipeline 落盘/验证/回滚。
 *
 * Java 与 Go/package_migration 的根本差异：Java import 是全限定单类 `import com.foo.UserService`，
 *   不是 moduleBase 路径前缀。因此不能复用 computeMigrationPlan（其 rewriteImportPaths 按 `/prefix/` 前缀
 *   替换文本字节，会把类名当路径段误伤）。这里用 tree-sitter 精确改 import 声明节点 + 物理移动文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseAstRoot } from '../tools/ts_kernel/index.js';
import type { SyntaxNodeLike } from '../tools/ts_kernel/index.js';
import type { RunningChangePlan } from '../tools/refactor_langs.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

export interface SpringLayeringFile {
  file: string;
  pkg: string;
  layer: string;
  annotations: string[];
}

export interface SpringLayeringPlan {
  total_files: number;
  classified: number;
  other: number;
  layer_counts: Record<string, number>;
  assignments: SpringLayeringFile[];
  base_package: string;
  limitations: string[];
}

export interface SpringLayeringInput {
  project_dir: string;
  target_base_package?: string;
  annotation_layers?: Record<string, string>;
}

/** 落盘计划的一部分：一个归层文件的迁移描述 */
export interface LayerMigration {
  file: string;
  abs: string;
  layer: string;
  old_pkg: string;
  new_pkg: string;
  type_name: string;
}

export interface SpringMvcLayeringPlan extends SpringLayeringPlan {
  /** 落盘计划详情（dry_run 预览 / 驱动落盘） */
  migrations: LayerMigration[];
}

// ─────────────────────────────────────────────
// 内置 Spring 注解 → 层映射
// ─────────────────────────────────────────────

export const DEFAULT_ANNOTATION_LAYERS: Record<string, string> = {
  restcontroller: 'controller',
  controller: 'controller',
  service: 'service',
  repository: 'repository',
  mapper: 'repository',
  persistent: 'repository',
  entity: 'entity',
  table: 'entity',
  document: 'entity',
  configuration: 'config',
  component: 'config',
};

export const LAYER_ORDER = ['controller', 'service', 'repository', 'entity', 'config'];
export const LAYER_LABELS: Record<string, string> = {
  controller: '控制层',
  service: '服务层',
  repository: '数据访问层',
  entity: '实体层',
  config: '配置层',
  other: '未识别',
};

const DEFAULT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', '.design-canvas', '.venv', 'venv', '__pycache__', '.next', 'out',
]);

// ─────────────────────────────────────────────
// 纯函数：扫源码 + AST 提取
// ─────────────────────────────────────────────

export function collectJavaFiles(proj: string, skipDirs?: Set<string>): string[] {
  const skip = skipDirs ?? DEFAULT_SKIP_DIRS;
  const out: string[] = [];
  const stack = [proj];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skip.has(ent.name)) stack.push(p);
        continue;
      }
      if (ent.name.endsWith('.java')) out.push(path.relative(proj, p).split(path.sep).join('/'));
    }
  }
  return out;
}

function annotationName(n: SyntaxNodeLike): string | undefined {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    if (c.type === 'identifier') return c.text;
    if (c.type === 'scoped_identifier') {
      const segments = c.text.split('.');
      return segments[segments.length - 1];
    }
  }
  return undefined;
}

function collectAnnotations(n: SyntaxNodeLike): string[] {
  const out: string[] = [];
  const walk = (node: SyntaxNodeLike): void => {
    const t = node.type;
    if (t === 'marker_annotation' || t === 'annotation') {
      const name = annotationName(node);
      if (name) out.push(name);
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) walk(c);
    }
  };
  walk(n);
  return out;
}

function packageNameFrom(n: SyntaxNodeLike): string {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    if (c.type === 'scoped_identifier' || c.type === 'identifier') return c.text;
  }
  return '';
}

function typeNameFrom(n: SyntaxNodeLike): string {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    if (c.type === 'identifier') return c.text;
  }
  return '';
}

/** 解析单个 Java 文件 → 顶层类型清单（pkg + 类型名 + 注解）。同时返回 package 全文所在行用于改写。 */
function extractJavaTypes(root: SyntaxNodeLike | undefined): Array<{ pkg: string; type: string; annotations: string[] }> {
  const out: Array<{ pkg: string; type: string; annotations: string[] }> = [];
  if (!root) return out;
  let pkg = '';
  const walk = (n: SyntaxNodeLike): void => {
    const t = n.type;
    if (t === 'package_declaration') {
      pkg = packageNameFrom(n);
      return;
    }
    if (t === 'class_declaration' || t === 'interface_declaration' || t === 'enum_declaration' || t === 'record_declaration') {
      const name = typeNameFrom(n);
      let annotations: string[] = [];
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c && c.type === 'modifiers') annotations = collectAnnotations(c);
      }
      if (name) out.push({ pkg, type: name, annotations });
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c);
    }
  };
  walk(root);
  return out;
}

export function layerForType(annotations: string[], map: Record<string, string>): string {
  for (const a of annotations) {
    const hit = map[a.toLowerCase()];
    if (hit) return hit;
  }
  return 'other';
}

export function inferBasePackage(pkgs: string[]): string {
  const used = [...new Set(pkgs.filter(Boolean))];
  if (used.length === 0) return '';
  let common = used[0].split('.');
  for (const p of used) {
    const parts = p.split('.');
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  return common.join('.');
}

// ─────────────────────────────────────────────
// 只读分析：planSpringLayering
// ─────────────────────────────────────────────

export async function planSpringLayering(input: SpringLayeringInput): Promise<SpringLayeringPlan> {
  const proj = path.resolve(input.project_dir);
  const map = input.annotation_layers ?? DEFAULT_ANNOTATION_LAYERS;
  const limitations: string[] = [];

  const files = collectJavaFiles(proj);
  if (files.length === 0) limitations.push(`在 ${input.project_dir} 未发现 .java 文件`);

  const perFile = new Map<string, { layer: string; pkg: string; annotations: string[] }>();
  const pkgSet = new Set<string>();
  for (const rel of files) {
    const abs = path.resolve(proj, rel);
    let src = '';
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const root = await parseAstRoot(abs, src);
    const types = extractJavaTypes(root?.root);
    for (const t of types) pkgSet.add(t.pkg);
    const layers = types.map((t) => layerForType(t.annotations, map));
    const nonOther = layers.filter((l) => l !== 'other');
    const layer = nonOther[0] ?? layers[0] ?? 'other';
    const annotations = [...new Set(types.flatMap((t) => t.annotations))];
    const prev = perFile.get(rel);
    if (!prev || nonOther.length > 0) {
      perFile.set(rel, { layer, pkg: types[0]?.pkg ?? '', annotations });
    }
  }

  const basePackage = (input.target_base_package ?? '').trim() || inferBasePackage([...pkgSet].filter(Boolean));
  if (!basePackage) limitations.push('无法推断项目根包；可显式传 target_base_package');

  const layer_counts: Record<string, number> = {};
  let classified = 0;
  const assignments: SpringLayeringFile[] = [];
  for (const [file, info] of perFile) {
    layer_counts[info.layer] = (layer_counts[info.layer] ?? 0) + 1;
    if (info.layer !== 'other') classified++;
    assignments.push({ file, pkg: info.pkg, layer: info.layer, annotations: info.annotations });
  }

  return {
    total_files: files.length,
    classified,
    other: layer_counts['other'] ?? 0,
    layer_counts,
    assignments,
    base_package: basePackage,
    limitations,
  };
}

// ─────────────────────────────────────────────
// 落盘计划：buildSpringMvcLayeringPlan（纯计算）
// ─────────────────────────────────────────────

/**
 * 计算每个归层文件的迁移目标包：`<base>.<layer>`（如 com.example.app.controller）。
 * 仅当目标包 ≠ 当前包且非 other 时才需要迁移。
 */
function targetPackage(base: string, layer: string): string {
  return `${base}.${layer}`;
}

/** 把「包名 → 源树相对物理目录」换算：pkg com.example.app → com/example/app；相对 src java 根 */


/**
 * 生成 Spring MVC 分层的落盘计划（纯计算，不写盘）。
 *
 * 对每个归层文件：
 *  - 若 new_pkg === old_pkg → 不迁移（已落位）。
 *  - 否则产出 moves（把源文件物理移到 srcRoot/<newPkgPath>/<Type>.java）+ absToNew 内容改写：
 *      (a) 本文件 package 声明改新包；
 *      (b) 全项目所有 `import <old>.T;` → `import <new>.T;`（精确 FQN，只改 import 声明节点）。
 *  originals 记录每个被改文件的原始内容，供回滚。
 *
 * @param proj    项目根
 * @param input   同 planSpringLayering 的输入（project_dir + 可选 root package / 自定义映射）
 */
export async function buildSpringMvcLayeringPlan(proj: string, input: SpringLayeringInput): Promise<{ plan: SpringMvcLayeringPlan; run: RunningChangePlan }> {
  const absProj = path.resolve(proj);
  const plan = await planSpringLayering({ ...input, project_dir: absProj });
  const migrations: LayerMigration[] = [];
  const moves: NonNullable<RunningChangePlan['moves']> = [];
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();

  const base = plan.base_package;
  const limitations = [...plan.limitations];

  // 1) 决定每类迁移目标
  const fileMoves = new Map<string, { old_pkg: string; new_pkg: string; type_name: string; new_abs: string }>();
  const basePath = base.replace(/\./g, '/');
  for (const a of plan.assignments) {
    if (a.layer === 'other') continue;
    const newPkg = targetPackage(base, a.layer);
    if (newPkg === a.pkg) continue; // 已落位
    // 类型名：优先文件名（Java 惯例 public 类型名=文件名）；否则该文件首个顶层类型
    const typeName = a.file.split('/').pop()!.replace(/\.java$/, '');
    // 找 src 树根：pkg 物理路径在文件相对路径里的位置
    const oldPath = a.pkg.replace(/\./g, '/');
    const idx = a.file.indexOf(oldPath);
    if (idx < 0) {
      limitations.push(`无法定位 ${a.file} 的包目录（pkg=${a.pkg}），跳过迁移`);
      continue;
    }
    const srcRoot = a.file.slice(0, idx).replace(/\/$/, ''); // 如 src/main/java
    const newRel = a.pkg === '' ? '' : `${srcRoot}/${basePath}/${a.layer}`;
    const newAbs = path.resolve(absProj, newRel, `${typeName}.java`);
    const oldAbs = path.resolve(absProj, a.file);
    if (newAbs === oldAbs) continue;
    fileMoves.set(a.file, { old_pkg: a.pkg, new_pkg: newPkg, type_name: typeName, new_abs: newAbs });
    migrations.push({
      file: a.file,
      abs: oldAbs,
      layer: a.layer,
      old_pkg: a.pkg,
      new_pkg: newPkg,
      type_name: typeName,
    });
    moves.push({ from: oldAbs, to: newAbs });
  }

  if (fileMoves.size === 0) {
    return { plan: { ...plan, migrations }, run: { absToNew, originals, moves, units: 0 } };
  }

  // 2) 内容改写
  const allFiles = collectJavaFiles(absProj);
  const typeMap = new Map<string, { oldFqn: string; newFqn: string; oldPkg: string; newPkg: string }>();
  for (const m of fileMoves.values()) {
    typeMap.set(m.type_name, { oldFqn: `${m.old_pkg}.${m.type_name}`, newFqn: `${m.new_pkg}.${m.type_name}`, oldPkg: m.old_pkg, newPkg: m.new_pkg });
  }
  // 需要移动的文件：改写内容落到「移动后路径」（pipeline 先 move 再写 to 路径）
  const moveNewAbs = new Map<string, string>();
  for (const [rel, m] of fileMoves) moveNewAbs.set(rel, m.new_abs);

  const seenOriginal = new Set<string>();
  for (const rel of allFiles) {
    const abs = path.resolve(absProj, rel);
    let src = '';
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const selfMove = fileMoves.get(rel);
    const out = await rewriteJavaFile(src, abs, selfMove, typeMap);
    if (out === src) continue;
    // 内容确认有变
    const isMoved = selfMove !== undefined;
    const targetAbs = isMoved ? moveNewAbs.get(rel)! : abs;
    if (!seenOriginal.has(abs)) {
      originals.set(abs, src); // 移动文件回滚按原始路径还原
      seenOriginal.add(abs);
    }
    absToNew.set(targetAbs, out);
  }

  return { plan: { ...plan, migrations }, run: { absToNew, originals, moves, units: moves.length } };
}

/**
 * 改写单个 Java 文件：被迁移文件改 package 声明 + 全项目 import FQN 改写 +
 * 为"同包裸引用"自动补 import（拆到不同包后原本免 import 的裸引用会失效）。
 * 不牵涉迁移时返回原串（import 无命中、且本文件非迁移目标）。
 */
async function rewriteJavaFile(
  src: string,
  abs: string,
  selfMove: { old_pkg: string; new_pkg: string; type_name: string } | undefined,
  typeMap: Map<string, { oldFqn: string; newFqn: string; oldPkg: string; newPkg: string }>,
): Promise<string> {
  const r = await parseAstRoot(abs, src);
  if (!r?.root) return src;

  const edits: Array<{ start: number; end: number; text: string; guard: string }> = [];

  // (a) 本文件 package 声明 => newPkg
  if (selfMove) {
    const pkgNode = findPackageNode(r.root);
    const inner = pkgNode ? findPkgName(pkgNode) : undefined;
    if (inner) edits.push({ start: inner.startIndex, end: inner.endIndex, text: selfMove.new_pkg, guard: selfMove.old_pkg });
  }

  // (b) import FQN 改写（每个文件都扫）
  collectImportEdits(r.root, typeMap, edits);

  // (c) 同包裸引用补 import：本文件用类型位置的裸名指向某 moved 类型、但既没 import 覆盖、
  //     又不落在该类型新包、也不是本文件自身声明的同名类型 → 注入 `import <newPkg>.<T>;`
  const info = analyzeJavaRefs(r.root);
  if (info.typeUses.size > 0 && typeMap.size > 0) {
    const need: string[] = [];
    for (const name of info.typeUses) {
      const entry = typeMap.get(name);
      if (!entry) continue;
      if (info.importedTypes.has(name)) continue; // 已 import（collectImportEdits 已把旧→新改好）
      if (info.ownTypes.has(name)) continue; // 绑定本文件声明的同名类型，非 moved 类型
      if (info.pkg === entry.newPkg) continue; // 已落位同包，免 import
      need.push(entry.newFqn);
    }
    if (need.length > 0) {
      // 注入点：最后一个 import 语句结尾；无 import 则 package 声明结尾。
      const insert = info.lastImportEnd >= 0 ? info.lastImportEnd : info.packageEnd;
      if (insert >= 0) {
        const lines = [...new Set(need)].sort();
        const prefix = info.lastImportEnd >= 0 ? '\n' : '\n\n';
        edits.push({ start: insert, end: insert, text: prefix + lines.map((fqn) => `import ${fqn};`).join('\n'), guard: '' });
      }
    }
  }

  if (edits.length === 0) return src;
  edits.sort((a, b) => b.start - a.start);
  let s = src;
  for (const e of edits) {
    if (e.start < 0 || e.end > s.length || e.start > e.end) continue;
    const cur = s.slice(e.start, e.end);
    // guard：package/import 编辑守卫各自精确文本；insert（start==end，cur 空）直接用空守卫放行
    if (cur === e.guard) {
      s = s.slice(0, e.start) + e.text + s.slice(e.end);
    }
  }
  return s;
}

/** 一次遍历收集 Java 文件引用的类型位置裸名 / 已 import 类型 / 本文件声明类型 / 包名 / 插入锚点 */
function analyzeJavaRefs(root: SyntaxNodeLike): {
  pkg: string;
  ownTypes: Set<string>;
  importedTypes: Set<string>;
  typeUses: Set<string>;
  lastImportEnd: number;
  packageEnd: number;
} {
  const ownTypes = new Set<string>();
  const importedTypes = new Set<string>();
  const typeUses = new Set<string>();
  let pkg = '';
  let lastImportEnd = -1;
  let packageEnd = -1;

  const walk = (n: SyntaxNodeLike, parent: string): void => {
    const t = n.type;
    if (t === 'package_declaration') {
      pkg = packageNameFrom(n);
      packageEnd = n.endIndex ?? -1;
      // 不深入 package 内部
      return;
    }
    if (t === 'class_declaration' || t === 'interface_declaration' || t === 'enum_declaration' || t === 'record_declaration') {
      const name = typeNameFrom(n);
      if (name) ownTypes.add(name);
      // 不进入类型体：字段/方法的裸类型引用由 typeUses 单独收（type_identifier 仍会出现在体里），
      // 但为简单起见直接继续遍历（type_identifier 在任意深度都会被收）。
    }
    if (t === 'import_declaration') {
      const pathNode = importPathNode(n);
      if (pathNode) importedTypes.add(pathNode.text.split('.').pop()!);
      lastImportEnd = n.endIndex ?? lastImportEnd;
      return; // 不深入 import 内部
    }
    if (t === 'type_identifier' && parent !== 'scoped_type_identifier') {
      const text = n.text;
      if (isValidTypeName(text)) typeUses.add(text);
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) walk(c, t.toString());
    }
  };
  walk(root, '');
  return { pkg, ownTypes, importedTypes, typeUses, lastImportEnd, packageEnd };
}

/** 裸类型名的合法形态（Java 标识符；排除树里偶发出现的占位符） */
function isValidTypeName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function findPackageNode(root: SyntaxNodeLike): SyntaxNodeLike | undefined {
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'package_declaration') return n;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

function findPkgName(node: SyntaxNodeLike): { startIndex: number; endIndex: number } | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'scoped_identifier' || c.type === 'identifier') {
      return { startIndex: c.startIndex ?? 0, endIndex: c.endIndex ?? 0 };
    }
  }
  return undefined;
}

/** 收集所有 `import <old>.T;` 的编辑点 → `import <new>.T;` */
function collectImportEdits(
  root: SyntaxNodeLike,
  typeMap: Map<string, { oldFqn: string; newFqn: string; oldPkg: string; newPkg: string }>,
  edits: Array<{ start: number; end: number; text: string; guard: string }>,
): void {
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'import_declaration') {
      const pathNode = importPathNode(n);
      if (pathNode) {
        const fqn = pathNode.text;
        const entry = typeMap.get(fqn.split('.').pop()!);
        if (entry && fqn === entry.oldFqn) {
          // guard 用 oldFqn（而非 'import'）：edit 只覆盖 FQN 文本节点，不覆盖整条 import 语句
          edits.push({ start: pathNode.startIndex ?? 0, end: pathNode.endIndex ?? pathNode.startIndex ?? 0, text: entry.newFqn, guard: entry.oldFqn });
        }
      }
      continue; // import 内部不进（类型参数等）
    }
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (c) stack.push(c);
    }
  }
}

function importPathNode(node: SyntaxNodeLike): { text: string; startIndex?: number; endIndex?: number } | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'scoped_identifier' || c.type === 'identifier') {
      return { text: c.text, startIndex: c.startIndex, endIndex: c.endIndex };
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────
// 文本渲染 + handler
// ─────────────────────────────────────────────

export function renderLayeringText(plan: SpringLayeringPlan, targetBase = ''): string {
  const base = targetBase || plan.base_package;
  const lines: string[] = [];
  lines.push(`Spring MVC 分层（只读分析）`);
  lines.push(`扫描 ${plan.total_files} 个 Java 文件；归层 ${plan.classified} 个，其他/未识别 ${plan.other} 个。`);
  for (const layer of LAYER_ORDER) {
    const c = plan.layer_counts[layer];
    if (c) lines.push(`  ${layer}（${LAYER_LABELS[layer] ?? layer}）: ${c}`);
  }
  if (base) lines.push(`预计根包: ${base}（目标包按 controller/service/repository/entity/config 命名）`);
  for (const lim of plan.limitations) lines.push(`  ⚠ ${lim}`);

  lines.push('');
  lines.push('分层归属：');
  for (const a of plan.assignments) {
    lines.push(`  [${a.layer}] ${a.file}${a.annotations.length ? `  (@${a.annotations.join(', @')})` : ''}`);
  }
  return lines.join('\n');
}

export interface SpringLayeringResult extends SpringLayeringPlan {
  dry_run: boolean;
  message: string;
}

export async function springMvcLayeringHandler(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const project_dir = typeof args['project_dir'] === 'string' && args['project_dir'].trim()
    ? (args['project_dir'] as string)
    : '';
  if (!project_dir) return { text: '缺参数 "project_dir"（目标 Java 项目根）', isError: true };
  if (!fs.existsSync(path.resolve(project_dir))) {
    return { text: `project_dir 不存在：${project_dir}`, isError: true };
  }
  const targetBase = typeof args['target_base_package'] === 'string' ? (args['target_base_package'] as string) : undefined;

  const plan = await planSpringLayering({ project_dir, target_base_package: targetBase });
  return { text: renderLayeringText(plan, targetBase), isError: false };
}