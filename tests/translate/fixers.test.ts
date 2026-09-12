/**
 * fixers —— C1 内建 deterministic fixer 测试
 *
 * 覆盖：去未用 import（保用过的、别名按本地名判、整条未用删行）、合并同源 import、
 * 组合幂等；端到端：fill 后模块里没被函数体用到的跨文件 import 会被 fixer 移除。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixUnusedImports, squashImports, applyDeterministicFixers } from '../../src/translate/fixers.js';
import { translateGoProject } from '../../src/translate/project.js';

describe('fixUnusedImports：去未用 import', () => {
  it('保用过的 A/C，删未用的 B', () => {
    const src = [
      `import { A } from './a';`,
      `import { B, C } from './b';`,
      'export function f(x: number): number {',
      '  return A(x) + C;',
      '}',
    ].join('\n');
    const out = fixUnusedImports(src);
    expect(out).toContain("import { A } from './a';");
    expect(out).toContain("import { C } from './b';");
    expect(out).not.toMatch(/B\s*[,}]/);
  });

  it('整条未用 import → 移除该行', () => {
    const src = [`import { A, B } from './dead';`, 'export function f(): number {', '  return 1;', '}'].join('\n');
    const out = fixUnusedImports(src);
    expect(out).not.toContain('./dead');
    expect(out).toContain('export function f');
  });

  it('别名 import `A as AA`：本地名 AA 用则保留', () => {
    const src = [`import { A as AA } from './a';`, 'export function f(): number {', '  return AA();', '}'].join('\n');
    const out = fixUnusedImports(src);
    expect(out).toContain("import { A as AA } from './a';");
  });
});

describe('squashImports：合并同源 import', () => {
  it('同源两行 → 合并为一行并排序、去重名字', () => {
    const src = [`import { B } from './x';`, `import { A } from './x';`, `import { Z } from './y';`, 'export {}'].join('\n');
    const out = squashImports(src);
    expect(out.match(/from '\.\/x'/g)).toHaveLength(1);
    expect(out).toContain("import { A, B } from './x';");
    expect(out).toContain("import { Z } from './y';");
  });
});

describe('applyDeterministicFixers：组合且幂等', () => {
  it('先合并再去未用，结果保持稳定', () => {
    const src = [
      `import { A } from './x';`,
      `import { B } from './x';`,
      `import { Dead } from './z';`,
      'export function f(): number {',
      '  return A() + B();',
      '}',
    ].join('\n');
    const once = applyDeterministicFixers(src);
    expect(once).toContain("import { A, B } from './x';");
    expect(once).not.toContain('./z');
    expect(applyDeterministicFixers(once)).toBe(once); // 幂等
  });
});

describe('C1 端到端：组装时去未用跨文件 import', () => {
  it('函数体未用到的跨文件函数 import 被移除；签名用到的类型 import 保留', async () => {
    const root = path.join(os.tmpdir(), `dc-tr-fixer-${Date.now()}`);
    const write = (rel: string, content: string): void => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
    };
    write('model/user.go', 'package model\ntype User struct {\n\tValue int\n}\n');
    write('util/help.go', 'package util\nfunc Help(x int) int {\n\treturn x + 1\n}\n');
    write('svc/app.go', 'package svc\nimport (\n\t"model"\n\t"util"\n)\nfunc F(u *model.User) int {\n\treturn util.Help(u.Value)\n}\n');
    const r = await translateGoProject(root); // 不 fill → Help 在函数体(孔)里未用
    const app = r.modules.find((m) => m.rel === 'svc/app.go')!;
    expect(app.imports.join('')).toContain("import { Help } from '../util/help';"); // 原始 import 清单仍在
    expect(app.ts).toContain("from '../model/user'"); // 签名用到的类型 import 保留
    expect(app.ts).not.toContain("../util/help"); // 未用函数 import 被 fixer 移除
    fs.rmSync(root, { recursive: true, force: true });
  });
});