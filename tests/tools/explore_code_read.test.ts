/**
 * explore_code action=read 测试（2026-08-30 补 read 能力 + 统一行号）
 *
 * 核心验证点：
 * - 三种读取模式：整个文件 / 符号定位（AST 边界）/ 行区间（1-based 含端点）
 * - 返回行号与真实文件行一致（splitKeepEnds 下标+1 = 行号）
 * - 闭环（行号契约核心）：read 拿到的 start/end 直接喂 edit_code(op=range)
 *   替换正确符号体 → 证明行号基准统一，LLM 不会踩"读的行号喂编辑错位"坑
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exploreCode } from '../../src/tools/explore_code';
import { editCode } from '../../src/tools/edit_code';
import { closeProjectCacheDb } from '../../src/db/db';

interface ReadData {
  file: string;
  rel_path: string;
  total_lines: number;
  start: number;
  end: number;
  truncated: boolean;
  symbol?: {
    name: string;
    qualified_name: string;
    kind: string;
    signature?: string;
    parent?: string;
    start_line: number;
    end_line: number;
  };
  lines: string[];
}

const FIXTURE = [
  'const alpha = 1;',
  'const beta = 2;',
  '',
  'export function greet(name: string): string {',
  "  const msg = 'hello ' + name;",
  '  return msg;',
  '}',
  '',
  'export function bye(name: string): string {',
  "  return 'bye ' + name;",
  '}',
  '',
].join('\n');

let root: string;
let fileAbs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-read-'));
  fileAbs = path.join(root, 'greet.ts');
  fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
  fs.writeFileSync(fileAbs, FIXTURE, 'utf8');
});

afterEach(() => {
  closeProjectCacheDb(root); // 释放 cache.db 句柄（Windows EBUSY）
  fs.rmSync(root, { recursive: true, force: true });
});

describe('explore_code read - 读取模式与行号契约', () => {
  it('缺 file 报错（消息含缺失 key）', async () => {
    await expect(exploreCode({ action: 'read', args: {} })).rejects.toThrow(/"file"/);
  });

  it('文件不存在报错', async () => {
    await expect(
      exploreCode({ action: 'read', args: { file: path.join(root, 'nope.ts') } }),
    ).rejects.toThrow(/文件不存在/);
  });

  it('默认读整个文件，行号与真实文件逐行一致', async () => {
    const r = await exploreCode({ action: 'read', args: { file: fileAbs } });
    const d = r.data as ReadData;
    expect(d.start).toBe(1);
    expect(d.end).toBe(11);
    expect(d.total_lines).toBe(11);
    expect(d.truncated).toBe(false);
    expect(d.lines.length).toBe(11);
    // 首行与末尾行带真实行号前缀（行号按最大宽度左对齐填充）
    expect(d.lines[0]).toBe(' 1| const alpha = 1;');
    expect(d.lines[10]).toBe('11| }');
  });

  it('符号模式：按 AST 边界读函数体（greet L4-L7）', async () => {
    const r = await exploreCode({ action: 'read', args: { file: fileAbs, symbol: 'greet' } });
    const d = r.data as ReadData;
    expect(d.start).toBe(4);
    expect(d.end).toBe(7);
    expect(d.symbol?.qualified_name).toBe('greet');
    expect(d.symbol?.start_line).toBe(4);
    expect(d.symbol?.end_line).toBe(7);
    expect(d.lines[0]).toBe('4| export function greet(name: string): string {');
    expect(d.lines[3]).toBe('7| }');
    expect(r.message).toContain('L4-L7');
  });

  it('符号模式 + context：符号边界向两侧扩展', async () => {
    const r = await exploreCode({ action: 'read', args: { file: fileAbs, symbol: 'greet', context: 1 } });
    const d = r.data as ReadData;
    expect(d.start).toBe(3); // 4-1
    expect(d.end).toBe(8); // 7+1
  });

  it('符号未找到：报错并列出文件符号', async () => {
    await expect(
      exploreCode({ action: 'read', args: { file: fileAbs, symbol: 'nope' } }),
    ).rejects.toThrow(/符号未找到: nope/);
  });

  it('行区间模式：1-based 含端点（L5-L6）', async () => {
    const r = await exploreCode({ action: 'read', args: { file: fileAbs, start: 5, end: 6 } });
    const d = r.data as ReadData;
    expect(d.start).toBe(5);
    expect(d.end).toBe(6);
    expect(d.lines).toEqual(["5|   const msg = 'hello ' + name;", '6|   return msg;']);
  });

  it('行区间越界报错', async () => {
    await expect(
      exploreCode({ action: 'read', args: { file: fileAbs, start: 1, end: 99 } }),
    ).rejects.toThrow(/超出文件总行数/);
  });

  it('相对 project_dir 的 file 路径可解析', async () => {
    const r = await exploreCode({ action: 'read', args: { project_dir: root, file: 'greet.ts' } });
    const d = r.data as ReadData;
    expect(d.rel_path).toBe('greet.ts');
    expect(d.total_lines).toBe(11);
  });
});

describe('explore_code read → edit_code(op=range) 行号闭环', () => {
  it('read 的符号行号直接喂 edit_code，正确替换函数体（不踩行号漂移）', async () => {
    // 1) read 定位 greet，拿 start/end
    const rd = (await exploreCode({ action: 'read', args: { file: fileAbs, symbol: 'greet' } })).data as ReadData;
    expect(rd.symbol?.start_line).toBe(4);

    // 2) 用 read 的行号喂 edit_code op=range 替换函数体
    const newBody = [
      'export function greet(name: string): string {',
      "  return 'hi ' + name.toUpperCase();",
      '}',
    ].join('\n');
    const er = await editCode({
      project_dir: root,
      file: 'greet.ts',
      op: 'range',
      start: rd.start,
      end: rd.end,
      code: newBody,
    });
    expect(er.message).toContain('range 编辑');
    expect(er.message).not.toContain('语法错误');

    // 3) 落盘内容验证：替换的是 greet 而非 bye（证明行号没错位）
    const after = fs.readFileSync(fileAbs, 'utf8');
    expect(after).toContain("return 'hi ' + name.toUpperCase();");
    expect(after).toContain("return 'bye ' + name;"); // bye 原样保留
    expect(after).not.toContain("const msg = 'hello ' + name;"); // 旧 greet 体已替换
  });

  it('read 的行区间直接喂 edit_code，删除区间正确', async () => {
    const rd = (await exploreCode({ action: 'read', args: { file: fileAbs, symbol: 'bye' } })).data as ReadData;
    expect(rd.start).toBe(9);
    expect(rd.end).toBe(11);

    await editCode({ project_dir: root, file: 'greet.ts', op: 'range', start: rd.start, end: rd.end, code: '' });
    const after = fs.readFileSync(fileAbs, 'utf8');
    expect(after).not.toContain('bye');
    expect(after).toContain('greet');
  });
});
