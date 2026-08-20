/**
 * dead_deps 死依赖检测测试（积木瘦身事实层 Phase 5+）
 *
 * 覆盖：
 *   - 纯函数：Go import 限定符解析（块/单行/alias）、TS import 限定符解析
 *     （named/alias/namespace/default/副作用 null/CommonJS）、限定符出现行
 *     （Go 注释剔除 + URL 字符串保护）
 *   - Go 集成（真实 import_project 索引管线）：
 *     种子用到的三方 dep 活；同包 sibling 文件里不可达函数引的 dep → 死候选
 *     （unreachable_only）；包级 var 初始化引用的 dep → 保守活
 *   - TS 集成：种子调用链上的 dep 活；未被调用的导出函数里的 dep → 死候选；
 *     顶层 const（模块初始化）引用的 dep → 保守活
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { harvestClosure } from '../../src/tools/harvest_closure';
import { openDb } from '../../src/db/db';
import {
  analyzeDeadThirdParty,
  parseGoImportQualifiers,
  parseTsImportQualifiers,
  qualifierLines,
} from '../../src/tools/dead_deps';

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

describe('parseGoImportQualifiers', () => {
  it('块导入：alias 优先，无 alias 取路径末段', () => {
    const src = [
      'package svc',
      '',
      'import (',
      '\t"fmt"',
      '\tlive "github.com/live/livedep"',
      '\t"github.com/dead/deaddep"',
      ')',
    ].join('\n');
    const m = parseGoImportQualifiers(src);
    expect(m.get('fmt')).toBe('fmt');
    expect(m.get('github.com/live/livedep')).toBe('live');
    expect(m.get('github.com/dead/deaddep')).toBe('deaddep');
  });

  it('单行导入 + 空导入/点导入标记', () => {
    const src = 'package p\n\nimport "github.com/x/y"\nimport _ "github.com/side/effect"\nimport . "github.com/dot/dotdep"\n';
    const m = parseGoImportQualifiers(src);
    expect(m.get('github.com/x/y')).toBe('y');
    expect(m.get('github.com/side/effect')).toBe('_');
    expect(m.get('github.com/dot/dotdep')).toBe('.');
  });
});

describe('parseTsImportQualifiers', () => {
  const src = [
    "import def, { a, b as c } from 'pkg1';",
    "import * as ns from 'pkg2';",
    "import 'side-effect';",
    "const { d } = require('pkg3');",
    "import type { T } from 'pkg4';",
  ].join('\n');

  it('named/alias/default 混合', () => {
    expect(parseTsImportQualifiers(src, 'pkg1')).toEqual(['def', 'a', 'c']);
  });
  it('namespace', () => {
    expect(parseTsImportQualifiers(src, 'pkg2')).toEqual(['ns']);
  });
  it('副作用导入返回 null（调用方保守按活）', () => {
    expect(parseTsImportQualifiers(src, 'side-effect')).toBeNull();
  });
  it('CommonJS 解构', () => {
    expect(parseTsImportQualifiers(src, 'pkg3')).toEqual(['d']);
  });
  it('未出现的模块返回 null', () => {
    expect(parseTsImportQualifiers(src, 'not-imported')).toBeNull();
  });
});

describe('qualifierLines', () => {
  it('Go：Q. 成员访问行；行注释剔除；URL 字符串里的 // 不当注释', () => {
    const src = [
      'package p', // 1
      'x := dep.Use()', // 2 命中
      '// dep.Comment() 注释不算', // 3
      'u := "https://example.com/dep"' + ' // 注释', // 4（注释剥离后无 dep.）
      'y := strings.Contains(u, "x") // dep.InComment()', // 5 注释剥离
      'z := w.Get("https://a") + dep.After()', // 6 命中（URL 后的真引用）
    ].join('\n');
    expect(qualifierLines(src, 'dep', 'go')).toEqual([2, 6]);
  });

  it('TS：裸标识符出现即引用', () => {
    const src = ['const x = 1;', 'live()', 'const y = live;', 'deep.live.not', 'alive2()'].join('\n');
    // 第 4 行 .live 是属性访问（可能是 namespace 成员）→ 命中；第 5 行 alive2 词边界不命中
    expect(qualifierLines(src, 'live', 'ts')).toEqual([2, 3, 4]);
  });
});

// ── 集成（真实索引管线）──────────────────────────────────────

async function makeGoProject(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-deps-go-'));
  roots.push(root);
  put(root, 'go.mod', 'module example.com/demo\n\ngo 1.21\n');
  // 种子：Do() 用 livedep
  put(
    root,
    'pkg/svc/svc.go',
    [
      'package svc',
      '',
      'import (',
      '\t"fmt"',
      '\t"github.com/live/livedep"',
      ')',
      '',
      'func Do() string {',
      '\treturn fmt.Sprintf("%v", livedep.Use())',
      '}',
    ].join('\n'),
  );
  // 同包 sibling（Go 目录内聚被闭包端走）：Extra() 不可达，引 deaddep
  put(
    root,
    'pkg/svc/extra.go',
    [
      'package svc',
      '',
      'import "github.com/dead/deaddep"',
      '',
      'func Extra() string {',
      '\treturn deaddep.Thing()',
      '}',
    ].join('\n'),
  );
  // 包级 var 初始化（不进符号索引 → 落 span 外 → 保守活）
  put(
    root,
    'pkg/svc/initvar.go',
    [
      'package svc',
      '',
      'import "github.com/side/effect"',
      '',
      'var Global = effect.Setup()',
    ].join('\n'),
  );
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature: 'dead-deps-go', cache_db: db });
  db.close();
  return root;
}

async function makeTsProject(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-deps-ts-'));
  roots.push(root);
  put(
    root,
    'src/a.ts',
    [
      "import { helper } from './lib';",
      "import { live } from 'livedep';",
      '',
      'export function main(x: number): string {',
      '\treturn live(String(helper(x)));',
      '}',
    ].join('\n'),
  );
  put(
    root,
    'src/lib.ts',
    [
      "import { dead } from 'deaddep';",
      "import { side } from 'sidedep';",
      '',
      'export const client = side.create();',
      '',
      'export function helper(x: number): number {',
      '\treturn x * 2;',
      '}',
      '',
      'export function unused(): void {',
      '\tdead.call();',
      '}',
    ].join('\n'),
  );
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature: 'dead-deps-ts', cache_db: db });
  db.close();
  return root;
}

describe('analyzeDeadThirdParty 集成', () => {
  it('Go：sibling 不可达函数的 dep 死候选；种子用的活；包级 var 保守活', async () => {
    const root = await makeGoProject();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const closure = harvestClosure({ project_dir: root, files: ['pkg/svc/svc.go'] });
      const closureFiles = closure.internal_files.map((f) => f.path);
      expect(closureFiles).toContain('pkg/svc/extra.go'); // sibling 补全端走
      expect(closureFiles).toContain('pkg/svc/initvar.go');

      const r = analyzeDeadThirdParty({
        db,
        projectDir: root,
        closureFiles,
        seedFiles: ['pkg/svc/svc.go'],
        external: closure.external,
      });

      const deadSources = r.dead.map((d) => d.source);
      expect(deadSources).toEqual(['github.com/dead/deaddep']);
      expect(r.dead[0].reason).toBe('unreachable_only');
      expect(r.dead[0].files).toEqual(['pkg/svc/extra.go']);
      // livedep（种子活用）与 sidedep→effect（包级 var 保守）都不在死候选
      expect(deadSources).not.toContain('github.com/live/livedep');
      expect(dead_sources_check(r.dead)).not.toContain('github.com/side/effect');
      expect(r.total_symbols).toBeGreaterThan(0);
      expect(r.live_symbols).toBeGreaterThan(0);
      expect(r.limitations.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('TS：未调用导出函数的 dep 死候选；调用链上的活；顶层 const 保守活', async () => {
    const root = await makeTsProject();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const closure = harvestClosure({ project_dir: root, files: ['src/a.ts'] });
      const r = analyzeDeadThirdParty({
        db,
        projectDir: root,
        closureFiles: closure.internal_files.map((f) => f.path),
        seedFiles: ['src/a.ts'],
        external: closure.external,
      });

      const deadSources = r.dead.map((d) => d.source);
      expect(deadSources).toEqual(['deaddep']);
      expect(r.dead[0].reason).toBe('unreachable_only');
      // livedep（main 活用）、sidedep（lib.ts 顶层 const client 初始化）都不死
      expect(deadSources).not.toContain('livedep');
      expect(deadSources).not.toContain('sidedep');
    } finally {
      db.close();
    }
  });
});

function dead_sources_check(dead: Array<{ source: string }>): string[] {
  return dead.map((d) => d.source);
}
