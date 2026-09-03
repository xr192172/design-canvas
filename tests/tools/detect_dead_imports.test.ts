/**
 * detect_dead_imports 文件级死 import 检测测试
 *
 * 覆盖：
 *   - TS：死 import（绑定零引用 → 报死）；活 import（被引用 → 不报）。
 *   - TS 保守：副作用导入 `import 'x'` / re-export `export ... from` 恒活（绝不报死）。
 *   - Go：死 import（未用 → 报死）；活 import（`Q.` 成员访问 → 不报）。
 *   - Go 保守：空导入 `_` / 点导入 `.` 恒活。
 *   - 目录扫描：自动递归扫 TS/Go 源；files 显式收敛。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { detectDeadImports, classifyFileKind, enumerateTsSources } from '../../src/tools/detect_dead_imports';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 占用，留给 OS
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `dead-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

describe('detectDeadImports：TS', () => {
  it('零引用 import → 报死', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import _ from 'lodash';\nexport const live = 1;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    const cand = res.dead.find((c) => c.source === 'lodash');
    expect(cand).toBeDefined();
    expect(cand!.files).toContain('a.ts');
  });

  it('被引用的 import → 活（不报）', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { orderBy } from 'lodash';\nexport const use = orderBy([1], ['x']);\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'lodash')).toBeUndefined();
  });

  it('type import 绑定被类型引用 → 活（不报）', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import type { Box } from 'lib';\nexport const b: Box = { w: 1 };\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'lib')).toBeUndefined();
  });

  it('内联 type 导入 `{ type Box }` 被类型引用 → 活（回归：勿把限定符解析成 "type Box" 而误判死）', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { type Box } from 'lib';\nexport const b: Box[] = [];\n", 'utf-8');
    fs.writeFileSync(path.join(dir, 'b.ts'), "import { v, type Box } from 'lib2';\nexport const mix: Box = v ? { w: 1 } : null;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'lib')).toBeUndefined();
    expect(res.dead.find((c) => c.source === 'lib2')).toBeUndefined();
  });

  it('副作用导入 import "x" → 恒活（绝不报死）', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import 'polyfill';\nexport const x = 1;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'polyfill')).toBeUndefined();
  });

  it('re-export export * from / export {} from → 恒活', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "export * from 're';\nexport { z } from 're2';\nexport const own = 1;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 're')).toBeUndefined();
    expect(res.dead.find((c) => c.source === 're2')).toBeUndefined();
  });

  it('被引用的 require 绑定的模块 → 活', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.js'), "const fs = require('fs');\nexport const tag = fs ? 1 : 0;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'fs')).toBeUndefined();
  });

  it('未使用的 require 绑定 → 报死（与 remove 执行器同源规则一致）', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.js'), "const fs = require('fs');\nexport const tag = 1;\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    const cand = res.dead.find((c) => c.source === 'fs');
    expect(cand).toBeDefined();
  });

  it('无分号风格 + 属性复用：被引用的 import → 活（回归：stripTsImportLines 曾以分号/任意 from 终止，无分号时从注释里的 "dynamic import" 吞到远处，抹掉 `image: ImageRenderer` 使用行 → 活跃模块误判死）', () => {
    const dir = tempRoot();
    const src =
      '// 懒加载说明：首屏不加载这些，切换时才 dynamic import\n' +
      "import { ImageRenderer } from './renderers/ImageRenderer'\n" +
      'export const RENDERERS = { image: ImageRenderer }\n' +
      'export const CNT = Object.keys(RENDERERS).length\n';
    fs.writeFileSync(path.join(dir, 'a.ts'), src, 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    // 绑定 ImageRenderer 在属性值真正被用 → 该明确说明符绝不报死
    expect(res.dead.find((c) => c.source === './renderers/ImageRenderer')).toBeUndefined();
  });
});

describe('detectDeadImports：Go', () => {
  it('未用的 import → 报死', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.go'), "package a\nimport \"fmt\"\nfunc A() int { return 1 }\n", 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    const cand = res.dead.find((c) => c.source === 'fmt');
    expect(cand).toBeDefined();
    expect(cand!.files).toContain('a.go');
  });

  it('被 Q. 成员访问的 import → 活', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.go'), 'package a\nimport "fmt"\nfunc A() { fmt.Println("x") }\n', 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'fmt')).toBeUndefined();
  });

  it('空导入 _ / 点导入 . → 恒活', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.go'), 'package a\nimport _ "embed"\nfunc A() {}\n', 'utf-8');
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'embed')).toBeUndefined();
  });
});

describe('detectDeadImports：目录扫描', () => {
  it('自动递归扫嵌套目录，跨文件聚合同一源', () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, 'src', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.ts'), "import _ from 'lodash';\nexport const a = 1;\n", 'utf-8');
    fs.writeFileSync(path.join(dir, 'src', 'sub', 'b.ts'), "import _ from 'lodash';\nexport const b = 2;\n", 'utf-8');
    fs.writeFileSync(path.join(dir, 'c.go'), 'package c\nimport "fmt"\nfunc C() {}\n', 'utf-8');

    const res = detectDeadImports({ project_dir: dir });
    expect(res.scanned).toBe(3);
    const lodash = res.dead.find((c) => c.source === 'lodash');
    expect(lodash).toBeDefined();
    expect(lodash!.files).toEqual(['a.ts', path.join('src', 'sub', 'b.ts')]);
    const fmt = res.dead.find((c) => c.source === 'fmt');
    expect(fmt?.files).toEqual(['c.go']);
  });

  it('files 显式收敛只在给定文件内检测', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'a.ts'), "import _ from 'lodash';\nexport const a = 1;\n", 'utf-8');
    const only = path.join(dir, 'only.ts');
    fs.writeFileSync(only, "import _ from 'react';\nexport const r = 1;\n", 'utf-8');

    const res = detectDeadImports({ project_dir: dir, files: ['only.ts'] });
    expect(res.scanned).toBe(1);
    expect(res.dead.find((c) => c.source === 'lodash')).toBeUndefined();
    expect(res.dead.find((c) => c.source === 'react')).toBeDefined();
  });

  it('来源分类：src/test/fixture 分层，byKind 聚合正确', () => {
    const dir = tempRoot();
    // 真实源码里的死 import（可清）
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), "import _ from 'dep-a';\nexport const a = 1;\n", 'utf-8');
    // 测试文件
    fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'b.test.ts'), "import x from 'dep-b';\nexport const b = 1;\n", 'utf-8');
    // 夹具目录（字面量模块名，噪音）
    fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'sample.ts'), "import y from 'x';\nexport const s = 1;\n", 'utf-8');

    const res = detectDeadImports({ project_dir: dir });
    // 每个死源对应文件都有来源分类（scan 产出的 rel 用 OS 分隔符）
    expect(res.fileKind?.[path.join('src', 'a.ts')]).toBe('src');
    expect(res.fileKind?.[path.join('tests', 'b.test.ts')]).toBe('test');
    expect(res.fileKind?.[path.join('tests', 'fixtures', 'sample.ts')]).toBe('fixture');
    // 聚合：src 1、test 1、fixture 1；噪音可一眼识别
    expect(res.byKind).toEqual({ src: 1, test: 1, fixture: 1, generated: 0, snapshot: 0 });
  });

  it('classifyFileKind：快照/生成物优先级 + 默认 src', () => {
    expect(classifyFileKind('.design-canvas/projects/x/a.ts')).toBe('snapshot');
    expect(classifyFileKind('src/gen/cli.gen.ts')).toBe('generated');
    expect(classifyFileKind('tests/__fixtures__/data.ts')).toBe('fixture');
    expect(classifyFileKind('tests/foo.test.ts')).toBe('test');
    expect(classifyFileKind('src/svc/real.ts')).toBe('src');
  });

  it('注释里的 import 字面量不当真实源；URL 字符串不误剥', () => {
    // docstring / 代码注释里的 `import {..} from 'a'` 示例不是真导入 → 源发现侧应剥离注释
    const src = [
      "// 示例：`import { a } from 'a'` shows how",
      "/* doc: import { b, c } from 'x' */",
      "const url = 'https://cdn.example.com/p.js';",
      "import { real } from 'real-pkg';",
      'export const real = 1;',
    ].join('\n');
    const sources = enumerateTsSources(src);
    expect(sources).not.toContain('a'); // 行注释里的模块名
    expect(sources).not.toContain('x'); // 块注释里的模块名
    expect(sources).toContain('real-pkg'); // 真实 import 保留
  });

  it('文件仅注释里含 import 字面量 → 不报死 import', () => {
    const dir = tempRoot();
    // 整个文件唯一的 "import ... from 'a'" 在注释里：源发现剥离后无真实源，不该报死
    fs.writeFileSync(
      path.join(dir, 'doc.ts'),
      ["// `import { a } from 'a'`", 'export const x = 1;'].join('\n'),
      'utf-8',
    );
    const res = detectDeadImports({ project_dir: dir });
    expect(res.dead.find((c) => c.source === 'a')).toBeUndefined();
  });

  it('跳过 .design-canvas* 快照/备份目录（含 .design-canvas.bak-<ts> 变体）——不把历史快照副本重复计入', () => {
    const dir = tempRoot();
    // 真实源里的死 import
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), "import _ from 'lodash';\nexport const a = 1;\n", 'utf-8');
    // 快照/备份目录：同样的死 import 副本，绝不该被计入
    for (const snap of ['.design-canvas', '.design-canvas.bak-20260830-122215']) {
      const snapSrcDir = path.join(dir, snap, 'projects', 'design-canvas', 'src');
      fs.mkdirSync(snapSrcDir, { recursive: true });
      fs.writeFileSync(path.join(snapSrcDir, 'a.ts'), "import _ from 'lodash';\nexport const a = 1;\n", 'utf-8');
    }

    const res = detectDeadImports({ project_dir: dir });
    expect(res.scanned).toBe(1); // 只算真实 src
    const lodash = res.dead.find((c) => c.source === 'lodash');
    expect(lodash).toBeDefined();
    expect(lodash!.files).toEqual([path.join('src', 'a.ts')]); // 快照副本不被聚合进来
  });
});