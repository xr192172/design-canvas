/**
 * find_references —— 引用查找测试
 *
 * 覆盖：模块级导出符号 → 定义文件 + import 方（import 子句/使用点行号）；非模块级符号
 * / import 绑定 → 拒答；无引用 → 仅定义。只读不落盘。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findReferences } from '../../src/tools/find_references';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fr-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}
function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放 */
    }
  }
}

describe('findReferences', () => {
  it('导出函数：返回定义文件 + import 方的 import/使用点行号', async () => {
    const dir = mkProj({
      'src/def.ts': [
        'export function compute(a: number): number { return a; }',
        'function internal() { return compute(1); }',
      ].join('\n'),
      'src/a.ts': "import { compute } from './def';\nexport function run() { return compute(3); }\n",
      'src/b.ts': "import { compute as calc } from './def';\nexport function run2() { return calc(5); }\n",
    });
    const r = await findReferences({ project_dir: dir, file: 'src/def.ts', symbol: 'compute' });
    expect(r.ok).toBe(true);
    // 定义文件
    expect(r.definition!.kind).toBe('function');
    expect(r.definition!.refs.some((x) => x.kind === 'definition')).toBe(true);
    // import 方：a.ts（无别名，加使用点）；b.ts（别名，只 import 子句）
    const ra = r.importers!.find((x) => x.file === 'src/a.ts')!;
    expect(ra).toBeDefined();
    expect(ra.refs.some((x) => x.kind === 'import')).toBe(true);
    expect(ra.refs.some((x) => x.kind === 'usage')).toBe(true); // compute(3) 使用点
    const rb = r.importers!.find((x) => x.file === 'src/b.ts')!;
    expect(rb).toBeDefined();
    // 别名 importer 只报 import 子句，没有使用点（本地名 calc）
    expect(rb.refs.every((x) => x.kind === 'import')).toBe(true);
    rmForce(dir);
  });

  it('import 绑定（非声明）→ 拒答并提示在定义文件查', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute() { return 1; }\n',
      'src/a.ts': "import { compute } from './def';\n",
    });
    const r = await findReferences({ project_dir: dir, file: 'src/a.ts', symbol: 'compute' });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('import 绑定'))).toBe(true);
    rmForce(dir);
  });

  it('无 import 方 → 只返回定义，importerCount=0', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function lonely(a: number) { return a; }\n',
    });
    const r = await findReferences({ project_dir: dir, file: 'src/def.ts', symbol: 'lonely' });
    expect(r.ok).toBe(true);
    expect(r.importerCount).toBe(0);
    expect(r.importers).toEqual([]);
    rmForce(dir);
  });

  it('带扩展名 import（从 ./def.js 指向 def.ts）也能命中（修复 resolveRel 扩展名回退）', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number) { return a; }\n',
      'src/a.ts': "import { compute } from './def.js';\nexport function run() { return compute(1); }\n",
    });
    const r = await findReferences({ project_dir: dir, file: 'src/def.ts', symbol: 'compute' });
    expect(r.ok).toBe(true);
    // 修复前：source='./def.js' 在 resolveRel 中因 h.endsWith('.js')=false 漏掉 def.ts
    expect(r.importers!.some((x) => x.file === 'src/a.ts')).toBe(true);
    rmForce(dir);
  });
});