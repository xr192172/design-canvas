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

/**
 * 类型引用 + 纯 import 依赖项目：
 *   src/types.ts: interface Config（被 user.ts 引用）
 *   src/user.ts:  greet(c: Config) —— type_ref 跨文件边
 *   src/flags.ts: export const FLAG（常量，无符号边）
 *   src/use.ts:   run() { return FLAG; } —— 仅 import 依赖
 */
async function makeTypeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-impact-typeref-'));
  roots.push(root);
  put(root, 'src/types.ts', `export interface Config {\n  name: string;\n  retries: number;\n}\n`);
  put(root, 'src/user.ts', `import { Config } from './types';\n\nexport function greet(c: Config): string {\n  return c.name;\n}\n`);
  put(root, 'src/flags.ts', `export const FLAG = true;\n`);
  put(root, 'src/use.ts', `import { FLAG } from './flags';\n\nexport function run(): boolean {\n  return FLAG;\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  return root;
}

/** 修改文件后增量重导（二次 importProject 走 syncFile → 产 symbol_diff） */
async function reimport(root: string, feature: string): Promise<void> {
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
}

describe('diff_impact 多边类型影响图（v4）', () => {
  it('type_ref：改 interface 波及跨文件引用者，via_edge 分层正确', async () => {
    const root = await makeTypeProject('diff_t1');
    // Config 加字段 → 符号级实质变更
    put(root, 'src/types.ts', `export interface Config {\n  name: string;\n  retries: number;\n  timeout: number;\n}\n`);
    await reimport(root, 'diff_t1');

    const r = diffImpact({ feature: 'diff_t1', project_dir: root, changed: ['src/types.ts'], direction: 'callers' });

    expect(r.edge_counts.type_ref).toBeGreaterThan(0);

    // Config 直接改动（符号级收敛为 changed）
    const cfg = r.impacted_symbols.find((s) => s.name === 'Config');
    expect(cfg).toBeDefined();
    expect(cfg!.depth).toBe(0);
    expect(cfg!.role).toBe('changed');

    // greet 经 type_ref 跨文件边波及（call 图对此不可见）
    const greet = r.impacted_symbols.find((s) => s.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.depth).toBe(1);
    expect(greet!.via_edge).toBe('type_ref');
    expect(greet!.role).toBe('caller');

    // 文件级：user.ts 经 type_ref 符号边精准波及（符号级已定位变更，import 层不叠加）
    const user = r.impacted_files.find((f) => f.path === 'src/user.ts')!;
    expect(user).toBeDefined();
    expect(user.direct).toBe(false);
    expect(user.via_edges).toEqual(['type_ref']);

    // 分层报告文本
    expect(r.message).toContain('经类型引用');
  });

  it('import：改常量文件波及导入方（无符号边时仅 import 层）', async () => {
    const root = await makeTypeProject('diff_t2');
    put(root, 'src/flags.ts', `export const FLAG = false;\n`);
    await reimport(root, 'diff_t2');

    const r = diffImpact({ feature: 'diff_t2', project_dir: root, changed: ['src/flags.ts'], direction: 'callers' });

    expect(r.edge_counts.import).toBeGreaterThan(0);
    const use = r.impacted_files.find((f) => f.path === 'src/use.ts')!;
    expect(use).toBeDefined();
    expect(use.direct).toBe(false);
    expect(use.depth).toBe(1);
    // FLAG 无调用/类型引用边 → 只有 import 文件级波及
    expect(use.via_edges).toEqual(['import']);
    expect(use.symbol_count).toBe(0);
    expect(r.impacted_symbols.find((s) => s.name === 'run')).toBeUndefined();
    expect(r.message).toContain('经import 依赖');
  });

  it('dsl_contract_hits：波及符号撞上语义层 API（actual_apis 回填）', async () => {
    const root = await makeProject('diff_h');
    // helperB 实质变更 → 符号级 diff
    put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 3;\n}\n`);
    await reimport(root, 'diff_h');

    const r = diffImpact({ feature: 'diff_h', project_dir: root, changed: ['src/b.ts'], direction: 'callers' });

    const hit = r.dsl_contract_hits.find((h) => h.api.startsWith('helperB'));
    expect(hit).toBeDefined();
    expect(hit!.dsl_node_id).toBe('file_src_b_ts');
    // importProject 同填 expected/actual（代码即契约），命中任一即有效
    expect(['expected', 'actual']).toContain(hit!.api_source);
    expect(hit!.depth).toBe(0);
    expect(hit!.matched_symbol).toBe('helperB@src/b.ts');
    // 波及链上的调用方 API 也命中（mainA 在 a.ts 的 actual_apis 里，depth 1）
    const mainAHit = r.dsl_contract_hits.find((h) => h.api.startsWith('mainA'));
    expect(mainAHit).toBeDefined();
    expect(mainAHit!.depth).toBe(1);
    expect(r.message).toContain('DSL 契约命中');
  });
});