/**
 * arch_layer 架构分层分析测试
 *
 * 覆盖：
 *   - 目录/文件名模式命中：db.ts→data、types.ts→types、renderer→ui、server.ts→entry、tools→utility
 *   - 未匹配 → 归入 core 兜底层
 *   - persist=true 写回 feature（dsl.layers + node.arch_layer），持久化后 getDSL 可读
 *   - persist=false 仅分析不落盘
 *   - feature 不存在 → 抛错
 *   - 自定义分层（三明治：积木/契约/胶水）+ 层间违规检测（积木引胶水 → 违规）
 *   - parseImportsLight / scanImportEdges / detectLayerViolations 纯函数
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { archLayer, scanImportEdges } from '../../src/tools/arch_layer';
import { getDSL } from '../../src/storage';
import { openDb } from '../../src/db/db';
import { parseImportsLight, detectLayerViolations, type LayerDef } from '../../src/tools/layer_detect';

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

/** 建一个覆盖多层的项目并写入 feature（含 file 节点） */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-layer-'));
  roots.push(root);
  put(root, 'api/routes/users.ts', `export function list() { return []; }\n`);
  put(root, 'src/db/db.ts', `export const db = 1;\n`);
  put(root, 'src/dsl/types.ts', `export interface T {}\n`);
  put(root, 'src/renderer/view.ts', `export function view() {}\n`);
  put(root, 'src/server.ts', `export function main() {}\n`);
  put(root, 'src/tools/helper.ts', `export function h() {}\n`);
  put(root, 'src/oddname.ts', `export function x() {}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, source_root: root, cache_db: db });
  db.close();
  return root;
}

/** 三明治自定义分层：胶水层(引一切) / 契约层(只自引) / 积木层(引契约+自己) */
const SANDWICH_LAYERS: LayerDef[] = [
  { id: 'glue', name: '胶水层', desc: '入口/路由/中间件/配置', color: '#e07b5f', patterns: ['glue'], allowed_deps: ['glue', 'contract', 'brick'] },
  { id: 'contract', name: '契约层', desc: '类型/接口/DTO', color: '#4fa3c9', patterns: ['contract'], allowed_deps: ['contract'] },
  { id: 'brick', name: '积木层', desc: '业务/数据/UI 功能', color: '#5a9e6f', patterns: ['brick'], allowed_deps: ['brick', 'contract'] },
];

/** 建三明治项目：brick/bad.ts 反向引 glue/server.ts → 应被判违规 */
async function makeSandwichProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-sandwich-'));
  roots.push(root);
  put(root, 'glue/server.ts', `import { routes } from './routes';\nexport function boot() { routes(); }\n`);
  put(root, 'glue/routes.ts', `import { svc } from '../brick/service';\nexport function routes() { svc(); }\n`);
  put(root, 'contract/types.ts', `export interface User { id: string }\n`);
  put(root, 'brick/service.ts', `import type { User } from '../contract/types';\nexport function svc(): User { return { id: '1' }; }\n`);
  put(root, 'brick/bad.ts', `import { boot } from '../glue/server';\nexport function bad() { boot(); }\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, source_root: root, cache_db: db });
  db.close();
  return root;
}

const assignUnder = (r: Awaited<ReturnType<typeof archLayer>>, pathLike: string) =>
  r.assignments.find((a) => a.path && a.path.includes(pathLike));

describe('arch_layer 架构分层', () => {
  it('按目录/文件名模式正确推断架构层', async () => {
    const feature = `arch_${Date.now()}`;
    await makeProject(feature);
    const r = await archLayer({ feature });

    expect(assignUnder(r, 'api/routes/users.ts')!.arch_layer).toBe('api');
    expect(assignUnder(r, 'src/db/db.ts')!.arch_layer).toBe('data');
    expect(assignUnder(r, 'src/dsl/types.ts')!.arch_layer).toBe('types');
    expect(assignUnder(r, 'src/renderer/view.ts')!.arch_layer).toBe('ui');
    expect(assignUnder(r, 'src/server.ts')!.arch_layer).toBe('entry');
    expect(assignUnder(r, 'src/tools/helper.ts')!.arch_layer).toBe('utility');
    // 未匹配 → core 兜底
    expect(assignUnder(r, 'src/oddname.ts')!.arch_layer).toBe('core');
  });

  it('persist=true 写回 feature（layers + arch_layer），getDSL 可读', async () => {
    const feature = `arch_persist_${Date.now()}`;
    await makeProject(feature);
    const r = await archLayer({ feature, persist: true });
    expect(r.persisted).toBe(true);

    const dsl = getDSL(feature)!;
    expect(dsl.layers!.length).toBeGreaterThan(0);
    const fileNode = dsl.geometry.nodes.find((n) => n.type === 'file' && (n.description ?? '').includes('db/db.ts'));
    expect(fileNode!.arch_layer).toBe('data');
  });

  it('persist=false 仅分析不落盘', async () => {
    const feature = `arch_nopersist_${Date.now()}`;
    await makeProject(feature);
    // importProject 导入时已按设计回填 layers（供图例/着色），存档本就含 layers。
    // persist=false 应保证不新增任何写盘：磁盘 DSL 与调用前完全一致。
    const before = getDSL(feature)!;
    const r = await archLayer({ feature, persist: false });
    expect(r.persisted).toBe(false);
    expect(getDSL(feature)).toEqual(before);
  });

  it('feature 不存在 → 抛错', async () => {
    await expect(archLayer({ feature: `nope_${Date.now()}` })).rejects.toThrow(/不存在/);
  });

  it('自定义分层（三明治：胶水/契约/积木）正确归属 + 积木引胶水判违规', async () => {
    const feature = `arch_sandwich_${Date.now()}`;
    await makeSandwichProject(feature);
    const r = await archLayer({ feature, layers: SANDWICH_LAYERS, check_violations: true });

    expect(assignUnder(r, 'glue/server.ts')!.arch_layer).toBe('glue');
    expect(assignUnder(r, 'glue/routes.ts')!.arch_layer).toBe('glue');
    expect(assignUnder(r, 'contract/types.ts')!.arch_layer).toBe('contract');
    expect(assignUnder(r, 'brick/service.ts')!.arch_layer).toBe('brick');

    // 允许方向不判违规：glue→brick（routes 引 service）、brick→contract（service 引 types）
    expect(r.violations.find((v) => v.from_layer === 'glue' && v.to_layer === 'brick')).toBeUndefined();
    expect(r.violations.find((v) => v.from_layer === 'brick' && v.to_layer === 'contract')).toBeUndefined();
    // 违规：brick/bad.ts 反向引 glue/server.ts
    const viol = r.violations.find((v) => v.from_file.includes('brick/bad.ts'));
    expect(viol).toBeDefined();
    expect(viol!.from_layer).toBe('brick');
    expect(viol!.to_layer).toBe('glue');
    expect(viol!.via).toBe('../glue/server');

    // 层间矩阵应含 brick→glue 违规方向
    const m = r.layer_matrix.find((x) => x.from === 'brick' && x.to === 'glue');
    expect(m).toBeDefined();
    expect(m!.count).toBe(1);
  });

  it('check_violations=false 跳过违规检测（violations 为空、不读代码）', async () => {
    const feature = `arch_noviol_${Date.now()}`;
    await makeSandwichProject(feature);
    const r = await archLayer({ feature, layers: SANDWICH_LAYERS, check_violations: false });
    expect(r.violations).toEqual([]);
    expect(r.layer_matrix).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 纯函数：import 解析 / 边构建 / 违规判定
// ─────────────────────────────────────────────────────────────

describe('parseImportsLight - 轻量 import 解析', () => {
  it('TS/JS：from / 裸导入 / require / import() 的相对路径', () => {
    const src = `
      import a from './a';
      import './side';
      const b = require('../b');
      import('../c');
      import d from 'pkg'; // 包导入不应被收集
    `;
    const out = parseImportsLight(src);
    expect(out).toContain('./a');
    expect(out).toContain('./side');
    expect(out).toContain('../b');
    expect(out).toContain('../c');
    expect(out).not.toContain('pkg');
  });

  it('Go：import "x" / import ( "x" ) 的相对路径', () => {
    const src = `
      import "fmt"
      import (
        "strings"
        "./internal/local"
      )
    `;
    const out = parseImportsLight(src);
    expect(out).toContain('./internal/local');
    expect(out).not.toContain('fmt');
    expect(out).not.toContain('strings');
  });

  it('Python：from . import / from .x import / from ..y import', () => {
    const src = `
      from . import base
      from .models import User
      from ..shared import helper
      import os
    `;
    const out = parseImportsLight(src);
    expect(out).toContain('./');
    expect(out).toContain('./models');
    expect(out).toContain('../shared');
    expect(out).not.toContain('os');
  });
});

describe('scanImportEdges - 文件级 import 边', () => {
  it('相对导入解析到项目内文件，且去掉扩展名', () => {
    const files = [
      { path: 'glue/server.ts', src: `import { routes } from './routes';\n` },
      { path: 'glue/routes.ts', src: `import { svc } from '../brick/service.ts';\n` },
      { path: 'brick/service.ts', src: `export const svc = 1;\n` },
    ];
    const edges = scanImportEdges(files);
    expect(edges).toContainEqual({ from: 'glue/server.ts', to: 'glue/routes.ts', via: './routes' });
    expect(edges).toContainEqual({ from: 'glue/routes.ts', to: 'brick/service.ts', via: '../brick/service.ts' });
  });

  it('自引用 / 未命中目标 不产生边', () => {
    const files = [
      { path: 'a/x.ts', src: `import './x';\nimport 'pkg';\n` },
    ];
    expect(scanImportEdges(files)).toEqual([]);
  });
});

describe('detectLayerViolations - 层间违规判定', () => {
  it('brick 引 glue 判违规；glue 引 brick 与 brick 引 contract 合规', () => {
    const fileLayers: Record<string, string> = {
      'glue/server.ts': 'glue',
      'glue/routes.ts': 'glue',
      'contract/types.ts': 'contract',
      'brick/service.ts': 'brick',
      'brick/bad.ts': 'brick',
    };
    const edges = [
      { from: 'glue/routes.ts', to: 'brick/service.ts', via: '../brick/service' },
      { from: 'brick/service.ts', to: 'contract/types.ts', via: '../contract/types' },
      { from: 'brick/bad.ts', to: 'glue/server.ts', via: '../glue/server' },
    ];
    const v = detectLayerViolations({ defs: SANDWICH_LAYERS, fileLayers, edges });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ from_file: 'brick/bad.ts', from_layer: 'brick', to_layer: 'glue' });
  });

  it('层定义内 allowed_deps 优先于内置 DEFAULT_ALLOWED_DEPS', () => {
    const defs: LayerDef[] = [
      { id: 'a', name: 'A', desc: '', color: '#000', patterns: ['a'], allowed_deps: ['a'] },
      { id: 'b', name: 'B', desc: '', color: '#000', patterns: ['b'], allowed_deps: ['b'] },
    ];
    const v = detectLayerViolations({
      defs,
      fileLayers: { 'a/x.ts': 'a', 'b/y.ts': 'b' },
      edges: [{ from: 'a/x.ts', to: 'b/y.ts', via: '../b/y' }],
    });
    expect(v).toHaveLength(1);
  });
});
