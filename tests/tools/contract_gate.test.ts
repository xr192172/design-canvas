/**
 * contract_gate —— 契约对账闸门测试（重点：JS 家族已纳入扫描）
 *
 * 覆盖：
 *   - JS(.js/.mjs/.cjs)/JSX 会被 langOfFile 归入 ts 分支并参与扫描；
 *   - 纯 JS 里未定义名 `v2.Get`（无 import / 非声明 / 非局部 / 非全局）→ 判失配；
 *   - 局部变量 `const v2 = ...; v2.Get()` → 通过（不误报）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { scanContracts, contractGate } from '../../src/tools/contract_gate';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // leave to OS on Windows
    }
  }
});
function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `cg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}
function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('contract_gate / JS 家族', () => {
  it('.js 文件失去配未定义引用会被扫出（v2 未声明）', () => {
    const root = tempRoot();
    write(
      root,
      'a.js',
      'import * as x from "./m.js";\nfunction run() {\n  v2.Get("k");\n}\n',
    );
    const scan = scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'a.js');
    expect(a).toBeDefined();
    expect(a!.lang).toBe('ts');
    const ref = a!.undefinedRefs.find((r) => r.ident === 'v2');
    expect(ref).toBeDefined();
    expect(ref!.line).toBe(3);
  });

  it('.mjs / .cjs / .jsx 也纳入扫描', () => {
    const root = tempRoot();
    write(root, 'm.mjs', 'export const ok = 1;\n');
    write(root, 'c.cjs', 'const q = require("x");\nq.bad();\n');
    write(root, 'v.jsx', 'const Comp = () => <div>{weirdCls.fn()}</div>;\n');
    const scan = scanContracts({ cwd: root });
    expect(scan.files.some((f) => f.file === 'm.mjs')).toBe(true);
    expect(scan.files.some((f) => f.file === 'c.cjs')).toBe(true);
    expect(scan.files.some((f) => f.file === 'v.jsx')).toBe(true);
  });

  it('局部变量 v2 用于 v2.Get() 不误报', () => {
    const root = tempRoot();
    write(
      root,
      'ok.js',
      'function run() {\n  const v2 = make();\n  v2.Get("k");\n}\n',
    );
    const res = contractGate({ cwd: root });
    expect(res.ok).toBe(true);
    expect(res.scan.undefinedRefs.filter((r) => r.ident === 'v2')).toHaveLength(0);
  });
});