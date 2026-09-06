/**
 * function_annotation 测试：语义注释 扫描/分类(body指纹)/注入/过期(stale)
 * 只测纯逻辑（scanFileAnnotations / applyAnnotationsToSource），不触发 LLM。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanFileAnnotations, applyAnnotationsToSource, type FnTarget } from '../../src/tools/function_annotation';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

let dir: string;
function writeTs(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnann-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('scanFileAnnotations 分类', () => {
  it('无注释→missing；手写JSDoc→ok；一行空函数跳过', async () => {
    const abs = writeTs('a.ts', [
      'export function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '',
      '/** 计算两数积 */',
      'export function mul(a: number, b: number): number { return a * b; }',
      '',
      'export function noop() {}',
      '',
    ].join('\n'));
    const targets = await scanFileAnnotations(abs);
    const byName = new Map(targets.map((t) => [t.name, t]));
    expect(byName.get('add')?.status).toBe('missing');
    expect(byName.get('mul')?.status).toBe('ok');
    expect(byName.has('noop')).toBe(false); // 一行空函数体 → 无可描述，跳过
  });

  it('applyAnnotationsToSource：missing 注入、stale 替换、保持缩进；再扫→ok；改 body→stale（指纹失效）', async () => {
    const abs = writeTs('b.ts', [
      'export function greet(name: string): string {',
      '  return `hi ${name}`;',
      '}',
      '',
    ].join('\n'));
    const first = await scanFileAnnotations(abs);
    const greet0 = first.find((t) => t.name === 'greet')!;
    expect(greet0.status).toBe('missing');

    // 注入（缺失 → 插入）
    const job = { startLine: greet0.startLine, status: 'missing' as const, blockLines: [], blockStart: -1, newBlock: ['/**', ' * 生成问候语', ' *', ` * @fnhash ${greet0.bodyHash}`, ' */'] };
    const annotated = applyAnnotationsToSource(fs.readFileSync(abs, 'utf-8'), [job]);
    expect(annotated.startsWith('/**')).toBe(true);
    fs.writeFileSync(abs, annotated, 'utf-8');

    // 再扫：指纹 = 当前 body → ok
    let again = await scanFileAnnotations(abs);
    let g = again.find((t) => t.name === 'greet')!;
    expect(g.status).toBe('ok');
    expect(g.blockLines.some((l) => l.includes('@fnhash'))).toBe(true);

    // 改 body（加一行）→ 指纹失效 → stale
    const mutated = annotated.replace('return `hi ${name}`;', 'return `hi ${name}!!`;');
    fs.writeFileSync(abs, mutated, 'utf-8');
    again = await scanFileAnnotations(abs);
    g = again.find((t) => t.name === 'greet')!;
    expect(g.status).toBe('stale');

    // stale → 用新块替换旧块（保留指纹标记、仅换描述）
    const staleJob = { startLine: g.startLine, status: 'stale' as const, blockLines: ['/**', ' * 生成问候语', ' *', ` * @fnhash ${g.bodyHash}`, ' */'], blockStart: 0, newBlock: ['/**', ' * 生成带感叹号的问候语', ' *', ` * @fnhash ${g.bodyHash}`, ' */'] };
    const resynced = applyAnnotationsToSource(mutated, [staleJob]);
    expect(resynced.split('\n').filter((l) => l.includes('感叹号')).length).toBe(1);
    // stale 用新块整个替换旧块 → 只剩新块里那一个 marker 行
    const expectHashCnt = resynced.split('\n').filter((l) => l.includes('@fnhash')).length;
    expect(expectHashCnt).toBe(1);
  });

  it('方法(method)也纳入扫描，且缩进正确', async () => {
    const abs = writeTs('c.ts', [
      'export class Greeter {',
      '  hello(name: string): string {',
      '    return `h ${name}`;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const targets = await scanFileAnnotations(abs);
    const hello = targets.find((t) => t.name === 'hello');
    expect(hello).toBeDefined();
    expect(hello!.indent).toBe('  ');
    expect(hello!.status).toBe('missing');
  });

  it('Go：扫到函数、用 `//` 行注入（godoc 式）、re-scan→ok', async () => {
    const abs = path.join(dir, 'a.go');
    fs.writeFileSync(abs, [
      'package demo',
      '',
      'func Add(a int, b int) int {',
      '\treturn a + b',
      '}',
      '',
    ].join('\n'), 'utf-8');
    const first = await scanFileAnnotations(abs);
    const add = first.find((t) => t.name === 'Add');
    expect(add).toBeDefined();
    expect(add!.status).toBe('missing');

    // 用手工 Go 块做注入（空格缩进）
    const job = { startLine: add!.startLine, status: 'missing' as const, blockLines: [], blockStart: -1, newBlock: ["// Add 返回两数之和。", "//", `// @fnhash ${add!.bodyHash}`] };
    const annotated = applyAnnotationsToSource(fs.readFileSync(abs, 'utf-8'), [job]);
    const annLines = annotated.split('\n');
    // 推断：注释插在 func Add 声明行上方（package demo\n\n 之后 = 第 2 行）
    expect(annLines[2]).toBe('// Add 返回两数之和。');
    expect(annotated.includes(`// @fnhash ${add!.bodyHash}`)).toBe(true);
    fs.writeFileSync(abs, annotated, 'utf-8');
    const again = await scanFileAnnotations(abs);
    expect(again.find((t) => t.name === 'Add')?.status).toBe('ok');
  });
});