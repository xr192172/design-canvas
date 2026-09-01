/**
 * ts_kernel 跨语言 import 绑定提取测试：
 *   ParsedImport.bindings = 该 import 的「本地可用名字」，供符号级跨语言引用判定（find_references 精确化）用。
 *   - Go: 无别名 → 路径尾段（默认包名）；显式 alias → alias。
 *   - Python: from pkg import a → [a]；import a.b.c as d → [c, d]（模块尾段 + 别名）。
 *   - TS 系不填 bindings（走 ImportEdge 精确）。
 */
import { describe, it, expect } from 'vitest';
import { parseFileFull } from '../../src/tools/ts_kernel/index.js';

describe('ts_kernel 跨语言 import 绑定提取', () => {
  it('Go：无别名取路径尾段，显式 alias 取别名', async () => {
    const pf = await parseFileFull(
      'a.go',
      'package main\nimport (\n  "fmt"\n  alias "example.com/mod/util"\n)\nfunc run(){ fmt.Println(alias.Compute()) }\n',
    );
    expect(pf.imports.length).toBeGreaterThan(0);
    const fmt = pf.imports.find((i) => i.source === 'fmt');
    expect(fmt).toBeDefined();
    expect(fmt!.bindings).toContain('fmt');
    const util = pf.imports.find((i) => i.source === 'example.com/mod/util');
    expect(util).toBeDefined();
    expect(util!.bindings).toContain('alias');
  });

  it('Python：from→符号名(as 名)；import→模块尾段/别名', async () => {
    const pf = await parseFileFull(
      'a.py',
      'from pkg.mod import compute, other as oth\nimport os\nimport a.b.c as d\nx = compute(1) + oth(2) + os.getcwd() + d.f()\n',
    );
    const from = pf.imports.find((i) => i.source === 'pkg.mod');
    expect(from).toBeDefined();
    expect(from!.bindings).toContain('compute');
    expect(from!.bindings).toContain('oth'); // as 后名
    const osi = pf.imports.find((i) => i.source === 'os');
    expect(osi).toBeDefined();
    expect(osi!.bindings).toContain('os');
    const abc = pf.imports.find((i) => i.source === 'a.b.c');
    expect(abc).toBeDefined();
    expect(abc!.bindings).toContain('d'); // as 后名（使用处用 d）
  });

  it('TS：不填 bindings（走 ImportEdge.remoteName/localName 精确）', async () => {
    const pf = await parseFileFull('a.ts', "import { compute } from './lib';\ncompute(1);\n");
    const imp = pf.imports.find((i) => i.source === './lib');
    expect(imp).toBeDefined();
    expect(imp!.bindings).toBeUndefined();
  });
});