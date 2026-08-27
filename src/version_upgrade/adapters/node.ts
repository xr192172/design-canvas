/**
 * adapters/node —— Node.js 语言适配器
 *
 * 方言要点：
 *   - 声明文件：.nvmrc（内容即版本）、package.json（engines.node）、.tool-versions（nodejs/node 行）
 *   - 版本边界：Node 主版本
 *   - 静态闸：无单文件编译级校验（TS 依赖项目级 tsc；见 verifyCommands）
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

// ── 规则表（原 features.ts / removed.ts 的 Node 段） ──────────────

export const NODE_FEATURES: FeatureRule[] = [
  { name: '可选链 ?.', tool: 'node', since: 14, pattern: /\?\./, rewrite: '改为逐级判空（a && a.b）' },
  { name: '空值合并 ??', tool: 'node', since: 14, pattern: /\?\?/, rewrite: '改回 || 或显式判空' },
  { name: 'String.replaceAll', tool: 'node', since: 15, pattern: /\.replaceAll\(/, rewrite: '改回 .replace(/g 正则/)' },
];

export const NODE_REMOVED: RemovedRule[] = [
  { name: 'new Buffer(...)', tool: 'node', since: 6, kind: 'deprecated', pattern: /\bnew\s+Buffer\s*\(/, rewrite: '改用 Buffer.from(...) / Buffer.alloc(...)' },
  { name: 'crypto.createCipher', tool: 'node', since: 10, kind: 'deprecated', pattern: /\b(?:crypto\.)?createCipher\s*\(/, rewrite: '改用 crypto.createCipheriv()（显式指定 IV）' },
  { name: 'url.parse（legacy URL）', tool: 'node', since: 11, kind: 'deprecated', pattern: /\burl\.parse\s*\(/, rewrite: '改用 new URL()（WHATWG URL）' },
];

function parsePackageJson(content: string): { version: string; raw: string } | null {
  try {
    const j = JSON.parse(content) as { engines?: { node?: unknown } };
    const node = j?.engines?.node;
    if (typeof node === 'string' && node.trim()) return { version: node.trim(), raw: `engines.node = ${node}` };
  } catch {
    // 非法 JSON：忽略
  }
  return null;
}

export const nodeAdapter: LanguageAdapter = {
  lang: 'node',
  label: 'Node',
  declarationFiles: ['.nvmrc', 'package.json', '.tool-versions'],
  sourceExts: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  skipDirs: ['node_modules', '.next', 'dist'],
  asdfToolNames: ['nodejs', 'node'],
  featureRules: NODE_FEATURES,
  removedRules: NODE_REMOVED,
  probe: {
    cmd: 'node',
    args: ['-v'],
    parse: (out) => out.trim() || null,
  },

  parseDeclarationFile(abs: string): AdapterDeclaration[] {
    const name = path.basename(abs);
    let content = '';
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      return [];
    }
    const projectDir = path.dirname(abs);
    const emit = (r: { version: string; raw: string } | null): AdapterDeclaration[] =>
      r ? [{ projectDir, source: name, declaredVersion: r.version, raw: r.raw }] : [];

    if (name === '.nvmrc') {
      const v = content.trim();
      return v ? [{ projectDir, source: name, declaredVersion: v, raw: v }] : [];
    }
    if (name === 'package.json') return emit(parsePackageJson(content));
    if (name === '.tool-versions') {
      const out: AdapterDeclaration[] = [];
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*(nodejs|node)\s+([^\s#]+)/);
        if (!m) continue;
        out.push({ projectDir, source: name, declaredVersion: m[2], raw: line.trim() });
      }
      return out;
    }
    return [];
  },

  parseVersion(v: string): VersionInfo | null {
    // 18 / 18.17 / v18.17.0 / >=18 → major 18
    const s = String(v).trim().replace(/^v/, '');
    const m = s.match(/(\d+)(?:\.(\d+))?/);
    return m ? { major: parseInt(m[1], 10), minor: m[2] ? parseInt(m[2], 10) : 0 } : null;
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

  verifyCommands(dir: string): VerifyCommand[] {
    if (!fs.existsSync(path.join(dir, 'package.json'))) return [];
    const cmds: VerifyCommand[] = [{ label: 'tsc noEmit', cmd: 'npx', args: ['tsc', '--noEmit'] }];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> };
      if (typeof pkg.scripts?.test === 'string') {
        cmds.push({ label: 'npm test', cmd: 'npm', args: ['test', '--', '--run'], timeoutMs: 600_000 });
      }
    } catch {
      // 非法 JSON：忽略
    }
    return cmds;
  },
};
