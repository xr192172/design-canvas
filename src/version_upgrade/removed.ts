/**
 * removed：废弃/移除 API 检测（版本升级契约差检测 · 阶段 C）
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
 * 规则表为确定性正则（保守、可解释），命中作为候选清单供人工/LLM 裁决。
 */

import type { ToolName } from './toolchain.js';

/** 命中类型：硬性移除 / 软性废弃 */
export type DeprecationKind = 'removed' | 'deprecated';

/** 废弃/移除 API 规则 */
export interface RemovedRule {
  name: string; // API 名（如 "JAXB（javax.xml.bind）"）
  tool: ToolName;
  since: number; // 从该版本起被移除/废弃（JDK/Node 主版本，Go 取 1.x 的 x）
  kind: DeprecationKind;
  pattern: RegExp; // 匹配 import 或使用处的引用（勿用 g 标志）
  rewrite: string; // 替代/重写建议
}

export const JDK_REMOVED: RemovedRule[] = [
  { name: 'JAXB（javax.xml.bind）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.xml\.bind\b/, rewrite: 'JDK 11 起不再内置：引入 jakarta.xml.bind 依赖，或改用 JAXP / Jackson XML' },
  { name: 'JAX-WS（javax.xml.ws）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.xml\.ws\b/, rewrite: 'JDK 11 起不再内置：改用 Spring Web Services 或 REST 接口' },
  { name: 'JAF（javax.activation）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.activation\b/, rewrite: 'JDK 11 起不再内置：引入 jakarta.activation 依赖' },
  { name: '公共注解（javax.annotation）', tool: 'java', since: 11, kind: 'removed', pattern: /\bjavax\.annotation(?!\.processing)\b/, rewrite: 'JDK 11 起不再内置（javax.annotation.processing 仍保留）：引入 jakarta.annotation 依赖' },
  { name: 'CORBA（javax.rmi / org.omg）', tool: 'java', since: 11, kind: 'removed', pattern: /\b(?:javax\.rmi|org\.omg\.)/, rewrite: 'JDK 11 起移除 CORBA：换用 RMI-over-HTTP 或 gRPC' },
  { name: 'Observer / Observable', tool: 'java', since: 9, kind: 'deprecated', pattern: /\bjava\.util\.(?:Observable|Observer)\b/, rewrite: '改用事件/回调机制（PropertyChangeListener 或发布订阅）' },
  { name: 'SecurityManager', tool: 'java', since: 17, kind: 'deprecated', pattern: /\bjava\.lang\.SecurityManager\b/, rewrite: 'JDK 17 起标记废弃（未来移除）：改用 JVM 沙箱 / 容器隔离' },
];

export const GO_REMOVED: RemovedRule[] = [
  { name: 'io/ioutil', tool: 'go', since: 16, kind: 'deprecated', pattern: /\bio\/ioutil\b/, rewrite: 'Go 1.16 起废弃：os.ReadFile/WriteFile/ReadDir + io.ReadAll 替代' },
  { name: 'math/rand.Seed', tool: 'go', since: 20, kind: 'deprecated', pattern: /\brand\.Seed\s*\(/, rewrite: 'Go 1.20 起废弃：改用 math/rand/v2，无需手动 Seed' },
];

export const NODE_REMOVED: RemovedRule[] = [
  { name: 'new Buffer(...)', tool: 'node', since: 6, kind: 'deprecated', pattern: /\bnew\s+Buffer\s*\(/, rewrite: '改用 Buffer.from(...) / Buffer.alloc(...)' },
  { name: 'crypto.createCipher', tool: 'node', since: 10, kind: 'deprecated', pattern: /\b(?:crypto\.)?createCipher\s*\(/, rewrite: '改用 crypto.createCipheriv()（显式指定 IV）' },
  { name: 'url.parse（legacy URL）', tool: 'node', since: 11, kind: 'deprecated', pattern: /\burl\.parse\s*\(/, rewrite: '改用 new URL()（WHATWG URL）' },
];

/** 文件扩展名 → 规则集 */
export function removedRulesForExt(ext: string): RemovedRule[] {
  if (ext === '.java') return JDK_REMOVED;
  if (ext === '.go') return GO_REMOVED;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return NODE_REMOVED;
  return [];
}

/** 命中记录 */
export interface RemovedHit {
  file: string; // 相对 root 的路径
  line: number; // 1-based
  api: string;
  tool: ToolName;
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
 * @param declaredVersion 子项目声明的版本边界（JDK 主版本 / Go 1.x 的 x / Node 主版本）；
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
