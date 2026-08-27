/**
 * gate：静态闸 + 动态闸（编译级 / 运行级契约差验证）—— 通用内核
 *
 * 语言特性/废弃 API 检测（阶段 B/C）是"正则扫描候选"；两道闸更进一步：
 *   - 静态闸：用各语言的**编译级校验**按声明版本对源码做逐文件验证，直接暴露"编译会失败"的硬契约差。
 *   - 动态闸：用各语言的**运行时探针**真跑源码，暴露"编译能过但一跑就炸"的运行层契约差。
 *
 * 能力依语言而不同（由各适配器 staticGate / dynamicGate 决定）：
 *   - Python：静态闸 ast.parse(feature_version)；动态闸 python 执行捕获运行时异常
 *   - Java：静态闸 javac --release N；动态闸 javac + java 运行自包含 main 类
 *   - Go / Node：无单文件按版本编译手段，静态闸降级为"项目级构建验证"（见 verifyCommands）；动态闸暂未实现
 *
 * 只报告，不阻断——结果作为候选清单，与阶段 B/C 一同供人工/LLM 裁决。
 */

import path from 'node:path';
import { adapterForLang } from './adapters/registry.js';
import type { DynamicGateItem, StaticGateItem, ToolName } from './adapters/types.js';
import { filesForDeclarations } from './detect.js';
import type { ToolchainDeclaration } from './toolchain.js';

/** 某声明的静态闸结果 */
export interface StaticGateResult {
  projectDir: string; // 相对 root
  tool: ToolName;
  label: string; // 语言展示名
  declaredVersion: string;
  boundary: number | null;
  /** 该语言是否具备静态闸能力（无则 items 为空，改由项目级构建验证） */
  available: boolean;
  items: StaticGateItem[];
}

/** 对全部声明跑静态闸（按子项目扫描，复用 detect 的边界装配） */
export function runStaticGates(root: string, declarations: ToolchainDeclaration[]): StaticGateResult[] {
  const out: StaticGateResult[] = [];
  for (const { declaration: d, boundary, files } of filesForDeclarations(root, declarations)) {
    const adapter = adapterForLang(d.tool);
    const label = adapter?.label ?? d.tool;
    if (!adapter?.staticGate) {
      out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary: null, available: false, items: [] });
      continue;
    }
    if (boundary == null) {
      out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary: null, available: true, items: [] });
      continue;
    }
    const dir = path.join(root, d.projectDir === '.' ? '' : d.projectDir);
    const items = adapter.staticGate(dir, boundary, files);
    out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary, available: true, items });
  }
  return out;
}

/** 某声明的动态闸结果 */
export interface DynamicGateResult {
  projectDir: string; // 相对 root
  tool: ToolName;
  label: string; // 语言展示名
  declaredVersion: string;
  boundary: number | null;
  /** 该语言是否具备动态闸能力（无则 items 为空，运行层契约差暂不可检） */
  available: boolean;
  items: DynamicGateItem[];
}

/** 对全部声明跑动态闸（与 runStaticGates 平行：复用同一套"声明→边界→文件"装配） */
export async function runDynamicGates(root: string, declarations: ToolchainDeclaration[]): Promise<DynamicGateResult[]> {
  const out: DynamicGateResult[] = [];
  for (const { declaration: d, boundary, files } of filesForDeclarations(root, declarations)) {
    const adapter = adapterForLang(d.tool);
    const label = adapter?.label ?? d.tool;
    if (!adapter?.dynamicGate) {
      out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary: null, available: false, items: [] });
      continue;
    }
    if (boundary == null) {
      out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary: null, available: true, items: [] });
      continue;
    }
    const dir = path.join(root, d.projectDir === '.' ? '' : d.projectDir);
    const items = await adapter.dynamicGate(dir, boundary, files);
    out.push({ projectDir: d.projectDir, tool: d.tool, label, declaredVersion: d.declaredVersion, boundary, available: true, items });
  }
  return out;
}
