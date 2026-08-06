/**
 * diff_impact 变更影响分析测试
 *
 * 覆盖：
 *   - callers：改 b.ts → 波及调用它的 a.ts(mainA)、c.ts(mainC)
 *   - callees：改 a.ts → 波及它调用的 b.ts(helperB)
 *   - both：改 a.ts → 同时波及调用方 c.ts 与被调方 b.ts
 *   - max_depth 截断：depth=1 时不再波及 depth=2 的 mainC
 *   - 跨文件调用边（import_project + cache.db 建边）
 *   - changed 文件不在缓存 → 警告 + 仍列为直接受影响文件
 *   - feature 不存在 → 抛错
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { diffImpact } from '../../src/tools/diff_impact';
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

/**
 * 建一个三文件调用图项目并写入符号缓存：
 *   src/a.ts: mainA → helperB（import ./b）
 *   src/b.ts: helperB
 *   src/c.ts: mainC → mainA（import ./a）
 * 返回项目根。feature 名唯一，避免测试间存储冲突。
 */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-impact-'));
  roots.push(root);
  put(root, 'src/a.ts', `import { helperB } from './b';\n\nexport function mainA(x: number): number {\n  return helperB(x);\n}\n`);
  put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
  put(root, 'src/c.ts', `import { mainA } from './a';\n\nexport function mainC(x: number): number {\n  return mainA(x) + 1;\n}\n`);
  // 缓存必须放在项目根 .design-canvas/ 下，diffImpact 的 getProjectCacheDb 读同一文件
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

const filePaths = (r: ReturnType<typeof diffImpact>) => r.impacted_files.map((f) => f.path).sort();

describe('diff_impact 变更影响分析', () => {
  it('callers：改 b.ts 波及调用它的 a.ts 与 c.ts（跨文件）', async () => {
    const root = await makeProject('diff_a');
    const r = diffImpact({ feature: 'diff_a', project_dir: root, changed: ['src/b.ts'], direction: 'callers' });

    expect(r.has_call_edges).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(filePaths(r)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);

    const b = r.impacted_files.find((f) => f.path === 'src/b.ts')!;
    expect(b.direct).toBe(true);
    expect(b.depth).toBe(0);
    expect(b.dsl_node_id).toBe('file_src_b_ts');

    const a = r.impacted_files.find((f) => f.path === 'src/a.ts')!;
    expect(a.direct).toBe(false);
    expect(a.depth).toBe(1);

    const c = r.impacted_files.find((f) => f.path === 'src/c.ts')!;
    expect(c.depth).toBe(2);

    // 符号明细：helperB 直接改动，mainA/mainC 是调用方
    const roles = new Map(r.impacted_symbols.map((s) => [s.qualified_name, s.role]));
    expect(roles.get('helperB')).toBe('changed');
    expect(roles.get('mainA')).toBe('caller');
    expect(roles.get('mainC')).toBe('caller');
  });

  it('callees：改 a.ts 波及它调用的 b.ts', async () => {
    const root = await makeProject('diff_b');
    const r = diffImpact({ feature: 'diff_b', project_dir: root, changed: ['src/a.ts'], direction: 'callees' });

    expect(filePaths(r)).toEqual(['src/a.ts', 'src/b.ts']);
    const b = r.impacted_files.find((f) => f.path === 'src/b.ts')!;
    expect(b.direct).toBe(false);
    expect(b.depth).toBe(1);
    // callees 方向不沿调用方追溯，c.ts 不应出现
    expect(filePaths(r)).not.toContain('src/c.ts');
  });

  it('both：改 a.ts 同时波及调用方 c.ts 与被调方 b.ts', async () => {
    const root = await makeProject('diff_c');
    const r = diffImpact({ feature: 'diff_c', project_dir: root, changed: ['src/a.ts'], direction: 'both' });

    expect(filePaths(r)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const roles = new Map(r.impacted_symbols.map((s) => [s.qualified_name, s.role]));
    expect(roles.get('mainC')).toBe('caller');
    expect(roles.get('helperB')).toBe('callee');
  });

  it('max_depth 截断：depth=1 时不再波及 depth=2 的 c.ts', async () => {
    const root = await makeProject('diff_d');
    const r = diffImpact({ feature: 'diff_d', project_dir: root, changed: ['src/b.ts'], direction: 'callers', max_depth: 1 });

    expect(filePaths(r)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(filePaths(r)).not.toContain('src/c.ts');
  });

  it('changed 文件不在缓存：警告 + 仍列为直接受影响文件', async () => {
    const root = await makeProject('diff_e');
    const r = diffImpact({ feature: 'diff_e', project_dir: root, changed: ['src/nope.ts'], direction: 'callers' });

    expect(r.warnings.some((w) => w.includes('src/nope.ts'))).toBe(true);
    const nope = r.impacted_files.find((f) => f.path === 'src/nope.ts')!;
    expect(nope).toBeDefined();
    expect(nope.direct).toBe(true);
    expect(nope.symbol_count).toBe(0);
  });

  it('feature 不存在时报错', async () => {
    expect(() => diffImpact({ feature: 'no_such_feature', project_dir: process.cwd(), changed: ['x.ts'] })).toThrow(
      'feature "no_such_feature" 不存在',
    );
  });
});