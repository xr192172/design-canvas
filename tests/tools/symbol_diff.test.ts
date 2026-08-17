/**
 * 符号级 diff（v3）测试：波及源从"整文件所有符号"收敛到"真正改动的符号"
 *
 * 项目结构：b.ts{b1,b2}，a→b1，e→b2 —— 改 b1 时 e 不应波及（符号级收敛的关键验证）
 *
 *   - 改函数体 → changed=[b1]，波及 {b,a}，e 不在
 *   - 只改注释/缩进 → 无实质符号变更，波及为空
 *   - 新增符号 → 无既有调用方，不做波及源
 *   - 删除符号 → 入边已消失，保守回退文件级
 *   - 链式合并 → 同文件连续两次编辑合成净差异（加了又删 = 净无）
 *   - 首次导入 → 无 diff 行，回退文件级
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { syncProject, mergeSymbolStatus, symbolSpanHash } from '../../src/db/symbols';
import { openDb, closeAllProjectCacheDbs, type Database } from '../../src/db/db';
import { diffImpact } from '../../src/tools/diff_impact';
import { runImpactReport } from '../../src/tools/impact_report';

const roots: string[] = [];
const dbs: Database[] = [];

afterAll(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  closeAllProjectCacheDbs();
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

const B0 = `export function b1(x: number): number { return x * 2; }\nexport function b2(x: number): number { return x + 1; }\n`;

/** 初始项目：b.ts{b1,b2}，a 调 b1，e 调 b2 */
async function makeProject(): Promise<{ root: string; db: Database; b0Hash: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'symbol-diff-'));
  roots.push(root);
  put(root, 'src/b.ts', B0);
  put(root, 'src/a.ts', `import { b1 } from './b';\nexport function a(x: number): number { return b1(x); }\n`);
  put(root, 'src/e.ts', `import { b2 } from './b';\nexport function e(x: number): number { return b2(x) + 9; }\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  dbs.push(db);
  await syncProject(db, root, ['src/b.ts', 'src/a.ts', 'src/e.ts'].map((f) => path.join(root, f)));
  return { root, db, b0Hash: crypto.createHash('sha1').update(B0, 'utf-8').digest('hex') };
}

async function resync(root: string, db: Database, rel: string): Promise<void> {
  const r = await syncProject(db, root, [path.join(root, rel)]);
  expect(r.results[0]?.status).toBe('updated');
}

describe('符号级 diff · 单元', () => {
  it('mergeSymbolStatus 净差异合并', () => {
    expect(mergeSymbolStatus('added', 'removed')).toBeUndefined(); // 加了又删 → 净无
    expect(mergeSymbolStatus('added', 'changed')).toBe('added'); // 相对起点仍是新增
    expect(mergeSymbolStatus('removed', 'added')).toBe('changed'); // 删了又回 → 变更
    expect(mergeSymbolStatus('changed', 'removed')).toBe('removed');
    expect(mergeSymbolStatus('changed', 'changed')).toBe('changed');
    expect(mergeSymbolStatus(undefined, 'added')).toBe('added');
    expect(mergeSymbolStatus('changed', undefined)).toBe('changed');
  });

  it('symbolSpanHash 剔除纯注释行与缩进差异', () => {
    const a = symbolSpanHash(['function f() {', '  // 注释', '    return 1;', '}'], 1, 4, 'ts');
    const b = symbolSpanHash(['function f() {', '  return 1;', '}'], 1, 3, 'ts');
    expect(a).toBe(b); // 注释行剔除 + 缩进归一 → 同 hash
    const c = symbolSpanHash(['function f() {', '  return 2;', '}'], 1, 3, 'ts');
    expect(a).not.toBe(c); // 实质变更 → 不同 hash
    const py = symbolSpanHash(['def f():', '    # comment', '    return 1'], 1, 3, 'py');
    const py2 = symbolSpanHash(['def f():', '    return 1'], 1, 2, 'py');
    expect(py).toBe(py2); // py # 注释剔除
  });
});

describe('符号级 diff · 波及源收敛', () => {
  it('首次导入无 diff 行 → 回退文件级（全部符号做源）', async () => {
    const { root } = await makeProject();
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 2 });
    expect(r.symbol_diffs).toHaveLength(1);
    expect(r.symbol_diffs[0].granularity).toBe('file');
    expect(r.symbol_diffs[0].note).toContain('无符号级 diff');
    const qns = r.impacted_symbols.filter((s) => s.depth === 0).map((s) => s.qualified_name).sort();
    expect(qns).toEqual(['b1', 'b2']);
  });

  it('改 b1 函数体 → 波及源只有 b1；e（调 b2）不波及', async () => {
    const { root, db } = await makeProject();
    put(root, 'src/b.ts', `export function b1(x: number): number { return x * 3; }\nexport function b2(x: number): number { return x + 1; }\n`);
    await resync(root, db, 'src/b.ts');
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 2 });
    expect(r.symbol_diffs[0]).toMatchObject({ granularity: 'symbol', changed: ['b1'], added: [], removed: [] });
    const direct = r.impacted_symbols.filter((s) => s.depth === 0).map((s) => s.qualified_name);
    expect(direct).toEqual(['b1']); // b2 未改，不做源
    const files = r.impacted_files.map((f) => f.path).sort();
    expect(files).toEqual(['src/a.ts', 'src/b.ts']); // e 不在——符号级收敛的直接收益
  });

  it('只改注释/空白 → 无实质符号变更，波及清单为空', async () => {
    const { root, db } = await makeProject();
    put(
      root,
      'src/b.ts',
      `// 文件头新注释\nexport function b1(x: number): number {\n  // 函数内整行注释\n  return x * 2;\n}\nexport function b2(x: number): number { return x + 1; }\n`,
    );
    await resync(root, db, 'src/b.ts');
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 2 });
    expect(r.symbol_diffs[0]).toMatchObject({ granularity: 'symbol', changed: [], added: [], removed: [] });
    expect(r.symbol_diffs[0].note).toContain('无实质符号变更');
    expect(r.impacted_files).toEqual([]);
    expect(r.impacted_symbols).toEqual([]);
  });

  it('仅新增符号 → 无既有调用方，不做波及源', async () => {
    const { root, db } = await makeProject();
    put(root, 'src/b.ts', `${B0}export function b3(x: number): number { return x - 1; }\n`);
    await resync(root, db, 'src/b.ts');
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 2 });
    expect(r.symbol_diffs[0]).toMatchObject({ granularity: 'symbol', added: ['b3'], changed: [], removed: [] });
    expect(r.symbol_diffs[0].note).toContain('仅新增');
    expect(r.impacted_files).toEqual([]);
  });

  it('删除符号 → 入边已消失，保守回退文件级', async () => {
    const { root, db } = await makeProject();
    put(root, 'src/b.ts', `export function b1(x: number): number { return x * 2; }\n`); // b2 删除
    await resync(root, db, 'src/b.ts');
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 2 });
    expect(r.symbol_diffs[0].granularity).toBe('file');
    expect(r.symbol_diffs[0].removed).toEqual(['b2']);
    expect(r.symbol_diffs[0].note).toContain('保守');
    // 文件级：b1 做源 → a 波及；e→b2 边已级联消失，无法追溯（保守面里的已知盲区）
    const files = r.impacted_files.map((f) => f.path).sort();
    expect(files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('链式合并：加了又删 = 净无；from_hash 链到最初版本', async () => {
    const { root, db, b0Hash } = await makeProject();
    // 编辑 1：加 tmp
    put(root, 'src/b.ts', `${B0}export function tmp(): number { return 0; }\n`);
    await resync(root, db, 'src/b.ts');
    // 编辑 2：删 tmp + 改 b1（两次编辑间 diff 未消费）
    put(root, 'src/b.ts', `export function b1(x: number): number { return x * 5; }\nexport function b2(x: number): number { return x + 1; }\n`);
    await resync(root, db, 'src/b.ts');
    const row = db
      .prepare('SELECT from_hash, to_hash, added, removed, changed FROM symbol_diffs WHERE file_path = ?')
      .get('src/b.ts') as { from_hash: string; to_hash: string; added: string; removed: string; changed: string };
    expect(JSON.parse(row.added)).toEqual([]); // tmp 加了又删 → 净无
    expect(JSON.parse(row.removed)).toEqual([]);
    expect(JSON.parse(row.changed)).toEqual(['b1']);
    expect(row.from_hash).toBe(b0Hash); // 链式：起点是最初版本而非中间版本
  });
});

describe('符号级 diff · 影响报告摘要', () => {
  it('实质变更：摘要带变更符号名；(b1) 后缀', async () => {
    const { root, db } = await makeProject();
    put(root, 'src/b.ts', `export function b1(x: number): number { return x * 3; }\nexport function b2(x: number): number { return x + 1; }\n`);
    await resync(root, db, 'src/b.ts');
    const s = runImpactReport({ project_dir: root, changed: ['src/b.ts'] });
    expect(s.changed_symbols).toEqual(['b1']);
    expect(s.no_real_change).toBe(false);
    expect(s.summary_line).toContain('src/b.ts(b1)');
    expect(s.summary_line).toContain('直接1符号');
  });

  it('无实质变更：摘要明示，不虚报波及', async () => {
    const { root, db } = await makeProject();
    put(
      root,
      'src/b.ts',
      `export function b1(x: number): number {\n  // 注释\n  return x * 2;\n}\nexport function b2(x: number): number { return x + 1; }\n`,
    );
    await resync(root, db, 'src/b.ts');
    const s = runImpactReport({ project_dir: root, changed: ['src/b.ts'] });
    expect(s.no_real_change).toBe(true);
    expect(s.changed_symbols).toEqual([]);
    expect(s.summary_line).toContain('无实质符号变更');
    expect(s.impacted_file_paths).toEqual([]);
  });
});
