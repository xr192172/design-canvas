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
import { getDSL } from '../../src/storage';

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
    // 8 个源文件（node_modules / .test.ts / .git 应被跳过）
    expect(result.files_parsed).toBe(8);
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

    // TS: a.ts → b.ts
    expect(depPairs).toContain('file_src_a_ts→file_src_b_ts');
    // TS: util/index.ts → util/c.ts
    expect(depPairs).toContain('file_src_util_index_ts→file_src_util_c_ts');
    // Go: svc.go → model.go（module 前缀剥离）
    expect(depPairs).toContain('file_pkg_svc_svc_go→file_pkg_model_model_go');
    // Python: worker.py → config.py（点分模块或同包导入至少解析一条）
    expect(depPairs).toContain('file_pylib_worker_py→file_pylib_config_py');

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
});
