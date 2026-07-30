/**
 * src/db 符号缓存层单元测试
 *
 * 覆盖：schema 幂等打开、初始同步、hash 增量跳过、单文件变更重同步、
 * import 边在目标文件重同步后存活（文件节点 UPSERT 不删除的核心约定）、
 * 符号删除后 FTS 触发器同步、FTS5 trigram 搜索（中文/标识符子串）、removeFile 级联。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from '../../src/db/db';
import { openDb } from '../../src/db/db';
import {
  syncFile,
  syncProject,
  removeFile,
  searchSymbols,
  getIndexStats,
  getFileParse,
  resolveImportTarget,
} from '../../src/db/symbols';

const FILE_A = `import { helperB } from './b';

/** 解析配置入口 */
export function parseConfig(input: string): object {
  return helperB(input);
}

export class ConfigLoader {
  load(p: string): object {
    return parseConfig(p);
  }
}
`;

const FILE_B = `export function helperB(x: string): object {
  return { x };
}
`;

let dir: string;
let db: Database;
let dbFile: string;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-db-test-'));
  dbFile = path.join(dir, '.design-canvas', 'cache.db');
  writeProjectFile('a.ts', FILE_A);
  writeProjectFile('b.ts', FILE_B);
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('openDb - schema 初始化', () => {
  it('重复打开同一文件幂等', () => {
    const db2 = openDb(dbFile);
    const v = db2.prepare('SELECT COUNT(*) c FROM schema_versions').get() as { c: number };
    expect(v.c).toBe(1);
    db2.close();
  });
});

describe('syncProject - 初始同步与增量跳过', () => {
  it('首次同步两文件 updated，FTS/节点/边齐全', async () => {
    const res = await syncProject(db, dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')]);
    expect(res.updated).toBe(2);
    expect(res.failed).toBe(0);

    const stats = getIndexStats(db);
    // 2 文件节点 + parseConfig/ConfigLoader/load/helperB 等符号节点
    expect(stats.files).toBe(2);
    expect(stats.nodes).toBeGreaterThanOrEqual(5);
    expect(stats.edges).toBe(1); // a.ts → b.ts import
  });

  it('hash 未变重跑全部 skipped', async () => {
    const files = [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')];
    await syncProject(db, dir, files);
    const res = await syncProject(db, dir, files);
    expect(res.skipped).toBe(2);
    expect(res.updated).toBe(0);
  });

  it('单文件变更只重同步该文件', async () => {
    const files = [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')];
    await syncProject(db, dir, files);
    writeProjectFile('b.ts', `${FILE_B}\nexport function renderWidget(): string { return 'w'; }\n`);
    const res = await syncProject(db, dir, files);
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.results.find((r) => r.path === 'b.ts')?.node_count).toBe(2);
  });
});

describe('import 边生命周期', () => {
  it('目标文件重同步后 import 边仍存活（文件节点 UPSERT 不删除）', async () => {
    const aAbs = path.join(dir, 'a.ts');
    await syncFile(db, dir, aAbs); // 先同步 a：b 未同步，走桩节点
    const edgeBefore = db
      .prepare("SELECT COUNT(*) c FROM edges WHERE kind='import' AND source='a.ts' AND target='b.ts'")
      .get() as { c: number };
    expect(edgeBefore.c).toBe(1);

    await syncFile(db, dir, path.join(dir, 'b.ts')); // b 正式同步（ON CONFLICT 回填桩）
    const edgeAfter = db
      .prepare("SELECT COUNT(*) c FROM edges WHERE kind='import' AND source='a.ts' AND target='b.ts'")
      .get() as { c: number };
    expect(edgeAfter.c).toBe(1);
  });

  it('removeFile 删除目标文件后级联清边', async () => {
    await syncProject(db, dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')]);
    removeFile(db, dir, path.join(dir, 'b.ts'));
    const stats = getIndexStats(db);
    expect(stats.files).toBe(1);
    expect(stats.edges).toBe(0);
    expect(searchSymbols(db, 'helperB')).toEqual([]);
  });
});

describe('searchSymbols - FTS5 trigram', () => {
  beforeEach(async () => {
    await syncProject(db, dir, [path.join(dir, 'a.ts'), path.join(dir, 'b.ts')]);
  });

  it('完整标识符命中', () => {
    const hits = searchSymbols(db, 'parseConfig');
    expect(hits.length).toBe(1);
    expect(hits[0].file_path).toBe('a.ts');
    expect(hits[0].kind).toBe('function');
  });

  it('标识符子串命中（trigram 特性）', () => {
    const hits = searchSymbols(db, 'Config');
    const names = hits.map((h) => h.name);
    expect(names).toContain('parseConfig');
    expect(names).toContain('ConfigLoader');
  });

  it('<3 字符返回空', () => {
    expect(searchSymbols(db, 'ab')).toEqual([]);
  });

  it('文件节点不出现在搜索结果', () => {
    const hits = searchSymbols(db, 'helperB');
    expect(hits.every((h) => h.kind !== 'file')).toBe(true);
  });

  it('符号从文件删除后 FTS 同步清除', async () => {
    writeProjectFile('a.ts', 'export function onlyOne(): number { return 1; }\n');
    await syncFile(db, dir, path.join(dir, 'a.ts'));
    expect(searchSymbols(db, 'parseConfig')).toEqual([]);
    expect(searchSymbols(db, 'onlyOne').length).toBe(1);
  });
});

describe('resolveImportTarget - 相对导入解析', () => {
  it('省略扩展名解析', () => {
    expect(resolveImportTarget(dir, 'a.ts', './b')).toBe('b.ts');
  });

  it('嵌套目录 + index 解析', () => {
    writeProjectFile('lib/util/index.ts', 'export const x = 1;\n');
    expect(resolveImportTarget(dir, 'a.ts', './lib/util')).toBe('lib/util/index.ts');
  });

  it('解析不到返回 null', () => {
    expect(resolveImportTarget(dir, 'a.ts', './nonexistent')).toBeNull();
  });
});

describe('syncFile - 失败重试语义', () => {
  it('不支持的扩展名记为 ignored 语义（node_count 0）', async () => {
    const mdAbs = writeProjectFile('README.md', '# hi\n');
    const res = await syncFile(db, dir, mdAbs);
    // 未支持语言：不写符号节点，但 files 行记录 hash（下次跳过）
    expect(res.status === 'updated' || res.status === 'ignored').toBe(true);
    expect(res.node_count).toBe(0);
    const row = db.prepare('SELECT language, node_count FROM files WHERE path = ?').get('README.md') as
      | { language: string; node_count: number }
      | undefined;
    expect(row?.node_count).toBe(0);
  });
});

describe('imports 表与 getFileParse（import_project 缓存读取路径）', () => {
  const FILE_C = `import { join } from 'node:path';
import { helperB } from './b';

export function buildPath(x: string): string {
  return join('a', helperB(x));
}
`;

  it('syncFile 写入原始 import 记录（relative + package 全量种类）', async () => {
    writeProjectFile('c.ts', FILE_C);
    await syncFile(db, dir, path.join(dir, 'c.ts'));
    const rows = db
      .prepare('SELECT source, kind FROM imports WHERE file_path = ? ORDER BY line')
      .all('c.ts') as Array<{ source: string; kind: string }>;
    // package 导入也必须留存——edges 表只建相对导入边，丢了它缓存路径会静默丢 Go/Python 依赖
    expect(rows).toEqual([
      { source: 'node:path', kind: 'package' },
      { source: './b', kind: 'relative' },
    ]);
  });

  it('getFileParse 返回行数 + 符号 + imports；未索引文件返回 null', async () => {
    writeProjectFile('c.ts', FILE_C);
    expect(getFileParse(db, 'c.ts')).toBeNull();
    await syncFile(db, dir, path.join(dir, 'c.ts'));
    const cached = getFileParse(db, 'c.ts')!;
    expect(cached).not.toBeNull();
    expect(cached.line_count).toBe(6);
    expect(cached.imports.length).toBe(2);
    const names = cached.symbols.map((s) => s.name);
    expect(names).toContain('buildPath');
    expect(cached.symbols[0].start_line).toBeGreaterThan(0);
  });

  it('removeFile 连同 imports 记录一起清除', async () => {
    writeProjectFile('c.ts', FILE_C);
    await syncFile(db, dir, path.join(dir, 'c.ts'));
    removeFile(db, dir, path.join(dir, 'c.ts'));
    const rows = db.prepare('SELECT COUNT(*) c FROM imports WHERE file_path = ?').get('c.ts') as { c: number };
    expect(rows.c).toBe(0);
    expect(getFileParse(db, 'c.ts')).toBeNull();
  });
});

describe('openDb - 版本迁移（v1→v2 清空重建）', () => {
  it('旧版本缓存被清空并登记新版本（缓存是派生物，不做保留式迁移）', async () => {
    const migDbFile = path.join(dir, 'mig', 'cache.db');
    // 首轮：正常打开落 v2，同步一个文件造数据，然后伪装成 v1
    let mdb = openDb(migDbFile);
    await syncFile(mdb, dir, path.join(dir, 'a.ts'));
    mdb.exec('DELETE FROM schema_versions');
    mdb.prepare('INSERT INTO schema_versions(version, applied_at, description) VALUES (1, ?, ?)').run(Date.now(), 'fake v1');
    mdb.close();
    // 重新打开：检测到 MAX(version)=1 < 2 → 清空业务表强制重建
    mdb = openDb(migDbFile);
    const files = mdb.prepare('SELECT COUNT(*) c FROM files').get() as { c: number };
    expect(files.c).toBe(0);
    const nodes = mdb.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number };
    expect(nodes.c).toBe(0);
    const vers = (mdb.prepare('SELECT version FROM schema_versions ORDER BY version').all() as Array<{ version: number }>).map(
      (v) => v.version,
    );
    expect(vers).toEqual([1, 2]);
    mdb.close();
  });
});
