/**
 * detect_dead_imports —— 文件级死 import 检测（确定性重构管线的"一键"真相层）
 *
 * 定位：与 dead_deps（闭包级）互补。dead_deps 回答"闭包内某三方源是否被种子可达
 * 代码引用"——它依赖 harvest_closure 产出的 closure/seed/external 上下文，只服务
 * 积木瘦身场景，无法对"只给 project_dir 的任意项目"通用一键。
 *
 * 本模块是**文件级自洽**判定：对一个文件，某 import 源的全部本地绑定在"剥离
 * import/require 语句自身"的源码里零出现 → 该源是死 import。不需要 DB、不需要
 * 闭包、不需要种子，任何 TS/Go 项目都能直接扫。这是管线把 dead_imports 步变成
 * "自动检测 + 删除"的基础。
 *
 * 保守规则（宁多报活/漏报死，不误删——检测信任优先，删除还过验证闭环）：
 *   - Go 空导入 `_` / 点导入 `.`：import 即执行副作用 → 恒活
 *   - TS 副作用导入 `import 'x'` / re-export `export ... from` / 语法不认识
 *     （parseTsImportQualifiers 返回 null）→ 恒活
 *   - TS 裸名扫描只在剥离 import 行后的源码做（import 语句自身含绑定名，不剥会
 *     假"出现"）；注释里的同名出现不剥（TS 无行注释剔除）→ 只会多活，安全向
 *   - Go 无 alias 时 import 行不含 `Q.`，成员访问扫描天然不误判 import 行自身
 *
 * 产物结构与 removeDeadImports 的 dead 清单一致（source + files），管线的
 * dead_imports 步据此删除；也可单独交付给用户先看报告再拍板。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  parseGoImportQualifiers,
  parseTsImportQualifiers,
  qualifierLines,
  stripTsImportLines,
} from './dead_deps.js';

export interface DeadImportCandidate {
  /** 死三方源（Go import 路径 / TS 模块说明符） */
  source: string;
  /** 导入该源且文件内零引用的文件（相对 project_dir） */
  files: string[];
  reason: 'no_reference';
}

export interface DetectDeadImportsOptions {
  project_dir: string;
  /** 显式文件清单（相对或绝对路径）；缺省递归扫全部 TS/Go 源 */
  files?: string[];
}

export interface DetectDeadImportsResult {
  dead: DeadImportCandidate[];
  /** 参与扫描的文件数 */
  scanned: number;
  /** 规则说明（供报告） */
  limitations: string[];
  /** 每个死 import 引用文件的来源分类（相对 project_dir → kind），便于一眼区分"真实源码可清"vs"测试/夹具噪音" */
  fileKind?: Record<string, FileKind>;
  /** 死 import 出现次数按来源分类聚合（src/test/fixture/generated/snapshot） */
  byKind?: Record<FileKind, number>;
}

/** 死 import 引用的来源分类：真实源码 / 测试 / 生成物 / 测试夹具 / 快照副本 */
export type FileKind = 'src' | 'test' | 'fixture' | 'generated' | 'snapshot';

const TS_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const GO_RE = /\.go$/;

function langOf(rel: string): 'go' | 'ts' | null {
  if (GO_RE.test(rel)) return 'go';
  if (TS_RE.test(rel)) return 'ts';
  return null;
}

/**
 * 按路径约定分类死 import 引用来源。
 * 优先级：快照 > 生成物 > 夹具 > 测试 > 源码（fixture/generated 属"不应真清"的噪音层）。
 * 纯路径判断，不读文件；对已显式收敛（files）或默认扫描都适用。
 */
export function classifyFileKind(rel: string): FileKind {
  const p = rel.split(/[\\/]/);
  const base = p[p.length - 1] ?? '';
  if (p.some((seg) => seg.startsWith('.design-canvas'))) return 'snapshot';
  if (/\.gen\.(ts|tsx|js|jsx|mjs|cjs|go)$/.test(base) || /\.generated\.|_generated\.go$/.test(base)) return 'generated';
  if (
    p.some((seg) => /^(fixtures?|__fixtures__|testdata|golden|snapshots)$/i.test(seg)) ||
    /\.(fixtures?|_testdata)\./.test(base)
  ) {
    return 'fixture';
  }
  if (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(base) ||
    /_test\.go$/.test(base) ||
    /[.\\/]test_.+\.go$/.test(base) ||
    p.includes('__tests__')
  ) {
    return 'test';
  }
  return 'src';
}

/** 递归收集项目内 TS/Go 源文件（跳过 node_modules/.git/dist） */
export function scanProjectSourceFiles(project_dir: string, files?: string[]): string[] {
  const proj = path.resolve(project_dir);
  const toAbs = (f: string): string => (path.isAbsolute(f) ? path.resolve(f) : path.resolve(proj, f));
  const targets: string[] = [];
  if (files && files.length > 0) {
    for (const f of files) {
      const abs = toAbs(f);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile() && langOf(abs)) targets.push(abs);
    }
    return targets;
  }
  const walkDir = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      // 递归跳过：依赖/版本控制/构建产物；以及 vendor/（第三方 vendored 代码）——
      // 它们绝不可能算"自研积木"，不参与死 import 扫描，避免把 vendored 依赖误报为下线候选。
      // 进一步排除 .design-canvas* 快照/备份目录（含 .design-canvas、.design-canvas.bak-<ts> 变体）：
      // 它们是项目自身历史快照的生成副本，扫进来会把每个 src 命中重复多倍，污染清理清单。
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'vendor') continue;
      if (ent.isDirectory() && ent.name.startsWith('.design-canvas')) continue;
      const p = path.join(dir, ent.name);
      // 跳过生成的源码产物（*.gen.ts 等），不参与"自研源码"判定
      if (ent.isDirectory()) walkDir(p);
      else if (langOf(ent.name) && !/\.gen\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ent.name)) targets.push(p);
    }
  };
  walkDir(proj);
  return targets;
}

/**
 * 单源判定：src 中某 import 源是否文件内零引用。
 * 返回 true = 死候选（可删）；false = 活（保守保留）。
 */
function isSourceDead(src: string, source: string, lang: 'go' | 'ts'): boolean {
  if (lang === 'go') {
    const quals = parseGoImportQualifiers(src).get(source);
    if (!quals || quals.length === 0) return false; // 解析失败 → 活
    // 空/点导入：副作用，恒活
    if (quals.some((q) => q === '_' || q === '.')) return false;
    // 任一候选限定符有 `Q.` 成员访问 → 活；全部零出现 → 死
    return !quals.some((q) => qualifierLines(src, q, 'go').length > 0);
  }

  // TS：先剥 import/require 语句行（避免 import 行自身含绑定名假"出现"）
  const scan = stripTsImportLines(src);
  const quals = parseTsImportQualifiers(src, source);
  if (quals === null) return false; // 副作用/re-export/语法不认识 → 恒活
  if (quals.length === 0) return false;
  // 裸名扫描（'ts' 模式不剥注释 → 只多活，安全向）
  return !quals.some((q) => qualifierLines(scan, q, 'ts').length > 0);
}

/**
 * 文件级死 import 检测：扫描项目源文件，聚合出死候选（source → files）。
 * 只返回"文件内零引用"的源；同一源可能在多个文件死（皆记入 files）。
 */
export function detectDeadImports(opts: DetectDeadImportsOptions): DetectDeadImportsResult {
  const proj = path.resolve(opts.project_dir);
  const absFiles = scanProjectSourceFiles(proj, opts.files);
  const agg = new Map<string, { files: string[]; seen: Set<string> }>();
  const readSrc = (abs: string): string | null => {
    try {
      return fs.readFileSync(abs, 'utf-8');
    } catch {
      return null;
    }
  };

  for (const abs of absFiles) {
    const src = readSrc(abs);
    if (src === null) continue;
    const lang = langOf(abs);
    if (!lang) continue;

    // 枚举本文件的 import 源
    let sourcesOfFile: string[];
    if (lang === 'go') {
      sourcesOfFile = [...parseGoImportQualifiers(src).keys()];
    } else {
      sourcesOfFile = enumerateTsSources(src);
    }

    for (const source of sourcesOfFile) {
      if (!isSourceDead(src, source, lang)) continue;
      let a = agg.get(source);
      if (!a) {
        a = { files: [], seen: new Set() };
        agg.set(source, a);
      }
      const rel = path.relative(proj, abs) || abs;
      if (!a.seen.has(rel)) {
        a.seen.add(rel);
        a.files.push(rel);
      }
    }
  }

  const dead: DeadImportCandidate[] = [];
  const fileKind: Record<string, FileKind> = {};
  const byKind: Record<FileKind, number> = { src: 0, test: 0, fixture: 0, generated: 0, snapshot: 0 };
  for (const [source, a] of agg) {
    if (a.files.length === 0) continue;
    for (const rel of a.files) {
      const kind = classifyFileKind(rel);
      fileKind[rel] = kind;
      byKind[kind] += 1;
    }
    dead.push({ source, files: a.files.sort(), reason: 'no_reference' });
  }
  dead.sort((x, y) => (x.source < y.source ? -1 : 1));

  return {
    dead,
    scanned: absFiles.length,
    fileKind,
    byKind,
    limitations: [
      '文件级自洽判定：某 import 的全部绑定在文件内零引用即报死；注释中的同名出现（TS）会保守多活',
      'Go 空导入/点导入与 TS 副作用导入/re-export 恒活（import 即执行副作用，绝不误删）',
      '判定仅见文件内部，未做跨文件可达性——保守漏报多于误报；删除前请先过验证闭环',
      '来源分类纯路径判定：fixture/generated/snapshot 多为夹具/产物噪音，真实可清项以 src/test 为主，仍建议逐个过验证',
    ],
  };
}

/** 剥 TS 行注释 + 块注释（保行号/换行数），用于"源发现"侧：注释里的 import 字面量
 *  （如 docstring `// B import {..} from 'a'`）不该被当成真实模块源。
 *  先归一化 \r：JS 正则 `.` 不匹配 `\r`，CRLF 文件里 `//` 行注释会剥离失败（`$` 又不能在 \r 前锚定）。
 *  行注释保护 URL：`://` 前的 `//` 当字符串不剥（https://…）。块注释替换为空白保换行。 */
function stripTsComments(src: string): string {
  let out = src.replace(/\r/g, '');
  out = out.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
  return out;
}

/** 枚举 TS/JS 源码里出现的模块说明符（import/require/export-from），去引号。
 *  先剥注释：注释里的 `import ... from 'x'` / `require('x')` 字面量不是真导入，
 *  不该被当成源（否则 docstring 示例会把 'a'/'x' 之类报成死 import）。 */
export function enumerateTsSources(src: string): string[] {
  const scan = stripTsComments(src);
  const out = new Set<string>();
  const mod = (m: RegExpMatchArray): void => {
    const s = m[m.length - 1];
    if (s) out.add(s.replace(/^['"]|['"]$/g, ''));
  };
  // 具名/默认/命名空间/副作用 import 与 type import
  const reImport = /import(?:\s+type)?\s+[\s\S]*?from\s*(['"][^'"]+['"])/g;
  let m: RegExpMatchArray | null;
  while ((m = reImport.exec(scan)) !== null) mod(m);
  // import 'x' 副作用（无 from）
  const reBare = /import\s*(['"])([^'"]+)\1/g;
  while ((m = reBare.exec(scan)) !== null) {
    if (m.index !== undefined && scan.slice(Math.max(0, m.index - 8), m.index).trimEnd().endsWith('from')) continue;
    out.add(m[2]);
  }
  // export ... from 'x'
  const reExport = /export\s*[\s\S]*?from\s*(['"][^'"]+['"])/g;
  while ((m = reExport.exec(scan)) !== null) mod(m);
  // require('x')
  const reRequire = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = reRequire.exec(scan)) !== null) out.add(m[2]);
  return [...out];
}