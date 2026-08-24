/**
 * remove_dead_imports 测试（死 import 移除执行器）
 *
 * 覆盖：
 *   - 纯函数 removeImportsFromSource，Go 形态：单行/别名/块成员/空块删壳/空导入/
 *     点导入；无关 import 与注释保留。
 *   - TS 形态：具名（含别名）/默认/命名空间/type import/副作用/re-export/
 *     CommonJS require（含跨行）；动态 import('x') 与字符串使用点不误删。
 *   - 执行器 removeDeadImports：聚合 dead → 按文件分组 → 原子落盘、changed 标记、
 *     源去重、读取失败整批中止。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { removeImportsFromSource, removeDeadImports } from '../../src/tools/remove_dead_imports';

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

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `rmdei-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

describe('removeImportsFromSource · Go', () => {
  it('单行 import：整行删除，其余 import 保留', () => {
    const src = ['package p', '', 'import "fmt"', 'import "github.com/dead/deaddep"', '', 'func f() { fmt.Println(1) }'].join('\n');
    const r = removeImportsFromSource(src, 'github.com/dead/deaddep', 'go');
    expect(r.changed).toBe(true);
    expect(r.output).toContain('import "fmt"');
    expect(r.output).not.toContain('deaddep');
    expect(r.output).toContain('func f()');
  });

  it('单行别名 import：整行删除', () => {
    const src = ['package p', '', 'import dd "github.com/dead/deaddep"', '', 'func f() int { return 1 }'].join('\n');
    const r = removeImportsFromSource(src, 'github.com/dead/deaddep', 'go');
    expect(r.changed).toBe(true);
    expect(r.output).not.toContain('deaddep');
    expect(r.output).toContain('func f()');
  });

  it('块 import：删成员行 + 相连成员；其余成员保留', () => {
    const src = [
      'package p',
      '',
      'import (',
      '\t"fmt"',
      '\t"github.com/dead/deaddep"',
      '\tkeep "github.com/live/kept"',
      ')',
      '',
      'func f() { fmt.Println(keep.V) }',
    ].join('\n');
    const r = removeImportsFromSource(src, 'github.com/dead/deaddep', 'go');
    expect(r.changed).toBe(true);
    expect(r.output).toContain('"fmt"');
    expect(r.output).toContain('keep "github.com/live/kept"');
    expect(r.output).not.toContain('deaddep');
    expect(r.output).toContain('import (');
  });

  it('块 import：删至空块 → 连 `import (`、`)` 一起删（空块壳折叠）', () => {
    const src = [
      'package p',
      '',
      'import (',
      '\t"github.com/dead/deaddep"',
      ')',
      '',
      'func f() {}',
    ].join('\n');
    const r = removeImportsFromSource(src, 'github.com/dead/deaddep', 'go');
    expect(r.changed).toBe(true);
    expect(r.output).not.toContain('deaddep');
    expect(r.output).not.toContain('import (');
    expect(r.output).toContain('func f()');
  });

  it('空导入 _ / 点导入 . 的死依赖：成员行删除', () => {
    const src = ['package p', '', 'import (', '\t_ "github.com/dead/side"', '\t. "github.com/dead/dotdot"', ')', '', 'func f() {}'].join('\n');
    for (const t of ['github.com/dead/side', 'github.com/dead/dotdot']) {
      const r = removeImportsFromSource(src, t, 'go');
      expect(r.changed).toBe(true);
      expect(r.output).not.toContain(t);
    }
  });

  it('无关 import / 注释保留；目标不在时不改动', () => {
    const src = ['package p', '', 'import "fmt" // keep me', '', 'func f() {}'].join('\n');
    const r = removeImportsFromSource(src, 'github.com/nonexistent/xx', 'go');
    expect(r.changed).toBe(false);
    expect(r.output).toBe(src);
  });
});

describe('removeImportsFromSource · TS', () => {
  it('具名 import（含别名）：整条删除，其余语句保留', () => {
    const src = [
      "import { a as b, c } from 'dead-pkg';",
      "import { ok } from 'live-pkg';",
      'export { useIt } ;',
    ].join('\n');
    const r = removeImportsFromSource(src, 'dead-pkg', 'ts');
    expect(r.changed).toBe(true);
    expect(r.output).not.toContain('dead-pkg');
    expect(r.output).toContain("import { ok } from 'live-pkg';");
  });

  it('跨行 import（大括号内换行）：整条删除', () => {
    const src = [
      "import {",
      '  x,',
      '  y,',
      "} from 'dead-pkg';",
      '',
      'export const z = 1;',
    ].join('\n');
    const r = removeImportsFromSource(src, 'dead-pkg', 'ts');
    expect(r.changed).toBe(true);
    expect(r.output).not.toContain('dead-pkg');
    expect(r.output).not.toContain('import {');
    expect(r.output).toContain('export const z = 1;');
  });

  it('默认 / 命名空间 / type import：各形态整条删除', () => {
    const base = "import def, { a } from 'dead-pkg';\nimport * as ns from 'dead-pkg';\nimport type { T } from 'dead-pkg';\nimport X from 'dead-pkg';\n";
    for (const line of base.split('\n').filter(Boolean)) {
      const r = removeImportsFromSource(line, 'dead-pkg', 'ts');
      expect(r.changed).toBe(true);
      expect(r.output.trim()).toBe('');
    }
  });

  it('副作用 import：删除', () => {
    const src = "import 'dead-side-effect';\nimport 'real-side-effect';";
    const r = removeImportsFromSource(src, 'dead-side-effect', 'ts');
    expect(r.changed).toBe(true);
    expect(r.output).toContain("import 'real-side-effect';");
    expect(r.output).not.toContain('dead-side-effect');
  });

  it('re-export：export * 与 export {…} from 均删除', () => {
    const src = "export * from 'dead-pkg';\nexport { a, b as c } from 'dead-pkg';\nexport { live } from 'live-pkg';";
    const r = removeImportsFromSource(src, 'dead-pkg', 'ts');
    expect(r.changed).toBe(true);
    expect(r.output).not.toContain('dead-pkg');
    expect(r.output).toContain("export { live } from 'live-pkg';");
  });

  it('CommonJS require：const 解构与裸 require 删除', () => {
    const a = "const { d } = require('dead-pkg');";
    const ra = removeImportsFromSource(a, 'dead-pkg', 'ts');
    expect(ra.changed).toBe(true);
    expect(ra.output.trim()).toBe('');

    const b = "const x = require('dead-pkg');\nconst keep = require('live-pkg');";
    const rb = removeImportsFromSource(b, 'dead-pkg', 'ts');
    expect(rb.changed).toBe(true);
    expect(rb.output).not.toContain('dead-pkg');
    expect(rb.output).toContain("const keep = require('live-pkg');");
  });

  it('不误删：动态 import("x") 与字符串使用点保留', () => {
    const src = [
      "import { real } from 'real-pkg';",
      "async function go() { const m = await import('dead-pkg'); return m; }",
      "const s = 'dead-pkg';",
    ].join('\n');
    const r = removeImportsFromSource(src, 'dead-pkg', 'ts');
    expect(r.output).toContain("await import('dead-pkg')");
    expect(r.output).toContain('const s =');
  });
});

describe('removeDeadImports · 执行器', () => {
  it('聚合 dead 清单 → 按文件删除并原子落盘；changed / 计数正确', () => {
    const dir = tempRoot();
    const goFile = 'pkg/a.go';
    const tsFile = 'src/b.ts';
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, goFile),
      ['package p', '', 'import (', '\t"fmt"', '\t"github.com/dead/ddead"', ')', '', 'func f() {}'].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(dir, tsFile),
      "import { x } from 'dead-ts';\nimport { ok } from 'ok-ts';\n",
      'utf-8',
    );

    const r = removeDeadImports({
      project_dir: dir,
      dead: [
        { source: 'github.com/dead/ddead', files: [goFile], reason: 'no_reference' },
        { source: 'dead-ts', files: [tsFile], reason: 'no_reference' },
      ],
    });

    expect(r.files_changed).toBe(2);
    expect(r.statements_removed).toBe(2);
    expect(r.files.map((f) => f.lang)).toEqual(['go', 'ts']);
    // 磁盘已更新
    expect(fs.readFileSync(path.join(dir, goFile), 'utf-8')).not.toContain('ddead');
    expect(fs.readFileSync(path.join(dir, tsFile), 'utf-8')).not.toContain('dead-ts');
    expect(fs.readFileSync(path.join(dir, tsFile), 'utf-8')).toContain('import { ok }');
  });

  it('dead 源去重：同一文件两个 dead 条目引用同源只删一次', () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg/a.go'), 'package p\n\nimport "github.com/dead/ddup"\n\nfunc f() {}\n', 'utf-8');
    const r = removeDeadImports({
      project_dir: dir,
      dead: [
        { source: 'github.com/dead/ddup', files: ['pkg/a.go'], reason: 'no_reference' },
        { source: 'github.com/dead/ddup', files: ['pkg/a.go'], reason: 'unreachable_only' },
      ],
    });
    expect(r.statements_removed).toBe(1);
  });

  it('无变更（指向不存在依赖）→ files_changed 0，且不写盘', () => {
    const dir = tempRoot();
    const rel = 'src/x.ts';
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "import { k } from 'real';\n", 'utf-8');
    const r = removeDeadImports({ project_dir: dir, dead: [{ source: 'not-imported', files: [rel], reason: 'no_reference' }] });
    expect(r.files_changed).toBe(0);
    expect(r.statements_removed).toBe(0);
    expect(fs.readFileSync(path.join(dir, rel), 'utf-8')).toContain("import { k }");
  });

  it('文件读取失败 → 整批中止（原子性，一个都不写）', () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const good = path.join(dir, 'src/g.ts');
    fs.writeFileSync(good, 'package p\n\nimport "github.com/dead/gd"\n\nfunc f() {}\n', 'utf-8');
    expect(() =>
      removeDeadImports({
        project_dir: dir,
        dead: [
          { source: 'github.com/dead/gd', files: ['src/g.ts'], reason: 'no_reference' },
          { source: 'x', files: ['src/missing.go'], reason: 'no_reference' },
        ],
      }),
    ).toThrow(/未写任何文件/);
    // 好的文件也没有被写
    expect(fs.readFileSync(good, 'utf-8')).toContain('github.com/dead/gd');
  });
});