/**
 * contract_gate —— 契约对账闸门测试
 *
 * 覆盖：
 *   - JS(.js/.mjs/.cjs)/JSX 会被 langOfFile 归入 ts 分支并参与扫描；
 *   - 纯 JS 里未定义名 `v2.Get`（无 import / 非声明 / 非局部 / 非全局）→ 判失配；
 *   - 局部变量 `const v2 = ...; v2.Get()` → 通过（不误报）。
 *   - Python（AST 分支）：`.py` 纳入扫描；未定义 `db` 失配；import/from-import 别名、
 *     局部变量、self、def/class 声明不误报；通配导入整文件跳过。
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
  it('.js 文件失去配未定义引用会被扫出（v2 未声明）', async () => {
    const root = tempRoot();
    write(
      root,
      'a.js',
      'import * as x from "./m.js";\nfunction run() {\n  v2.Get("k");\n}\n',
    );
    const scan = await scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'a.js');
    expect(a).toBeDefined();
    expect(a!.lang).toBe('ts');
    const ref = a!.undefinedRefs.find((r) => r.ident === 'v2');
    expect(ref).toBeDefined();
    expect(ref!.line).toBe(3);
  });

  it('.mjs / .cjs / .jsx 也纳入扫描', async () => {
    const root = tempRoot();
    write(root, 'm.mjs', 'export const ok = 1;\n');
    write(root, 'c.cjs', 'const q = require("x");\nq.bad();\n');
    write(root, 'v.jsx', 'const Comp = () => <div>{weirdCls.fn()}</div>;\n');
    const scan = await scanContracts({ cwd: root });
    expect(scan.files.some((f) => f.file === 'm.mjs')).toBe(true);
    expect(scan.files.some((f) => f.file === 'c.cjs')).toBe(true);
    expect(scan.files.some((f) => f.file === 'v.jsx')).toBe(true);
  });

  it('局部变量 v2 用于 v2.Get() 不误报', async () => {
    const root = tempRoot();
    write(
      root,
      'ok.js',
      'function run() {\n  const v2 = make();\n  v2.Get("k");\n}\n',
    );
    const res = await contractGate({ cwd: root });
    expect(res.ok).toBe(true);
    expect(res.scan.undefinedRefs.filter((r) => r.ident === 'v2')).toHaveLength(0);
  });
});

describe('contract_gate / Python（AST 分支）', () => {
  it('.py 纳入扫描，未定义引用被扫出（db 无任何定义源）', async () => {
    const root = tempRoot();
    write(
      root,
      'a.py',
      'import os\n\ndef run():\n    os.getenv("K")\n    db.exec("sql")\n',
    );
    const scan = await scanContracts({ cwd: root });
    const a = scan.files.find((f) => f.file === 'a.py');
    expect(a).toBeDefined();
    expect(a!.lang).toBe('py');
    // os 有 import 源 → 不误报
    expect(a!.undefinedRefs.some((r) => r.ident === 'os')).toBe(false);
    // db 无 import/声明/局部/内建 → 失配
    const ref = a!.undefinedRefs.find((r) => r.ident === 'db');
    expect(ref).toBeDefined();
    expect(ref!.line).toBe(5);
  });

  it('import os.path / from .m import a as b / 局部变量 / self 不误报', async () => {
    const root = tempRoot();
    write(
      root,
      'ok.py',
      [
        'import os.path',
        'from .util import helper as h',
        'CONFIG = {}',
        'def run(ctx):',
        '    ctx.data = 1',
        '    packed = h.format(CONFIG)',
        '    return os.path.join("a", "b")',
        '    return ctx.data',
      ].join('\n'),
    );
    const res = await contractGate({ cwd: root });
    expect(res.ok).toBe(true);
    expect(res.scan.undefinedRefs).toHaveLength(0);
  });

  it('def/class 定义源：本文件声明的符号作 `X.` 接收者不误报', async () => {
    const root = tempRoot();
    write(
      root,
      'svc.py',
      [
        'class Handler:',
        '    def run(self):',
        '        return 0',
        'def make():',
        '    return Handler',
        'Handler.new().run()',
      ].join('\n'),
    );
    const res = await contractGate({ cwd: root });
    expect(res.ok).toBe(true);
  });

  it('通配导入 from .util import * → 定义源不可枚举，整文件跳过判定', async () => {
    const root = tempRoot();
    write(
      root,
      'wild.py',
      'from .util import *\n\ndef run():\n    magic_box.do_it()\n',
    );
    const scan = await scanContracts({ cwd: root });
    const w = scan.files.find((f) => f.file === 'wild.py');
    expect(w).toBeDefined();
    expect(w!.undefinedRefs).toHaveLength(0);
  });
});
