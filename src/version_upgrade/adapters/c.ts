/**
 * adapters/c —— C 语言适配器
 *
 * 方言要点：
 *   - "版本" = C 语言标准（c89/c99/c11/c17/c23），由编译器 flag `-std=cXX` 声明：
 *     Makefile/CMakeLists.txt/configure.ac，或 CMake `CMAKE_C_STANDARD` 整数。
 *   - 版本边界：标准号（99/11/17/23…；c89 → 89）
 *   - 特性规则按标准号；探测取本机 cc 版本作为"装了没"信号（标准判定以声明为准）
 *   - 静态/动态闸：无（依赖编译命令项目级验证，verifyCommands 占位）
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  LanguageAdapter,
  AdapterDeclaration,
  VersionInfo,
  FeatureRule,
  RemovedRule,
} from './types.js';
import type { VerifyCommand } from '../../tools/verify_refactor.js';

// ── 规则表（按 C 标准号边界） ──────────────────────────────

export const C_FEATURES: FeatureRule[] = [
  { name: '_Generic 泛型选择', tool: 'c', since: 11, pattern: /\b_Generic\s*\(/, rewrite: 'C11 起支持：改用宏重载或类型标签技法' },
  { name: '_Static_assert 静态断言', tool: 'c', since: 11, pattern: /\b_Static_assert\s*\(/, rewrite: 'C11 起支持：改用运行时 assert 或条件编译' },
  { name: 'alignof/_Alignas 对齐', tool: 'c', since: 11, pattern: /\b(?:alignof|_Alignas|_Alignof)\s*\(/, rewrite: 'C11 起支持：改用编译器特定对齐宏' },
  { name: 'nullptr 关键字', tool: 'c', since: 23, pattern: /\bnullptr\b/, rewrite: 'C23 起支持：改回 NULL 宏' },
  { name: '二进制字面量 0b', tool: 'c', since: 23, pattern: /\b0[bB][01]/, rewrite: 'C23 起支持：改回 0x 十六进制或十进制' },
];

export const C_REMOVED: RemovedRule[] = [
  { name: 'gets（已被移除）', tool: 'c', since: 11, kind: 'removed', pattern: /\bgets\s*\(/, rewrite: 'C11 起被移除：改用 fgets(buf, size, stdin)' },
  { name: 'K&R 旧式函数定义', tool: 'c', since: 23, kind: 'deprecated', pattern: /^\s*\w[\w\s]*\b\w+\s*\(\s*\w+\s*\)\s*\n\s*\{/m, rewrite: '改用带参数表的现代函数原型' },
];

// ── 声明解析 ───────────────────────────────────────────────────

/** 从 Makefile/CMakeLists/configure 中找 `-std=cXX` 或 `CMAKE_C_STANDARD N` 或 `std=c++XX`（排除 C++） */
function parseStd(content: string): { version: string; raw: string } | null {
  const cc = content.match(/(?:^|[\s=:])-?std=c(g?nu)?(\d{2,4})(?:\s|$)/);
  if (cc) return { version: cc[2], raw: `-std=c${cc[2]}` };
  const cmake = content.match(/CMAKE_C_STANDARD\s+(\d{2,4})/);
  if (cmake) return { version: cmake[1], raw: `CMAKE_C_STANDARD ${cmake[1]}` };
  return null;
}

// ── 适配器对象 ────────────────────────────────────────────────

export const cAdapter: LanguageAdapter = {
  lang: 'c',
  label: 'C',
  declarationFiles: ['Makefile', 'CMakeLists.txt', 'configure.ac'],
  sourceExts: ['.c', '.h'],
  skipDirs: ['build', '.deps'],
  featureRules: C_FEATURES,
  removedRules: C_REMOVED,
  probe: {
    cmd: 'cc',
    args: ['--version'],
    parse: (out) => out.trim().split(/\r?\n/)[0]?.trim() || null,
  },

  parseDeclarationFile(abs: string): AdapterDeclaration[] {
    const name = path.basename(abs);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      return [];
    }
    const r = parseStd(content);
    return r ? [{ projectDir: path.dirname(abs), source: name, declaredVersion: r.version, raw: r.raw }] : [];
  },

  parseVersion(v: string): VersionInfo | null {
    // '99'/'11'/'17'/'23' → major=标准号；也兼容 'c11' 原始输入
    const s = String(v).toLowerCase().replace(/^c/, '').replace(/^gnu/, '');
    const m = s.match(/^(\d{2,4})/);
    return m ? { major: parseInt(m[1], 10) } : null;
  },

  featureBoundary(info: VersionInfo): number {
    return info.major;
  },

  versionSatisfies(declared: string, local: string): boolean {
    // 本机没有标准号可比（cc 版本 ≠ C 标准），保守：声明可满足则 true；解析不出按 false
    const d = this.parseVersion(declared);
    if (!d) return false;
    // 不尝试用编译器版本冒充标准版本——有明确的声明即视为可支持（本机编译可用性由项目级构建验证）
    return true;
  },

  verifyCommands(_dir: string): VerifyCommand[] {
    return [];
  },
};