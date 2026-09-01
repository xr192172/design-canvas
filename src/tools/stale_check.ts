/**
 * stale_check —— 检测「源码比编译产物新」的 STALE BUILD（文件级精确）
 *
 * 痛点：design-canvas 自身 `npm run build` 产出 dist/（tsc）。改 src 下 ts 后忘了
 * 重跑 build，MCP server / CLI 跑的是旧 dist——行为与源码不符，排查浪费时间。
 *
 * 判定：对每个可编译源码文件（src 下 ts/tsx），找其对应 dist 产物
 *   src/foo.ts          → dist/src/foo.js
 *   src/tools/x.ts      → dist/src/tools/x.js
 * 若源文件 mtime > 产物 mtime（或产物缺失）→ stale。
 *
 * 忽略范围（生成文件/非手写源）：
 *   - gen.ts 后缀（构建脚本生成，改它=必然重跑 build，不算待重建的源）
 *   - AGENTS.md / .trae / docs 等非 src 内容（只盯 src/ 下手写 TS）
 *
 * 只读，不改文件。可被 run_tests/diagnose 前置调用，或独立 CLI 跑。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StaleEntry {
  /** 相对项目根的源码路径（POSIX） */
  src: string;
  /** 对应 dist 产物路径（相对项目根） */
  out: string;
  /** 产物缺失（true）或比源旧（false） */
  missing: boolean;
  /** 源文件 mtime（ms） */
  srcMtime: number;
  /** 产物 mtime（ms；missing 时 0） */
  outMtime: number;
}

export interface StaleCheckResult {
  ok: boolean;
  /** 是否发现 stale（有未重建产物） */
  stale: boolean;
  /** stale 条目（文件级） */
  entries: StaleEntry[];
  /** 扫描的源码文件数 */
  scanned: number;
  /** 项目根 */
  root: string;
}

/** 忽略的源码文件名模式（生成文件，改它必重跑 build，不算待重建） */
const GEN_SRC_RE = /\.gen\.ts$/;

/** src 下递归收集手写 .ts/.tsx 源文件（排除 *.gen.ts） */
function walkSrcSources(root: string, out: string[]): void {
  const srcDir = path.join(root, 'src');
  if (!fs.existsSync(srcDir)) return;
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && /\.tsx?$/.test(e.name) && !GEN_SRC_RE.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(srcDir);
}

/** 源文件 → dist 产物路径（tsc rootDir='.' 的映射：src/x.ts → dist/src/x.js） */
function distOutFor(root: string, srcAbs: string): string {
  const rel = path.relative(root, srcAbs); // src/foo.ts
  const relNoExt = rel.replace(/\.tsx?$/, '');
  return path.join(root, 'dist', relNoExt + '.js');
}

/** 文件 mtime（ms），不存在返回 -1 */
function mtimeOf(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return -1;
  }
}

export function checkStaleBuild(root: string): StaleCheckResult {
  const rootAbs = path.resolve(root);
  const sources: string[] = [];
  walkSrcSources(rootAbs, sources);
  const entries: StaleEntry[] = [];
  for (const srcAbs of sources) {
    const outAbs = distOutFor(rootAbs, srcAbs);
    const srcM = mtimeOf(srcAbs);
    const outM = mtimeOf(outAbs);
    if (srcM < 0) continue; // 源都读不到（极端），跳过
    const missing = outM < 0;
    if (missing || outM < srcM) {
      entries.push({
        src: path.relative(rootAbs, srcAbs).replace(/\\/g, '/'),
        out: path.relative(rootAbs, outAbs).replace(/\\/g, '/'),
        missing,
        srcMtime: Math.round(srcM),
        outMtime: missing ? 0 : Math.round(outM),
      });
    }
  }
  // 文件级精确：按路径排序
  entries.sort((a, b) => a.src.localeCompare(b.src));
  return {
    ok: true,
    stale: entries.length > 0,
    entries,
    scanned: sources.length,
    root: rootAbs,
  };
}

/** 人类可读摘要（供 CLI/doctor 复用） */
export function formatStaleText(r: StaleCheckResult): string {
  if (!r.stale) return `✓ 无 STALE BUILD：${r.scanned} 个手写源均已重建（dist 最新）`;
  const lines = [`⚠ STALE BUILD：${r.entries.length}/${r.scanned} 个源码文件比 dist 新（未重跑 npm run build）`];
  for (const e of r.entries.slice(0, 30)) {
    lines.push(`  - ${e.src} → ${e.missing ? '缺产物' : `产物旧(源 ${new Date(e.srcMtime).toISOString().slice(11, 19)} vs 产物 ${new Date(e.outMtime).toISOString().slice(11, 19)})`}`);
  }
  if (r.entries.length > 30) lines.push(`  … 其余 ${r.entries.length - 30} 个`);
  lines.push(`  → 跑 npm run build 重建后生效`);
  return lines.join('\n');
}
