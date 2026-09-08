import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { instrumentProject } from '../../src/observe/instrument';

describe('instrument scope 模式（enterScope/try/finally/exitScope 注入）', () => {
  it('对含 return 的嵌套函数注入 scope，花括号平衡，一个函数只一对 enter/exit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scinstr_'));
    fs.writeFileSync(path.join(tmp, 'a.ts'), `export function outer(x: number): number {
  if (x > 0) {
    return inner(x);
  }
  return 0;
}
function inner(y: number): number {
  return y * 2;
}
`, 'utf-8');
    // probeImport 显式指定，避免依赖本仓绝对路径；backupRoot 默认=被插项目根
    const results = await instrumentProject(tmp, { write: true, scope: true, probeImport: '../probe.js' });
    const out = fs.readFileSync(path.join(tmp, 'a.ts'), 'utf-8');
    expect(results[0].error).toBeFalsy();
    // scope 模式注入 global 探针调用（非 import 形态）
    expect(out).toContain('__probeScope?.enter');
    expect(out).toContain('try {');
    expect(out).toContain('} finally {');
    // 花括号平衡（剥字符串字面量）
    const noStr = out.replace(/['"`][^'"`]*['"`]/g, '');
    expect((noStr.match(/\{/g) || []).length).toBe((noStr.match(/\}/g) || []).length);
    // 两个函数各一对 enter/exit
    expect((out.match(/__probeScope\?\.enter/g) || []).length).toBe(2);
    expect((out.match(/__probeScope\?\.exit/g) || []).length).toBe(2);
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 20000);

  it('默认（scope=false）不注入 scope，仍走 captureProbe', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scinstr2_'));
    fs.writeFileSync(path.join(tmp, 'b.ts'), `export function f(x: number): number { return x * 2; }\n`, 'utf-8');
    await instrumentProject(tmp, { write: true, probeImport: '../probe.js' });
    const out = fs.readFileSync(path.join(tmp, 'b.ts'), 'utf-8');
    expect(out).toContain('captureProbe(');
    expect(out).not.toContain('enterScope(');
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 20000);

  it('shebang 入口：import 插到 shebang 之后，首行仍是 #!（esbuild/tsx 兼容）', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scinstr3_'));
    fs.writeFileSync(path.join(tmp, 'bin.ts'), `#!/usr/bin/env node
export function f(x: number): number { return x * 2; }
`);
    await instrumentProject(tmp, { write: true, scope: true, probeImport: './_observe_probe.ts' });
    const out = fs.readFileSync(path.join(tmp, 'bin.ts'), 'utf-8');
    expect(out.startsWith('#!')).toBe(true); // shebang 必须留在首行
    expect(out.indexOf('\n#!')).toBe(-1);    // 不应有第二处 shebang
    // scope 模式无 import（global 形态），但探针调用注入成功
    expect(out).toContain('__probeScope?.enter');
    expect(out).not.toContain("import { captureProbe");
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 20000);
});