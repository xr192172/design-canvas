/**
 * gate：静态闸（编译级契约差验证）—— 通用内核
 *
 * 语言特性/废弃 API 检测（阶段 B/C）是"正则扫描候选"；静态闸更进一步：
 * 用各语言的**编译级校验**按声明版本对源码做逐文件验证，直接暴露"编译会失败"的硬契约差。
 *
 * 能力依语言而不同（由各适配器 staticGate 决定）：
 *   - Python：ast.parse(feature_version=(3, boundary)) —— 无需编译器，精确按目标版本语法校验
 *   - Java：javac --release N 单文件编译（仅限自包含文件）
 *   - Go / Node：无单文件按版本编译手段，静态闸降级为"项目级构建验证"（见 verifyCommands）
 *
 * 只报告，不阻断——结果作为候选清单，与阶段 B/C 一同供人工/LLM 裁决。
 */

import path from 'node:path';
import { adapterForLang } from './adapters/registry.js';
import type { StaticGateItem, ToolName } from './adapters/types.js';
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
