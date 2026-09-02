/**
 * adapters/csharp —— C#/.NET 语言适配器
 *
 * 方言要点：
 *   - 声明文件：global.json（SDK version，精确名匹配）、Directory.Build.props / Directory.Build.targets
 *     （<LangVersion> 是 C# 语言版本号，直接作特性边界；<TargetFramework>net8.0 → 8）
 *   - 版本边界：C# 语言主版本（9/10/11/12…；net8.0 实际对应 C#12，但这里按 LangVersion 直取最准）
 *   - 静态/动态闸：无单文件编译级校验（依赖 dotnet build 项目级验证，verifyCommands 占位）
 *   - 探测：dotnet --version（SDK 版本；仅作"装了没"信号，边界判定以声明 LangVersion 为准）
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

// ── 规则表（按 C# 语言版本边界） ──────────────────────────────

export const CSHARP_FEATURES: FeatureRule[] = [
  { name: 'switch 表达式（值 switch 形式）', tool: 'csharp', since: 8, pattern: /\w+\s+switch\s*\{/, rewrite: '改回传统 switch 语句（case x: … break;）' },
  { name: 'record 记录类', tool: 'csharp', since: 9, pattern: /\brecord\s+(?:class\s+)?\w+\s*\(/, rewrite: '改回普通 class（属性 + 构造器 + 相等性）' },
  { name: 'init 访问器', tool: 'csharp', since: 9, pattern: /\binit\s*;/, rewrite: '改用 set 访问器（或在构造器中赋值）' },
  { name: '文件作用域命名空间', tool: 'csharp', since: 10, pattern: /^\s*namespace\s+[\w.]+\s*;/m, rewrite: '改回块作用域命名空间 namespace X { … }' },
  { name: 'required 成员', tool: 'csharp', since: 11, pattern: /\brequired\s+\w+\s/, rewrite: '去掉 required，改由构造器/初始化器保证必填' },
  { name: '主构造函数', tool: 'csharp', since: 12, pattern: /class\s+\w+\s*\([^)]*\)\s*[;{]/, rewrite: '改回显式构造器 + 字段' },
];

export const CSHARP_REMOVED: RemovedRule[] = [
  { name: 'BinaryFormatter', tool: 'csharp', since: 8, kind: 'deprecated', pattern: /\bBinaryFormatter\b/, rewrite: '改用 System.Text.Json 等安全序列化（BinaryFormatter 有反序列化漏洞）' },
  { name: 'Hashtable / ArrayList（非泛型集合）', tool: 'csharp', since: 8, kind: 'deprecated', pattern: /\b(?:Hashtable|ArrayList)\b/, rewrite: '改用泛型 Dictionary<TKey,TValue> / List<T>' },
];

// ── 声明解析 ───────────────────────────────────────────────────

function parseLangVersion(content: string): { version: string; raw: string } | null {
  // <LangVersion>12</LangVersion>（C# 语言版本直取）→ 否则 TargetFramework net8.0 → 8
  const lvTok = content.match(/<LangVersion>\s*(\d+)\s*<\/LangVersion>/);
  if (lvTok) return { version: lvTok[1], raw: `<LangVersion>${lvTok[1]}` };
  const tf = content.match(/<TargetFramework>\s*net(\d+)(?:\.\d+)?\s*<\/TargetFramework>/);
  if (tf) return { version: tf[1], raw: `<TargetFramework>net${tf[1]}` };
  return null;
}

function parseGlobalJson(content: string): { version: string; raw: string } | null {
  const m = content.match(/"version"\s*:\s*"(\d+\.\d+)(?:\.\d+)?"/);
  if (!m) return null;
  return { version: m[1], raw: `"version": "${m[1]}"` };
}

// ── 适配器对象 ────────────────────────────────────────────────

export const csharpAdapter: LanguageAdapter = {
  lang: 'csharp',
  label: '.NET',
  declarationFiles: ['global.json', 'Directory.Build.props', 'Directory.Build.targets'],
  sourceExts: ['.cs'],
  skipDirs: ['bin', 'obj'],
  asdfToolNames: ['dotnet'],
  featureRules: CSHARP_FEATURES,
  removedRules: CSHARP_REMOVED,
  probe: {
    cmd: 'dotnet',
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
    const emit = (r: { version: string; raw: string } | null): AdapterDeclaration[] =>
      r ? [{ projectDir: path.dirname(abs), source: name, declaredVersion: r.version, raw: r.raw }] : [];
    if (name === 'global.json') return emit(parseGlobalJson(content));
    return emit(parseLangVersion(content));
  },

  parseVersion(v: string): VersionInfo | null {
    const s = String(v).trim().replace(/^net/, '');
    const m = s.match(/^(\d+)/);
    return m ? { major: parseInt(m[1], 10) } : null;
  },

  featureBoundary(info: VersionInfo): number {
    return info.major;
  },

  versionSatisfies(declared: string, local: string): boolean {
    const d = this.parseVersion(declared);
    const l = this.parseVersion(local);
    if (!d || !l) return false;
    return l.major >= d.major;
  },

  verifyCommands(_dir: string): VerifyCommand[] {
    return [];
  },
};