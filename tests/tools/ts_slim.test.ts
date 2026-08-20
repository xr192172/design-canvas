/**
 * ts_slim / slim_brick TS 路径测试（Brick Harvest Phase 7）
 *
 * 覆盖：
 *   - slimTsFile 纯函数：死函数剪/活函数留/顶层 const 按 keep 集判活
 *     （与 dead_deps 值可达口径对齐——keep 进则活并记账，不在则剪）/
 *     import 绑定过滤（named 部分死重组、alias、default、namespace、
 *     副作用导入恒留）/ 类方法活则类留 / export { a, b } 名单过滤 /
 *     全空文件 out=null
 *   - resolveTsSpecifier：相对解析（原样/补扩展名/index/越界 null）
 *   - 全链（真 harvest_from_url 入盒 → slim_brick TS 路径 → 贫困编译）：
 *     死函数文件整文件剔除、死三方依赖从 import 与依赖清单双剔除、
 *     非引用资产不搬、原积木零改动、derived_from 溯源
 *
 * 环境：tree-sitter-typescript 已在 dependencies；贫困编译需 devDep
 * typescript（vitest 环境必有）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { slimTsFile } from '../../src/tools/ts_slim';
import { resolveTsSpecifier } from '../../src/tools/slim_brick';
import { harvestFromUrl } from '../../src/tools/harvest_from_url';
import { slimBrick } from '../../src/tools/slim_brick';

const roots: string[] = [];
const boxes: string[] = [];

afterAll(() => {
  for (const r of [...roots, ...boxes]) {
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

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(d);
  return d;
}

describe('slimTsFile 纯函数', () => {
  it('死函数剪、活函数留、顶层 const 按 keep 集判活', async () => {
    const src = [
      "import { helper } from './helper';",
      '',
      'export const VERSION = "1.0";',
      '',
      'export const DEAD_CONST = "dead";',
      '',
      'export function live(): number {',
      '  return VERSION.length + helper();',
      '}',
      '',
      'export function dead(): number {',
      '  return 42;',
      '}',
      '',
      '// 文件尾注释',
      '',
    ].join('\n');
    const r = await slimTsFile(src, ['live', 'VERSION']);
    expect(r.dropped_decls).toEqual(['DEAD_CONST', 'dead']);
    expect(r.kept_decls).toEqual(['VERSION', 'live']);
    expect(r.out).toContain('export function live');
    expect(r.out).toContain('export const VERSION');
    expect(r.out).not.toContain('export function dead');
    expect(r.out).toContain("// 文件尾注释");
  });

  it('import 绑定过滤：named 部分死重组，全死整条删，副作用导入恒留', async () => {
    const src = [
      "import { used, unused } from './mix';",
      "import { gone } from './all-dead';",
      "import './side-effect';",
      "import aliveDefault from './def';",
      '',
      'export function f(): number {',
      '  return used() + aliveDefault;',
      '}',
    ].join('\n');
    const r = await slimTsFile(src, ['f']);
    expect(r.out).toContain("import { used } from './mix';");
    expect(r.out).not.toContain('unused');
    expect(r.out).not.toContain('./all-dead');
    expect(r.out).toContain("import './side-effect';");
    expect(r.out).toContain("import aliveDefault from './def';");
    expect(r.dropped_imports.map((s) => s.replace(/^['"]|['"]$/g, ''))).toEqual(['./all-dead']);
  });

  it('alias import：引用名是别名；namespace import 按引用名判定', async () => {
    const src = [
      "import { a as renamed, b as bGone } from './mix';",
      "import * as ns from './ns';",
      '',
      'export function f(): string {',
      '  return renamed() + ns.value;',
      '}',
    ].join('\n');
    const r = await slimTsFile(src, ['f']);
    expect(r.out).toContain('a as renamed');
    expect(r.out).not.toContain('bGone');
    expect(r.out).toContain("import * as ns from './ns';");
  });

  it('类：死类剪、活类留、方法活而类名不在 keep 则类留（方法挂靠盲区防护）', async () => {
    const src = [
      'export class DeadThing {',
      '  run(): void {}',
      '}',
      '',
      'export class LiveThing {',
      '  run(): void {}',
      '}',
      '',
      'export class MethodAlive {',
      '  liveMethod(): void {}',
      '  deadMethod(): void {}',
      '}',
    ].join('\n');
    const r = await slimTsFile(src, ['LiveThing', 'liveMethod']);
    expect(r.out).toContain('export class LiveThing');
    expect(r.out).not.toContain('DeadThing');
    // 类整体保留（方法级剪枝不做），但类判定被 liveMethod 救活
    expect(r.out).toContain('export class MethodAlive');
    expect(r.dropped_decls).toEqual(['DeadThing']);
  });

  it('interface/type/enum：活留死剪；export { a, b } 本地名单过滤（死函数出名单）', async () => {
    const src = [
      'interface DeadShape {',
      '  x: number;',
      '}',
      '',
      'export interface LiveShape {',
      '  y: number;',
      '}',
      '',
      'export type DeadAlias = string;',
      '',
      'export function a(): number {',
      '  return 1;',
      '}',
      '',
      'export function b(): number {',
      '  return 2;',
      '}',
      '',
      'export { a, b };',
    ].join('\n');
    const r = await slimTsFile(src, ['LiveShape', 'a']);
    expect(r.out).toContain('export interface LiveShape');
    expect(r.out).not.toContain('DeadShape');
    expect(r.out).not.toContain('DeadAlias');
    expect(r.out).toContain('export function a');
    expect(r.out).not.toContain('export function b');
    expect(r.out).toContain('export { a };');
    expect(r.out).not.toContain('b }');
  });

  it('全空文件：所有声明死且无模块级代码 → out=null', async () => {
    const src = [
      "import { x } from './gone';",
      '',
      'export function onlyDead(): void {',
      '  x();',
      '}',
    ].join('\n');
    const r = await slimTsFile(src, []);
    expect(r.out).toBeNull();
    expect(r.dropped_decls).toEqual(['onlyDead']);
  });

  it('引用救活：被剪 type alias 被保留代码引用 → 复活；无人引用的死类型照剪', async () => {
    const src = [
      'export type PresetId = "dark" | "light";',
      '',
      'export interface Theme {',
      '  id: PresetId;',
      '}',
      '',
      'export type DeadShape = string;',
    ].join('\n');
    const r = await slimTsFile(src, ['Theme']);
    // PresetId 被 Theme（keep）的类型位置引用 → 救活（live 档案符号宇宙无 type alias 的兜底）
    expect(r.kept_decls).toContain('PresetId');
    expect(r.dropped_decls).toEqual(['DeadShape']);
    expect(r.out).toContain('export type PresetId');
    expect(r.out).not.toContain('DeadShape');
  });

  it('引用救活链式：keep→B→C，B 复活后其引用再救 C（不动点）', async () => {
    const src = [
      'export type Inner = number;',
      '',
      'export type Middle = Inner[];',
      '',
      'export function live(m: Middle): void {}',
      '',
      'export type DeadTail = string;',
    ].join('\n');
    const r = await slimTsFile(src, ['live']);
    expect(r.kept_decls).toContain('Middle'); // live 的参数类型
    expect(r.kept_decls).toContain('Inner'); // Middle 复活后其正文引用 Inner → 二轮救活
    expect(r.dropped_decls).toEqual(['DeadTail']);
  });
});

describe('resolveTsSpecifier', () => {
  const files = new Set(['src/a.ts', 'src/b/index.ts', 'src/data.json', 'src/mod.tsx']);
  const exists = (p: string): boolean => files.has(p);
  it('原样/补扩展名/index 解析；非相对与越界返回 null', () => {
    expect(resolveTsSpecifier('src/main.ts', './a', exists)).toBe('src/a.ts');
    expect(resolveTsSpecifier('src/main.ts', './mod', exists)).toBe('src/mod.tsx');
    expect(resolveTsSpecifier('src/main.ts', './b', exists)).toBe('src/b/index.ts');
    expect(resolveTsSpecifier('src/main.ts', './data.json', exists)).toBe('src/data.json');
    expect(resolveTsSpecifier('src/main.ts', '../outside', exists)).toBeNull();
    expect(resolveTsSpecifier('src/main.ts', 'react', exists)).toBeNull();
    expect(resolveTsSpecifier('src/deep/x.ts', '../a', exists)).toBe('src/a.ts');
  });
});

describe('slim_brick TS 全链', () => {
  /** TS fixture：svc.ts（种子）→ helper.ts；svc 活用 zod；dead.ts 死函数引死三方 deadlib + 未引用资产 */
  function makeTsProjectWithDead(): string {
    const root = tmpDir('slim-ts-src-');
    put(
      root,
      'package.json',
      JSON.stringify({ name: 'ts-demo', dependencies: { zod: '^3.0.0', deadlib: '^1.0.0' } }, null, 2),
    );
    put(
      root,
      'src/helper.ts',
      ['export function helper(): number {', '  return 1;', '}', '', 'export function unusedHelper(): number {', '  return 2;', '}'].join('\n'),
    );
    put(
      root,
      'src/svc.ts',
      [
        "import { z } from 'zod';",
        "import { helper } from './helper';",
        "import { deadFn } from './dead';",
        '',
        'export const schema = z.object({ name: z.string() });',
        '',
        'export function getUser(): { name: string } {',
        '  return schema.parse({ name: "alice" + helper() });',
        '}',
      ].join('\n'),
    );
    put(
      root,
      'src/dead.ts',
      [
        "import { thing } from 'deadlib';",
        '',
        'export function deadFn(): string {',
        '  return thing();',
        '}',
      ].join('\n'),
    );
    put(root, 'src/unused-asset.json', JSON.stringify({ dead: true }));
    put(root, 'src/unused.css', '.dead { color: red; }');
    return root;
  }

  it('入盒 → TS 瘦身：死文件剔除、死依赖双剔除、未引用资产不搬、贫困编译通过、原积木零改动', async () => {
    const src = makeTsProjectWithDead();
    const box = tmpDir('slim-ts-box-');
    boxes.push(box);
    const h = await harvestFromUrl({
      source: src,
      bricks: [{ name: 'ts_demo', seeds: ['src/svc.ts'] }],
      box_dir: box,
      write: true,
    });
    const brick = h.bricks[0] as { name: string; closure_count: number };
    expect(brick.name).toBe('ts_demo');
    expect(brick.closure_count).toBe(3); // svc + helper + dead（import 闭包）
    // slim_candidates 读盘上 manifest（返回结构不带；盘上真相优先）
    const harvestManifest = JSON.parse(
      fs.readFileSync(path.join(box, 'ts_demo', 'manifest.json'), 'utf-8'),
    ) as {
      slim_candidates?: {
        live_symbols: number;
        dead_third_party: Array<{ source: string }>;
        live_symbols_by_file: Record<string, string[]>;
      };
    };
    expect(harvestManifest.slim_candidates).toBeDefined();
    expect(harvestManifest.slim_candidates!.dead_third_party.map((d) => d.source)).toContain('deadlib');
    expect(harvestManifest.slim_candidates!.live_symbols_by_file['src/svc.ts']).toContain('getUser');

    const r = await slimBrick({ brick_name: 'ts_demo', box_dir: box, verify_build: true, write: true });
    // dead.ts 整文件剔除（种子不可达）
    expect(r.dropped_files).toEqual(['src/dead.ts']);
    // 死依赖从 import 与依赖清单双剔除
    expect(r.deps_before).toEqual(['deadlib', 'zod']);
    expect(r.deps_after).toEqual(['zod']);
    expect(r.deps_removed).toEqual(['deadlib']);
    // helper.ts 的 unusedHelper 剪掉，helper 保留
    const helper = r.files.find((f) => f.path === 'src/helper.ts');
    expect(helper?.kept_decls).toEqual(['helper']);
    expect(helper?.dropped_decls).toEqual(['unusedHelper']);
    // 未引用资产不搬
    const outFiles = fs.readdirSync(path.join(r.slim_dir, 'files', 'src')).sort();
    expect(outFiles).toEqual(['helper.ts', 'svc.ts']);
    // 贫困编译通过
    expect(r.build_verification?.status).toBe('pass');
    // 原积木零改动
    expect(fs.existsSync(path.join(box, 'ts_demo', 'files', 'src', 'dead.ts'))).toBe(true);
    // derived_from 溯源
    const m = JSON.parse(fs.readFileSync(path.join(r.slim_dir, 'manifest.json'), 'utf-8')) as {
      derived_from?: { brick: string };
    };
    expect(m.derived_from?.brick).toBe('ts_demo');
  }, 180_000);

  /** TS fixture：svc.ts `import type` 引 types.ts（编译期依赖），types.ts 混活/死类型 */
  function makeTsProjectTypeOnly(): string {
    const root = tmpDir('slim-ts-typeonly-src-');
    put(root, 'package.json', JSON.stringify({ name: 'ts-typeonly' }, null, 2));
    put(
      root,
      'src/types.ts',
      [
        'export type Config = { name: string; level: number };',
        '',
        'export interface Meta { tag: string; }',
        '',
        'export type DeadShape = boolean;',
        '',
        'export function deadTypeUser(d: DeadShape): string {',
        '  return "x";',
        '}',
      ].join('\n'),
    );
    put(
      root,
      'src/svc.ts',
      [
        "import type { Config } from './types.js';",
        '',
        'export function load(c: Config): string {',
        '  return c.name;',
        '}',
      ].join('\n'),
    );
    return root;
  }

  it('import type 编译期依赖：类型文件随闭包走，跨文件 type alias 活/死类型剪，贫困编译通过', async () => {
    const src = makeTsProjectTypeOnly();
    const box = tmpDir('slim-ts-typeonly-box-');
    boxes.push(box);
    const h = await harvestFromUrl({
      source: src,
      bricks: [{ name: 'ts_typeonly', seeds: ['src/svc.ts'] }],
      box_dir: box,
      write: true,
    });
    // import type 是运行时擦除的编译期依赖：闭包必须带上类型文件（自包含可编译）
    expect(h.bricks[0].closure_count).toBe(2);

    const r = await slimBrick({ brick_name: 'ts_typeonly', box_dir: box, verify_build: true, write: true });
    // 跨文件 type_ref（svc.load 参数注解 → types.Config）激活 Config；死类型照剪
    const types = r.files.find((f) => f.path === 'src/types.ts');
    expect(types?.kept_decls).toContain('Config');
    expect(types?.dropped_decls).toContain('DeadShape');
    // 贫困编译：import type 相对路径可解析、Config 存在 → pass
    expect(r.build_verification?.status).toBe('pass');
  }, 180_000);
});
