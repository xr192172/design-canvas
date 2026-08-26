/**
 * refactor_langs —— 多语言重构执行器契约（可插拔骨架的地基）
 *
 * 目标（用户洞见）：tree-sitter 是我们的共享解析根基（AST 解析是通用能力）；
 * 但每门语言"修正屎山"的改造路径（检测规则、改写规则、验证命令）各不相同——
 * 新语言就开发新的路径（一个 LanguageRefactorExecutor），注册进注册表即可被
 * 管线拾取，无需改动管线主流程。
 *
 * 三层分工：
 *   1. 共享内核（不动）：tree-sitter AST / ts_kernel —— 各语言 GM 统一共用。
 *   2. 语言执行器（本文件契约）：一门语言一个 LanguageRefactorExecutor，
 *     内含自己的源码判定、验证命令、以及顺序的 steps（dead_imports 等）。
 *   3. 管线（refactor_pipeline）：按项目探测命中哪些语言（可能多门并存，
 *     如 TS+Go 混项目）→ 聚合它们的 stages → 统一"基线一次 + 每步一次改后
 *     验证 + 失败只回滚到最近绿点"。
 *
 * 本文件只放契约接口 + 注册表 + 目录语言命中探测，不 import refactor_pipeline
 * （避免循环依赖）；内置 TS/Go 执行器的装配（compute 依赖 pipeline 的既有
 * 纯计算函数）放在 refactor_pipeline.ts，经 DEFAULT_LANGS 注册。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { VerifyCommand } from './verify_refactor.js';

// ─────────────────────────────────────────────
// 步骤配置（与 runRefactorPipeline.steps 对齐，供执行器判定是否启用）
// ─────────────────────────────────────────────
export interface DeadImportsStepCfg {
  enabled?: boolean;
  dead?: Array<{ source: string; files: string[] }>;
}
export interface DeadStatementsStepCfg {
  enabled?: boolean;
  files?: string[];
}
/** 包/目录迁移（提级）步骤配置：把整棵目录树提升到父级，同时改 package 声明、
 * import 引用面、可选别名。详情见 package_migration.ts。 */
export interface PackageMigrationStepCfg {
  enabled?: boolean;
  migrate?: PackageMigrationSpec;
}
export interface RefactorStepsCfg {
  dead_imports?: DeadImportsStepCfg;
  dead_statements?: DeadStatementsStepCfg;
  package_migration?: PackageMigrationStepCfg;
}

// ─────────────────────────────────────────────
// 契约接口
// ─────────────────────────────────────────────
export type RefactorStageKind = 'dead_imports' | 'dead_statements' | 'package_migration';

/** 一次迁移参数：把 `project/<prefix>` 整棵树移动到 `project/<to>`，
 *  顶层源文件的 `package <packageRename.from>` → `package <packageRename.to>`，
 *  全项目源文件里所有 `"<moduleBase>/<prefix>…"` import 路径重写为 `"<moduleBase>/<to>…"`，
 *  并按 aliases 清洗 import 别名（碰撞敏感，逐个文件守卫）。 */
export interface PackageMigrationSpec {
  /** 模块根，如 'github.com/acme/widget/server'（配合 prefix 拼出被改写的 import 前缀） */
  moduleBase: string;
  /** 相对 project_dir 的被迁移目录（正斜杠），如 'internal/hub/v2' */
  prefix: string;
  /** 相对 project_dir 的目标目录，如 'internal/hub' */
  to: string;
  /** 顶层源文件 package 声明改名（应对 Go 的 package v2 → 父名）。
   *  仅作用于 `packageRenameDir`（缺省取 `to` 相对 project_dir 的物理目录）内的
   *  源文件；`from_test` 包自动改为 `to_test`。 */
  packageRename?: { from: string; to: string };
  /** package 改名作用的物理目录（相对 project_dir）。缺省 = to（即假设代码已/将
   *  放在要提级到的目录）。多 v2 并存（如 hub 与 hubclient）时用此各自限定。
   *  顶级源文件才改 package（子目录不碰），除非 packageRenameTopLevelOnly=false。 */
  packageRenameDir?: string;
  /** 源文件扩展名白名单（做内容改写：package 改名 + import 引用面 + 别名）；缺省 .go/.ts/.tsx… */
  sourceExts?: string[];
  /** import 别名清洗：importPath 为"重写后"的规范化路径，from 为现别名，to 为清洗目标名 */
  aliases?: Array<{ importPath: string; from: string; to: string }>;
  /** 移动时跳过的目录名（缺省：node_modules/.git/dist/.design-canvas/venv/__pycache__/target 等） */
  skipDirs?: string[];
  /** 顶层目录内是否只处理"直接位于 to 下的源文件"做 package 改名（缺省 true，子目录不碰） */
  packageRenameTopLevelOnly?: boolean;
}

/** 单个文件移动（from 绝对路径 → to 绝对路径） */
export interface FileMove {
  from: string;
  to: string;
}

export interface RunningChangePlan {
  /** 待落盘的"最终路径" → 新源码。若该文件参与了移动，key 是其 to（移动后路径） */
  absToNew: Map<string, string>;
  /** 预读的原始内容（apply 前盘上内容；回滚用）。key = 移动前/原始路径 */
  originals: Map<string, string>;
  /** 文件移动 from→to（先移动，再写 absToNew 内容） */
  moves?: FileMove[];
  /** 删除的单位数；缺省由管线按步骤退化 */
  units?: number;
}

export interface RefactorStageComputeArgs {
  project_dir: string;
  cwd: string;
  files?: string[];
  dead?: Array<{ source: string; files: string[] }>;
  migrate?: PackageMigrationSpec;
}

/** 单步执行器：纯计算，绝不落盘。落盘 + 验证 + 回滚全由管线负责。 */
export interface RefactorStageExecutor {
  kind: RefactorStageKind;
  /** 人类可读标题（报告展示；多语言同名步骤以语言前缀区分） */
  label: string;
  compute(args: RefactorStageComputeArgs): RunningChangePlan | Promise<RunningChangePlan>;
  /** 本步保守规则说明（写进报告 / 供人审） */
  limitations: string[];
}

/** 一门语言的完整执行器（"新语言新路径"） */
export interface LanguageRefactorExecutor {
  /** 语言 id，如 'ts_go' / 'py' / 'java'（注册唯一 key） */
  lang: string;
  /** 命中该语言源文件的扩展名判定 */
  isSourceFile(rel: string): boolean;
  /** 依该项目形态给验证命令组；空数组 = 不可自动验证 */
  detectVerifyCommands(cwd: string): VerifyCommand[];
  /** 该语言暴露的重构步骤（按声明顺序执行） */
  stages: RefactorStageExecutor[];
  /**
   * 该项目形态的 manifest 文件名（相对项目根，如 'package.json' / 'go.mod'）。
   * 用于"manifest 定主导工具链"：验证命令只从主导语言取，不逐语言合并。
   */
  manifestFiles?: string[];
  /** 多 manifest 并存时的主导优先级：数值越大越主导；缺省 0。 */
  manifestPriority?: number;
}

/** 判定项目根是否存在某 manifest 文件之一。 */
export function manifestPresent(cwd: string, files?: string[]): boolean {
  if (!files || files.length === 0) return false;
  const root = path.resolve(cwd);
  return files.some((f) => fs.existsSync(path.join(root, f)));
}

// ─────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────
const DEFAULT_SKIP = new Set([
  'node_modules', '.git', 'dist', '.next', 'out', 'build', 'target', // node/go/js/java
  'venv', '.venv', '__pycache__', // python
]);

/** 递归判定目录内是否存在命中该语言判定的源文件（含路径过滤，跳过噪音目录） */
export function dirHasSource(cwd: string, isSourceFile: (rel: string) => boolean): boolean {
  let stack = [path.resolve(cwd)];
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
        if (!DEFAULT_SKIP.has(ent.name)) stack.push(p);
        continue;
      }
      if (isSourceFile(path.relative(cwd, p))) return true;
    }
  }
  return false;
}

export class RefactorLangRegistry {
  private m = new Map<string, LanguageRefactorExecutor>();

  /** 注册一门语言的执行器（同 lang 覆盖） */
  register(ex: LanguageRefactorExecutor): void {
    this.m.set(ex.lang, ex);
  }

  get(lang: string): LanguageRefactorExecutor | undefined {
    return this.m.get(lang);
  }

  all(): LanguageRefactorExecutor[] {
    return [...this.m.values()];
  }

  /**
   * 按项目根探测命中哪些语言：目录内存在该语言源文件 → 入选。
   * 允许多语言并存（如 TS+Go 混项目）；空目录 / 无源码 → 空数组。
   */
  forProject(cwd: string): LanguageRefactorExecutor[] {
    return this.all().filter((ex) => dirHasSource(cwd, ex.isSourceFile));
  }
}