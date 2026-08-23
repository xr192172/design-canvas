/**
 * ast_rename —— 作用域感知的局部变量重命名（AST 重构引擎地基）
 *
 * 覆盖：
 *   - analyzeLocals：提取函数体内局部绑定（const/let/var/param/catch），
 *     带作用域归属与引用字节偏移；同名不同作用域 → 不同绑定（作用域隔离）。
 *   - renameLocal：列级安全重命名——只改目标绑定声明+引用，
 *     不误伤其他函数/块的同名变量；不动属性 key / 字符串 / 注释 / 类型名。
 *   - 遮蔽：内层块同名变量与外层是不同绑定，改外层不影响内层。
 */
import { describe, it, expect } from 'vitest';
import { analyzeLocals, renameLocal, deleteDeadLocals, type LocalBinding } from '../../src/tools/ast_rename';

/** 拿到 src 里第 n 个名字匹配的绑定 */
async function findByName(src: string, name: string, nth = 0): Promise<LocalBinding> {
  const locals = await analyzeLocals(src);
  const hits = locals.filter((b) => b.name === name);
  if (hits.length <= nth) {
    throw new Error(`expected ${nth + 1} binding named "${name}", got ${hits.length}: ${JSON.stringify(locals)}`);
  }
  return hits[nth];
}

describe('analyzeLocals - 局部绑定提取', () => {
  it('提取函数体内 const/let/var 与参数，并记录声明点偏移', async () => {
    const src = [
      'function f(a) {',
      '  const x = a + 1;',
      '  let y = x * 2;',
      '  var z = y;',
      '  return z;',
      '}',
    ].join('\n');
    const locals = await analyzeLocals(src);
    expect(locals.length).toBe(4); // a, x, y, z
    const x = await findByName(src, 'x');
    const a = await findByName(src, 'a');
    expect(x.kind).toBe('const');
    // 参数在函数作用域、函数体 let 在其嵌套块作用域（JS 语义本就不同）
    expect(x.scopeId).not.toBe(a.scopeId);
    // a 在 x 初始化式里被引用一次
    expect(a.refs.length).toBe(1);
    expect(src[x.declIndex]).toBe('x');
    expect(x.refs.length).toBe(1); // y = x * 2 处引用
  });

  it('同名变量在不同函数 → 不同绑定（作用域隔离）', async () => {
    const src = [
      'function left() {',
      '  const t = 1;',
      '  return t + t;',
      '}',
      'function right() {',
      '  const t = 2;',
      '  return t;',
      '}',
    ].join('\n');
    const locals = await analyzeLocals(src);
    expect(locals.filter((b) => b.name === 't')).toHaveLength(2);
  });

  it('块级遮蔽：内层块宣言与外层是不同绑定', async () => {
    const src = [
      'function f() {',
      '  let v = 1;',
      '  if (true) {',
      '    let v = 2;',
      '    void v;',
      '  }',
      '  return v;',
      '}',
    ].join('\n');
    const locals = await analyzeLocals(src);
    expect(locals.filter((b) => b.name === 'v')).toHaveLength(2);
    const outer = await findByName(src, 'v', 0);
    const inner = await findByName(src, 'v', 1);
    expect(outer.scopeId).not.toBe(inner.scopeId);
    expect(outer.refs.length).toBe(1); // return v
    expect(inner.refs.length).toBe(1); // void v
  });
});

describe('renameLocal - 列级安全重命名', () => {
  it('改一个局部变量，声明与全部引用一起变', async () => {
    const src = 'function f() {\n  const cnt = 0;\n  cnt = cnt + 1;\n  return cnt;\n}\n';
    const { id } = await findByName(src, 'cnt');
    const { out } = await renameLocal(src, id, 'count');
    expect(out).toBe('function f() {\n  const count = 0;\n  count = count + 1;\n  return count;\n}\n');
  });

  it('同名不同函数：只改目标函数那个，另一个不动', async () => {
    const src = [
      'function left() {',
      '  const t = 1;',
      '  return t;',
      '}',
      'function right() {',
      '  const t = 2;',
      '  return t;',
      '}',
    ].join('\n');
    const leftT = await findByName(src, 't', 0);
    const { out } = await renameLocal(src, leftT.id, 'tmp');
    expect(out).toContain('const tmp = 1;');
    expect(out).toContain('return tmp;');
    expect(out).toContain('const t = 2;');
    expect(out).toContain('return t;');
  });

  it('块级遮蔽：改外层 v，内层同名 v 不受影响', async () => {
    const src = [
      'function f() {',
      '  let v = 1;',
      '  if (true) {',
      '    let v = 2;',
      '    void v;',
      '  }',
      '  return v;',
      '}',
    ].join('\n');
    const outer = await findByName(src, 'v', 0);
    const { out } = await renameLocal(src, outer.id, 'value');
    expect(out).toContain('let value = 1;');
    expect(out).toContain('return value;');
    expect(out).toContain('let v = 2;');
    expect(out).toContain('void v;');
  });

  it('参数改名：函数签名与函数体引用同步', async () => {
    const src = 'function add(a, b) {\n  return a + b;\n}\n';
    const { id } = await findByName(src, 'a');
    const { out } = await renameLocal(src, id, 'lhs');
    expect(out).toBe('function add(lhs, b) {\n  return lhs + b;\n}\n');
  });

  it('绝不误伤：属性 key / 字符串 / 注释 / 类型名中的同名文本', async () => {
    const src = [
      'interface Shape {',
      '  count: number;',
      '}',
      'function f() {',
      '  const count = 1;',
      '  const obj = { count, obj_count: count, key: "count" };',
      '  const val = obj.count;',
      '  // count 是注释',
      '  return count;',
      '}',
    ].join('\n');
    const { id } = await findByName(src, 'count');
    const { out } = await renameLocal(src, id, 'n');
    // 局部变量与它自己的引用全改
    expect(out).toContain('const n = 1;');
    expect(out).toContain('const obj = { n, obj_count: n, key: "count" };');
    expect(out).toContain('return n;');
    // 绝不该动的
    expect(out).toContain('count: number;'); // 接口字段
    expect(out).toContain('obj.count;'); // 属性访问
    expect(out).toContain('key: "count"'); // 字符串
    expect(out).toContain('count 是注释'); // 注释
  });
});

describe('deleteDeadLocals - 死局部变量删除', () => {
  it('块内从未引用的纯值声明被删整行', async () => {
    const src = 'function f() {\n  const a = 1;\n  return 2;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toBe('function f() {\n  return 2;\n}\n');
  });

  it('被引用的活变量不删', async () => {
    const src = 'function f() {\n  const a = 1;\n  return a;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toBe(src);
  });

  it('赋值左侧也算使用：let 被赋值则不算死', async () => {
    const src = 'function f() {\n  let a = 1;\n  a = 2;\n  return a;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toBe(src);
  });

  it('初始化含函数调用（副作用）→ 保守不删', async () => {
    const src = 'function f() {\n  const a = foo();\n  return 2;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toBe(src);
  });

  it('同一语句多声明只要有一个活 → 整句保留', async () => {
    const src = 'function f() {\n  const a = 1, b = 2;\n  return b;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toBe(src); // b 活 → a 也不能删整句
  });

  it('模块顶层 const 不删（可能被外部消费）', async () => {
    const src = 'const HELP = 1;\nfunction f() {\n  const dead = 2;\n  return 0;\n}\n';
    const { out } = await deleteDeadLocals(src);
    expect(out).toContain('const HELP = 1;');
    expect(out).not.toContain('const dead = 2;');
    expect(out).toContain('return 0;');
  });

  it('作用域隔离：外层死 a 删、内层活 a 保留', async () => {
    const src = [
      'function f() {',
      '  const a = 1;', // 死（无引用）
      '  if (true) {',
      '    const a = 2;',
      '    void a;', // 内层活
      '  }',
      '  return 0;',
      '}',
    ].join('\n');
    const { out } = await deleteDeadLocals(src);
    expect(out).not.toContain('const a = 1;');
    expect(out).toContain('const a = 2;');
    expect(out).toContain('void a;');
    expect(out).toContain('return 0;');
  });
});