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

describe('contract_gate / Python', () => {
  it('.py 文件被纳入扫描且未定义名 `smth.` 被判失配', () => {
    const root = tempRoot();
    write(root, 'a.py', 'import os\n\ndef run():\n    smth.Get("k")\n');
    const scan = scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'a.py');
    expect(a).toBeDefined();
    expect(a!.lang).toBe('py');
    expect(a!.undefinedRefs.some((r) => r.ident === 'smth')).toBe(true);
  });

  it('已声明/import/局部名不误报', () => {
    const root = tempRoot();
    write(
      root,
      'ok.py',
      'import numpy as np\nclass Service:\n    def __init__(self):\n        self.cache = {}\n\ndef run():\n    obj = make()\n    np.load("x")\n    obj.go()\n    return self.cache\n',
    );
    const res = contractGate({ cwd: root });
    expect(res.ok).toBe(true);
    const bad = res.scan.undefinedRefs.map((r) => r.ident);
    expect(bad).not.toContain('np');
    expect(bad).not.toContain('obj');
    expect(bad).not.toContain('self');
  });
});

describe('contract_gate / Java · C# · C', () => {
  it('Java：import 末段 + 方法形参为定义源；未导入类名误报', () => {
    const root = tempRoot();
    write(
      root,
      'App.java',
      'package app;\nimport com.acme.Foo;\npublic class App {\n  void run() {\n    Foo f = new Foo();\n    f.go();\n    ghost.call();\n    System.out.println(1);\n  }\n}\n',
    );
    const scan = scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'App.java')!;
    expect(a.lang).toBe('java');
    const bad = a.undefinedRefs.map((r) => r.ident);
    expect(bad).not.toContain('Foo');
    expect(bad).not.toContain('f');
    expect(bad).not.toContain('System');
    expect(bad).toContain('ghost');
  });

  it('C#：using 末段 + 形参为定义源；未 using 类型误报', () => {
    const root = tempRoot();
    write(
      root,
      'App.cs',
      'using System.Collections.Generic;\nnamespace App {\n  class Service {\n    void Run(List<int> xs) {\n      xs.Add(1);\n      Console.WriteLine(xs.Count);\n      Nope.Do();\n    }\n  }\n}\n',
    );
    const scan = scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'App.cs')!;
    expect(a.lang).toBe('cs');
    const bad = a.undefinedRefs.map((r) => r.ident);
    expect(bad).not.toContain('List');
    expect(bad).not.toContain('xs');
    expect(bad).not.toContain('Console');
    expect(bad).toContain('Nope');
  });

  it('C：全局函数/struct 变量/形参为定义源；未声明变量误报', () => {
    const root = tempRoot();
    write(
      root,
      'a.c',
      '#include <stdio.h>\nstruct Point { int x; };\nvoid move(struct Point *p) {\n  p->x = 1;\n  pt.x = 2;\n  ghost.field = 3;\n}\n',
    );
    const scan = scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'a.c')!;
    expect(a.lang).toBe('c');
    const bad = a.undefinedRefs.map((r) => r.ident);
    expect(bad).not.toContain('p');
    expect(bad).toContain('ghost');
  });
});