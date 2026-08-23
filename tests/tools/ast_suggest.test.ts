/**
 * ast_suggest —— 短变量智能化改名（LLM 命名建议 + 批量重命名）
 *
 * 覆盖：
 *   - renameMany：一次解析、合并多个重命名目标，按位置逆序统一生成，绝不错位；
 *     同作用域目标名冲突（b→a 而 a 已存在）→ 保守跳过该项；
 *     跨函数同名 / 块级遮蔽保持隔离，互不误伤。
 *   - findSuggestCandidates：从源码里挑出"值得改名"的短名/无意义局部变量（纯逻辑），
 *     附声明行上下文与引用数，供 LLM 索要建议。
 *   - suggestRenames：可注入 LLM 命名建议（判据驱动）；无 LLM 或调用失败 → 降级只列候选。
 */
import { describe, it, expect } from 'vitest';
import { analyzeLocals, renameMany, type LocalBinding } from '../../src/tools/ast_rename';
import { findSuggestCandidates, suggestRenames, type SuggestCandidate } from '../../src/tools/ast_suggest';

async function findByName(src: string, name: string, nth = 0): Promise<LocalBinding> {
  const locals = await analyzeLocals(src);
  const hits = locals.filter((b) => b.name === name);
  if (hits.length <= nth) throw new Error(`no binding ${name}#${nth}: ${JSON.stringify(locals)}`);
  return hits[nth];
}

describe('renameMany - 批量重命名（一次解析，合并生成）', () => {
  it('多个目标一次解析后同时改名，不错位', async () => {
    const src = 'function f() {\n  const cnt = 1;\n  const set = cnt + 1;\n  return count(set, cnt);\n}\n';
    const cnt = await findByName(src, 'cnt');
    const set = await findByName(src, 'set');
    const { out, applied } = await renameMany(src, [
      { id: cnt.id, to: 'count' },
      { id: set.id, to: 'flag' },
    ]);
    expect(out).toContain('const count = 1;');
    expect(out).toContain('const flag = count + 1;');
    expect(out).toContain('return count(flag, count);');
    expect(applied).toHaveLength(2);
    expect(applied.map((a) => a.changed).every((c) => c > 0)).toBe(true);
  });

  it('同作用域目标名冲突（b→a 而 a 已存在）→ 该跳过，另一项照常', async () => {
    const src = 'function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
    const a = await findByName(src, 'a');
    const b = await findByName(src, 'b');
    const { out, applied } = await renameMany(src, [
      { id: b.id, to: 'c' }, // 无害，允
      { id: a.id, to: 'b' }, // 冲突：b 已在此作用域
    ].reverse());
    // a→b 因冲突被跳过，name 仍 a；b→c 生效
    const forbid = applied.find((x) => x.id === a.id);
    expect(forbid?.changed).toBe(0);
    expect(forbid?.from).toBe('a');
    expect(out).toContain('const a = 1;'); // a 未改（冲突跳过）
    expect(out).toContain('const c = 2;'); // b→c 生效
    expect(out).toContain('return a + c;');
  });

  it('跨函数同名 / 块级遮蔽：各自独立，互不误伤', async () => {
    const src = [
      'function left() {',
      '  let t = 1;',
      '  if (true) {',
      '    let t = 2;',
      '    void t;',
      '  }',
      '  return t;',
      '}',
      'function right() {',
      '  let t = 3;',
      '  return t;',
      '}',
    ].join('\n');
    const leftOuter = await findByName(src, 't', 0); // 外层
    const { out } = await renameMany(src, [
      { id: leftOuter.id, to: 'limit' },
    ]);
    // 只改 left 外层
    expect(out).toContain('let limit = 1;');
    expect(out).toContain('return limit;');
    // 遮蔽内层与 right 都保持 t
    expect(out).toContain('let t = 2;');
    expect(out).toContain('void t;');
    expect(out).toContain('let t = 3;');
    expect(out).toContain('return t;');
  });

  it('目标名与旧名相同 → 该项 changed=0 且不产生编辑', async () => {
    const src = 'function f() {\n  const k = 1;\n  return k;\n}\n';
    const k = await findByName(src, 'k');
    const { out, applied } = await renameMany(src, [{ id: k.id, to: 'k' }]);
    expect(applied[0].changed).toBe(0);
    expect(out).toBe(src);
  });
});

describe('findSuggestCandidates - 短名/无意义变量候选（纯逻辑）', () => {
  it('挑出 <=2 字短名与无意义名；略过正常名', async () => {
    const src = [
      'function f() {',
      '  const a = 1;', // 短名
      '  const total = 2;', // 正常
      '  const tmp = a + total;', // 无意义
      '  return tmp;',
      '}',
    ].join('\n');
    const cands = await findSuggestCandidates(src);
    const names = cands.map((c) => c.name).sort();
    expect(names).toContain('a');
    expect(names).toContain('tmp');
    expect(names).not.toContain('total');
  });

  it('候选附声明行上下文、所属函数与引用数', async () => {
    const src = [
      'function fee() {',
      '  const n = calc();', // 短名，1 处引用
      '  return n + 1;',
      '}',
    ].join('\n');
    const [c] = await findSuggestCandidates(src);
    expect(c).toBeDefined();
    expect(c.name).toBe('n');
    expect(c.parentFunction).toBe('fee');
    expect(c.declLine).toContain('const n = calc();');
    expect(c.refs).toBe(1);
  });

  it('模块顶层短名不当候选（可能是外部导出常量）', async () => {
    const src = 'const A = 1;\nfunction f() {\n  const a = 2;\n  return a;\n}\n';
    const cands = await findSuggestCandidates(src);
    expect(cands.some((c) => c.name === 'A')).toBe(false);
    expect(cands.some((c) => c.name === 'a')).toBe(true);
  });

  it('短参数（如 add(a,b) 的 a/b）也是候选，所属函数记为参数所在函数', async () => {
    const src = 'function add(a, b) {\n  return a + b;\n}\n';
    const cands = await findSuggestCandidates(src);
    expect(cands.some((c) => c.name === 'a')).toBe(true);
    expect(cands.some((c) => c.name === 'b')).toBe(true);
    expect(cands.every((c) => c.parentFunction === 'add')).toBe(true);
  });
});

describe('suggestRenames - LLM 命名建议（判据驱动）', () => {
  it('LLM 注入：为每个候选返回新名+理由，suggested 被填入', async () => {
    const src = 'function f() {\n  const a = 1;\n  const b = a + 1;\n  return b;\n}\n';
    const fakeLlm = async (cands: SuggestCandidate[]): Promise<Array<{ name: string; reason: string }>> =>
      cands.map((c) => ({ name: c.name === 'a' ? 'base' : 'next', reason: '更语义化' }));
    const res = await suggestRenames(src, 'file.ts', { llm: fakeLlm });
    expect(res.llm).toBe(true);
    const byName = new Map(res.candidates.map((c) => [c.name, c]));
    expect(byName.get('a')?.suggested).toBe('base');
    expect(byName.get('b')?.suggested).toBe('next');
    expect(res.candidates.every((c) => c.reason)).toBe(true);
  });

  it('无 LLM（显式关闭）→ 降级只列候选，suggested 为空，llm=false', async () => {
    const src = 'function f() {\n  const x = 1;\n  return x;\n}\n';
    const res = await suggestRenames(src, 'file.ts', { llm: null });
    expect(res.llm).toBe(false);
    expect(res.candidates.some((c) => c.name === 'x')).toBe(true);
    expect(res.candidates.every((c) => c.suggested === '')).toBe(true);
  });

  it('LLM 调用失败 → 降级仍返回候选，note 含原因', async () => {
    const src = 'function f() {\n  const q = 1;\n  return q;\n}\n';
    const boom = async (): Promise<never> => {
      throw new Error('timeout');
    };
    const res = await suggestRenames(src, 'file.ts', { llm: boom });
    expect(res.llm).toBe(false);
    expect(res.note).toContain('timeout');
    expect(res.candidates.some((c) => c.name === 'q')).toBe(true);
  });
});