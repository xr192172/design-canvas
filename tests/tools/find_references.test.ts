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

  it('mode=field：报字段读取点(obj.field)与构造点(field:)——含定义文件内部（结构引用缺口）', async () => {
    const dir = mkProj({
      'src/def.ts': 'export interface S { a: number }\nconst x: S = { a: 1 };\nconst y = x.a;\n',
      'src/use.ts': 'import { S } from "./def";\nconst q: S = { a: 2 };\nfunction f(s: S) { return s.a; }\n',
    });
    const r = await findReferences({ project_dir: dir, mode: 'field', field: 'a' });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('field');
    // 定义文件内部也要报（此前 symbol 模式漏掉的构造/读取点）
    const def = r.fieldRefs!.find((x) => x.file === 'src/def.ts');
    expect(def).toBeDefined();
    // { a: 1 } 是构造点（field-key）；interface 里 a 是声明点（field-decl）；x.a 是读
    expect(def!.refs.some((x) => x.kind === 'field-key')).toBe(true);
    expect(def!.refs.some((x) => x.kind === 'field-decl')).toBe(true);
    expect(def!.refs.some((x) => x.kind === 'field-read')).toBe(true);
    // 使用方文件
    const use = r.fieldRefs!.find((x) => x.file === 'src/use.ts');
    expect(use).toBeDefined();
    expect(use!.refs.some((x) => x.kind === 'field-read')).toBe(true);
    // snippet 非空（免开文件）
    expect(def!.refs[0].snippet.length).toBeGreaterThan(0);
    rmForce(dir);
  });

  it('mode=field：读取含方括号、解构读与注释里的同名忽略', async () => {
    const dir = mkProj({
      'src/use.ts': [
        'const m = obj["hidden"];', // 方括号读
        'const { hidden } = obj;', // 解构读（field-destructure）
        '// .hidden 这里注释里的同名不算', // 注释噪音应被 AST 跳过
        'const s = obj.hidden2;', // 不同字段，不应命中
      ].join('\n'),
    });
    const r = await findReferences({ project_dir: dir, mode: 'field', field: 'hidden', scope: 'all' });
    const use = r.fieldRefs!.find((x) => x.file === 'src/use.ts');
    expect(use).toBeDefined();
    // 方括号读
    expect(use!.refs.some((x) => x.kind === 'field-read' && x.snippet.includes('["hidden"]'))).toBe(true);
    // 解构读
    expect(use!.refs.some((x) => x.kind === 'field-destructure')).toBe(true);
    // 注释里的同名不报（AST 归属不到 member/pair/object_pattern）
    expect(use!.refs.filter((x) => x.kind === 'field-read').every((x) => !x.snippet.startsWith('//'))).toBe(true);
    // hidden2 不同字段，不混入
    expect(use!.refs.every((x) => !x.snippet.includes('hidden2'))).toBe(true);
    rmForce(dir);
  });

  it('mode=type：从类型声明解成员，找交叠 ≥ min_hit 的对象字面量候选构造点', async () => {
    const dir = mkProj({
      'src/types.ts': 'export interface Config { host: string; port: number; ssl: boolean; }\n',
      'src/a.ts': 'const c = { host: "x", port: 1, ssl: true };\n', // 命中 3 成员 → 候选
      'src/b.ts': 'const d = { host: "y", timeout: 5 };\n', // 只 1 → 非候选
    });
    const r = await findReferences({ project_dir: dir, mode: 'type', file: 'src/types.ts', symbol: 'Config', scope: 'all' });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('type');
    expect(r.typeMembers).toContain('host');
    expect(r.typeMembers).toContain('ssl');
    expect(r.typeCandidates!.some((c) => c.file === 'src/a.ts')).toBe(true);
    expect(r.typeCandidates!.some((c) => c.file === 'src/b.ts')).toBe(false); // 只 1 个成员交叠
    rmForce(dir);
  });

  it('跨语言（Go）文件里的引用：以 cross-usage 文本探针报告（AST 提取不了但闭包含它）', async () => {
    const dir = mkProj({
      'src/def.ts': 'export function compute(a: number): number { return a; }\n',
      'src/main.go': 'package main\n\nfunc run(v int) int {\n\treturn compute(v)\n}\n',
    });
    const r = await findReferences({ project_dir: dir, file: 'src/def.ts', symbol: 'compute' });
    expect(r.ok).toBe(true);
    const go = r.importers!.find((x) => x.file === 'src/main.go');
    expect(go).toBeDefined(); // expandClosure 闭包含该项目内全部源文件 → main.go 在内
    expect(go!.refs.some((x) => x.kind === 'cross-usage' && x.line === 4 && x.text === 'compute')).toBe(true);
    rmForce(dir);
  });
});