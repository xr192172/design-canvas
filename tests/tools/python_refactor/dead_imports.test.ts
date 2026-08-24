import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  detectDeadPyImports,
  enumeratePyImports,
  removePyImportsFromSource,
} from '../../../src/tools/python_refactor/dead_imports';

const tmpDirs: string[] = [];
function tempRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-py-dead-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('python 死 import 检测（enumeratePyImports）', () => {
  it('单目标 import / import-as / dotted 绑定解析', () => {
    const refs = enumeratePyImports("import os\nimport requests as req\nimport foo.bar\n");
    expect(refs).toEqual([
      { source: 'os', bind: 'os' },
      { source: 'requests', bind: 'req' },
      { source: 'foo.bar', bind: 'foo' },
    ]);
  });

  it('from-import 单目标解析；多目标/星号/相对/__future__ 一律跳过', () => {
    const refs = enumeratePyImports([
      'from a import b',
      'from a.b import c as cc',
      'from m import x, y',        // 多目标 → 跳过
      'from m import *',           // 星号 → 跳过
      'from . import rel',         // 相对 → 跳过
      'from __future__ import annotations', // future → 跳过
      'import p, q',               // 多目标 import → 跳过
    ].join('\n'));
    expect(refs).toEqual([
      { source: 'a', bind: 'b' },
      { source: 'a.b', bind: 'cc' },
    ]);
  });
});

describe('python 死 import 检测（detectDeadPyImports）', () => {
  it('未使用的 import 报死，被引用的 import 保活', () => {
    const dir = tempRoot();
    fs.writeFileSync(
      path.join(dir, 'a.py'),
      "import os\nimport math\nx = math.sqrt(4)\n",
      'utf-8',
    );
    const res = detectDeadPyImports({ project_dir: dir });
    expect(res.scanned).toBe(1);
    expect(res.dead.map((d) => d.source)).toEqual(['os']);
  });

  it('__future__ 指令恒活不误报（import 后 always live）', () => {
    const dir = tempRoot();
    fs.writeFileSync(
      path.join(dir, 'a.py'),
      "from __future__ import annotations\nimport platform\n",
      'utf-8',
    );
    const res = detectDeadPyImports({ project_dir: dir });
    // platform 未使用 → 死；但 from __future__ 恒活不出现
    expect(res.dead.map((d) => d.source)).toEqual(['platform']);
  });

  it('同一模块出现多目标行时整源保活（防连活绑定一起删的 false positive）', () => {
    const dir = tempRoot();
    // line20 多目标 import C, S（活）；line38 单目标 LEAN_STARTUP（死）。src.config 应整源保活
    fs.writeFileSync(
      path.join(dir, 'a.py'),
      [
        'from src.config import COMPETE_WEIGHTS, LEAN_STARTUP_WEIGHTS',
        'from src.config import LEAN_STARTUP',
        '',
        'def f():',
        '    w = COMPETE_WEIGHTS',   // 活绑定使用 → src.config 绝对不可删
        '    return w',
        '',
      ].join('\n'),
      'utf-8',
    );
    const res = detectDeadPyImports({ project_dir: dir });
    // src.config 被多目标行 + 活绑定保护 → 不报死
    expect(res.dead.some((d) => d.source === 'src.config')).toBe(false);
  });

  it('括号续写 from m import (...) 所在模块整源保活', () => {
    const dir = tempRoot();
    fs.writeFileSync(
      path.join(dir, 'a.py'),
      'from pkg import (\n    a,\n    b,\n)\nvalue = a + b\n',
      'utf-8',
    );
    const res = detectDeadPyImports({ project_dir: dir });
    expect(res.dead.some((d) => d.source === 'pkg')).toBe(false);
  });

  it('removePyImportsFromSource 整条删除单目标 import/from-import', () => {
    const src = "import os\nimport math\nfrom foo import bar\nfrom foo import baz\nimport other as o\n";
    const r = removePyImportsFromSource(src, 'foo');
    expect(r.removed).toBe(2);
    expect(r.output).not.toContain('from foo import');
    expect(r.output).toContain('import os');
    expect(r.output).toContain('import math');
  });
});