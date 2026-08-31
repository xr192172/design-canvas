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