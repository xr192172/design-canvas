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
