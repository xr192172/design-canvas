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
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
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
    expect(path.resolve(root!)).toBe(path.resolve(path.join(dir, 'outer/inner')));
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

    expect(path.resolve(resolveProjectRoot(path.join(dir, 'outer/inner/src/def.ts')))).toBe(
      path.resolve(path.join(dir, 'outer/inner')),
    );
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
