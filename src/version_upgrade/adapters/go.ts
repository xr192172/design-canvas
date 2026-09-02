/**
 * adapters/go —— Go 语言适配器
 *
 * 方言要点：
 *   - 声明文件：go.mod（"go 1.21" 指令）、.tool-versions（golang 行）
 *   - 版本边界：Go 1.x 的 x（minor）
 *   - 静态闸：Go 的语言版本由 go.mod 的 go 指令经 go build 强制执行，
 *     无"单文件按版本编译"；以项目级 go build/test（verifyCommands）作为闸
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

// ── 规则表（原 features.ts / removed.ts 的 Go 段） ──────────────

export const GO_FEATURES: FeatureRule[] = [
  { name: '泛型函数（类型参数）', tool: 'go', since: 18, pattern: /\bfunc\s+[A-Za-z_]\w*\[/, rewrite: '改为 interface{} + 类型断言，或按类型拆多个函数' },
];

export const GO_REMOVED: RemovedRule[] = [
  { name: 'io/ioutil', tool: 'go', since: 16, kind: 'deprecated', pattern: /\bio\/ioutil\b/, rewrite: 'Go 1.16 起废弃：os.ReadFile/WriteFile/ReadDir + io.ReadAll 替代' },
  { name: 'math/rand.Seed', tool: 'go', since: 20, kind: 'deprecated', pattern: /\brand\.Seed\s*\(/, rewrite: 'Go 1.20 起废弃：改用 math/rand/v2，无需手动 Seed' },
];

function parseGoMod(content: string): { version: string; raw: string } | null {
  const m = content.match(/^\s*go\s+([\d.]+)\s*$/m);
  if (!m) return null;
  return { version: m[1], raw: `go ${m[1]}` };
}

export const goAdapter: LanguageAdapter = {
  lang: 'go',
  label: 'Go',
  declarationFiles: ['go.mod', '.tool-versions'],
  sourceExts: ['.go'],
  skipDirs: ['vendor'],
  asdfToolNames: ['golang'],
  featureRules: GO_FEATURES,
  removedRules: GO_REMOVED,
  probe: {
    cmd: 'go',
    args: ['version'],
    parse: (out) => out.match(/go([\d.]+)/)?.[1] ?? null,
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

    if (name === 'go.mod') {
      const r = parseGoMod(content);
      return r ? [{ projectDir, source: name, declaredVersion: r.version, raw: r.raw }] : [];
    }
    if (name === '.tool-versions') {
      const out: AdapterDeclaration[] = [];
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*(golang|go)\s+([^\s#]+)/);
        if (!m) continue;
        out.push({ projectDir, source: name, declaredVersion: m[2], raw: line.trim() });
      }
      return out;
    }
    return [];
  },

  parseVersion(v: string): VersionInfo | null {
    // 1.21 / 1.21.5 → major 1, minor 21
    const s = String(v).trim().replace(/^v/, '');
    const m = s.match(/^(\d+)\.(\d+)/);
    return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
  },

  featureBoundary(info: VersionInfo): number {
    return info.minor ?? info.major;
  },

  versionSatisfies(declared: string, local: string): boolean {
    const d = this.parseVersion(declared);
    const l = this.parseVersion(local);
    if (!d || !l) return false;
    // 按 major.minor 字典序比较（1.21 < 1.22）
    if (l.major !== d.major) return l.major > d.major;
    return (l.minor ?? 0) >= (d.minor ?? 0);
  },

  verifyCommands(dir: string) {
    if (!fs.existsSync(path.join(dir, 'go.mod'))) return [];
    return [
      { label: 'go build', cmd: 'go', args: ['build', './...'] },
      { label: 'go test', cmd: 'go', args: ['test', './...'], timeoutMs: 600_000 },
    ];
  },
};
