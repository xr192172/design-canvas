/**
 * function_outline 测试：函数级大纲汇聚（nodes=function/method + edges=call）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, closeAllProjectCacheDbs, type Database } from '../../src/db/db';
import { queryFunctionOutline, buildFeatureIndex, attachFunctionFeatures, type FunctionOutlineFn } from '../../src/tools/function_outline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let dir: string;
let db: Database;
function fn(id: string, kind: string, name: string, fp: string, sl: number, el: number, qn = name, sig?: string, isClosure = 0) {
  db.prepare(
    `INSERT INTO nodes(id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, is_closure, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, kind, name, qn, fp, 'go', sl, el, sig ?? null, isClosure, Date.now());
}
function callSrc(src: string, tgt: string, line: number, cross = false) {
  db.prepare(
    `INSERT INTO edges(source, target, kind, line, metadata) VALUES (?,?,?,?,?)`,
  ).run(src, tgt, 'call', line, cross ? JSON.stringify({ cross: true }) : null);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnout-'));
  db = openDb(path.join(dir, 'cache.db'));
});
afterEach(() => {
  try { db.close(); } catch { /* 已关 */ }
  closeAllProjectCacheDbs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('queryFunctionOutline', () => {
  it('按 file_path 分组、dir 取自路径、函数卡含签名/行号', () => {
    fn('cmd/a/main.go#Main', 'function', 'Main', 'cmd/a/main.go', 1, 5, 'Main', 'Main() int');
    fn('pkg/b/util.go#Helper', 'function', 'Helper', 'pkg/b/util.go', 3, 9, 'Helper', 'Helper(s string)');
    const o = queryFunctionOutline(db);
    expect(o.functions).toHaveLength(2);
    const main = o.functions.find((f) => f.name === 'Main')!;
    expect(main.file).toBe('cmd/a/main.go');
    expect(main.dir).toBe('cmd/a');
    expect(main.signature).toBe('Main() int');
    expect(main.start_line).toBe(1);
    expect(main.recursive).toBe(false);
  });

  it('汇聚 calls（出）/called_by（入）/递归标记', () => {
    fn('cmd/a/main.go#Main', 'function', 'Main', 'cmd/a/main.go', 1, 10);
    fn('cmd/a/main.go#step', 'function', 'step', 'cmd/a/main.go', 12, 20);
    fn('pkg/b/util.go#Helper', 'function', 'Helper', 'pkg/b/util.go', 3, 9);
    callSrc('cmd/a/main.go#Main', 'cmd/a/main.go#step', 5);          // 同文件
    callSrc('cmd/a/main.go#step', 'pkg/b/util.go#Helper', 15, true); // 跨文件
    callSrc('cmd/a/main.go#Main', 'cmd/a/main.go#Main', 8);          // 自递归
    const o = queryFunctionOutline(db);
    const main = o.functions.find((f) => f.name === 'Main')!;
    const step = o.functions.find((f) => f.name === 'step')!;
    const helper = o.functions.find((f) => f.name === 'Helper')!;
    expect(main.calls.map((c) => c.name).sort()).toEqual(['Main', 'step']);
    expect(main.calls.some((c) => c.name === 'step' && !c.cross)).toBe(true);
    expect(main.recursive).toBe(true);
    expect(step.calls.map((c) => c.name)).toEqual(['Helper']);
    expect(step.calls[0].cross).toBe(true);
    expect(helper.called_by.map((c) => c.name)).toEqual(['step']);
  });

  it('排除局部闭包（is_closure=1）不进大纲', () => {
    fn('a.go#Exported', 'function', 'Exported', 'a.go', 1, 3);
    fn('a.go#hidden', 'function', 'hidden', 'a.go', 5, 7, 'hidden', undefined, 1); // closure
    const o = queryFunctionOutline(db);
    expect(o.functions).toHaveLength(1);
    expect(o.functions[0].name).toBe('Exported');
  });

  it('不做截断：全量返回全部函数（像编译器一样数据完整）', () => {
    fn('a.go#A', 'function', 'A', 'a.go', 1, 2);
    fn('b.go#B', 'function', 'B', 'b.go', 1, 2);
    const o = queryFunctionOutline(db);
    expect(o.functions.map((f) => f.name).sort()).toEqual(['A', 'B']);
  });

  it('空库（无节点）返回空 functions 不炸', () => {
    const o = queryFunctionOutline(db);
    expect(o.functions).toEqual([]);
  });

  it('按 dir 懒加载过滤：只返回该目录下的函数', () => {
    fn('cmd/a/main.go#Main', 'function', 'Main', 'cmd/a/main.go', 1, 5);
    fn('cmd/a/main.go#step', 'function', 'step', 'cmd/a/main.go', 7, 10);
    fn('cmd/b/other.go#Other', 'function', 'Other', 'cmd/b/other.go', 1, 3);
    fn('pkg/util.go#Helper', 'function', 'Helper', 'pkg/util.go', 3, 9);
    fn('hello.go#Top', 'function', 'Top', 'hello.go', 1, 2); // 根目录（无斜杠）

    // dir=cmd/a → 只该目录
    const a = queryFunctionOutline(db, { dir: 'cmd/a' });
    expect(a.functions.map((f) => f.name).sort()).toEqual(['Main', 'step']);
    expect(a.functions.every((f) => f.dir === 'cmd/a')).toBe(true);

    // dir=pkg → 仅 pkg/util.go 里的 Helper
    const p = queryFunctionOutline(db, { dir: 'pkg' });
    expect(p.functions.map((f) => f.name)).toEqual(['Helper']);

    // dir=.（根）→ 顶层无斜杠文件
    const root = queryFunctionOutline(db, { dir: '.' });
    expect(root.functions.map((f) => f.name)).toEqual(['Top']);

    // 无 dir → 全量
    const all = queryFunctionOutline(db);
    expect(all.functions.map((f) => f.name).sort()).toEqual(['Helper', 'Main', 'Other', 'Top', 'step']);
  });
});

describe('buildFeatureIndex / attachFunctionFeatures（DSL feature_tree 投影）', () => {
  const dsl = {
    feature_tree: {
      features: [
        { id: 'renderer', name: '渲染器' },
        { id: 'observe', name: '观测' },
      ],
      file_map: {
        'renderer.tsx': { feature_id: 'renderer', community_id: 0 },
        'observe/chain.ts': { feature_id: 'observe', community_id: 1 },
        'observe/rings.ts': { feature_id: 'observe', community_id: 1 },
      },
    },
    semantic: {
      files: [
        { id: 'renderer.tsx', path: 'src/app/renderer.tsx', responsibility: '渲染输出层' },
        { id: 'observe/chain.ts', path: 'observe/chain.ts', responsibility: '探针链构建与匹配' },
        { id: 'observe/rings.ts', path: 'observe/rings.ts', responsibility: '环形观测' },
      ],
    },
  };

  it('buildFeatureIndex 精确命中 + 长后缀兜底（路径形态不一致）', () => {
    const idx = buildFeatureIndex(dsl as never);
    // 精确：DSL path = observe/chain.ts → 观测
    expect(idx.get('observe/chain.ts')).toEqual({ id: 'observe', name: '观测', responsibility: '探针链构建与匹配' });
    // 后缀兜底：cache 里文件是 project_root/observe/chain.ts，取 L2 后缀 observe/chain.ts
    expect(idx.get('src/app/renderer.tsx')).toEqual({ id: 'renderer', name: '渲染器', responsibility: '渲染输出层' });
    // 单文件名后缀不应吞掉（仅 ≥2 段做后缀）
    expect(idx.get('chain.ts')).toBeUndefined();
  });

  it('attachFunctionFeatures 把函数挂上所属功能，索引空时不改原数组', () => {
    const fns: FunctionOutlineFn[] = [
      { id: 'a#Main', name: 'Main', kind: 'function', qualified_name: 'Main', file: 'observe/chain.ts', dir: 'observe', start_line: 1, end_line: 5, calls: [], called_by: [], recursive: false },
      { id: 'b#Other', name: 'Other', kind: 'function', qualified_name: 'Other', file: 'app/renderer.tsx', dir: 'app', start_line: 1, end_line: 4, calls: [], called_by: [], recursive: false },
      { id: 'c#Miss', name: 'Miss', kind: 'function', qualified_name: 'Miss', file: 'unknown/x.go', dir: 'unknown', start_line: 1, end_line: 3, calls: [], called_by: [], recursive: false },
    ];
    const out = attachFunctionFeatures(fns, dsl as never);
    expect(out.find((f) => f.name === 'Main')?.feature_name).toBe('观测');
    expect(out.find((f) => f.name === 'Main')?.file_responsibility).toBe('探针链构建与匹配');
    expect(out.find((f) => f.name === 'Other')?.feature_name).toBe('渲染器');
    expect(out.find((f) => f.name === 'Miss')?.feature_name).toBeUndefined();
    expect(out).toBe(fns); // 同步返回原数组

    // 无 feature_tree / 无语义文件 → 空索引，不新增 feature（用全新数组，避免沿用上面已挂的字段）
    const fresh: FunctionOutlineFn = { id: 'c#Miss', name: 'Miss', kind: 'function', qualified_name: 'Miss', file: 'unknown/x.go', dir: 'unknown', start_line: 1, end_line: 3, calls: [], called_by: [], recursive: false };
    const bare = attachFunctionFeatures([fresh], { feature_tree: undefined, semantic: { files: [] } } as never);
    expect(bare[0].feature_name).toBeUndefined();
  });
});