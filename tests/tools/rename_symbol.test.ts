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
import { renameSymbol, analyzeModuleSource, analyzeGoSource } from '../../src/tools/rename_symbol';

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

// 联动改名会经 rename_file 打开项目 sqlite 索引（进程内未立即释放），
// Windows 上立刻 rmSync 可能 EBUSY——重试删除，避免测试清理时序误报。
function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 句柄尚未释放，稍候重试
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略最终失败（临时目录，OS 会回收） */
  }
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

describe('renameSymbol - 文件联动改名（rename_file_if_matching）', () => {
  it('符号=文件名（UserService 类在 UserService.ts）→ 联动把文件也改名', async () => {
    const dir = mkProj({
      'src/UserService.ts': [
        'export class UserService {',
        '  greet(): string { return "hi"; }',
        '}',
      ].join('\n'),
      'src/app.ts': [
        "import { UserService } from './UserService';",
        'export function make() { return new UserService(); }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/UserService.ts', symbol: 'UserService', to: 'MemberService', rename_file_if_matching: true });
    expect(r.ok).toBe(true);
    expect(r.fileRenamed).toBe('src/MemberService.ts');

    // 文件已物理改名
    expect(readFileSync(path.join(dir, 'src/MemberService.ts'), 'utf-8')).toContain('export class MemberService');
    expect(() => readFileSync(path.join(dir, 'src/UserService.ts'), 'utf-8')).toThrow();
    // import 引用已改写
    const app = readFileSync(path.join(dir, 'src/app.ts'), 'utf-8');
    expect(app).toContain("import { MemberService } from './MemberService';");
    expect(app).toContain('new MemberService()');
    rmForce(dir);
  });

  it('符号≠文件名（def.ts 导出 compute）→ 不联动文件', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally', rename_file_if_matching: true });
    expect(r.ok).toBe(true);
    expect(r.fileRenamed).toBeUndefined();
    // 文件未改名，符号已改
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function tally');
    rmForce(dir);
  });

  it('rename_file_if_matching 缺省（false）→ 不改文件', async () => {
    const dir = mkProj({
      'src/UserService.ts': 'export class UserService {}\n',
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/UserService.ts', symbol: 'UserService', to: 'MemberService' });
    expect(r.ok).toBe(true);
    expect(r.fileRenamed).toBeUndefined();
    expect(readFileSync(path.join(dir, 'src/UserService.ts'), 'utf-8')).toContain('export class MemberService');
    rmForce(dir);
  });
});

describe('renameSymbol - 自动定位项目根（project_dir 省略，依赖 project_root.expandClosure）', () => {
  it('不传 project_dir，只传绝对 file → 自动定位 manifest 根并改名，importer 一并改写', async () => {
    const dir = mkProj({
      'package.json': '{ "name": "proj" }\n',
      'src/def.ts': [
        'export function compute(a: number): number { return a * 2; }',
      ].join('\n'),
      'src/app.ts': [
        "import { compute } from './def';",
        'export function run() { return compute(3); }',
      ].join('\n'),
    });

    const r = await renameSymbol({ file: path.join(dir, 'src/def.ts'), symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    // 定义文件 + 同根 importer 都改了
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function tally');
    expect(readFileSync(path.join(dir, 'src/app.ts'), 'utf-8')).toContain("import { tally } from './def';");
    expect(readFileSync(path.join(dir, 'src/app.ts'), 'utf-8')).toContain('return tally(3);');
    rmForce(dir);
  });

  it('跨根引用：def 依赖项目根外 shared.ts → 闭包沿 import 边扩入，shared 对 def 的回引一并改写', async () => {
    const dir = mkProj({
      // 项目 A：package.json 标志 manifest 根
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': [
        "import { sharedHelper } from '../../shared';",
        'export function compute(a: number): number { return a + sharedHelper(a); }',
      ].join('\n'),
      // shared.ts 在 A 根外（同一上层目录）——def.ts 相对引用它，形成跨根 import 边
      'shared.ts': [
        "import { compute } from './A/src/def';",
        'export function sharedHelper(x: number): number { return x; }',
        'export function use() { return compute(1); }',
      ].join('\n'),
    });

    // 从 A 内文件发起改名，project_dir 省略 → 自动定位 A 根 + 闭包沿 import 边扩到根外 shared.ts
    const r = await renameSymbol({ file: path.join(dir, 'A/src/def.ts'), symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'A/src/def.ts'), 'utf-8')).toContain('export function tally');
    // 跨根 shared.ts 被闭包纳入：import 远程名 + 使用点都改
    expect(readFileSync(path.join(dir, 'shared.ts'), 'utf-8')).toContain("import { tally } from './A/src/def';");
    expect(readFileSync(path.join(dir, 'shared.ts'), 'utf-8')).toContain('return tally(1);');
    rmForce(dir);
  });
});

describe('renameSymbol - dry_run 结构化 diff 预览', () => {
  it('dry_run=true → 不落盘，返回 dryRun + 每处 old→new 编辑', async () => {
    const dir = mkProj({
      'src/def.ts': [
        'export function compute(a: number): number { return a * 2; }',
        'export { compute };',
      ].join('\n'),
      'src/a.ts': [
        "import { compute } from './def';",
        'export function run() { return compute(3); }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally', dry_run: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0); // 未落盘

    // 定义文件 + importer 都未被物理改动
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function compute');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain("import { compute }");

    // 结构化 diff：定义文件含声明处 compute→tally
    expect(r.definition).toBeDefined();
    expect(r.definition!.ops!.some((o) => o.old === 'compute' && o.new === 'tally')).toBe(true);
    // importer：import 远程名 + 使用点，2 处都是 compute→tally
    const imp = r.importers!.find((i) => i.file === 'src/a.ts')!;
    expect(imp.ops!.length).toBe(2);
    expect(imp.ops!.every((o) => o.old === 'compute' && o.new === 'tally')).toBe(true);
    // ops 的字节区间落在源文件合法范围内（可被 LLM 据此重放验证）
    const srcA = readFileSync(path.join(dir, 'src/a.ts'), 'utf-8');
    for (const o of imp.ops!) {
      expect(o.pos).toBeGreaterThanOrEqual(0);
      expect(o.pos + o.len).toBeLessThanOrEqual(srcA.length);
    }
    rmForce(dir);
  });

  it('dry_run=true + rename_file_if_matching → 只报计划联动名，文件物理未动', async () => {
    const dir = mkProj({
      'src/UserService.ts': 'export class UserService {}\n',
      'src/app.ts': "import { UserService } from './UserService';\nexport function make() { return new UserService(); }\n",
    });
    const r = await renameSymbol({
      project_dir: dir,
      file: 'src/UserService.ts',
      symbol: 'UserService',
      to: 'MemberService',
      rename_file_if_matching: true,
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.fileRenamed).toBe('src/MemberService.ts'); // 计划联动名
    // 物理未动
    expect(readFileSync(path.join(dir, 'src/UserService.ts'), 'utf-8')).toContain('export class UserService');
    expect(() => readFileSync(path.join(dir, 'src/MemberService.ts'), 'utf-8')).toThrow();
    rmForce(dir);
  });
});

describe('renameSymbol - tsconfig 路径别名（@/）', () => {
  it('importer 用 @/def 别名导入 → import 远程名 + 使用点都改', async () => {
    const dir = mkProj({
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'src/def.ts': 'export function compute(a: number): number { return a; }\n',
      'src/a.ts': "import { compute } from '@/def';\nexport function run() { return compute(1); }\n",
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function tally');
    // 别名 importer：import 子句远程名 + 使用点都改，别名前缀保留
    const a = readFileSync(path.join(dir, 'src/a.ts'), 'utf-8');
    expect(a).toContain("import { tally } from '@/def';");
    expect(a).toContain('return tally(1);');
    rmForce(dir);
  });
});

describe('renameSymbol - 跨根 importer（兄弟项目相对引用）', () => {
  it('B 项目用 ../A/src/def 引用 A 的 compute → 邻域扫描命中并改写', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': 'export function compute(a: number): number { return a; }\n',
      'B/package.json': '{ "name": "b" }\n',
      'B/src/use.ts': "import { compute } from '../../A/src/def';\nexport function use() { return compute(1); }\n",
    });

    // 不传 project_dir：自动定位 A 根 + 邻域扫描到 B
    const r = await renameSymbol({ file: path.join(dir, 'A/src/def.ts'), symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'A/src/def.ts'), 'utf-8')).toContain('export function tally');
    // 跨根 importer：import 远程名 + 使用点都改，相对路径保留
    const use = readFileSync(path.join(dir, 'B/src/use.ts'), 'utf-8');
    expect(use).toContain("import { tally } from '../../A/src/def';");
    expect(use).toContain('return tally(1);');
    // 结果里能看到跨根文件（相对根外一级：root=A，B 在相同父目录下）
    expect(r.importers!.some((i) => i.file === '../B/src/use.ts')).toBe(true);
    rmForce(dir);
  });
});

describe('renameSymbol - 跨根别名 importer（兄弟项目用自身别名引用 seed）', () => {
  it('B 用 @shared/def 别名引用 A 的 compute → 邻域扫描按 B 自身 tsconfig 命中并改写', async () => {
    const dir = mkProj({
      'A/package.json': '{ "name": "a" }\n',
      'A/src/def.ts': 'export function compute(a: number): number { return a; }\n',
      'B/package.json': '{ "name": "b" }\n',
      'B/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@shared/*': ['../A/src/*'] } } }),
      'B/src/use.ts': "import { compute } from '@shared/def';\nexport function use() { return compute(1); }\n",
    });

    const r = await renameSymbol({ file: path.join(dir, 'A/src/def.ts'), symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'A/src/def.ts'), 'utf-8')).toContain('export function tally');
    // 兄弟项目别名 importer：import 远程名 + 使用点都改（按 B 自身 tsconfig 解析）
    const use = readFileSync(path.join(dir, 'B/src/use.ts'), 'utf-8');
    expect(use).toContain("import { tally } from '@shared/def';");
    expect(use).toContain('return tally(1);');
    // 结果显示跨根别名 importer 被命中
    expect(r.importers!.some((i) => i.file === '../B/src/use.ts')).toBe(true);
    rmForce(dir);
  });
});

describe('analyzeGoSource - Go 包级符号解析', () => {
  it('收集 function/type 定义偏移 + 同文件裸引用偏移', async () => {
    const src = [
      'package svc',
      '',
      'func Target(x int) int {',
      '\treturn x + 1',
      '}',
      '',
      'func helper() int {',
      '\treturn Target(1)',
      '}',
      '',
      'type Target2 struct {',
      '\tV int',
      '}',
    ].join('\n');
    const m = await analyzeGoSource(src);
    expect(m).not.toBeNull();
    expect(m!.rootKinds.get('Target')).toBe('function');
    expect(m!.rootKinds.get('Target2')).toBe('type');
    // helper 内的 Target(1) 是引用
    expect(m!.refs.get('Target')!.length).toBe(1);
    // 定义偏移
    expect(src.slice(m!.rootOffsets.get('Target')!, m!.rootOffsets.get('Target')! + 6)).toBe('Target');
  });
});

describe('renameSymbol - Go 跨文件改名', () => {
  it('包级函数：定义 + 同文件引用 + 同目录 .go 引用一起改', async () => {
    const dir = mkProj({
      'src/def.go': [
        'package svc',
        '',
        'func Compute(a int) int {',
        '\treturn a * 2',
        '}',
        '',
        'func internal() int {',
        '\treturn Compute(1)',
        '}',
      ].join('\n'),
      'src/use.go': [
        'package svc',
        '',
        'func Run() int {',
        '\treturn Compute(3)',
        '}',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.go', symbol: 'Compute', to: 'Tally' });
    expect(r.ok).toBe(true);

    const def = readFileSync(path.join(dir, 'src/def.go'), 'utf-8');
    expect(def).toContain('func Tally(a int) int');
    expect(def).toContain('return Tally(1)'); // internal 引用改
    expect(def).not.toContain('func Compute');

    const use = readFileSync(path.join(dir, 'src/use.go'), 'utf-8');
    expect(use).toContain('return Tally(3)'); // 同包其它文件引用改

    // 改写了 2 个文件
    expect(r.filesWritten).toBe(2);
    expect(r.importers!.some((i) => i.file === 'src/use.go')).toBe(true);
    rmForce(dir);
  });

  it('type 符号：type_identifier 定义 + 引用一起改', async () => {
    const dir = mkProj({
      'src/def.go': [
        'package svc',
        'type Worker struct { Name string }',
        'func New() Worker { return Worker{} }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'src/def.go', symbol: 'Worker', to: 'Employee' });
    expect(r.ok).toBe(true);
    const def = readFileSync(path.join(dir, 'src/def.go'), 'utf-8');
    expect(def).toContain('type Employee struct');
    expect(def).toContain('func New() Employee { return Employee{} }');
    rmForce(dir);
  });

  it('撞名（同包其它文件已定义 to）→ 原子阻断，定义文件不变', async () => {
    const dir = mkProj({
      'src/def.go': 'package svc\nfunc Compute(a int) int { return a }\n',
      'src/other.go': 'package svc\nfunc Tally() int { return 1 }\n',
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.go', symbol: 'Compute', to: 'Tally' });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('Tally'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/def.go'), 'utf-8')).toContain('func Compute');
    rmForce(dir);
  });

  it('非包级符号（未定义）→ 拒绝', async () => {
    const dir = mkProj({
      'src/def.go': 'package svc\nfunc Compute() int { return 1 }\n',
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.go', symbol: 'Nope', to: 'X' });
    expect(r.ok).toBe(false);
    expect(r.blocked![0]).toContain('包级定义');
    rmForce(dir);
  });

  it('dry_run=true → 不落盘，返回 dryRun + ops', async () => {
    const dir = mkProj({
      'src/def.go': 'package svc\nfunc Compute(a int) int { return a }\nfunc use() int { return Compute(1) }\n',
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.go', symbol: 'Compute', to: 'Tally', dry_run: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0);
    expect(readFileSync(path.join(dir, 'src/def.go'), 'utf-8')).toContain('func Compute');
    // 定义 + 引用至少 2 处 ops
    expect(r.definition!.ops!.length).toBeGreaterThanOrEqual(2);
    expect(r.definition!.ops!.every((o) => o.old === 'Compute' && o.new === 'Tally')).toBe(true);
    rmForce(dir);
  });

  it('非 .go 文件不引入 Go 分支，仍按原 TS 语义（含作用于内符号入 TS 判断）', async () => {
    // 回归冒烟：确认 defExt 不是 .go 时走原 TS 分支逻辑（compute 改名）
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
      'src/a.ts': "import { compute } from './def';\nexport function run() { return compute(3); }\n",
    });
    const r = await renameSymbol({ project_dir: dir, file: 'src/def.ts', symbol: 'compute', to: 'tally' });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'src/def.ts'), 'utf-8')).toContain('export function tally');
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('return tally(3);');
    rmForce(dir);
  });

  it('跨包引用：主包 `corepkg.Process` → `corepkg.Tally`（前缀不动，field 改）', async () => {
    const dir = mkProj({
      'corepkg/corepkg.go': [
        'package corepkg',
        'func Process(x int) int { return x }',
      ].join('\n'),
      'main/main.go': [
        'package main',
        '',
        'import "corepkg"',
        '',
        'func run() int {',
        '  return corepkg.Process(1)',
        '}',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'corepkg/corepkg.go', symbol: 'Process', to: 'Tally' });
    expect(r.ok).toBe(true);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'corepkg/corepkg.go'), 'utf-8')).toContain('func Tally(x int) int');
    // 引包方跨包引用：pkg.Process → pkg.Tally
    const main = readFileSync(path.join(dir, 'main/main.go'), 'utf-8');
    expect(main).toContain('return corepkg.Tally(1)');
    expect(r.importers!.some((i) => i.file === 'main/main.go')).toBe(true);
    rmForce(dir);
  });

  it('跨包带别名：`corepkg "corepkg"` 别名 import → 仍按本地名判连，field 改', async () => {
    const dir = mkProj({
      'corepkg/corepkg.go': 'package corepkg\nfunc Process(x int) int { return x }\n',
      'main/main.go': [
        'package main',
        '',
        'import corepkg "corepkg"',
        '',
        'func run() int { return corepkg.Process(1) }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'corepkg/corepkg.go', symbol: 'Process', to: 'Tally' });
    expect(r.ok).toBe(true);
    expect(readFileSync(path.join(dir, 'main/main.go'), 'utf-8')).toContain('return corepkg.Tally(1)');
    rmForce(dir);
  });

  it('无关联包（未 import 定义包）→ 引包方跨包引用不动（隔离不误改）', async () => {
    const dir = mkProj({
      'corepkg/corepkg.go': 'package corepkg\nfunc Process(x int) int { return x }\n',
      // otherpkg 包有自己的 Process，且没 import corepkg → 不应被波及
      'otherpkg/otherpkg.go': 'package otherpkg\nfunc Process(x int) int { return x }\n',
      'main/main.go': [
        'package main',
        '',
        'import "otherpkg"',
        '',
        'func run() int { return otherpkg.Process(1) }',
      ].join('\n'),
    });

    const r = await renameSymbol({ project_dir: dir, file: 'corepkg/corepkg.go', symbol: 'Process', to: 'Tally' });
    expect(r.ok).toBe(true);
    // corepkg 自身改
    expect(readFileSync(path.join(dir, 'corepkg/corepkg.go'), 'utf-8')).toContain('func Tally');
    // main.go 引用的是 otherpkg.Process，不是 corepkg → 不动
    const main = readFileSync(path.join(dir, 'main/main.go'), 'utf-8');
    expect(main).toContain('return otherpkg.Process(1)');
    // 没有 import corepkg 的引包方被改写
    expect(r.importers!.filter((i) => i.file.endsWith('main.go'))).toEqual([]);
    rmForce(dir);
  });
});