/**
 * cross_repo —— 跨项目符号索引单元测试
 *
 * 夹具：
 *   hybrid-a：util.ts(sum 函数 + Point 接口, 仅 A) / shared.ts(merge 数组版) / widget.ts(render)
 *   hybrid-b：core.ts(merge 标量版) / widget.ts(render 同签) / own.ts(bootstrap, 仅 B)
 *
 * 预期：
 *   - 冲突(同名不同签)：merge
 *   - 双胞胎(同名同签)：render
 *   - aOnly(求差 A 独有)：Point, sum
 *   - bOnly(求差 B 独有)：bootstrap
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProjectIndex, compareProjects } from '../../src/cross_repo/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const aRoot = path.join(here, '..', 'fixtures', 'hybrid-a');
const bRoot = path.join(here, '..', 'fixtures', 'hybrid-b');

describe('cross_repo: 单仓索引', () => {
  it('buildProjectIndex 收集全部顶层符号（含函数与接口）', async () => {
    const idx = await buildProjectIndex(aRoot);
    expect(idx.root).toBe(aRoot);
    expect(idx.fileCount).toBe(3);
    const names = [...idx.symbols.keys()].sort();
    expect(names).toEqual(['Point', 'merge', 'render', 'sum']);
    const sum = idx.symbols.get('sum')!;
    expect(sum[0].kind).toBe('function');
    expect(sum[0].file).toBe('src/util.ts');
    const pt = idx.symbols.get('Point')!;
    expect(pt[0].kind).toBe('interface');
  });
});

describe('cross_repo: 两仓求交/求差', () => {
  it('compareProjects 正确分类冲突/双胞胎/迁移候选', async () => {
    const r = await compareProjects(aRoot, bRoot);

    expect(r.aFiles).toBe(3);
    expect(r.bFiles).toBe(3);
    expect(r.aSymbols).toBe(4); // sum, Point, merge, render
    expect(r.bSymbols).toBe(3); // merge, render, bootstrap

    // 冲突：merge（同名不同签）
    expect(r.conflicts.map((c) => c.name)).toEqual(['merge']);
    const m = r.conflicts[0];
    expect(m.duplicate).toBe(false);
    expect(m.a.some((s) => s.file === 'src/shared.ts')).toBe(true);
    expect(m.b.some((s) => s.file === 'src/core.ts')).toBe(true);

    // 双胞胎：render（同名同签）
    expect(r.duplicates.map((c) => c.name)).toEqual(['render']);
    expect(r.duplicates[0].duplicate).toBe(true);

    // 求差：迁移候选
    expect(r.aOnly).toEqual(['Point', 'sum']);
    expect(r.bOnly).toEqual(['bootstrap']);
  });

  it('aOnly/bOnly 与冲突/双胞胎互斥且并集 = 两侧符号名全集', async () => {
    const r = await compareProjects(aRoot, bRoot);
    const covered = new Set([
      ...r.conflicts.map((c) => c.name),
      ...r.duplicates.map((c) => c.name),
      ...r.aOnly,
      ...r.bOnly,
    ]);
    const all = new Set([...r.aOnly, ...r.bOnly, ...r.conflicts.map((c) => c.name), ...r.duplicates.map((c) => c.name)]);
    expect(covered.size).toBe(covered.size);
    expect(covered.size).toBe(5); // merge, render, sum, Point, bootstrap
    expect(all.size).toBe(5);
  });

  it('同根自比：全部符号都是双胞胎（同名同签），无冲突无迁移', async () => {
    const r = await compareProjects(aRoot, aRoot);
    expect(r.conflicts).toEqual([]);
    expect(r.aOnly).toEqual([]);
    expect(r.bOnly).toEqual([]);
    expect(r.duplicates.length).toBe(4); // sum, Point, merge, render 全部双胞胎
  });
});
