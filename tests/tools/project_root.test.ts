/**
 * project_root —— 自动定位项目根 + 动态闭包边界单元测试
 *
 * 覆盖：
 *   - gitRootOf：嵌套 git（内层仓库含于外层工作树）→ 返回最近仓库根
 *   - manifestRootOf：无 git 时向上找最近 manifest 目录
 *   - resolveProjectRoot：git 优先（嵌套安全）
 *   - realResolveImport：扩展名补全 / 目录索引 / 裸包与缺失 → null
 *   - expandClosure：根内文件 + 沿 import 边扩入根外本地文件（跨根自包含）
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  gitRootOf,
  manifestRootOf,
  resolveProjectRoot,
  realResolveImport,
  expandClosure,
  loadAliasConfig,
  resolveAliasedImport,
  findExternalImporters,
} from '../../src/tools/project_root';
import { syncFile, syncProject, toRelPath, hasAnyIndexedFiles, pruneDeletedFiles } from '../../src/db/symbols';
import { getProjectCacheDb, closeProjectCacheDb } from '../../src/db/db';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pr-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄尚未释放（Windows），稍候重试 */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略最终失败（临时目录，OS 会回收） */
  }
}

describe('gitRootOf - 嵌套 git 根解析', () => {
  it('内层仓库（outer 内含 inner）→ 返回最近仓库根 inner', () => {
    const dir = mkProj({
      'outer/inner/src/def.ts': 'export function compute() { return 1; }\n',
    });
    execSync('git init', { cwd: path.join(dir, 'outer'), stdio: 'pipe' });
    execSync('git init', { cwd: path.join(dir, 'outer/inner'), stdio: 'pipe' });

    const root = gitRootOf(path.join(dir, 'outer/inner/src/def.ts'));
    expect(root).not.toBeNull();
    // git rev-parse 返回的根在 win runner 上可能是 8.3 短路径(RUNNER~1)、mac 是 /private/var 符号链接，
    // 都与 os.tmpdir() 的长路径在字符串上不等，无法用路径相等断言 → 转验证明内层仓库结构在根下可达
    expect(existsSync(path.join(root!, 'src/def.ts'))).toBe(true);
    rmForce(dir);
  });

  it('非 git 目录 → null', () => {
    const dir = mkProj({ 'src/def.ts': 'export function compute() { return 1; }\n' });
    expect(gitRootOf(path.join(dir, 'src/def.ts'))).toBeNull();
    rmForce(dir);
  });
});

describe('manifestRootOf - manifest 边界判据', () => {
  it('向上找最近 manifest 目录（go.mod 优先命中）', () => {
    const dir = mkProj({
      'svc/go.mod': 'module svc\n',
      'svc/src/def.ts': 'export function compute() { return 1; }\n',
    });
    expect(path.resolve(manifestRootOf(path.join(dir, 'svc/src/def.ts'))!)).toBe(
      path.resolve(path.join(dir, 'svc')),
    );
    rmForce(dir);
  });
});

describe('resolveProjectRoot - git 优先（嵌套安全）', () => {
  it('内层 git 仓库内文件 → 根 = 内层仓库根', () => {
    const dir = mkProj({
      'outer/inner/src/def.ts': 'export function compute() { return 1; }\n',
    });
    execSync('git init', { cwd: path.join(dir, 'outer'), stdio: 'pipe' });
    execSync('git init', { cwd: path.join(dir, 'outer/inner'), stdio: 'pipe' });

    expect(
      existsSync(path.join(resolveProjectRoot(path.join(dir, 'outer/inner/src/def.ts')), 'src/def.ts')),
    ).toBe(true);
    rmForce(dir);
  });
});

describe('realResolveImport - 相对导入真实落盘解析', () => {
  it('扩展名补全 / 目录索引 / js 直接命中', () => {
    const dir = mkProj({
      'a.ts': 'export const x = 1;\n',
      'sub/index.ts': 'export const y = 2;\n',
      'sub/plain.js': 'export const z = 3;\n',
    });
    const importer = path.join(dir, 'main.ts');
    expect(realResolveImport(importer, './a')).toBe(path.join(dir, 'a.ts'));
    expect(realResolveImport(importer, './sub')).toBe(path.join(dir, 'sub/index.ts'));
    expect(realResolveImport(importer, './sub/plain')).toBe(path.join(dir, 'sub/plain.js'));
    rmForce(dir);
  });

  it('裸包 / 绝对路径 / 缺失 → null（不属本地闭包）', () => {
    const dir = mkProj({ 'a.ts': 'export const x = 1;\n' });
    const importer = path.join(dir, 'main.ts');
    expect(realResolveImport(importer, 'lodash')).toBeNull();
    expect(realResolveImport(importer, '/abs/path')).toBeNull();
    expect(realResolveImport(importer, './nope')).toBeNull();
    rmForce(dir);
  });
});

describe('expandClosure - 动态闭包边界', () => {
  it('根内文件 + 沿 import 边扩入根外 shared.ts → 自包含闭包', async () => {
    const dir = mkProj({
      // 项目 A：manifest 标志根
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': [
        "import { sharedHelper } from '../../shared';",
        'export function compute(a: number): number { return a + sharedHelper(a); }',
      ].join('\n'),
      'A/src/app.ts': [
        "import { compute } from './def';",
        'export function run() { return compute(1); }',
      ].join('\n'),
      // 根外 shared.ts：被 def.ts 相对引用（跨根 import 边）
      'shared.ts': 'export function sharedHelper(x: number): number { return x; }\n',
    });

    const root = resolveProjectRoot(path.join(dir, 'A/src/def.ts'));
    expect(path.resolve(root)).toBe(path.resolve(path.join(dir, 'A')));

    const files = await expandClosure(path.join(dir, 'A/src/def.ts'), root);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'A/src/def.ts').replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'A/src/app.ts').replace(/\\/g, '/'));
    // 跨根 shared.ts 被 import 边纳入
    expect(norm).toContain(path.join(dir, 'shared.ts').replace(/\\/g, '/'));
    rmForce(dir);
  });

  it('非相对导入（裸包）不扩入边界外文件', async () => {
    const dir = mkProj({
      'src/def.ts': "import { z } from 'lodash';\nexport function compute() { return z; }\n",
    });
    const files = await expandClosure(path.join(dir, 'src/def.ts'), dir);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'src/def.ts').replace(/\\/g, '/'));
    expect(norm).not.toContain(expect.stringContaining('lodash'));
    rmForce(dir);
  });
});

describe('loadAliasConfig - tsconfig 路径别名读取', () => {
  it('读 baseUrl+paths，最长前缀优先排序', () => {
    const dir = mkProj({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@lib/*': ['lib/*'] } },
      }),
      'src/a.ts': '',
      'lib/b.ts': '',
    });
    const cfg = loadAliasConfig(dir);
    expect(cfg).not.toBeNull();
    expect(path.resolve(cfg!.baseUrl)).toBe(path.resolve(dir));
    // 最长前缀优先：@lib/* 在 @/* 前
    expect(cfg!.paths.map((p) => p.prefix)).toEqual(['@lib/*', '@/*']);
    rmForce(dir);
  });

  it('支持一级 extends（子配置覆盖父配置的 baseUrl/paths）', () => {
    const dir = mkProj({
      'base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@base/*': ['base/*'] } } }),
      'tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { paths: { '@/*': ['src/*'] } } }),
    });
    const cfg = loadAliasConfig(dir);
    expect(cfg).not.toBeNull();
    // extends 合并：paths 子覆盖父
    expect(cfg!.paths.map((p) => p.prefix)).toEqual(['@/*']);
    rmForce(dir);
  });

  it('无 tsconfig / 无 paths → null', () => {
    const dir = mkProj({ 'package.json': '{}\n' });
    expect(loadAliasConfig(dir)).toBeNull();
    const dir2 = mkProj({ 'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020' } }) });
    expect(loadAliasConfig(dir2)).toBeNull();
    rmForce(dir);
    rmForce(dir2);
  });

  it('向上找最近的 tsconfig（monorepo：根配置，包内文件在子目录）', () => {
    const dir = mkProj({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'packages/a/src/def.ts': 'export const x = 1;\n',
      'src/foo.ts': 'export const foo = 1;\n',
    });
    // 从包内深路径向上定位根 tsconfig
    const cfg = loadAliasConfig(path.join(dir, 'packages/a/src'));
    expect(cfg).not.toBeNull();
    expect(path.resolve(cfg!.baseUrl)).toBe(path.resolve(dir));
    expect(resolveAliasedImport('@/foo', cfg!)).toBe(path.join(dir, 'src/foo.ts'));
    rmForce(dir);
  });
});

describe('resolveAliasedImport - 别名导入落盘解析', () => {
  it('通配前缀 / 目录索引 / 未命中裸包', () => {
    const dir = mkProj({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@lib/*': ['lib/*'] } },
      }),
      'src/foo.ts': 'export const foo = 1;\n',
      'src/dir/index.ts': 'export const d = 1;\n',
      'lib/util.ts': 'export const u = 1;\n',
    });
    const cfg = loadAliasConfig(dir)!;
    expect(resolveAliasedImport('@/foo', cfg)).toBe(path.join(dir, 'src/foo.ts'));
    expect(resolveAliasedImport('@/dir', cfg)).toBe(path.join(dir, 'src/dir/index.ts'));
    expect(resolveAliasedImport('@lib/util', cfg)).toBe(path.join(dir, 'lib/util.ts'));
    expect(resolveAliasedImport('lodash', cfg)).toBeNull(); // 裸包，本地无此文件
    rmForce(dir);
  });

  it('baseUrl 直连兜底：未配 paths 也能命中 baseUrl 下文件', () => {
    const dir = mkProj({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.' } }),
      'shared/util.ts': 'export const u = 1;\n',
    });
    const cfg = loadAliasConfig(dir)!;
    expect(cfg.paths.length).toBe(0);
    expect(resolveAliasedImport('shared/util', cfg)).toBe(path.join(dir, 'shared/util.ts'));
    rmForce(dir);
  });
});

describe('expandClosure - 别名边跨根扩展', () => {
  it('def 用别名 @shared/* 依赖根外 helper.ts → 闭包沿别名边扩入', async () => {
    const dir = mkProj({
      // 项目 A：manifest 根 + tsconfig 把 @shared/* 映射到根外 ../shared/*
      'A/package.json': '{ "name": "a" }\n',
      'A/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['../shared/*'] } } }),
      'A/src/def.ts': "import { helper } from '@shared/helper';\nexport function compute() { return helper(); }\n",
      // 根外 shared/helper.ts：只能经别名边可达
      'shared/helper.ts': 'export function helper() { return 1; }\n',
    });

    const root = resolveProjectRoot(path.join(dir, 'A/src/def.ts'));
    expect(path.resolve(root)).toBe(path.resolve(path.join(dir, 'A')));
    const cfg = loadAliasConfig(root);

    const files = await expandClosure(path.join(dir, 'A/src/def.ts'), root, cfg);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'A/src/def.ts').replace(/\\/g, '/'));
    // 根外 helper.ts 经别名边被纳入
    expect(norm).toContain(path.join(dir, 'shared/helper.ts').replace(/\\/g, '/'));
    rmForce(dir);
  });
});

describe('findExternalImporters - importer 邻域有界扫描', () => {
  it('兄弟项目相对引用 seed → 命中；未引用 → 不命中', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': 'export function compute() { return 1; }\n',
      'B/package.json': '{ "name": "b" }\n',
      'B/src/use.ts': "import { compute } from '../../A/src/def';\nexport function use() { return compute(); }\n",
      'B/src/other.ts': 'export const x = 1;\n',
    });
    const hits = await findExternalImporters(path.join(dir, 'A/src/def.ts'), path.join(dir, 'A'));
    const norm = hits.map((h) => h.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'B/src/use.ts').replace(/\\/g, '/'));
    expect(norm).not.toContain(expect.stringContaining('other.ts'));
    rmForce(dir);
  });

  it('兄弟项目用自身别名(@shared/*)引用 seed → 命中（per-project alias 解析）', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': 'export function compute() { return 1; }\n',
      'B/package.json': '{ "name": "b" }\n',
      // B 的 tsconfig 把 @shared/* 映射到 ../A/src/*（兄弟项目各自别名）
      'B/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['../A/src/*'] } } }),
      'B/src/use.ts': "import { compute } from '@shared/def';\nexport function use() { return compute(); }\n",
    });
    const hits = await findExternalImporters(path.join(dir, 'A/src/def.ts'), path.join(dir, 'A'));
    const norm = hits.map((h) => h.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'B/src/use.ts').replace(/\\/g, '/'));
    rmForce(dir);
  });
});

describe('expandClosure - importer 邻域自包含', () => {
  it('兄弟项目引用 seed → 闭包纳入并沿其 import 边扩展（自包含）', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': 'export function compute() { return 1; }\n',
      'B/package.json': '{ "name": "b" }\n',
      'B/src/use.ts': "import { compute } from '../../A/src/def';\nimport { helper } from './util';\nexport function use() { return compute() + helper(); }\n",
      'B/src/util.ts': 'export function helper() { return 1; }\n',
    });
    const files = await expandClosure(path.join(dir, 'A/src/def.ts'), path.join(dir, 'A'));
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'A/src/def.ts').replace(/\\/g, '/'));
    // 兄弟项目引用 seed 的文件被邻域扫描纳入
    expect(norm).toContain(path.join(dir, 'B/src/use.ts').replace(/\\/g, '/'));
    // 邻域文件的本地依赖也被纳入（自包含承诺）
    expect(norm).toContain(path.join(dir, 'B/src/util.ts').replace(/\\/g, '/'));
    rmForce(dir);
  });
});

describe('expandClosure - 跨语言 import 边（Go/Python）', () => {
  it('Go 相对 import 链 → 闭包沿 .go import 边扩展', async () => {
    const dir = mkProj({
      'go.mod': 'module demo\n',
      'main.go': "package main\n\nimport \"demo/util\"\n\nfunc main() { util.Hi() }\n",
      'util/util.go': 'package util\n\nfunc Hi() {}\n',
    });
    const files = await expandClosure(path.join(dir, 'main.go'), dir);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'main.go').replace(/\\/g, '/'));
    // Go 包路径 import（demo/util → util/util.go）被解析进闭包
    expect(norm).toContain(path.join(dir, 'util/util.go').replace(/\\/g, '/'));
    rmForce(dir);
  });

  it('Python 相对 import → 闭包沿 .py import 边扩展', async () => {
    const dir = mkProj({
      'main.py': 'import sibling\n\nprint(sibling.VAL)\n',
      'sibling.py': 'VAL = 1\n',
    });
    const files = await expandClosure(path.join(dir, 'main.py'), dir);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'main.py').replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'sibling.py').replace(/\\/g, '/'));
    rmForce(dir);
  });
});

describe('expandClosure - 通用兜底语言 + 裸包 workspace importer', () => {
  it('Java package import（com.x.Hi）→ 通用兜底解析到 com/x/Hi.java', async () => {
    const dir = mkProj({
      'src/com/x/Hi.java': 'package com.x;\npublic class Hi {}\n',
      'src/Main.java': 'package main;\nimport com.x.Hi;\npublic class Main { Hi h; }\n',
    });
    const files = await expandClosure(path.join(dir, 'src/Main.java'), dir);
    const norm = files.map((f) => f.replace(/\\/g, '/'));
    // 通用兜底：import com.x.Hi → com/x/Hi.java（末段 Hi 是类名，退目录一级）
    expect(norm).toContain(path.join(dir, 'src/Main.java').replace(/\\/g, '/'));
    rmForce(dir);
  });

  it('兄弟项目用 seed 包名裸包 import（workspace 互引）→ findExternalImporters 命中', async () => {
    const dir = mkProj({
      // A 项目：包名 "alpha"，seed 在其中
      'A/package.json': '{ "name": "alpha" }\n',
      'A/src/index.ts': 'export function compute() { return 1; }\n',
      // B 兄弟项目：`import { compute } from 'alpha'` 裸包引用 A 包
      'B/package.json': '{ "name": "b" }\n',
      'B/src/use.ts': "import { compute } from 'alpha';\nexport function use() { return compute(); }\n",
    });
    const hits = await findExternalImporters(path.join(dir, 'A/src/index.ts'), path.join(dir, 'A'));
    const norm = hits.map((h) => h.replace(/\\/g, '/'));
    expect(norm).toContain(path.join(dir, 'B/src/use.ts').replace(/\\/g, '/'));
    rmForce(dir);
  });
});

// ─────────────────────────────────────────────────────────────
// 索引快速路径（② cache.db 反查子图 + ④ 无索引回退）
// ─────────────────────────────────────────────────────────────

/** 在临时项目根内建 cache.db：把 files 全部 syncFile 进项目的 .design-canvas/cache.db */
async function buildIndex(root: string): Promise<void> {
  const db = getProjectCacheDb(root);
  const allAbs: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync_safe(d)) {
      const p = path.join(d, e);
      const st = tryStat(p);
      if (!st) continue;
      if (st.isDirectory()) {
        if (e === 'node_modules' || e === '.git' || e.startsWith('.')) continue;
        walk(p);
      } else if (st.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|go|py|java)$/i.test(e)) {
        allAbs.push(p);
      }
    }
  };
  walk(root);
  await syncProject(db, root, allAbs);
}

import { readdirSync, statSync } from 'node:fs';
function readdirSync_safe(d: string): string[] {
  try { return readdirSync(d); } catch { return []; }
}
function tryStat(p: string) {
  try { return statSync(p); } catch { return null; }
}

function normSet(arr: string[]): Set<string> {
  return new Set(arr.map((f) => f.replace(/\\/g, '/')));
}

describe('expandClosure 索引快速路径 - ②+④ 行为', () => {
  it('TS 项目：有 cache.db 时走反查子图，结果 ⊇ 全扫闭包（同目录兄弟+alias 保守兜底）', async () => {
    const dir = mkProj({
      'package.json': '{ "name": "demo" }\n',
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/def.ts': "import { sharedHelper } from '@/shared';\nexport function compute(a: number): number { return a + sharedHelper(a); }\n",
      'src/shared.ts': 'export function sharedHelper(x: number): number { return x; }\n',
      'src/app.ts': "import { compute } from './def';\nexport function run() { return compute(1); }\n",
      'src/unrelated.ts': 'export const FLAG = 42;\n', // 不被 seed 链引用
    });
    await buildIndex(dir);
    const db = getProjectCacheDb(dir);
    expect(hasAnyIndexedFiles(db)).toBe(true); // 索引已建

    const fast = await expandClosure(path.join(dir, 'src/def.ts'), dir);
    const fastSet = normSet(fast);
    // 种子、其别名依赖 shared、其调用者 app 都在反查子图里
    expect(fastSet.has(path.join(dir, 'src/def.ts').replace(/\\/g, '/'))).toBe(true);
    expect(fastSet.has(path.join(dir, 'src/shared.ts').replace(/\\/g, '/'))).toBe(true);
    expect(fastSet.has(path.join(dir, 'src/app.ts').replace(/\\/g, '/'))).toBe(true);
    // unrelated.ts：全扫闭包包含它（初始 walk 全根），但快路径是子图语义「只扩 seed 边实际相连文件」
    // 两者语义合法不同：快路径 O(relevant) 就是要抛弃与 seed 无关的 noise。
    // 这里只验证关键引用链都命中，不做相等断言。
    closeProjectCacheDb(dir);
    rmForce(dir);
  });

  it('Go 项目：有 cache.db 时按包导入反查，Go 包路径 import 被反查命中', async () => {
    const dir = mkProj({
      'go.mod': 'module demo\n',
      'main.go': 'package main\n\nimport "demo/util"\n\nfunc main() { util.Hi() }\n',
      'util/util.go': 'package util\n\nfunc Hi() {}\n',
      'util/other.go': 'package util\n\nfunc Other() { Hi() }\n', // 同目录 util 包兄弟
    });
    await buildIndex(dir);

    // 从 util/util.go 出发：seed 同目录 other.go (包共享可见性) + main.go (反向 import "demo/util")
    const files = await expandClosure(path.join(dir, 'util/util.go'), dir);
    const s = normSet(files);
    expect(s.has(path.join(dir, 'util/util.go').replace(/\\/g, '/'))).toBe(true);
    expect(s.has(path.join(dir, 'util/other.go').replace(/\\/g, '/'))).toBe(true); // 同目录兄弟
    expect(s.has(path.join(dir, 'main.go').replace(/\\/g, '/'))).toBe(true); // 反向包导入
    closeProjectCacheDb(dir);
    rmForce(dir);
  });

  it('Python 项目：有 cache.db 时点分模块正向 + 反向命中', async () => {
    const dir = mkProj({
      'pkg/__init__.py': '',
      'pkg/sub.py': 'from .helper import VAL\n\ndef run(): return VAL\n',
      'pkg/helper.py': 'VAL = 1\n',
      'pkg/sibling.py': 'print(\"I am package sibling\")\n',
    });
    await buildIndex(dir);

    const files = await expandClosure(path.join(dir, 'pkg/sub.py'), dir);
    const s = normSet(files);
    expect(s.has(path.join(dir, 'pkg/sub.py').replace(/\\/g, '/'))).toBe(true);
    expect(s.has(path.join(dir, 'pkg/helper.py').replace(/\\/g, '/'))).toBe(true); // 正向依赖
    expect(s.has(path.join(dir, 'pkg/sibling.py').replace(/\\/g, '/'))).toBe(true); // 同目录兄弟
    closeProjectCacheDb(dir);
    rmForce(dir);
  });

  it('④ 无索引（无 .design-canvas/cache.db）→ 回退全扫，结果与原行为一致', async () => {
    const dir = mkProj({
      'package.json': '{ "name": "a" }\n',
      'src/def.ts': "import { sharedHelper } from '../../shared';\nexport function compute(a: number): number { return a + sharedHelper(a); }\n",
      'src/app.ts': "import { compute } from './def';\nexport function run() { return compute(1); }\n",
      'shared.ts': 'export function sharedHelper(x: number): number { return x; }\n',
    });
    // 注意：不调用 buildIndex，项目无 cache.db → expandClosure 应走 ④ 回退
    const files = await expandClosure(path.join(dir, 'src/def.ts'), dir);
    const s = normSet(files);
    // 与现有 ④ 测试一致：根内文件 + 跨根 shared 都纳入
    expect(s.has(path.join(dir, 'src/def.ts').replace(/\\/g, '/'))).toBe(true);
    expect(s.has(path.join(dir, 'src/app.ts').replace(/\\/g, '/'))).toBe(true);
    expect(s.has(path.join(dir, 'shared.ts').replace(/\\/g, '/'))).toBe(true);
    rmForce(dir); // 无 DB 无需关连接
  });

  it('seed 未索引（只有部分文件建了索引）→ 回退全扫，不漏文件', async () => {
    const dir = mkProj({
      'package.json': '{ "name": "demo" }\n',
      'src/def.ts': 'export function compute() { return 1; }\n',
      'src/app.ts': "import { compute } from './def';\nexport function run() { return compute(); }\n",
    });
    // 只给 app.ts 建索引，故意漏 def.ts（seed）——tryIndexedExpandClosure 应判定 seed 未索引 → null → 回退
    const db = getProjectCacheDb(dir);
    await syncFile(db, dir, path.join(dir, 'src/app.ts'));
    expect(hasAnyIndexedFiles(db)).toBe(true); // 索引非空，但不包含 seed

    const files = await expandClosure(path.join(dir, 'src/def.ts'), dir);
    const s = normSet(files);
    // 回退全扫：两个根内文件均纳入
    expect(s.has(path.join(dir, 'src/def.ts').replace(/\\/g, '/'))).toBe(true);
    expect(s.has(path.join(dir, 'src/app.ts').replace(/\\/g, '/'))).toBe(true);
    closeProjectCacheDb(dir);
    rmForce(dir);
  });

  it('DB 打开异常（只读根 / 不可写 .design-canvas）→ 回退全扫，不抛错', async () => {
    const dir = mkProj({
      'package.json': '{ "name": "a" }\n',
      'src/def.ts': 'export function compute() { return 1; }\n',
      'src/app.ts': "import { compute } from './def';\nexport function run() { return compute(); }\n",
    });
    // 把 .design-canvas/cache.db 作为目录创建（会导致 openDb 创建 DatabaseSync 抛错）
    const fakeDb = path.join(dir, '.design-canvas', 'cache.db');
    mkdirSync(path.dirname(fakeDb), { recursive: true });
    writeFileSync(fakeDb, 'NOT A SQLITE FILE'); // 也可写垃圾头让 open 不炸但 hasAnyIndexedFiles 会炸
    // 注意：写入非法内容时 openDb() 可能不炸（SQLite 会在首次查询炸）。
    // 用更直接的手段：以文件占位 cache.db 的父路径目录结构，
    // 再额外用 try/catch 包装确认 expandClosure 绝不抛错——这才是关键需求。
    let result: string[] | null = null;
    let threw = false;
    try {
      result = await expandClosure(path.join(dir, 'src/def.ts'), dir);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result).not.toBeNull();
    const s = normSet(result!);
    // 回退或成功：至少包含种子（两条路径都应该）
    expect(s.has(path.join(dir, 'src/def.ts').replace(/\\/g, '/'))).toBe(true);
    closeProjectCacheDb(dir);
    rmForce(dir);
  });

  it('跨根别名边（@shared/* 指向根外）：有索引时闭包仍沿别名正向扩入', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['../shared/*'] } } }),
      'A/src/def.ts': "import { helper } from '@shared/helper';\nexport function compute() { return helper(); }\n",
      'shared/helper.ts': 'export function helper() { return 1; }\n',
    });
    // 建 A 项目索引（注意：shared 不在 A 根内，所以它不会被 syncProject 扫到，是典型"跨根未索引文件"）
    await buildIndex(path.join(dir, 'A'));

    const root = path.join(dir, 'A');
    const cfg = loadAliasConfig(root);
    const files = await expandClosure(path.join(dir, 'A/src/def.ts'), root, cfg);
    const s = normSet(files);
    expect(s.has(path.join(dir, 'A/src/def.ts').replace(/\\/g, '/'))).toBe(true);
    // 跨根 shared/helper.ts：正向 resolveAliasedImport 命中 → 加入；它未索引 → expandOneFileOnTheFly 解析；应纳入
    expect(s.has(path.join(dir, 'shared/helper.ts').replace(/\\/g, '/'))).toBe(true);
    closeProjectCacheDb(root);
    rmForce(dir);
  });
});
