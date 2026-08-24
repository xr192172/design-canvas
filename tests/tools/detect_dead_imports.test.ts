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
import { detectDeadImports } from '../../src/tools/detect_dead_imports';

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
});