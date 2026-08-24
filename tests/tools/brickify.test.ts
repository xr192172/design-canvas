/**
 * brickify（依赖驱动积木化管线）测试：
 *   buildFileDeps 文件级依赖边 / computeCommunities 功能社区 / detectMixedFiles 混合文件信号
 *   buildBrickify 全链路（design-canvas 狗食现场）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildFileDeps, computeCommunities, detectMixedFiles, buildBrickify } from '../../src/tools/brickify';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brickify-'));
}
function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

const SRC = path.join(process.cwd(), 'src');

describe('buildFileDeps 文件级依赖边', () => {
  it('把相对 import 解析成 file→file 有向边（含 .js→.ts、目录→index）', () => {
    const root = makeTmp();
    write(root, 'a.ts', "import { b } from './b';\nimport { c } from './sub/c';\nimport './side';\n");
    write(root, 'b.ts', 'export const b = 1;\n');
    write(root, 'sub/c.ts', 'export const c = 2;\n');
    write(root, 'side.ts', 'console.log(1);\n');
    const rels = ['a.ts', 'b.ts', 'sub/c.ts', 'side.ts'];
    const deps = buildFileDeps(root, rels);
    expect(deps).toContainEqual({ from: 'a.ts', to: 'b.ts', count: 1 });
    expect(deps).toContainEqual({ from: 'a.ts', to: 'sub/c.ts', count: 1 });
    // 副作用 import './side' 也应是依赖（真实加载关系）
    expect(deps).toContainEqual({ from: 'a.ts', to: 'side.ts', count: 1 });
  });

  it('裸包名（非相对 import）不产生内部依赖边', () => {
    const root = makeTmp();
    write(root, 'a.ts', "import axios from 'axios';\nexport const x = axios;\n");
    write(root, 'b.ts', 'export const y = 1;\n');
    const deps = buildFileDeps(root, ['a.ts', 'b.ts']);
    expect(deps.filter((d) => d.from === 'a.ts' && d.to === 'b.ts')).toHaveLength(0);
  });
});

describe('computeCommunities 功能社区', () => {
  it('按依赖连通分量为社区，并给出内聚度', () => {
    // 布局：a/b/c 互相依赖成社区1；d/e 独立成社区2；f 孤立（每子目录=一积木，目录做种子）
    const root = makeTmp();
    write(root, 'a/a.ts', "import '../b/b';\nimport '../c/c';\n");
    write(root, 'b/b.ts', "import '../a/a';\n");
    write(root, 'c/c.ts', "\n");
    write(root, 'd/d.ts', "import '../e/e';\n");
    write(root, 'e/e.ts', "\n");
    write(root, 'f/f.ts', "\n");
    const rels = ['a/a.ts', 'b/b.ts', 'c/c.ts', 'd/d.ts', 'e/e.ts', 'f/f.ts'];
    const deps = buildFileDeps(root, rels);
    const comms = computeCommunities(rels, deps);
    const names = comms.map((c) => c.bricks.sort().join(','));
    expect(names).toEqual(expect.arrayContaining(['a,b,c', 'd,e', 'f']));
    // 孤立积木社区内聚度 = 1
    const f = comms.find((c) => c.bricks.includes('f'));
    expect(f?.cohesion).toBe(1);
    // a 社区有内部边（a→b,b→a,a→c）与零外部边，内聚满格
    const abc = comms.find((c) => c.bricks.includes('a'));
    expect(abc?.internal_edges).toBeGreaterThan(0);
    expect(abc?.external_edges).toBe(0);
    expect(abc?.cohesion).toBe(1);
  });
});

describe('detectMixedFiles 混合文件信号（一文件多功能）', () => {
  it('识别出多个无耦合概念簇的文件为解耦候选', async () => {
    const root = makeTmp();
    write(
      root,
      'mix.ts',
      `import { helperA } from './a';
import { helperB } from './b';
export function alpha() { return helperA(); }
export function beta() { return helperA(); }
export function gamma() { return helperB(); }
export function delta() { return helperB(); }
`,
    );
    const signals = await detectMixedFiles(root, ['mix.ts']);
    expect(signals).toHaveLength(1);
    expect(signals[0].file).toBe('mix.ts');
    // 两个概念簇：alpha/beta 共用 './a'；gamma/delta 共用 './b'
    expect(signals[0].clusters.length).toBe(2);
    const alphabeta = signals[0].clusters.find((c) => c.includes('alpha'));
    expect(alphabeta).toEqual(expect.arrayContaining(['alpha', 'beta']));
    const gammadelta = signals[0].clusters.find((c) => c.includes('gamma'));
    expect(gammadelta).toEqual(expect.arrayContaining(['gamma', 'delta']));
  });

  it('单概念文件（全共用同一依赖）不标信号', async () => {
    const root = makeTmp();
    write(
      root,
      'single.ts',
      `import { helperA } from './a';
export function alpha() { return helperA(); }
export function beta() { return helperA(); }
`,
    );
    const signals = await detectMixedFiles(root, ['single.ts']);
    expect(signals).toHaveLength(0);
  });
});

describe('buildBrickify 全链路（design-canvas 狗食）', () => {
  it('扫描 src → 积木 → 社区 → 混合文件，链路自洽可渲染', async () => {
    const r = await buildBrickify({ project_dir: path.join(process.cwd()), source_root: SRC });
    expect(r.meta.scanned_files).toBeGreaterThan(100);
    expect(r.bricks.length).toBeGreaterThan(0);
    // 每个积木都归属社区（可空仅当真正孤立）
    expect(r.communities.length).toBeGreaterThan(0);
    expect(Array.isArray(r.file_deps)).toBe(true);
    expect(Array.isArray(r.mixed_files)).toBe(true);
    // 内聚度都在 [0,1]
    for (const c of r.communities) {
      expect(c.cohesion).toBeGreaterThanOrEqual(0);
      expect(c.cohesion).toBeLessThanOrEqual(1);
    }
    // 混合文件诊断应为确定性信号（可能 0，但结构必须可渲染）
    expect(r.limitations.some((l) => l.includes('社区'))).toBe(true);
  });
});