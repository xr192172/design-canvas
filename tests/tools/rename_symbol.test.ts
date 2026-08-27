/**
 * rename_symbol —— 跨文件符号级改名测试
 *
 * 覆盖：
 *   - 模块级导出函数：定义名 + 同文件引用 + 无别名 importer 的 import/引用 一起改。
 *   - 别名 importer：只改 import 子句远程名，使用点（本地别名）不动。
 *   - class（值+类型双栖）：identifier 与 type_identifier 都改。
 *   - interface（纯类型）：只改 type_identifier。
 *   - 局部遮蔽：模块符号被函数内同名局部遮蔽时，遮蔽侧的引用不改。
 *   - 原子阻断：目标名是 import 绑定 / 撞名 / export * 转发 → 全部不落盘。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameSymbol, analyzeModuleSource } from '../../src/tools/rename_symbol';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rs-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    // sqlite/files 目录逐级创建
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('analyzeModuleSource - 模块级作用域解析', () => {
  it('根作用域收集声明 + import 绑定，值引用解析到根', async () => {
    const src = [
      "import { helper } from './util';",
      'export function compute(a: number): number {',
      '  return a + helper(a);',
      '}',
      'export { compute };',
      'function internal() { return compute(1); }',
    ].join('\n');
    const m = await analyzeModuleSource(src, 'def.ts');
    expect(m).not.toBeNull();
    expect(m!.rootKinds.get('compute')).toBe('function');
    expect(m!.rootKinds.get('helper')).toBe('import');
    expect(m!.rootKinds.get('internal')).toBe('function');
    // compute 的两处根引用：参数无(参数是局部)、internal 内的调用，以及 export 列表由 exportRefs 单独记
    const computeRefs = m!.rootRefs.filter((r) => r.name === 'compute');
    expect(computeRefs.length).toBe(1); // internal() 内的 compute(1)
    expect(computeRefs[0].nodeType).toBe('value');
    // export { compute } → exportRefs
    expect(m!.exportRefs.some((r) => r.name === 'compute' && r.nodeType === 'value')).toBe(true);
  });

  it('局部遮蔽：模块 compute 被函数内 const compute 遮蔽时不误改', async () => {
    const src = [
      'export function compute(a: number) { return a; }',
      'export function outer() {',
      '  const compute = 1;',
      '  return compute;',
      '}',
    ].join('\n');
    const m = await analyzeModuleSource(src, 'def.ts');
    const refs = m!.rootRefs.filter((r) => r.name === 'compute');
    // outer 内的 const compute 声明与 return compute 都不是模块根的引用
    expect(refs.length).toBe(0);
  });
});

describe('renameSymbol - 跨文件改名落盘', () => {
  it('导出函数：定义名+同文件引用+无别名 importer 一起改', async () => {
    const dir = mkProj({
      'src/def.ts': [
        'export function compute(a: number): number {',
        '  return a * 2;',
        '}',
        'export { compute };',
        'function internal() { return compute(1); }',
      ].join('\n'),
      'src/a.ts': [
        "import { compute } from './def';",
        'export function run() { return compute(3); }',
      ].join('\n'),
      'src/b.ts': [
        "import { compute as calc } from './def';",
        'export function run2() { return calc(5); }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    const def = readFileSync(path.join(dir, 'src/def.ts'), 'utf-8');
    expect(def).toContain('export function tally(');
    expect(def).toContain('export { tally };');
    expect(def).toContain('return tally(1);'); // internal
    expect(def).not.toContain('export function compute');
    expect(def).not.toContain('export { compute }');

    const a = readFileSync(path.join(dir, 'src/a.ts'), 'utf-8');
    expect(a).toContain("import { tally } from './def';");
    expect(a).toContain('return tally(3);');

    const b = readFileSync(path.join(dir, 'src/b.ts'), 'utf-8');
    expect(b).toContain("import { tally as calc } from './def';");
    expect(b).toContain('return calc(5);'); // 别名使用点不动

    rmSync(dir, { recursive: true, force: true });
  });

  it('class 值+类型双栖：type_identifier 与 identifier 都改', async () => {
    const dir = mkProj({
      'src/point.ts': [
        'export class Point {',
        '  x = 0;',
        '}',
        'export function make(p: Point) { return new Point(); }',
      ].join('\n'),
      'src/use.ts': [
        "import { Point } from './point';",
        'let p: Point = new Point();',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/point.ts', symbol: 'Point', to: 'Vertex' });
    expect(r.ok).toBe(true);

    const def = readFileSync(path.join(dir, 'src/point.ts'), 'utf-8');
    expect(def).toContain('export class Vertex');
    expect(def).toContain('make(p: Vertex)'); // type 引用
    expect(def).toContain('return new Vertex();'); // value 引用

    const use = readFileSync(path.join(dir, 'src/use.ts'), 'utf-8');
    expect(use).toContain("import { Vertex } from './point';");
    expect(use).toContain('let p: Vertex = new Vertex();');

    rmSync(dir, { recursive: true, force: true });
  });

  it('interface 纯类型：只改 type_identifier', async () => {
    const dir = mkProj({
      'src/shape.ts': [
        'export interface Shape { area(): number; }',
        'export function calc(s: Shape) { return s.area(); }',
      ].join('\n'),
      'src/use.ts': [
        "import { Shape } from './shape';",
        'function f(s: Shape) {}',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/shape.ts', symbol: 'Shape', to: 'Figure' });
    expect(r.ok).toBe(true);

    const def = readFileSync(path.join(dir, 'src/shape.ts'), 'utf-8');
    expect(def).toContain('export interface Figure');
    expect(def).toContain('calc(s: Figure)');

    const use = readFileSync(path.join(dir, 'src/use.ts'), 'utf-8');
    expect(use).toContain("import { Figure } from './shape';");
    expect(use).toContain('function f(s: Figure)');

    rmSync(dir, { recursive: true, force: true });
  });

  it('同文件遮蔽侧不改：局部 const compute 保持原名', async () => {
    const dir = mkProj({
      'src/def.ts': [
        'export function compute(a: number): number { return a; }',
        'export function outer() {',
        '  const compute = 1;',
        '  return compute;',
        '}',
        'function use() { return compute(9); }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    const def = readFileSync(path.join(dir, 'src/def.ts'), 'utf-8');
    expect(def).toContain('export function tally(');
    expect(def).toContain('return tally(9);'); // 模块级 use() 引用改
    expect(def).toContain('const compute = 1;'); // 遮蔽侧不改
    expect(def).toContain('return compute;'); // 遮蔽侧不改

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('renameSymbol - 原子阻断（全部不落盘）', () => {
  it('目标名在文件里是 import 绑定而非声明 → 拒绝', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
      'src/a.ts': "import { compute } from './def';\n",
    });
    // 在 a.ts 上发起（它只 import，没有声明 compute）
    const r = await renameSymbol({ project_dir: dir, file: 'src/a.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(false);
    expect(r.blocked![0]).toContain('import 绑定');
    rmSync(dir, { recursive: true, force: true });
  });

  it('importer 已 import 名为 to 的符号 → 阻断且定义文件不变', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
      'src/other.ts': 'export const tally = 99;\n',
      'src/a.ts': "import { compute } from './def';\nimport { tally } from './other';\n",
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('tally'))).toBe(true);
    // 定义文件必须未改
    const def = readFileSync(path.join(dir, 'src/def.ts'), 'utf-8');
    expect(def).toContain('export function compute');
    rmSync(dir, { recursive: true, force: true });
  });

  it('export * 转发自定义文件 → 阻断且定义文件不变', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
      'src/barrel.ts': "export * from './def';\n",
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('export *'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function compute');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Python 模块级作用域解析（analyzeModuleSource .py 分支）', () => {
  it('收集 def/class/顶层赋值声明 + import 绑定', async () => {
    const src = [
      'import os',
      'from .util import helper',
      'from . import def_mod',
      'CONFIG = {}',
      'def compute(a):',
      '    return helper(a)',
      'class Point:',
      '    def area(self):',
      '        return 0',
    ].join('\n');
    const m = await analyzeModuleSource(src, 'def.py');
    expect(m).not.toBeNull();
    expect(m!.rootKinds.get('compute')).toBe('function');
    expect(m!.rootKinds.get('Point')).toBe('class');
    expect(m!.rootKinds.get('CONFIG')).toBe('const');
    expect(m!.rootKinds.get('os')).toBe('import');
    expect(m!.rootKinds.get('helper')).toBe('import');
    expect(m!.rootKinds.get('def_mod')).toBe('import');
  });

  it('模块属性引用记录到 moduleAttrs', async () => {
    const src = ['import util', 'util.format(x)'].join('\n');
    const m = await analyzeModuleSource(src, 'main.py');
    expect(m!.moduleAttrs.some((a) => a.attrName === 'format' && a.objectName === 'util')).toBe(true);
  });
});

describe('renameSymbol - Python 跨文件改名落盘', () => {
  it('from .def import compute 无别名：import+直接引用一起改', async () => {
    const dir = mkProj({
      'src/def.py': ['def compute(a):', '    return a * 2', 'def internal():', '    return compute(1)'].join('\n'),
      'src/a.py': ['from .def import compute', 'def run():', '    return compute(3)'].join('\n'),
      'src/b.py': ['from .def import compute as calc', 'def run2():', '    return calc(5)'].join('\n'),
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.py', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    const def = readFileSync(path.join(dir, 'src/def.py'), 'utf-8');
    expect(def).toContain('def tally(a):');
    expect(def).toContain('return tally(1)');
    const a = readFileSync(path.join(dir, 'src/a.py'), 'utf-8');
    expect(a).toContain('from .def import tally');
    expect(a).toContain('return tally(3)');
    const b = readFileSync(path.join(dir, 'src/b.py'), 'utf-8');
    expect(b).toContain('from .def import tally as calc');
    expect(b).toContain('return calc(5)'); // 别名使用点不动
    rmSync(dir, { recursive: true, force: true });
  });

  it('from . import def_mod + def_mod.compute(...) 模块属性引用也改', async () => {
    const dir = mkProj({
      'src/def_mod.py': 'def compute(x):\n    return x + 1\n',
      'src/main.py': ['from . import def_mod', 'def run():', '    return def_mod.compute(3)'].join('\n'),
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def_mod.py', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    const main = readFileSync(path.join(dir, 'src/main.py'), 'utf-8');
    expect(main).toContain('return def_mod.tally(3)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('import util 绝对模块路径 + util.compute(...) 属性引用也改', async () => {
    const dir = mkProj({
      'src/util.py': 'def compute(x):\n    return x * 2\n',
      'src/main.py': ['import util', 'def run():', '    return util.compute(4)'].join('\n'),
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/util.py', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    const main = readFileSync(path.join(dir, 'src/main.py'), 'utf-8');
    expect(main).toContain('return util.tally(4)');
    rmSync(dir, { recursive: true, force: true });
  });

  it('同文件局部遮蔽：参数/局部同名不改', async () => {
    const dir = mkProj({
      'src/def.py': ['def compute(a):', '    return a', 'def outer(compute):', '    return compute'].join('\n'),
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.py', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    const def = readFileSync(path.join(dir, 'src/def.py'), 'utf-8');
    expect(def).toContain('def tally(a):');
    expect(def).toContain('def outer(compute):'); // 遮蔽侧不改
    expect(def).toContain('    return compute'); // 遮蔽侧不改
    rmSync(dir, { recursive: true, force: true });
  });
});