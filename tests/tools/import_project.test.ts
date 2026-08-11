/**
 * import_project 测试：扫描 fixture 项目 → 验证生成的 DSL
 *
 * 覆盖：
 *   - 文件扫描（跳过 node_modules / 测试文件）
 *   - 符号解析（TS/Go/Python 混合项目）
 *   - import 依赖边（相对导入 / Go module / Python 点分模块）
 *   - 目录容器节点 + contains 边
 *   - 布局无负坐标、容器包裹子节点
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { getDSL, getLiveFeature } from '../../src/storage';
import { diffViews } from '../../src/tools/diff_views';

let fixtureRoot: string;

/** 写 fixture 文件 */
function put(rel: string, content: string): void {
  const abs = path.join(fixtureRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'import-project-fixture-'));

  // TypeScript: src/a.ts 导入 ./b，src/b.ts 无导入
  put('src/a.ts', `import { helperB } from './b';\n\nexport function mainA(x: number): number {\n  return helperB(x);\n}\n`);
  put('src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);

  // TypeScript: src/util/c.ts 被 a.ts 间接依赖（测试目录容器嵌套）
  put('src/util/c.ts', `export const VERSION = '1.0';\nexport function utilC(): string {\n  return VERSION;\n}\n`);
  put('src/util/index.ts', `export { utilC } from './c';\n`);

  // Go: pkg/svc/svc.go 导入项目内 pkg/model
  put('go.mod', 'module example.com/demo\n\ngo 1.21\n');
  put('pkg/model/model.go', 'package model\n\ntype User struct {\n\tName string\n}\n\nfunc NewUser(name string) *User {\n\treturn &User{Name: name}\n}\n');
  put('pkg/svc/svc.go', 'package svc\n\nimport "example.com/demo/pkg/model"\n\nfunc GetUser() *model.User {\n\treturn model.NewUser("alice")\n}\n');

  // Python: pylib/worker.py 导入 pylib.config（点分 + 同包）
  put('pylib/config.py', 'TIMEOUT = 30\n\ndef get_timeout():\n    return TIMEOUT\n');
  put('pylib/worker.py', 'from pylib.config import get_timeout\nimport config\n\ndef run():\n    return get_timeout()\n');

  // Go 多模块（monorepo）：submod 有自己的 go.mod，模块路径独立
  put('submod/go.mod', 'module example.com/submod\n\ngo 1.21\n');
  put('submod/lib/lib.go', 'package lib\n\nfunc Hello() string {\n\treturn "hi"\n}\n');
  put('submod/cmd/main.go', 'package main\n\nimport "example.com/submod/lib"\n\nfunc main() {\n\tprintln(lib.Hello())\n}\n');

  // 应被跳过的内容
  put('node_modules/dep/index.js', 'module.exports = {};\n');
  put('src/a.test.ts', `import { mainA } from './a';\ntest('a', () => { mainA(1); });\n`);
  put('.git/ignored.ts', 'export const x = 1;\n');
});

afterAll(() => {
  try {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    // Windows 文件占用，留给 OS 清理
  }
});

describe('import_project', () => {
  it('应扫描 fixture 项目并生成 DSL', async () => {
    const result = await importProject({
      project_dir: fixtureRoot,
      feature: 'imported_demo',
      title: 'Demo 项目导入',
    });

    expect(result.feature).toBe('imported_demo');
    // 10 个源文件（node_modules / .test.ts / .git 应被跳过）
    expect(result.files_parsed).toBe(10);
    expect(result.symbols_found).toBeGreaterThanOrEqual(8);
    expect(result.dirs_created).toBeGreaterThanOrEqual(3); // src, src/util, pkg, pkg/model, pkg/svc, pylib
  });

  it('生成的 DSL 应包含文件节点、目录容器与语义层', () => {
    const dsl = getDSL('imported_demo');
    expect(dsl).not.toBeNull();
    expect(dsl!.title).toBe('Demo 项目导入');
    expect(dsl!.status).toBe('done');

    const nodeIds = dsl!.geometry.nodes.map((n) => n.id);
    // 文件节点
    expect(nodeIds).toContain('file_src_a_ts');
    expect(nodeIds).toContain('file_pkg_svc_svc_go');
    expect(nodeIds).toContain('file_pylib_worker_py');
    // 目录容器节点
    expect(nodeIds).toContain('dir_src');
    expect(nodeIds).toContain('dir_src_util');
    expect(nodeIds).toContain('dir_pkg_svc');

    // 语义层：每个文件都有 expected_apis 和 actual_apis（导入即回填）
    const svcFile = dsl!.semantic.files.find((f) => f.path === 'pkg/svc/svc.go');
    expect(svcFile).toBeDefined();
    expect(svcFile!.status).toBe('done');
    expect(svcFile!.expected_apis!.length).toBeGreaterThanOrEqual(1);
    expect(svcFile!.expected_apis![0].signature).toContain('GetUser');
    expect(svcFile!.actual_apis).toEqual(svcFile!.expected_apis);
  });

  it('依赖边应正确解析（相对导入 / Go module / Python 包）', () => {
    const dsl = getDSL('imported_demo')!;
    const edges = dsl!.geometry.edges || [];
    const depEdges = edges.filter((e) => e.label === 'imports');
    const depPairs = depEdges.map((e) => `${e.from}→${e.to}`);

    // TS: a.ts → b.ts（同目录，文件级边保留）
    expect(depPairs).toContain('file_src_a_ts→file_src_b_ts');
    // TS: util/index.ts → util/c.ts（同目录，文件级边保留）
    expect(depPairs).toContain('file_src_util_index_ts→file_src_util_c_ts');
    // Go: svc.go → model.go（跨目录，聚合为 LCA 层目录容器间边）
    expect(depPairs).toContain('dir_pkg_svc→dir_pkg_model');
    // Go 多模块: cmd/main.go → lib/lib.go（子模块 go.mod 独立识别，跨目录聚合）
    expect(depPairs).toContain('dir_submod_cmd→dir_submod_lib');
    // Python: worker.py → config.py（同目录，文件级边保留）
    expect(depPairs).toContain('file_pylib_worker_py→file_pylib_config_py');
    // 跨目录边不应以文件级形式出现（已聚合）
    expect(depPairs).not.toContain('file_pkg_svc_svc_go→file_pkg_model_model_go');

    // contains 边：目录→文件、父目录→子目录
    const containsPairs = edges.filter((e) => e.label === 'contains').map((e) => `${e.from}→${e.to}`);
    expect(containsPairs).toContain('dir_src→file_src_a_ts');
    expect(containsPairs).toContain('dir_src→dir_src_util');
    expect(containsPairs).toContain('dir_src_util→file_src_util_c_ts');
  });

  it('布局应无负坐标，且目录容器完整包裹其子节点', () => {
    const dsl = getDSL('imported_demo')!;
    const nodes = dsl!.geometry.nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));

    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
    }

    // 容器包裹检查：dir_src_util 应包裹 file_src_util_c_ts
    const utilDir = byId.get('dir_src_util')!;
    const cFile = byId.get('file_src_util_c_ts')!;
    expect(cFile.x!).toBeGreaterThanOrEqual(utilDir.x!);
    expect(cFile.y!).toBeGreaterThanOrEqual(utilDir.y!);
    expect(cFile.x! + cFile.width!).toBeLessThanOrEqual(utilDir.x! + utilDir.width!);
    expect(cFile.y! + cFile.height!).toBeLessThanOrEqual(utilDir.y! + utilDir.height!);

    // 嵌套包裹：dir_src 应包裹 dir_src_util
    const srcDir = byId.get('dir_src')!;
    expect(utilDir.x!).toBeGreaterThanOrEqual(srcDir.x!);
    expect(utilDir.y! + utilDir.height!).toBeLessThanOrEqual(srcDir.y! + srcDir.height!);

    // 画布尺寸足以容纳全部节点
    const maxRight = Math.max(...nodes.map((n) => n.x! + (n.width || 0)));
    const maxBottom = Math.max(...nodes.map((n) => n.y! + (n.height || 0)));
    expect(dsl!.geometry.width!).toBeGreaterThanOrEqual(maxRight);
    expect(dsl!.geometry.height!).toBeGreaterThanOrEqual(maxBottom);
  });

  it('空目录应报错，非法 project_dir 应报错', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-empty-'));
    await expect(importProject({ project_dir: emptyDir, feature: 'empty_proj' })).rejects.toThrow('未找到可解析的源文件');
    await expect(importProject({ project_dir: path.join(emptyDir, 'nonexistent'), feature: 'no_dir' })).rejects.toThrow('不存在');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('max_files 应截断并记录 skipped', async () => {
    const result = await importProject({
      project_dir: fixtureRoot,
      feature: 'imported_truncated',
      max_files: 3,
    });
    expect(result.files_parsed).toBe(3);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.skipped[0]).toContain('max_files');
  });

  it('design_mode：仅生成顶级目录节点，无文件节点、无悬空边', async () => {
    await importProject({
      project_dir: fixtureRoot,
      feature: 'design_mode_demo',
      title: '设计模式',
      design_mode: true,
    });

    const dsl = getDSL('design_mode_demo')!;
    expect(dsl).not.toBeNull();

    const dirNodes = dsl.geometry.nodes.filter((n) => n.type === 'module');
    const fileNodes = dsl.geometry.nodes.filter((n) => n.type === 'file');
    // 仅 4 个顶级目录（src/pkg/pylib/submod），无文件节点
    expect(fileNodes.length).toBe(0);
    expect(dirNodes.length).toBe(4);
    const dirIds = new Set(dirNodes.map((n) => n.id));
    expect(dirIds).toContain('dir_src');
    expect(dirIds).toContain('dir_pkg');
    expect(dirIds).toContain('dir_pylib');
    expect(dirIds).toContain('dir_submod');
    // 不含深层目录节点（不应出现 dir_src_util 等）
    expect(dirIds.has('dir_src_util')).toBe(false);

    // 无悬空边：每条边的 from/to 都必须落在已存在节点上
    const nodeIds = new Set(dsl.geometry.nodes.map((n) => n.id));
    for (const e of dsl.geometry.edges) {
      expect(nodeIds.has(e.from), `边 ${e.id} 的 from=${e.from} 悬空`).toBe(true);
      expect(nodeIds.has(e.to), `边 ${e.id} 的 to=${e.to} 悬空`).toBe(true);
    }

    // 语义层为目录级聚合（path 带末尾斜杠）
    const srcFile = dsl.semantic.files.find((f) => f.path === 'src/');
    expect(srcFile).toBeDefined();
    expect(srcFile!.expected_apis!.length).toBeGreaterThan(0);
  });

  it('full chain：design 与 live 视图落在同一 dataHome，diff_views 能同时找到两者', async () => {
    // design_mode 导入（写设计视图 → dataHome）
    await importProject({
      project_dir: fixtureRoot,
      feature: 'chain_demo',
      title: '全链路',
      design_mode: true,
    });
    // live_only 导入（不传 live_dir，默认与设计视图同根 → dataHome）
    await importProject({
      project_dir: fixtureRoot,
      feature: 'chain_demo',
      title: '全链路 live',
      live_only: true,
    });

    // 两视图都应可读（同一根目录）
    const design = getDSL('chain_demo');
    const live = getLiveFeature('chain_demo');
    expect(design).not.toBeNull();
    expect(live).not.toBeNull();

    // diff_views 无 live_dir 也能同时命中 design 与 live（dog food 路径修正）
    const diff = diffViews({ feature: 'chain_demo' });
    expect(diff.data.design_exists).toBe(true);
    expect(diff.data.live_exists).toBe(true);
    // design=目录级聚合，live=文件级 → 语义差异理应有大量 added
    expect(diff.data.summary.removed_files).toBeGreaterThan(0);
  });

  // ─────────────────────────────────────────────────────────────
  // gen_roles + design_mode：LLM 生成的标题键与 lookup 键必须一致
  // 回归测试：之前设计模式下 semanticFiles 路径带末尾 '/'，传给 LLM 的
  // path 字段是 'src/'，而 LLM 按"path 必须来自给定清单"会原样回传 'src/'。
  // 但 lookup 用的是 searchRel（去掉末尾 '/' 的 'src'），永远查不到。
  // 修复：传给 LLM 的 path 字段提前去掉 '/'，与 searchRel 对齐。
  // ─────────────────────────────────────────────────────────────
  it('gen_roles + design_mode：LLM 返回的标题能正确写回 dir 节点', async () => {
    const roleMod = await import('../../src/tools/role_title');
    const orig = roleMod.generateFileRoleTitles;
    // 模拟真实 LLM：原样回传输入的 path 作为 key（这是 LLM 提示"path 必须来自给定清单"的标准行为）
    Object.defineProperty(roleMod, 'generateFileRoleTitles', {
      value: async (files: Array<{ path: string }>) => {
        const out: Record<string, string> = {};
        for (const f of files) out[f.path] = `中文职责:${f.path}`;
        return out;
      },
      configurable: true,
      writable: true,
    });
    try {
      await importProject({
        project_dir: fixtureRoot,
        feature: 'roles_demo',
        title: '职责演示',
        design_mode: true,
        gen_roles: true,
      });
      const dsl = getDSL('roles_demo')!;
      expect(dsl).not.toBeNull();
      const dirNodes = dsl.geometry.nodes.filter((n) => n.type === 'module');
      // 至少有一个 dir 节点拿到了标题
      const titled = dirNodes.filter((n) => typeof n.title === 'string' && n.title.length > 0);
      expect(titled.length).toBeGreaterThan(0);
      // 验证 src 节点确实拿到了标题（lookup 必须能命中）
      const srcNode = dirNodes.find((n) => n.id === 'dir_src');
      expect(srcNode).toBeDefined();
      expect(srcNode!.title).toMatch(/中文职责:src\/?$/);
    } finally {
      Object.defineProperty(roleMod, 'generateFileRoleTitles', {
        value: orig,
        configurable: true,
        writable: true,
      });
    }
  });
});
