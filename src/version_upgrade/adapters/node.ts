/**
 * adapters/node —— Node.js 语言适配器
 *
 * 方言要点：
 *   - 声明文件：.nvmrc（内容即版本）、package.json（engines.node）、.tool-versions（nodejs/node 行）
 *   - 版本边界：Node 主版本
 *   - 静态闸：无单文件编译级校验（TS 依赖项目级 tsc；见 verifyCommands）
 *   - 动态闸：运行时探针——JS 家族（.mjs/.cjs/.js）原生 node 直跑、零转译（保留 ESM/CJS 原生语义），
 *     TS 家族（.ts/.tsx/.jsx）经 typescript.transpileModule 转 CJS 后跑（复用 behavior 线的转译助手）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { transpileToCjs } from '../../behavior/index.js';
import type {
  LanguageAdapter,
  AdapterDeclaration,
  VersionInfo,
  FeatureRule,
  RemovedRule,
  SourceFile,
  DynamicGateItem,
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

// ── 动态闸：运行时探针 ───────────────────────────────────────────

/** 依赖/跨文件引用无法单文件隔离的错误特征（镜像 Python 的 ModuleNotFoundError → skipped） */
const MODULE_RESOLVE_RE =
  /Cannot find module|ERR_MODULE_NOT_FOUND|Cannot use import statement outside a module|ERR_UNKNOWN_FILE_EXTENSION/;

/** 运行模式：ESM 原生 / CJS 原生 / TS 家族转译 CJS */
type NodeRunMode = 'esm' | 'cjs' | 'transpile';

/**
 * 按扩展名 + 项目 package.json 决定运行模式（"零转译优先"）：
 *   - .mjs  → 原生 ESM（import.meta / 顶层 await 全保留原生语义）
 *   - .cjs  → 原生 CJS
 *   - .js   → 看 package.json 的 type 字段：module → ESM，否则 CJS
 *   - .ts/.tsx/.jsx → transpileModule 转 CJS（JS 家族不转译，避免语义近似）
 */
function nodeRunMode(dir: string, filePath: string): NodeRunMode {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mjs') return 'esm';
  if (ext === '.cjs') return 'cjs';
  if (ext === '.js') {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { type?: string };
      return pkg.type === 'module' ? 'esm' : 'cjs';
    } catch {
      return 'cjs';
    }
  }
  return 'transpile';
}

/**
 * 用 node 真跑单文件顶层代码，捕获运行层契约差（"编译能过、一跑就炸"）。
 * - 依赖/跨文件引用无法隔离（Cannot find module / ERR_MODULE_NOT_FOUND）→ skipped（改由项目级验证）
 * - 真实运行时异常 → fail（附异常摘要）
 * - 干净跑完 → ok
 * 在隔离临时目录执行，不污染项目；带超时防止死循环拖死扫描。
 * 判定顺序镜像 Python runProbe：先判 signal（超时），再判 error（node 不可用）。
 */
function nodeRunProbe(dir: string, file: SourceFile): DynamicGateItem {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `dc-node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-`));
  try {
    const mode = nodeRunMode(dir, file.path);
    const tmpFile = path.join(tmpDir, mode === 'esm' ? 'probe.mjs' : 'probe.cjs');
    let jsContent = file.content;
    if (mode === 'transpile') {
      const tr = transpileToCjs(path.join(dir, file.path), file.content);
      if ('error' in tr) {
        return { file: file.path, status: 'fail', detail: tr.error };
      }
      jsContent = tr.js;
    }
    fs.writeFileSync(tmpFile, jsContent, 'utf-8');
    const r = spawnSync(process.execPath, [tmpFile], { encoding: 'utf-8', timeout: 60_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    // 超时被终止时 Node 会同时置 error=ETIMEDOUT 与 signal=SIGTERM —— 必须先判 signal：
    // 超时是"死循环/环境卡顿"的硬信号，归 fail；先判 error 会把超时误报成"node 不可用"(skipped)
    if (r.signal) {
      return { file: file.path, status: 'fail', detail: `运行超时被终止（${r.signal}），疑似死循环` };
    }
    if (r.error) {
      return { file: file.path, status: 'skipped', detail: `node 不可用/执行异常: ${r.error.message}` };
    }
    if (r.status === 0) return { file: file.path, status: 'ok' };
    // Node 未捕获异常的消息在 stderr 顶部（Python 在底部），故分类对完整 stderr 匹配、详情取前几行
    const errFull = `${r.stderr || ''}${r.stdout ? `\n${r.stdout}` : ''}`.trim();
    if (MODULE_RESOLVE_RE.test(errFull)) {
      return { file: file.path, status: 'skipped', detail: '依赖/跨文件引用无法单文件隔离，改由项目级验证' };
    }
    const head = errFull.split(/\r?\n/).filter(Boolean).slice(0, 4).join('\n');
    return { file: file.path, status: 'fail', detail: head.slice(0, 400) || `运行时抛异常（exit ${r.status}）` };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Windows 上留给 OS 清理
    }
  }
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

  async dynamicGate(dir: string, _boundary: number, files: SourceFile[]): Promise<DynamicGateItem[]> {
    // 与 Python 一致：探针只验"跑不跑得动"，不强制声明边界 ≤ 本机 node 版本（node 无按版本的单文件编译手段）
    return files.map((f) => nodeRunProbe(dir, f));
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
