/**
 * adapters/types —— 语言适配器契约（通用内核的可插拔"方言"）
 *
 * 版本升级契约差检测的核心是**语言无关**的编排（扫描声明 → 边界 → 扫契约差 →
 * 局部重写 → 验证闭环）。真正随语言变化的只有一小撮"方言"，全部收进 LanguageAdapter：
 *
 *   1. 声明文件格式        （Java: pom.xml/build.gradle；Node: .nvmrc/package.json；
 *                           Go: go.mod；Python: pyproject.toml/.python-version；共享 .tool-versions）
 *   2. 版本解析与比较规则   （Java/Node 主版本、Go 1.x 的 x、Python minor）
 *   3. 源码扩展名 + 特性/废弃 API 规则表（正则）
 *   4. 本机版本探测命令     （java -version / node -v / go version / python3 --version）
 *   5. 静态闸：按声明版本单文件编译级校验（Python: ast.parse(feature_version)；Java: javac --release）
 *   6. 项目级验证命令组     （go build/test、tsc、compileall、mvn…）
 *
 * 通用内核只认这个接口，不认识具体语言；新增语言 = 新增一个适配器 + 注册进 registry。
 */

import type { VerifyCommand } from '../../tools/verify_refactor.js';

/** 语言代号（新增语言在此扩展） */
export type ToolName = 'java' | 'node' | 'go' | 'python';

/** 解析后的版本结构 */
export interface VersionInfo {
  major: number;
  minor?: number;
}

/** 工具链声明：某个子项目需要的运行时版本 */
export interface AdapterDeclaration {
  projectDir: string; // 声明所在子项目目录（绝对路径；由内核归一化为相对 root）
  source: string; // 声明来源文件名（pom.xml / .nvmrc / go.mod / ...）
  declaredVersion: string; // 声明的版本原文（如 "1.8"、"18"、"1.21"、">=3.10"）
  raw: string; // 声明的原始证据行（供报告展示）
}

/** 待扫描的源码文件（path 为相对所在子项目） */
export interface SourceFile {
  path: string;
  content: string;
}

/** 语言特性规则（阶段 B）：用了超过声明版本的语言特性 = 契约对不上 */
export interface FeatureRule {
  name: string; // 特性名（如 "var 局部变量"）
  tool: ToolName; // 所属语言
  since: number; // 引入版本边界数值（JDK/Node 主版本、Go 1.x 的 x、Python minor）
  pattern: RegExp; // 语法模式（勿用 g 标志，避免 lastIndex 状态）
  rewrite: string; // 若需降级/重写时的一句话建议
}

/** 废弃/移除类型 */
export type DeprecationKind = 'removed' | 'deprecated';

/** 废弃/移除 API 规则（阶段 C）：目标版本已移除/废弃该 API = 另一类契约差 */
export interface RemovedRule {
  name: string; // API 名（如 "JAXB（javax.xml.bind）"）
  tool: ToolName;
  since: number; // 从该版本起被移除/废弃（边界数值同 FeatureRule）
  kind: DeprecationKind;
  pattern: RegExp; // 匹配 import 或使用处的引用（勿用 g 标志）
  rewrite: string; // 替代/重写建议
}

/** 静态闸单文件结果 */
export interface StaticGateItem {
  file: string; // 相对该子项目
  status: 'ok' | 'fail' | 'skipped';
  detail?: string; // fail/skipped 时的说明（编译错误摘要 / 无法隔离校验的原因）
}

/** 本机版本探测：命令 + 输出解析 */
export interface ProbeSpec {
  cmd: string;
  args: string[];
  parse: (stdout: string) => string | null;
}

/**
 * 语言适配器：通用内核认识语言的全部差异点。
 * 静态闸（staticGate）与项目级验证（verifyCommands）可选——不实现的语言按能力降级。
 */
export interface LanguageAdapter {
  /** 语言代号 */
  readonly lang: ToolName;
  /** 展示名（报告用），如 'JDK' / 'Node' / 'Go' / 'Python' */
  readonly label: string;
  /** 本语言关注的声明文件名（含共享的 .tool-versions 时按行筛自己） */
  readonly declarationFiles: string[];
  /** 本语言源码扩展名 */
  readonly sourceExts: string[];
  /** 额外跳过的目录（构建产物/依赖，并入内核默认集） */
  readonly skipDirs?: string[];
  /** .tool-versions 中本语言的工具别名（如 nodejs/node；Java 无别名则为空） */
  readonly asdfToolNames?: string[];
  /** 语言特性规则表 */
  readonly featureRules: FeatureRule[];
  /** 废弃/移除 API 规则表 */
  readonly removedRules: RemovedRule[];
  /** 本机版本探测 */
  readonly probe: ProbeSpec;

  /** 解析单个声明文件（abs 为绝对路径；projectDir 取所在目录） */
  parseDeclarationFile(abs: string): AdapterDeclaration[];
  /** 按本语言规则解析版本字符串 */
  parseVersion(v: string): VersionInfo | null;
  /** 特性边界数值：声明版本 → 边界（java major / go minor / node major / python minor） */
  featureBoundary(info: VersionInfo): number;
  /** 本机版本是否满足声明（declared=声明原文，local=本机版本原文） */
  versionSatisfies(declared: string, local: string): boolean;

  /** 静态闸：按声明版本对源码做单文件编译级校验（可选；不实现则无静态闸） */
  staticGate?(dir: string, boundary: number, files: SourceFile[]): StaticGateItem[];
  /** 项目级验证命令组（可选；返回空数组 = 该语言无项目级验证） */
  verifyCommands?(dir: string): VerifyCommand[];
}
