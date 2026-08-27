/**
 * features：语言特性契约差检测（版本升级 · 阶段 B）—— 通用内核
 *
 * 老项目"契约对不上"的第一层：代码里用了哪些"语言特性"，各自要求最低什么版本。
 * 本模块按行扫描源码，命中特性注册表中的语法模式，标注该特性所需的引入版本；
 * 与"目标版本边界"对比后，可判断哪些是"超标需重写"（特性引入版本 > 目标版本）。
 *
 * 语言无关：特性规则表不再硬编码在本文件，而是从各语言适配器（adapters/*）取。
 * 规则形如 { name, tool, since, pattern, rewrite }，见 adapters/types.ts 的 FeatureRule。
 *
 * 定位：这是"报告差异候选清单"，供人工/LLM 做局部重写决策，不是自动改写。
 * 因此采用确定性正则（保守、可解释），误报作为候选可被裁决门过滤。
 */

import { adapterForExt } from './adapters/registry.js';
import type { FeatureRule } from './adapters/types.js';

export type { FeatureRule } from './adapters/types.js';
export { JDK_FEATURES } from './adapters/java.js';
export { GO_FEATURES } from './adapters/go.js';
export { NODE_FEATURES } from './adapters/node.js';
export { PY_FEATURES } from './adapters/python.js';

/** 文件扩展名 → 特性规则集（来自适配器注册表） */
export function rulesForExt(ext: string): FeatureRule[] {
  return adapterForExt(ext)?.featureRules ?? [];
}

/** 命中记录 */
export interface FeatureHit {
  file: string; // 相对 root 的路径
  line: number; // 1-based
  feature: string;
  tool: string;
  since: number; // 该特性引入版本
  rewrite: string;
  snippet: string; // 命中行文本（trim）
}

export interface SourceFile {
  path: string; // 相对路径（用于报告）
  content: string;
}

/**
 * 扫描源码中的语言特性。
 * @param files      源码文件列表
 * @param minVersion 目标版本边界：只报告 since > minVersion 的特性（超出目标=需重写）
 *                   —— 不传或 -1 时报告全部命中。
 */
export function scanFeatureHits(files: SourceFile[], minVersion: number): FeatureHit[] {
  const hits: FeatureHit[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    const rules = rulesForExt(extOf(f.path));
    if (rules.length === 0) continue;
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!lineText) continue;
      for (const rule of rules) {
        if (minVersion >= 0 && rule.since <= minVersion) continue; // 边界内，不超标
        if (!rule.pattern.test(lineText)) continue;
        const key = `${f.path}:${i + 1}:${rule.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          file: f.path,
          line: i + 1,
          feature: rule.name,
          tool: rule.tool,
          since: rule.since,
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
