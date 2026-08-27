/**
 * adapters/python —— Python 语言适配器（示范：新增语言只需一个适配器）
 *
 * 方言要点：
 *   - 声明文件：pyproject.toml（[project] requires-python / poetry python 约束）、
 *     .python-version（内容即版本）、.tool-versions（python 行）
 *   - 版本边界：Python minor（特性以 minor 引入：3.6 f-string / 3.8 walrus / 3.10 match）
 *   - 静态闸：ast.parse(source, feature_version=(3, boundary)) —— 用解释器自带的
 *     AST 解析器按"目标版本语法"校验，无需额外编译器，能精确抓到语法级契约差
 *   - 项目级验证：python -m compileall（全量语法编译）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type {
  LanguageAdapter,
  AdapterDeclaration,
  VersionInfo,
  SourceFile,
  StaticGateItem,
  FeatureRule,
  RemovedRule,
} from './types.js';

/** Windows 常只有 python；POSIX 约定 python3 */
const PY = process.platform === 'win32' ? 'python' : 'python3';

// ── 规则表（Python 特性/废弃 API，since 均为 minor） ─────────────

export const PY_FEATURES: FeatureRule[] = [
  { name: 'f-string 字符串', tool: 'python', since: 6, pattern: /\bf["']/, rewrite: '改为普通字符串 + format()/% 拼接' },
  { name: '海象运算符 :=', tool: 'python', since: 8, pattern: /(?<!\w):=(?!=)/, rewrite: '拆成两行：先赋值再判断' },
  { name: 'match 语句（结构化模式匹配）', tool: 'python', since: 10, pattern: /\bmatch\s+[A-Za-z_]\w*\s*:/, rewrite: '改回 if/elif 链' },
];

export const PY_REMOVED: RemovedRule[] = [
  { name: 'distutils 打包模块', tool: 'python', since: 12, kind: 'removed', pattern: /\bdistutils\b/, rewrite: 'Python 3.12 起移除：改用 setuptools（pyproject.toml）或 build' },
  { name: 'imp 模块', tool: 'python', since: 12, kind: 'removed', pattern: /\bimp\./, rewrite: 'Python 3.12 起移除：改用 importlib' },
  { name: 'cgi 模块', tool: 'python', since: 13, kind: 'removed', pattern: /\bcgi\./, rewrite: 'Python 3.13 起移除：改用 WSGI / ASGI 框架解析表单' },
  { name: 'typing.Text', tool: 'python', since: 8, kind: 'deprecated', pattern: /\btyping\.Text\b|from\s+typing\s+import\s+[^\n]*\bText\b/, rewrite: '3.8 起废弃：改用 str' },
  { name: 'collections.Callable 等泛型别名', tool: 'python', since: 9, kind: 'deprecated', pattern: /\bcollections\.(?:Callable|Iterable|Iterator|Mapping|Sequence|Set|Hashable|Sized|Container|MutableMapping|MutableSequence)\b/, rewrite: '3.9 起废弃：改用 collections.abc（from collections.abc import Callable）' },
];

// ── 声明解析 ─────────────────────────────────────────────────────

/** 从 requires-python / poetry python 约束中取"最低要求版本"（取所有提及版本里最小的） */
function minVersionFromSpec(spec: string): { version: string; raw: string } | null {
  const versions: Array<[number, number]> = [];
  for (const m of spec.matchAll(/(\d+)\.(\d+)/g)) {
    versions.push([parseInt(m[1], 10), parseInt(m[2], 10)]);
  }
  if (versions.length === 0) return null;
  versions.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  return { version: versions[0].join('.'), raw: spec.trim() };
}

function parsePyproject(content: string): { version: string; raw: string } | null {
  // PEP 621: requires-python = ">=3.10" | poetry: python = "^3.8"
  const pep = content.match(/^\s*requires-python\s*=\s*["']([^"']+)["']/m);
  if (pep) return minVersionFromSpec(pep[1]);
  const poetry = content.match(/^\s*\[tool\.poetry\.dependencies\]\s*[\s\S]*?^\s*python\s*=\s*["']([^"']+)["']/m);
  if (poetry) return minVersionFromSpec(poetry[1]);
  return null;
}

// ── 静态闸：ast.parse(feature_version) ───────────────────────────

/**
 * 用当前解释器的 AST 解析器按"声明版本语法"校验单个文件。
 * feature_version 高于解释器版本时 ast.parse 抛 ValueError → 降级为 skipped。
 */
function astGate(file: SourceFile, boundary: number): StaticGateItem {
  const script = [
    'import ast,sys',
    `ver=(3,${boundary})`,
    "try:",
    "    ast.parse(sys.stdin.read(), filename='<gate>', feature_version=ver)",
    "except SyntaxError as e:",
    "    sys.stderr.write(f'{e.lineno}: {e.msg}\\n')",
    "    sys.exit(1)",
    "except ValueError as e:",
    "    sys.stderr.write(f'UNAVAILABLE: {e}\\n')",
    "    sys.exit(2)",
  ].join('\n');
  const r = spawnSync(PY, ['-c', script], {
    input: file.content,
    encoding: 'utf-8',
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) {
    return { file: file.path, status: 'skipped', detail: `python 不可用: ${r.error.message}` };
  }
  if (r.status === 2) {
    return { file: file.path, status: 'skipped', detail: '本机 Python 版本低于声明边界，无法按目标语法校验' };
  }
  if (r.status === 1) {
    const err = `${r.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join('\n');
    return { file: file.path, status: 'fail', detail: err.slice(0, 400) || `不符合 Python 3.${boundary} 语法` };
  }
  return { file: file.path, status: 'ok' };
}

// ── 适配器对象 ────────────────────────────────────────────────────

export const pythonAdapter: LanguageAdapter = {
  lang: 'python',
  label: 'Python',
  declarationFiles: ['pyproject.toml', '.python-version', '.tool-versions'],
  sourceExts: ['.py'],
  skipDirs: ['__pycache__', '.venv', 'venv', '.tox'],
  asdfToolNames: ['python'],
  featureRules: PY_FEATURES,
  removedRules: PY_REMOVED,
  probe: {
    cmd: PY,
    args: ['--version'],
    parse: (out) => out.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null,
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

    if (name === 'pyproject.toml') {
      const r = parsePyproject(content);
      return r ? [{ projectDir, source: name, declaredVersion: r.version, raw: r.raw }] : [];
    }
    if (name === '.python-version') {
      const v = content.trim();
      return v ? [{ projectDir, source: name, declaredVersion: v, raw: v }] : [];
    }
    if (name === '.tool-versions') {
      const out: AdapterDeclaration[] = [];
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*python\s+([^\s#]+)/);
        if (!m) continue;
        out.push({ projectDir, source: name, declaredVersion: m[1], raw: line.trim() });
      }
      return out;
    }
    return [];
  },

  parseVersion(v: string): VersionInfo | null {
    // 3.10 / 3.10.4 → major 3, minor 10
    const s = String(v).trim().replace(/^v/, '');
    const m = s.match(/^(\d+)\.(\d+)/);
    return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
  },

  featureBoundary(info: VersionInfo): number {
    return info.minor ?? 0;
  },

  versionSatisfies(declared: string, local: string): boolean {
    const d = this.parseVersion(declared);
    const l = this.parseVersion(local);
    if (!d || !l) return false;
    if (l.major !== d.major) return l.major > d.major;
    return (l.minor ?? 0) >= (d.minor ?? 0);
  },

  staticGate(_dir: string, boundary: number, files: SourceFile[]): StaticGateItem[] {
    return files.map((f) => astGate(f, boundary));
  },

  verifyCommands(dir: string) {
    if (!fs.existsSync(path.join(dir, 'pyproject.toml')) && !fs.existsSync(path.join(dir, '.python-version'))) return [];
    return [{ label: 'compileall 语法编译', cmd: PY, args: ['-m', 'compileall', '-q', '.'], timeoutMs: 600_000 }];
  },
};
