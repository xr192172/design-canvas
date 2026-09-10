/**
 * symbol_move —— 跨文件模块级符号移动（语义重构第一棒）测试
 * - 移动定义 + 重定向 importer（源删/目标加/import source 改向）
 * - dry_run 不落盘
 * - 阻断：目标撞名 / statement 混入其它符号 / namespace import / 星号转发 / 非模块级符号
 * - 跨工作区外部：externalRefs 只反馈，外部盘态不变
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveSymbol } from '../../src/tools/symbol_move.js';
import { analyzeModuleSource } from '../../src/tools/rename_symbol.js';
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../../src/db/db.js';
import { searchSymbols } from '../../src/db/symbols.js';

let tmp: string;
let root: string;

function write(abs: string, content: string): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'symmove-'));
  root = path.join(tmp, 'proj');
  write(path.join(root, 'tsconfig.json'), '{}');
});

afterEach(() => {
  closeAllProjectCacheDbs();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用留给 OS */
  }
});

describe('symbol_move 跨文件模块级迁移', () => {
  it('移动定义 + 重定向 importer，源删/目标加/import 指向新目标/索引可查', async () => {
    write(path.join(root, 'a.ts'), 'export function target(): number { return 1; }\n');
    write(path.join(root, 'b.ts'), "import { target } from './a.js';\ntarget();\n");
    const cAbs = path.join(root, 'c.ts');

    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(true);

    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).not.toContain('function target');
    const c = fs.readFileSync(cAbs, 'utf8');
    expect(c).toContain('function target');
    expect(c).toContain('export');
    const b = fs.readFileSync(path.join(root, 'b.ts'), 'utf8');
    expect(b).toContain("import { target } from './c'");
    expect(b).not.toContain("'./a");
    // 目标文件能被模块级分析认出该符号
    const tmod = await analyzeModuleSource(c, cAbs);
    expect(tmod?.rootKinds.get('target')).toBe('function');
    // 索引可查
    const db = getProjectCacheDb(root);
    expect(searchSymbols(db, 'target', 5).length).toBeGreaterThan(0);
  });

  it('dry_run 不落盘', async () => {
    write(path.join(root, 'a.ts'), 'export function target(): number { return 1; }\n');
    write(path.join(root, 'b.ts'), "import { target } from './a.js';\ntarget();\n");
    const cAbs = path.join(root, 'c.ts');

    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0);
    expect(r.redirects?.length).toBe(1);
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toContain('function target');
    expect(fs.existsSync(cAbs)).toBe(false);
  });

  it('目标文件已存在同名符号 → 阻断，不落盘', async () => {
    write(path.join(root, 'a.ts'), 'export function target(): number { return 1; }\n');
    write(path.join(root, 'c.ts'), 'export function target(): string { return "x"; }\n');
    const aBefore = fs.readFileSync(path.join(root, 'a.ts'), 'utf8');
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(false);
    expect(r.blocked?.join('')).toContain('同名');
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toBe(aBefore);
  });

  it('statement 同时引入其它符号 → 阻断', async () => {
    write(path.join(root, 'a.ts'), 'export function target() { return 1; }\nexport function other() { return 2; }\n');
    write(path.join(root, 'b.ts'), "import { target, other } from './a.js';\n");
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(false);
    expect(r.blocked?.join('')).toMatch(/同时引入其它符号/);
  });

  it('namespace import → 阻断', async () => {
    write(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
    write(path.join(root, 'b.ts'), "import * as ns from './a.js';\nns.target();\n");
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(false);
    expect(r.blocked?.join('')).toMatch(/namespace/);
  });

  it('星号转发（export * from 源文件）→ 阻断', async () => {
    write(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
    write(path.join(root, 'b.ts'), "export * from './a.js';\n");
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(false);
    expect(r.blocked?.join('')).toMatch(/export \*/);
  });

  it('对非模块级符号发起 → 阻断（target 是局部 const）', async () => {
    write(path.join(root, 'a.ts'), 'export function run() { const local = 1; return local; }\n');
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'local', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(false);
    expect(r.blocked?.join('')).toMatch(/不是/);
  });

  it('跨工作区外部：externalRefs 只反馈，外部文件盘态不变', async () => {
    const external = path.join(tmp, 'external');
    write(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
    write(path.join(root, 'b.ts'), "import { target } from './a.js';\nimport { h } from '../external/ext.js';\ntarget();\nh();\n");
    const extPath = write(path.join(external, 'ext.js'), 'export function h() { return 1; }\n');
    const extBefore = fs.readFileSync(extPath, 'utf8');

    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', dry_run: false });
    expect(r.ok).toBe(true);
    expect(r.externalRefs?.some((e) => e.resolved === extPath)).toBe(true);
    // 外部不被改动
    expect(fs.readFileSync(extPath, 'utf8')).toBe(extBefore);
    // b.ts 里指向外部的 import 保留；指向 a 的改到 c
    const b = fs.readFileSync(path.join(root, 'b.ts'), 'utf8');
    expect(b).toContain("import { target } from './c'");
    expect(b).toContain("import { h } from '../external/ext.js'");
  });

  it('传入 to_symbol 但 v1 不改名 → toSymbolDeferred，符号仍原名移动', async () => {
    write(path.join(root, 'a.ts'), 'export function target() { return 1; }\n');
    write(path.join(root, 'b.ts'), "import { target } from './a.js';\ntarget();\n");
    const cAbs = path.join(root, 'c.ts');
    const r = await moveSymbol({ project_dir: root, file: 'a.ts', symbol: 'target', to_file: 'c.ts', to_symbol: 'renamed', dry_run: false });
    expect(r.ok).toBe(true);
    expect(r.toSymbolDeferred).toBe(true);
    expect(fs.readFileSync(cAbs, 'utf8')).toContain('function target');
    expect(fs.readFileSync(cAbs, 'utf8')).not.toContain('function renamed');
  });
});