/**
 * import_project 缓存路径测试（cache_db 增量解析）
 *
 * 覆盖：
 *   - 缓存路径与全量解析产出一致（依赖边 / API 面），含 Go 包导入边存活
 *   - 二次运行全部命中缓存（hits=N, reparsed=0），结果不变
 *   - 单文件变更只重解析该文件，DSL 同步更新
 *
 * db 文件放在独立临时目录（不在 fixture 项目内），避免干扰文件扫描。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { getDSL } from '../../src/storage';
import { openDb } from '../../src/db/db';

let fixtureRoot: string;
let dbDir: string;

function put(rel: string, content: string): void {
  const abs = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** 边集合（feature 无关的可比形式） */
function edgeSet(feature: string): string[] {
  const dsl = getDSL(feature)!;
  return (dsl.geometry.edges || []).map((e) => `${e.from}→${e.to}:${e.label}`).sort();
}

/** 语义层 API 面：文件路径 → API 签名列表 */
function apiMap(feature: string): Map<string, string[]> {
  const dsl = getDSL(feature)!;
  return new Map(dsl.semantic.files.map((f) => [f.path, (f.expected_apis || []).map((a) => a.signature).sort()]));
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cache-fixture-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cache-db-'));

  // TypeScript: a.ts → b.ts（相对导入）
  put('src/a.ts', `import { helperB } from './b';\n\nexport function mainA(x: number): number {\n  return helperB(x);\n}\n`);
  put('src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);

  // Go: svc.go → model.go（包导入——只有 imports 表存了原始 source 串，缓存路径才能重建这条边）
  put('go.mod', 'module example.com/demo\n\ngo 1.21\n');
  put('pkg/model/model.go', 'package model\n\ntype User struct {\n\tName string\n}\n\nfunc NewUser(name string) *User {\n\treturn &User{Name: name}\n}\n');
  put('pkg/svc/svc.go', 'package svc\n\nimport "example.com/demo/pkg/model"\n\nfunc GetUser() *model.User {\n\treturn model.NewUser("alice")\n}\n');
});

afterAll(() => {
  for (const d of [fixtureRoot, dbDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

describe('import_project 缓存路径', () => {
  it('缓存路径与全量解析产出一致（依赖边 + API 面）', async () => {
    const fresh = await importProject({ project_dir: fixtureRoot, feature: 'cache_cmp_fresh' });
    const db = openDb(path.join(dbDir, 'cmp.db'));
    const cached = await importProject({ project_dir: fixtureRoot, feature: 'cache_cmp_cached', cache_db: db });
    db.close();

    expect(cached.cache).toEqual({ hits: 0, reparsed: 4, failed: 0 });
    expect(cached.files_parsed).toBe(fresh.files_parsed);
    expect(cached.symbols_found).toBe(fresh.symbols_found);
    expect(cached.dep_edges).toBe(fresh.dep_edges);
    expect(edgeSet('cache_cmp_cached')).toEqual(edgeSet('cache_cmp_fresh'));
    expect(apiMap('cache_cmp_cached')).toEqual(apiMap('cache_cmp_fresh'));
    // Go 包导入边在缓存路径存活（imports 表存原始 source 串的意义）
    expect(edgeSet('cache_cmp_cached')).toContain('dir_pkg_svc→dir_pkg_model:imports');
  });

  it('二次运行全部命中缓存，DSL 不变', async () => {
    const db = openDb(path.join(dbDir, 'twice.db'));
    const r1 = await importProject({ project_dir: fixtureRoot, feature: 'cache_run1', cache_db: db });
    expect(r1.cache).toEqual({ hits: 0, reparsed: 4, failed: 0 });
    const r2 = await importProject({ project_dir: fixtureRoot, feature: 'cache_run2', cache_db: db });
    db.close();

    expect(r2.cache).toEqual({ hits: 4, reparsed: 0, failed: 0 });
    expect(r2.symbols_found).toBe(r1.symbols_found);
    expect(r2.dep_edges).toBe(r1.dep_edges);
    expect(edgeSet('cache_run2')).toEqual(edgeSet('cache_run1'));
    expect(apiMap('cache_run2')).toEqual(apiMap('cache_run1'));
  });

  it('单文件变更只重解析该文件，DSL 同步更新', async () => {
    const db = openDb(path.join(dbDir, 'mod.db'));
    const r1 = await importProject({ project_dir: fixtureRoot, feature: 'cache_mod1', cache_db: db });

    put('src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n\nexport function extraB(): string {\n  return 'e';\n}\n`);
    const r2 = await importProject({ project_dir: fixtureRoot, feature: 'cache_mod2', cache_db: db });
    db.close();

    expect(r2.cache).toEqual({ hits: 3, reparsed: 1, failed: 0 });
    expect(r2.symbols_found).toBe(r1.symbols_found + 1); // extraB
    const bApis = apiMap('cache_mod2').get('src/b.ts')!;
    expect(bApis.some((s) => s.includes('extraB'))).toBe(true);
    // 依赖边不因增量而丢失
    expect(edgeSet('cache_mod2')).toContain('file_src_a_ts→file_src_b_ts:imports');
  });

  // 注意：本测试会增删共享 fixture 文件，必须放在最后
  it('文件删除后缓存自动清理（删除侦测），DSL 同步剔除', async () => {
    put('src/c.ts', `export function loneC(): number {\n  return 3;\n}\n`);
    const db = openDb(path.join(dbDir, 'del.db'));
    const r1 = await importProject({ project_dir: fixtureRoot, feature: 'cache_del1', cache_db: db });
    expect(r1.files_parsed).toBe(5);

    fs.rmSync(path.join(fixtureRoot, 'src/c.ts'));
    const r2 = await importProject({ project_dir: fixtureRoot, feature: 'cache_del2', cache_db: db });

    expect(r2.cache).toEqual({ hits: 4, reparsed: 0, failed: 0 });
    expect(r2.files_parsed).toBe(4);
    expect(r2.skipped.some((s) => s.includes('缓存清理') && s.includes('src/c.ts'))).toBe(true);
    // 缓存内也不留尸体
    const row = db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number };
    expect(row.c).toBe(4);
    // DSL 节点同步剔除
    const nodeIds = getDSL('cache_del2')!.geometry.nodes.map((n) => n.id);
    expect(nodeIds).not.toContain('file_src_c_ts');
    db.close();
  });
});
