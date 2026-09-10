/**
 * edit_code 符号级编辑测试：
 * - replace：函数/类方法（qualified_name）/ Go 方法（parent 消歧）
 * - insert：锚点后插入 / 文件末尾 / 新文件创建
 * - delete：删函数 + 空行压缩
 * - 安全：语法破坏回滚（不写盘）、粘贴错函数拒绝、同名多候选消歧、
 *   符号未找到列出候选、索引重建（cache.db 同步）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editCode } from '../../src/tools/edit_code.js';
import { parseFileFull } from '../../src/tools/ts_kernel/index.js';
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../../src/db/db.js';
import { searchSymbols, getFileParse } from '../../src/db/symbols.js';

let dir: string;

function write(rel: string, content: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-code-'));
});

afterEach(() => {
  closeAllProjectCacheDbs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const TS_SAMPLE = `export function add(a: number, b: number): number {
  return a + b;
}

export class Calc {
  total = 0;

  reset(): void {
    this.total = 0;
  }

  add(n: number): number {
    this.total += n;
    return this.total;
  }
}

export function helper(): string {
  return 'x';
}
`;

describe('顶层 const 符号（狗食缺陷修复：handler 形态）', () => {
  const HANDLER_SAMPLE = `import { wrap } from './wrap.js';

/** handler：wrap 装配形态 */
const observeJudgeHandler = wrap(async (a) => {
  return { message: 'ok' };
});

const A = 1;
let count = 0;
const { x, y } = obj;
const p = 1, q = 2;

export function real() {
  const inner = 2;
  return inner;
}
`;

  it('parseFileFull 提取顶层 const/let 为 kind=const，局部/解构/多声明器跳过', async () => {
    const p = write('handlers.ts', HANDLER_SAMPLE);
    const parsed = await parseFileFull(p, HANDLER_SAMPLE);
    const consts = parsed.symbols.filter((s) => s.kind === 'const');
    const names = consts.map((s) => s.name);
    expect(names).toContain('observeJudgeHandler');
    expect(names).toContain('A');
    expect(names).toContain('count');
    expect(names).not.toContain('inner'); // 局部 const 不索引
    expect(names).not.toContain('x'); // 解构跳过
    expect(names).not.toContain('p'); // 多声明器跳过
    const h = consts.find((s) => s.name === 'observeJudgeHandler')!;
    expect(h.signature).toContain('wrap(async (a) =>');
    expect(h.qualified_name).toBe('observeJudgeHandler');
  });

  it('edit_code 可 replace 顶层 const handler（此前符号未找到）', async () => {
    const p = write('handlers.ts', HANDLER_SAMPLE);
    const r = await editCode({
      project_dir: dir,
      file: p,
      op: 'replace',
      symbol: 'observeJudgeHandler',
      code: `const observeJudgeHandler = wrap(async (a) => {
  return { message: 'v2' };
});`,
    });
    expect(r.message).toContain('已替换');
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toContain("'v2'");
    expect(after).toContain('export function real()');
  });
});

describe('重复顶层符号防御（狗食缺陷修复）', () => {
  it('replace 引入与既有符号重名的定义 → 拒绝不写盘', async () => {
    const src = `export interface Box {
  size: number;
}

export function make(): Box {
  return { size: 1 };
}
`;
    const p = write('box.ts', src);
    await expect(
      editCode({
        project_dir: dir,
        file: p,
        op: 'replace',
        symbol: 'make',
        // 粘贴的 code 里带入了 Box 的副本——旧 Box 还在，新旧并存
        code: `export interface Box {
  size: number;
  weight?: number;
}

export function make(): Box {
  return { size: 2 };
}`,
      }),
    ).rejects.toThrow(/重复的顶层符号[\s\S]*Box × 2/);
    // 未写盘：文件内容不变
    expect(fs.readFileSync(p, 'utf8')).toBe(src);
  });
});

describe('replace', () => {
  it('替换顶层函数（短名）', async () => {
    write('src/math.ts', TS_SAMPLE);
    const r = await editCode({
      project_dir: dir,
      file: 'src/math.ts',
      op: 'replace',
      symbol: 'add',
      code: `export function add(a: number, b: number): number {
  return a + b + 1;
}`,
    });
    expect(r.message).toContain('已替换');
    const after = fs.readFileSync(path.join(dir, 'src/math.ts'), 'utf8');
    expect(after).toContain('a + b + 1');
    expect(after).toContain("return 'x';"); // 其他函数不动
  });

  it('类方法用 qualified_name 替换，同类名方法不受影响', async () => {
    write('src/calc.ts', TS_SAMPLE);
    await editCode({
      project_dir: dir,
      file: 'src/calc.ts',
      op: 'replace',
      symbol: 'Calc.reset',
      code: `  reset(): void {
    this.total = -1;
  }`,
    });
    const after = fs.readFileSync(path.join(dir, 'src/calc.ts'), 'utf8');
    expect(after).toContain('this.total = -1');
    expect(after).toContain('this.total += n;'); // Calc.add 不动
  });

  it('同名多候选报错并列签名行号，qn 消歧后成功', async () => {
    write(
      'src/amb.ts',
      `export class A {
  save(): void {}
}

export class B {
  save(): void {}
}
`,
    );
    await expect(
      editCode({ project_dir: dir, file: 'src/amb.ts', op: 'replace', symbol: 'save', code: '  save(): void {}' }),
    ).rejects.toThrow(/不唯一/);
    const r = await editCode({
      project_dir: dir,
      file: 'src/amb.ts',
      op: 'replace',
      symbol: 'A.save',
      code: `  save(): void {
    console.log('A.save v2');
  }`,
    });
    expect(r.message).toContain('A.save');
    const after = fs.readFileSync(path.join(dir, 'src/amb.ts'), 'utf8');
    expect(after).toContain('A.save v2');
    expect(after.match(/save\(\): void \{\}/g)?.length).toBe(1); // B.save 不动
  });

  it('新代码语法破坏 → 拒绝且不写盘', async () => {
    const p = write('src/bad.ts', TS_SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    await expect(
      editCode({
        project_dir: dir,
        file: 'src/bad.ts',
        op: 'replace',
        symbol: 'helper',
        code: `export function helper(): string {
  return 'unterminated
}`,
      }),
    ).rejects.toThrow(/解析失败|未写盘|放弃/);
    expect(fs.readFileSync(p, 'utf8')).toBe(before); // 文件原样
  });

  it('粘贴错函数（新代码无同名符号）→ 拒绝', async () => {
    write('src/wrong.ts', TS_SAMPLE);
    await expect(
      editCode({
        project_dir: dir,
        file: 'src/wrong.ts',
        op: 'replace',
        symbol: 'helper',
        code: `export function otherName(): string {
  return 'y';
}`,
      }),
    ).rejects.toThrow(/未找到同名符号|粘贴/);
  });

  it('Go 方法按 parent（receiver 类型）消歧替换', async () => {
    write('go/svc.go', `package svc

type Writer struct{}

func (w *Writer) Save(path string) error {
	return nil
}

type Reader struct{}

func (r *Reader) Save(path string) error {
	return nil
}
`);
    await expect(
      editCode({
        project_dir: dir,
        file: 'go/svc.go',
        op: 'replace',
        symbol: 'Save',
        code: 'func (r *Reader) Save(path string) error {\n\treturn nil2\n}',
      }),
    ).rejects.toThrow(/不唯一/);
    const r = await editCode({
      project_dir: dir,
      file: 'go/svc.go',
      op: 'replace',
      symbol: 'Save',
      parent: 'Reader',
      code: 'func (r *Reader) Save(path string) error {\n\treturn nil\n}',
    });
    expect(r.message).toContain('已替换');
  });
});

describe('insert / delete', () => {
  it('锚点后插入（自动空行分隔）', async () => {
    write('src/ins.ts', TS_SAMPLE);
    await editCode({
      project_dir: dir,
      file: 'src/ins.ts',
      op: 'insert',
      symbol: 'add',
      code: `export function sub(a: number, b: number): number {
  return a - b;
}`,
    });
    const after = fs.readFileSync(path.join(dir, 'src/ins.ts'), 'utf8');
    const parsed = await parseFileFull('x.ts', after);
    expect(parsed.symbols.some((s) => s.name === 'sub')).toBe(true);
    // add 函数体结束后与 sub 之间有空行
    expect(after).toMatch(/\}\r?\n\r?\nexport function sub/);
  });

  it('insert 创建新文件', async () => {
    const r = await editCode({
      project_dir: dir,
      file: 'src/new.ts',
      op: 'insert',
      code: `export const answer = 42;

export function q(): number {
  return answer;
}`,
    });
    expect(r.message).toContain('已创建');
    expect(fs.existsSync(path.join(dir, 'src/new.ts'))).toBe(true);
  });

  it('delete 函数 + 连续空行压缩', async () => {
    write('src/del.ts', TS_SAMPLE);
    await editCode({ project_dir: dir, file: 'src/del.ts', op: 'delete', symbol: 'Calc.reset' });
    const after = fs.readFileSync(path.join(dir, 'src/del.ts'), 'utf8');
    expect(after).not.toContain('reset');
    expect(after).toContain('Calc');
    expect(after).not.toMatch(/\n{3,}/); // 无 3 连空行
  });
});

describe('索引闭环（编辑即索引更新）', () => {
  it('replace 后 cache.db 可搜到新符号', async () => {
    write('src/idx.ts', TS_SAMPLE);
    // 先 insert 建立索引基线（新文件同步）
    await editCode({
      project_dir: dir,
      file: 'src/idx.ts',
      op: 'insert',
      symbol: 'helper',
      code: `export function branded(): string {
  return 'brand';
}`,
    });
    const db = getProjectCacheDb(dir);
    const hits = searchSymbols(db, 'branded', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('branded');
  });
});

describe('range（显式行区间编辑）', () => {
  it('替换指定行区间，其他行不动', async () => {
    write('src/math.ts', TS_SAMPLE);
    const r = await editCode({
      project_dir: dir,
      file: 'src/math.ts',
      op: 'range',
      start: 2,
      end: 2,
      code: '  return a + b + 100;\n',
    });
    expect(r.message).toContain('range');
    const after = fs.readFileSync(path.join(dir, 'src/math.ts'), 'utf8');
    expect(after).toContain('return a + b + 100;');
    expect(after).toContain("return 'x';"); // helper 不动
    // add 函数体被替换后仍是合法 TS
    const parsed = await parseFileFull('x.ts', after);
    expect(parsed.symbols.map((s) => s.name)).toContain('add');
  });

  it('dry_run 出 diff 预览但不写盘', async () => {
    const p = write('src/dry.ts', TS_SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    const r = await editCode({
      project_dir: dir,
      file: 'src/dry.ts',
      op: 'range',
      start: 2,
      end: 2,
      code: '  return a + b + 100;\n',
      dry_run: true,
    });
    expect(r.message).toContain('[干跑]');
    expect(r.message).toContain('语法门通过');
    expect(r.message).toContain('- ' + '  return a + b;');
    expect(r.message).toContain('+ ' + '  return a + b + 100;');
    // 未写盘
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('区间穿透符号 → 提示影响面', async () => {
    write('src/oc.ts', TS_SAMPLE);
    const r = await editCode({
      project_dir: dir,
      file: 'src/oc.ts',
      op: 'range',
      start: 6,
      end: 6,
      code: '  total = 42;\n',
    });
    // L6 落在 class Calc(L5-L16) 内部 → 提示穿透 Calc
    expect(r.message).toContain('⚠ 区间穿透');
    expect(r.message).toContain('Calc');
    const after = fs.readFileSync(path.join(dir, 'src/oc.ts'), 'utf8');
    expect(after).toContain('total = 42;');
  });

  it('传空串 code = 删除区间', async () => {
    write('src/delr.ts', TS_SAMPLE);
    const r = await editCode({
      project_dir: dir,
      file: 'src/delr.ts',
      op: 'range',
      start: 12,
      end: 15,
      code: '',
    });
    expect(r.message).toContain('range');
    const after = fs.readFileSync(path.join(dir, 'src/delr.ts'), 'utf8');
    expect(after).not.toContain('add(n: number)');
    expect(after).toContain('class Calc'); // 类其余部分保留
    const parsed = await parseFileFull('x.ts', after);
    expect(parsed.symbols.some((s) => s.qualified_name === 'Calc.add')).toBe(false); // 类方法没了
    expect(parsed.symbols.map((s) => s.name)).toContain('add'); // 顶层 export function add 仍在
  });

  it('区间引入语法错误 / 越界 → 拒绝不写盘', async () => {
    // 语法错误
    const p = write('src/badr.ts', TS_SAMPLE);
    const before = fs.readFileSync(p, 'utf8');
    await expect(
      editCode({
        project_dir: dir,
        file: 'src/badr.ts',
        op: 'range',
        start: 2,
        end: 2,
        code: '  return "unterminated',
      }),
    ).rejects.toThrow(/语法错误|放弃/);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
    // 越界 end
    await expect(
      editCode({ project_dir: dir, file: 'src/badr.ts', op: 'range', start: 1, end: 9999, code: '' }),
    ).rejects.toThrow(/超出文件总行数/);
    // start < 1
    await expect(
      editCode({ project_dir: dir, file: 'src/badr.ts', op: 'range', start: 0, end: 2, code: 'x' }),
    ).rejects.toThrow(/start 必须 ≥1|start 必须 ≥ 1/);
    // end < start
    await expect(
      editCode({ project_dir: dir, file: 'src/badr.ts', op: 'range', start: 5, end: 2, code: 'x' }),
    ).rejects.toThrow(/end\(2\) < start\(5\)/);
  });
});

describe('未预热：replace_text 无需预建索引（vs safe_rename 需预热）', () => {
  it('全新目录、无 cache.db、未预热 → replace_text 仍可编辑并事后建索引', async () => {
    write(
      'src/plain.ts',
      `export const GREETING = 'hello';

export function greet(): string {
  return GREETING;
}
`,
    );
    // 未预热：不做任何 index/import_project，直接 replace_text（文本唯一替换不依赖符号索引）
    const r = await editCode({
      project_dir: dir,
      file: 'src/plain.ts',
      op: 'replace_text',
      old_text: "'hello'",
      new_text: "'hi'",
    });
    expect(r.message).toContain('replace_text');
    const after = fs.readFileSync(path.join(dir, 'src/plain.ts'), 'utf8');
    expect(after).toContain("'hi'");
    // 编辑后索引已建立（新鲜度闭环）——即使此前从未预热
    const db = getProjectCacheDb(dir);
    expect(searchSymbols(db, 'greet', 5).length).toBeGreaterThan(0);
  });

  it('replace_text 降级失败用于绕开符号缺索引时：dry_run 亦不写盘', async () => {
    const p = write('src/dry_text.ts', `const A = 1;\n`);
    const before = fs.readFileSync(p, 'utf8');
    const r = await editCode({
      project_dir: dir,
      file: 'src/dry_text.ts',
      op: 'replace_text',
      old_text: 'A = 1',
      new_text: 'A = 2',
      dry_run: true,
    });
    expect(r.message).toContain('[干跑]');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });
});

describe('落盘原子性：中止编辑无残留（文件与 cache.db 双一致）', () => {
  it('先建索引基线，被拒绝的编辑既不改文件也不污染 cache.db', async () => {
    const p = write('src/math.ts', TS_SAMPLE);
    // 先建立索引基线（通过一次成功编辑确定性触发 syncFile）
    await editCode({
      project_dir: dir,
      file: 'src/math.ts',
      op: 'insert',
      symbol: 'helper',
      code: 'export function seeded(): number {\n  return 1;\n}',
    });
    const db = getProjectCacheDb(dir);
    const beforeContent = fs.readFileSync(p, 'utf8');
    const beforeSym = (getFileParse(db, 'src/math.ts')?.symbols ?? [])
      .map((s) => `${s.qualified_name}@${s.start_line}`)
      .sort();
    // 注入语法破坏的 replace → 被拒绝
    await expect(
      editCode({
        project_dir: dir,
        file: 'src/math.ts',
        op: 'replace',
        symbol: 'helper',
        code: 'export function helper(): string {\n  return "oops\n}',
      }),
    ).rejects.toThrow(/语法错误|放弃|解析失败|未写盘/);
    // 文件原样（没有半截写入）
    expect(fs.readFileSync(p, 'utf8')).toBe(beforeContent);
    // cache.db 符号表原样（没有被半写污染）
    const afterSym = (getFileParse(db, 'src/math.ts')?.symbols ?? [])
      .map((s) => `${s.qualified_name}@${s.start_line}`)
      .sort();
    expect(afterSym).toEqual(beforeSym);
  });
});

describe('并发 cache.db 写锁：并发编辑不抛 locked 也不损坏索引', () => {
  it('N 个文件并发 replace 各自成功，索引整体完整可查', async () => {
    const n = 12;
    for (let i = 0; i < n; i++) write(`src/f${i}.ts`, TS_SAMPLE);
    const jobs = Array.from({ length: n }, (_, i) =>
      editCode({
        project_dir: dir,
        file: `src/f${i}.ts`,
        op: 'replace',
        symbol: 'add',
        code: `export function add(a: number, b: number): number {\n  return a + b + ${i};\n}`,
      }),
    );
    const results = await Promise.all(jobs); // 任一抛「database is locked」都会使该句失败
    results.forEach((r) => expect(r.message).toContain('已替换'));
    // 每文件正文正确（并发没有互相覆盖/丢写）
    for (let i = 0; i < n; i++) {
      expect(fs.readFileSync(path.join(dir, `src/f${i}.ts`), 'utf8')).toContain(`a + b + ${i};`);
    }
    // 索引整体一致：12 个文件各有索引（每文件一个被编辑过的 add 顶层符号）
    const db = getProjectCacheDb(dir);
    const rows = searchSymbols(db, 'add', 50);
    const indexedFiles = new Set(rows.filter((s) => s.file_path.startsWith('src/f')).map((s) => s.file_path));
    expect(indexedFiles.size).toBe(n);
  });
});

describe('range 缩进规范化（以周围上下文为准）', () => {
  it('AI 给零缩进代码，range 后自动贴合所在缩进层级', async () => {
    write(
      'src/ind.ts',
      `class Svc {
  run(): void {
    stepA();
    stepB();
  }
}
`,
    );
    // range L3（run() 体，缩进 4 空格），传零缩进代码 → 归一化到 4 空格
    await editCode({
      project_dir: dir,
      file: 'src/ind.ts',
      op: 'range',
      start: 3,
      end: 3,
      code: 'stepNEW();\n',
    });
    const after = fs.readFileSync(path.join(dir, 'src/ind.ts'), 'utf8');
    expect(after).toMatch(/^ {4}stepNEW\(\);/m);
  });

  it('多行块只去公共缩进、保留内部相对嵌套', async () => {
    write(
      'src/ind2.ts',
      `function outer(): void {
  if (ok()) {
    inner();
  }
}
`,
    );
    // 传一段带 4 空格基线缩进（为更深层级写的）代码，range 到 L2-L4（if 语句，体缩进 2 空格）→
    // 去公共缩进（4）→ 按所在层级（2）重排，内部相对嵌套保留（inner/extra 相对 +2）
    await editCode({
      project_dir: dir,
      file: 'src/ind2.ts',
      op: 'range',
      start: 2,
      end: 4,
      code: `    if (ok()) {
      inner();
      extra();
    }`,
    });
    const after = fs.readFileSync(path.join(dir, 'src/ind2.ts'), 'utf8');
    // if 在 fn 体层级（2 空格），其内部再 +2
    expect(after).toMatch(/^  if \(ok\(\)\) \{$/m);
    expect(after).toContain('\n    inner();\n');
    expect(after).toContain('\n    extra();\n');
    // 仍能解析出 outer 函数
    const parsed = await parseFileFull('x.ts', after);
    expect(parsed.symbols.map((s) => s.name)).toContain('outer');
  });
});

describe('replace 裸函数体 → 提示改用 sub=body', () => {
  it('对 class 方法 replace 裸语句 → 报错含 sub=body 引导，且不写盘', async () => {
    const p = write(
      'src/rep.ts',
      `export class Calc {
  total = 0;

  add(n: number): number {
    return this.total + n;
  }
}
`,
    );
    const before = fs.readFileSync(p, 'utf8');
    await expect(
      editCode({
        project_dir: dir,
        file: 'src/rep.ts',
        op: 'replace',
        symbol: 'add',
        code: 'return this.total + 100;\n',
      }),
    ).rejects.toThrow(/sub='body'/);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('完整定义被替换不误报 sub=body（自包含代码正常通过）', async () => {
    const p = write('src/full.ts', TS_SAMPLE);
    await editCode({
      project_dir: dir,
      file: 'src/full.ts',
      op: 'replace',
      symbol: 'helper',
      code: 'export function helper(): string {\n  return \'v2\';\n}',
    });
    expect(fs.readFileSync(p, 'utf8')).toContain("'v2'");
  });
});

describe('同名命中返回 N 候选 + 上下文摘要 + parent 引导', () => {
  it('歧义报错含候选数、ctx 摘要与 parent 指引，AI 可凭正文分辨', async () => {
    write(
      'src/ambctx.ts',
      `export class A {
  save(): void {
    console.log('A saves fast');
  }
}

export class B {
  save(): void {
    console.log('B saves slow');
  }
}
`,
    );
    try {
      await editCode({
        project_dir: dir,
        file: 'src/ambctx.ts',
        op: 'replace',
        symbol: 'save',
        code: '  save(): void {\n    console.log(1);\n  }',
      });
      throw new Error('应当抛歧义错误，却成功了');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/不唯一（[23] 候选/);
      expect(msg).toContain('ctx:'); // 上下文摘要
      expect(msg).toContain('parent'); // 引导 parent 消歧
      expect(msg).toMatch(/A saves fast/); // 摘要含方法正文
      expect(msg).toMatch(/B saves slow/);
    }
  });
});
