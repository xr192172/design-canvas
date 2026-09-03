/**
 * java_refactor/executor —— 装配 Java 语言重构执行器（收敛 spring_mvc_layering 等 Java 专属能力）
 *
 * 收敛动机（用户洞悉）：spring_mvc_layering 不是独立 MCP 工具，而是 Java 语言包内的
 * 中间能力。随 refactor 线在 Java 项目被探明时自动拾取，Agent 不必单独 list。
 * 仿 python_refactor：声明 isSourceFile=.java + stages，注册进 DEFAULT_LANGS 即可被
 * runRefactorPipeline 按项目探测命中，落盘/验证/回滚由管线统一负责。
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  LanguageRefactorExecutor,
  RefactorStageComputeArgs,
  RunningChangePlan,
  RefactorStageExecutor,
} from '../tools/refactor_langs.js';
import type { VerifyCommand } from '../tools/verify_refactor.js';
import { buildSpringMvcLayeringPlan, collectJavaFiles } from './layering.js';

/** spring_mvc_layering 步骤 compute：纯计算（不落盘），产出迁移计划；落盘/验证/回滚交管线。 */
export async function computeSpringMvcLayeringPlan(args: RefactorStageComputeArgs): Promise<RunningChangePlan> {
  const proj = path.resolve(args.project_dir);
  const target = (args as unknown as { annotate?: Record<string, unknown> }).annotate as Record<string, unknown> | undefined;
  const targetBase = typeof target?.target_base_package === 'string' ? (target.target_base_package as string) : undefined;
  const annotationLayers = target?.annotation_layers as Record<string, string> | undefined;
  const { run } = await buildSpringMvcLayeringPlan(proj, {
    project_dir: proj,
    target_base_package: targetBase,
    annotation_layers: annotationLayers,
  });
  return run;
}

/** 构建 spring_mvc_layering 阶段（便于单测 / 复用） */
export function buildSpringMvcStage(): RefactorStageExecutor {
  return {
    kind: 'spring_mvc_layering',
    label: '[java] 按 Spring MVC 分层迁移',
    compute: computeSpringMvcLayeringPlan,
    limitations: [
      '按类型级注解（@Controller/@Service/@Repository/@Entity/@Configuration）把类迁移到 <base>.<layer> 包',
      '改本文件 package 声明 + 全项目 import FQN（Java 全限定单类 import，非 moduleBase 前缀语义）',
      '物理移动文件到目标包目录；同包裸引用（原免 import）自动补 `import <newPkg>.<T>;`，已 import 的走 FQN 改写',
      '编译验证仍是权威兜底：行内限定引用/重名歧义等边界由 mvn 编译失败回滚如实兜住',
      '撞名（目标文件已存在）/ 无 root 包时跳过该层并如实报告',
    ],
  };
}

/** 依项目形态探测 Java 验证命令（权威编译兜底；无构建文件 → 空 = 不可自动验证） */
export function javaVerifyCommands(cwd: string): VerifyCommand[] {
  if (fs.existsSync(path.join(cwd, 'pom.xml'))) {
    return [{ label: 'maven compile', cmd: 'mvn', args: ['-q', 'compile'], timeoutMs: 600_000 }];
  }
  if (fs.existsSync(path.join(cwd, 'build.gradle')) || fs.existsSync(path.join(cwd, 'build.gradle.kts'))) {
    const gradle = fs.existsSync(path.join(cwd, 'gradlew'))
      ? path.join(cwd, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')
      : 'gradle';
    return [{ label: 'gradle compile', cmd: gradle, args: ['compileJava'], timeoutMs: 600_000 }];
  }
  return [];
}

/** Java 语言执行器：命中 .java 即入选，暴露 spring_mvc_layering 步骤 */
export const javaExecutor: LanguageRefactorExecutor = {
  lang: 'java',
  isSourceFile: (rel) => rel.endsWith('.java'),
  detectVerifyCommands: javaVerifyCommands,
  stages: [buildSpringMvcStage()],
  manifestFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
  manifestPriority: 60,
};

/** 供探测/测试：目录内是否含 Java 源文件 */
export function dirHasJava(cwd: string): boolean {
  return collectJavaFiles(cwd).length > 0;
}