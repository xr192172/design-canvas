/**
 * spring_mvc_layering —— 按 Spring MVC 分层（Java 专属，确定性只读分析 + 安全落盘）
 *
 * 目标（用户洞悉）：把「一锅端」的 Java 代码按 Spring MVC 语义梳理成分层——
 *   controller / service / repository / entity / config。
 * 识别依据 = 类型级注解：@RestController/@Controller → controller，
 *   @Service → service，@Repository/@Mapper → repository，
 *   @Entity/@Table → entity，@Configuration/@Component → config。
 *
 * 复用策略：tree-sitter 解析走 ts_kernel 的 parseAstRoot 既有先例
 *   （rename_symbol 已证明可读 Java 的 package_declaration / class_declaration）；
 *   注解从 class 的 modifiers 子树提取（本工具新增）。
 * 落盘：本工具只产出"分层计划 + 每层目标包"，真实落盘由调用方接入
 *   runRefactorPipeline 的 package_migration 步骤 / 或仅预览。工具本身零副作用。
 *
 * 本文件为纯计算 + 只读分析层，不写盘（dry_run 预览语义天然满足）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseAstRoot } from './ts_kernel/index.js';
import type { SyntaxNodeLike } from './ts_kernel/index.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 单层归属汇总（供渲染 / 契约） */
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
  /** 推断的项目根包（未显式给 target_base_package 时推断） */
  base_package: string;
  limitations: string[];
}

export interface SpringLayeringInput {
  project_dir: string;
  /** 可选：目标根包；缺省从现有包推断共同前缀 */
  target_base_package?: string;
  /** 自定义注解→层映射（注解名小写 → 层 id），缺省内置 Spring 映射 */
  annotation_layers?: Record<string, string>;
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

/** 递归收集项目内 .java 文件（相对 project_dir 的正斜杠路径；跳过噪音目录） */
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

/** 取注解节点名（@RestController → RestController；@GetMapping("/x") → GetMapping；scoped 取末段） */
function annotationName(n: SyntaxNodeLike): string | undefined {
  for (let i = 0; i < n.childCount; i++) {
    const c = n.child(i);
    if (!c) continue;
    if (c.type === 'identifier') return c.text;
    if (c.type === 'scoped_identifier') {
      // com.example.Foo → Foo（末段）
      const segments = c.text.split('.');
      return segments[segments.length - 1];
    }
  }
  return undefined;
}

/** 从 modifiers 子树收集注解名（marker_annotation=@X / annotation=@X(...)） */
function collectAnnotations(n: SyntaxNodeLike): string[] {
  const out: string[] = [];
  const walk = (node: SyntaxNodeLike): void => {
    const t = node.type;
    if (t === 'marker_annotation' || t === 'annotation') {
      const name = annotationName(node);
      if (name) out.push(name);
      return; // 注解内部不进
    }
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c) walk(c);
    }
  };
  walk(n);
  return out;
}

/** 取 package 声明文本（com.example.foo） */
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
    if (c.type === 'identifier') return c.text; // 类名
  }
  return '';
}

/**
 * 解析单个 Java 文件 → 类型清单（pkg + 类型名 + 注解）。
 * 顶层类型（class/interface/enum/record）都识别；注解取类型声明前的 modifiers 子树。
 */
function extractJavaTypes(root: SyntaxNodeLike | undefined, rel: string): Array<{ pkg: string; type: string; annotations: string[] }> {
  const out: Array<{ pkg: string; type: string; annotations: string[] }> = [];
  if (!root) return out;
  let pkg = '';
  const walk = (n: SyntaxNodeLike): void => {
    const t = n.type;
    if (t === 'package_declaration') {
      pkg = packageNameFrom(n);
      return; // package 不进子节点
    }
    if (t === 'class_declaration' || t === 'interface_declaration' || t === 'enum_declaration' || t === 'record_declaration') {
      const name = typeNameFrom(n);
      // 注解来自该类型声明的 modifiers 子树（第一个 child 之一）
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

/** 注解名 → 层 id（小写匹配；无命中 → other） */
export function layerForType(annotations: string[], map: Record<string, string>): string {
  for (const a of annotations) {
    const hit = map[a.toLowerCase()];
    if (hit) return hit;
  }
  return 'other';
}

/** 推断项目根包：所有包名的最长共同前缀 */
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
// 主流程（只读分析；零副作用）
// ─────────────────────────────────────────────

export async function planSpringLayering(input: SpringLayeringInput): Promise<SpringLayeringPlan> {
  const proj = path.resolve(input.project_dir);
  const map = input.annotation_layers ?? DEFAULT_ANNOTATION_LAYERS;
  const limitations: string[] = [];

  const files = collectJavaFiles(proj);
  if (files.length === 0) limitations.push(`在 ${input.project_dir} 未发现 .java 文件`);

  // 每文件 → { layer, pkg, annotations }（文件内多顶层类型取首 layers，冲突取首个已归层）
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
    const types = extractJavaTypes(root?.root, rel);
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

  const basePackage =
    (input.target_base_package ?? '').trim() || inferBasePackage([...pkgSet].filter(Boolean));
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
// 文本渲染 + MCP handler
// ─────────────────────────────────────────────

/** 渲染分层计划为可读文本（dry_run 预览）；若给了目标包，追加每层目标包规划 */
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