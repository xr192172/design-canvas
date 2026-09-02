/**
 * removed：废弃/移除 API 检测（版本升级契约差检测 · 阶段 C）—— 通用内核
 *
 * 语言特性（阶段 B）检测"语法用得太新"；这里检测另一类契约差：
 * 源码引用了"某个版本起被移除 / 被废弃"的 API。
 *   - removed    移除：目标版本已不再提供该 API（如 JDK 11 起不再内置 JAXB）
 *                 → 不补依赖/不重写则编译运行必失败，属硬性契约差
 *   - deprecated 废弃：目标版本仍可用但官方标记废弃 → 建议重写，非必须
 *
 * 判定：以子项目声明版本为边界。规则 since 表示"从该版本起被移除/废弃"，
 * 当 声明版本 >= since 时命中（目标版本已经出问题）。
 * 注意与阶段 B 方向相反：B 是 since > 声明才超标；这里是 since <= 声明才命中。
 *
 * 语言无关：规则表来自各语言适配器（adapters/*），见 adapters/types.ts 的 RemovedRule。
 * 规则表为确定性正则（保守、可解释），命中作为候选清单供人工/LLM 裁决。
 */

import { adapterForExt } from './adapters/registry.js';
import type { DeprecationKind, RemovedRule } from './adapters/types.js';

export type { RemovedRule, DeprecationKind } from './adapters/types.js';
export { JDK_REMOVED } from './adapters/java.js';
export { GO_REMOVED } from './adapters/go.js';
export { NODE_REMOVED } from './adapters/node.js';
export { PY_REMOVED } from './adapters/python.js';

/** 文件扩展名 → 规则集（来自适配器注册表） */
export function removedRulesForExt(ext: string): RemovedRule[] {
  return adapterForExt(ext)?.removedRules ?? [];
}

/** 命中记录 */
export interface RemovedHit {
  file: string; // 相对 root 的路径
  line: number; // 1-based
  api: string;
  tool: string;
  since: number; // 从该版本起被移除/废弃
  kind: DeprecationKind;
  rewrite: string;
  snippet: string; // 命中行文本（trim）
}

export interface SourceFile {
  path: string;
  content: string;
}

/**
 * 扫描源码中的废弃/移除 API。
 * @param files          源码文件列表
 * @param declaredVersion 子项目声明的版本边界（见适配器 featureBoundary）；
 *                        声明版本 >= 规则 since 时命中。
 */
export function scanRemovedApis(files: SourceFile[], declaredVersion: number): RemovedHit[] {
  const hits: RemovedHit[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const rules = removedRulesForExt(extOf(f.path));
    if (rules.length === 0) continue;
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!lineText) continue;
      for (const rule of rules) {
        if (declaredVersion < rule.since) continue; // 目标版本还没到移除/废弃版本 → 不报
        if (!rule.pattern.test(lineText)) continue;
        const key = `${f.path}:${i + 1}:${rule.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          file: f.path,
          line: i + 1,
          api: rule.name,
          tool: rule.tool,
          since: rule.since,
          kind: rule.kind,
          rewrite: rule.rewrite,
          snippet: lineText.trim().slice(0, 120),
        });
      }
    }
  }
  return hits;
}

function extOf(p: string): string {
  const idx = p.lastIndexOf('.');
  return idx < 0 ? '' : p.slice(idx).toLowerCase();
}
