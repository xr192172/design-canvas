/**
 * harvest_closure 积木拎取闭包测试
 *
 * 覆盖：
 *   - 纯根须闭包：种子 a.ts（a→b）→ {a,b}，调用方 c.ts 不进来（默认 importee 方向）
 *   - 证据链：b.ts 带 imported_by=a.ts + import_source='./b' 原始语句
 *   - include_callers=true：调用方 c.ts 一起端走
 *   - 外部依赖三分类：react=三方 / node:path=标准库（TS）
 *   - Go：fmt=标准库 / github.com/x/y=三方 / example.com 内部包走闭包不算外部
 *   - 种子不在缓存 → 警告；feature 不存在 → 抛错
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { harvestClosure } from '../../src/tools/harvest_closure';
import { openDb } from '../../src/db/db';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** TS 项目：a→b（importee），c→a（caller）；a 另 import react / node:path */
async function makeTsProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-ts-'));
  roots.push(root);
  put(
    root,
    'src/a.ts',
    `import { helperB } from './b';\nimport { useState } from 'react';\nimport path from 'node:path';\n\nexport function mainA(x: number): string {\n  return path.sep + String(useState(x)) + String(helperB(x));\n}\n`,
  );
  put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
  put(root, 'src/c.ts', `import { mainA } from './a';\n\nexport function mainC(x: number): string {\n  return mainA(x) + '!';\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

/** TS 项目（type-only）：a 值引用 b；a 另 type-only 引用 react（运行时擦除，不算依赖） */
async function makeTypeOnlyProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-typeonly-'));
  roots.push(root);
  put(
    root,
    'src/a.ts',
    `import { helperB } from './b';\nimport type { useState } from 'react';\n\nexport function mainA(x: number): number {\n  return helperB(x);\n}\n`,
  );
  put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

/** Go 项目：svc → model（内部包），svc 另 import fmt / github.com/x/y */
async function makeGoProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-go-'));
  roots.push(root);
  put(root, 'go.mod', 'module example.com/demo\n\ngo 1.21\n');
  put(root, 'pkg/model/model.go', 'package model\n\ntype User struct {\n\tName string\n}\n\nfunc NewUser(name string) *User {\n\treturn &User{Name: name}\n}\n');
  put(
    root,
    'pkg/svc/svc.go',
    'package svc\n\nimport (\n\t"fmt"\n\t"github.com/x/y"\n\t"example.com/demo/pkg/model"\n)\n\nfunc GetUser() *model.User {\n\tfmt.Println(y.Tag())\n\treturn model.NewUser("alice")\n}\n',
  );
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

const internalPaths = (r: ReturnType<typeof harvestClosure>) => r.internal_files.map((f) => f.path);

describe('harvest_closure 积木拎取闭包', () => {
  it('纯根须：种子 a.ts → {a,b}，调用方 c.ts 不进来', async () => {
    const root = await makeTsProject('harvest_ts_a');
    const r = harvestClosure({ project_dir: root, files: ['src/a.ts'] });

    expect(r.seeds).toEqual(['src/a.ts']);
    expect(internalPaths(r)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(r.stats.internal_count).toBe(2);
    expect(r.stats.max_depth_reached).toBe(1);
  });

  it('证据链：b.ts 带 imported_by + 原始 import 语句', async () => {
    const root = await makeTsProject('harvest_ts_b');
    const r = harvestClosure({ project_dir: root, files: ['src/a.ts'] });

    const b = r.internal_files.find((f) => f.path === 'src/b.ts')!;
    expect(b.depth).toBe(1);
    expect(b.imported_by).toBe('src/a.ts');
    expect(b.import_source).toContain('./b');
    expect(b.symbol_count).toBeGreaterThan(0);
    expect(b.language).toBe('ts');

    const a = r.internal_files.find((f) => f.path === 'src/a.ts')!;
    expect(a.depth).toBe(0);
    expect(a.imported_by).toBeUndefined();
  });

  it('include_callers=true：调用方 c.ts 一起端走', async () => {
    const root = await makeTsProject('harvest_ts_c');
    const r = harvestClosure({ project_dir: root, files: ['src/a.ts'], include_callers: true });

    expect(internalPaths(r)).toContain('src/c.ts');
    const c = r.internal_files.find((f) => f.path === 'src/c.ts')!;
    expect(c.depth).toBe(1); // a 的直接调用方，一跳即达
  });

  it('外部三分类（TS）：react=三方 / node:path=标准库', async () => {
    const root = await makeTsProject('harvest_ts_d');
    const r = harvestClosure({ project_dir: root, files: ['src/a.ts'] });

    const cls = new Map(r.external.map((e) => [e.source, e.class]));
    expect(cls.get('react')).toBe('third_party');
    expect(cls.get('node:path')).toBe('stdlib');
    expect(r.stats.third_party_count).toBeGreaterThanOrEqual(1);
    expect(r.stats.stdlib_count).toBeGreaterThanOrEqual(1);
    // relative import（./b）不应出现在外部依赖里
    expect(r.external.some((e) => e.source.includes('./b'))).toBe(false);
  });

  it('Go：fmt=标准库 / github.com/x/y=三方 / 内部包走闭包', async () => {
    const root = await makeGoProject('harvest_go_a');
    const r = harvestClosure({ project_dir: root, files: ['pkg/svc/svc.go'] });

    // 内部闭包：svc + model（example.com/demo/pkg/model 已解析为内部边）
    expect(internalPaths(r).sort()).toEqual(['pkg/model/model.go', 'pkg/svc/svc.go']);
    const cls = new Map(r.external.map((e) => [e.source, e.class]));
    expect(cls.get('fmt')).toBe('stdlib');
    expect(cls.get('github.com/x/y')).toBe('third_party');
    // 内部包不能被算成外部三方
    expect(r.external.some((e) => e.source === 'example.com/demo/pkg/model')).toBe(false);
  });

  it('种子不在缓存 → 警告；feature 不存在 → 抛错', async () => {
    const root = await makeTsProject('harvest_ts_e');
    const r = harvestClosure({ project_dir: root, files: ['src/nope.ts'] });
    expect(r.warnings.length).toBe(1);
    expect(r.internal_files).toEqual([]);

    expect(() => harvestClosure({ project_dir: root, files: ['src/a.ts'], feature: 'no_such_feature' })).toThrow();
  });

  it('import type 运行时擦除：type-only 的 react 不进外部依赖', async () => {
    const root = await makeTypeOnlyProject('harvest_typeonly_a');
    const r = harvestClosure({ project_dir: root, files: ['src/a.ts'] });

    // 值引用 b 正常进闭包
    expect(internalPaths(r)).toEqual(['src/a.ts', 'src/b.ts']);
    // type-only 的 react 不算三方依赖（运行时不存在该依赖）
    expect(r.external.some((e) => e.source === 'react')).toBe(false);
    expect(r.stats.third_party_count).toBe(0);
  });
});
