/**
 * features：语言特性契约差检测（版本升级 · 阶段 B）
 *
 * 老项目"契约对不上"的第一层：代码里用了哪些"语言特性"，各自要求最低什么版本。
 * 本模块按行扫描源码，命中特性注册表中的语法模式，标注该特性所需的引入版本；
 * 与"目标版本边界"对比后，可判断哪些是"超标需重写"（特性引入版本 > 目标版本）。
 *
 * 覆盖语言与特性（首版聚焦，规则可扩展）：
 *   - Java/JDK：var 局部变量(10)、switch 表达式/箭头 case(14)、文本块(15)、record(16)、
 *     instanceof 模式匹配(16)、sealed 密封类(17)
 *   - Go：泛型函数(1.18)
 *   - Node/TS：可选链(14)、空值合并(14)、String.replaceAll(15)
 *
 * 定位：这是"报告差异候选清单"，供人工/LLM 做局部重写决策，不是自动改写。
 * 因此采用确定性正则（保守、可解释），误报作为候选可被裁决门过滤。
 */

import type { ToolName } from './toolchain.js';

/** 语言特性规则 */
export interface FeatureRule {
  name: string; // 特性名（如 "var 局部变量"）
  tool: ToolName; // 所属语言
  since: number; // 引入版本（JDK 主版本 / Go 1.x 的 x / Node 主版本）
  pattern: RegExp; // 语法模式（勿用 g 标志，避免 lastIndex 状态）
  rewrite: string; // 若需降级/重写时的一句话建议
}

export const JDK_FEATURES: FeatureRule[] = [
  { name: 'var 局部变量', tool: 'java', since: 10, pattern: /\bvar\s+\w+\s*=/, rewrite: '改为显式类型（如 List<String>）' },
  { name: 'switch 表达式 / 箭头 case', tool: 'java', since: 14, pattern: /case\s+[^:]+->/, rewrite: '改回传统 switch 语句（case x: ... break;）或 if-else' },
  { name: '文本块', tool: 'java', since: 15, pattern: /"""/, rewrite: '改为普通字符串 + 显式 \n 拼接' },
  { name: 'instanceof 模式匹配', tool: 'java', since: 16, pattern: /\binstanceof\s+\w+(?:\.\w+)*\s+\w+/, rewrite: '改回 instanceof 判断 + 显式强转' },
  { name: 'record 记录类', tool: 'java', since: 16, pattern: /\brecord\s+\w+\s*\(/, rewrite: '改为普通类（final 字段 + 构造器 + getter + equals/hashCode/toString）' },
  { name: 'sealed 密封类', tool: 'java', since: 17, pattern: /\bsealed\s+(?:non-sealed\s+)?(?:class|interface)/, rewrite: '去掉 sealed，改回普通 class/interface' },
];

export const GO_FEATURES: FeatureRule[] = [
  { name: '泛型函数（类型参数）', tool: 'go', since: 18, pattern: /\bfunc\s+[A-Za-z_]\w*\[/, rewrite: '改为 interface{} + 类型断言，或按类型拆多个函数' },
];

export const NODE_FEATURES: FeatureRule[] = [
  { name: '可选链 ?.', tool: 'node', since: 14, pattern: /\?\./, rewrite: '改为逐级判空（a && a.b）' },
  { name: '空值合并 ??', tool: 'node', since: 14, pattern: /\?\?/, rewrite: '改回 || 或显式判空' },
  { name: 'String.replaceAll', tool: 'node', since: 15, pattern: /\.replaceAll\(/, rewrite: '改回 .replace(/g 正则/)' },
];

/** 文件扩展名 → 特性规则集 */
export function rulesForExt(ext: string): FeatureRule[] {
  if (ext === '.java') return JDK_FEATURES;
  if (ext === '.go') return GO_FEATURES;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return NODE_FEATURES;
  return [];
}

/** 命中记录 */
export interface FeatureHit {
  file: string; // 相对 root 的路径
  line: number; // 1-based
  feature: string;
  tool: ToolName;
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
