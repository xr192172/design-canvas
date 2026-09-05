/**
 * function_outline 测试：函数级大纲汇聚（nodes=function/method + edges=call）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, closeAllProjectCacheDbs, type Database } from '../../src/db/db';
import { queryFunctionOutline } from '../../src/tools/function_outline';
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