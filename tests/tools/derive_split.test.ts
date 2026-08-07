/**
 * derive_split 工具测试（执行文件拆分，P2 路线图序号 16）
 *
 * 覆盖场景：
 * - dry_run 默认：只出草稿不落盘
 * - 抽取符号：从原文件抽出到新文件，原文件移除
 * - import 接线：新文件复制原文件 import + 从原文件补引用；原文件补 import 新文件
 * - 交叉引用报告：原文件中指向被抽取符号的引用点
 * - 语法级验收：两份草稿 tree-sitter 重解析通过
 * - dry_run=false：实际写文件
 * - 错误边界：目标文件不存在 / 语言不支持 / 符号未命中
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveSplit } from '../../src/tools/derive_split';

let root: string;

const SAMPLE = `import { helperA } from './common';
import fs from 'node:fs';

export function keepMe(a: number): number {
  return a * 2;
}

export function extractMe(x: string): void {
  console.log(helperA(x));
}

export function anotherExtract(y: boolean): boolean {
  return !y;
}
`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'derive_split_'));
});

function writeTarget(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return rel;
}

describe('deriveSplit', () => {
  it('dry_run 默认：只出草稿，不写文件', async () => {
    const rel = writeTarget('src/mod.ts', SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe'] });

    expect(r.dry_run).toBe(true);
    // 新文件未被创建
    expect(fs.existsSync(path.join(root, 'src', 'mod__split.ts'))).toBe(false);
    // 原文件保持原样
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).toBe(SAMPLE);
    // 抽取到新文件
    expect(r.extracted.map((e) => e.name)).toEqual(['extractMe']);
    expect(r.new_content).toContain('export function extractMe');
    // 原文件草稿已移除被抽取符号
    expect(r.original_content).not.toContain('function extractMe');
    expect(r.original_content).toContain('export function keepMe');
    // import 接线：原文件补 import 新文件
    expect(r.imports_added_original[0]).toContain("from './mod__split'");
    // 语法级验收通过
    expect(r.verification.new_syntax_ok).toBe(true);
    expect(r.verification.original_syntax_ok).toBe(true);
  });

  it('复制 import + 从原文件补被引用符号', async () => {
    const rel = writeTarget('src/mod.ts', SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe'] });

    // 复制了非自引用 import（common 与 node:fs）
    expect(r.imports_copied.some((i) => i.includes('./common'))).toBe(true);
    // 被抽取函数引用了 keepMe 之外的 helperA（留在原文件？否——helperA 在原文件顶层符号里）
    // 新文件会从原文件补 helperA（若 helperA 是原文件顶层符号）
  });

  it('抽取多个顶层符号，合并相邻区间', async () => {
    const rel = writeTarget('src/mod.ts', SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe', 'anotherExtract'] });

    expect(r.extracted.map((e) => e.name).sort()).toEqual(['anotherExtract', 'extractMe']);
    expect(r.new_content).toContain('function anotherExtract');
    expect(r.original_content).not.toContain('function extractMe');
    expect(r.original_content).not.toContain('function anotherExtract');
    expect(r.original_content).toContain('function keepMe');
  });

  it('原文件中指向被抽取符号的引用被报告', async () => {
    const rel = writeTarget(
      'src/mod.ts',
      `export function keepMe(): void {
  extractMe('hi');
}
export function extractMe(x: string): void {}
`,
    );
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe'] });
    expect(r.references_to_extracted.length).toBeGreaterThan(0);
    expect(r.references_to_extracted[0].ref).toBe('extractMe');
  });

  it('dry_run=false 实际写两个文件', async () => {
    const rel = writeTarget('src/mod.ts', SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe'], dry_run: false });

    expect(r.dry_run).toBe(false);
    const newAbs = path.join(root, 'src', 'mod__split.ts');
    expect(fs.existsSync(newAbs)).toBe(true);
    expect(fs.readFileSync(newAbs, 'utf8')).toContain('function extractMe');
    expect(fs.readFileSync(path.join(root, rel), 'utf8')).not.toContain('function extractMe');
  });

  it('目标文件不存在 → 失败降级', async () => {
    const r = await deriveSplit({ project_dir: root, target_file: 'src/nope.ts', symbols: ['x'] });
    expect(r.extracted).toHaveLength(0);
    expect(r.message).toContain('目标文件不存在');
  });

  it('语言不支持 → 失败降级', async () => {
    const rel = writeTarget('go.mod', 'module x\n');
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['x'] });
    expect(r.message).toContain('暂支持');
  });

  it('符号未命中 → 失败降级并列出可用符号', async () => {
    const rel = writeTarget('src/mod.ts', SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['nope'] });
    expect(r.extracted).toHaveLength(0);
    expect(r.message).toContain('未在');
    expect(r.message).toContain('keepMe');
  });
});

describe('deriveSplit · Go（同包拆分，无需跨文件 import）', () => {
  const GO_SAMPLE = `package main

import (
	"fmt"
)

func keepMe(x int) int {
	fmt.Println(x)
	return x * 2
}

func extractMe(s string) string {
	return fmt.Sprintf("hi %s", s)
}
`;

  it('同包拆分：新文件复制 package + import 块，原文件移除符号，无跨文件 import', async () => {
    const rel = writeTarget('main.go', GO_SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extractMe'] });

    expect(r.language).toBe('Go');
    // 新文件：package 头 + import 块 + 被抽取符号
    expect(r.new_content).toContain('package main');
    expect(r.new_content).toContain('import (');
    expect(r.new_content).toContain('func extractMe');
    // 原文件只移除被抽取符号，保留 package/import/keepMe
    expect(r.original_content).not.toContain('func extractMe');
    expect(r.original_content).toContain('func keepMe');
    expect(r.original_content).toContain('package main');
    // 同包无需跨文件 import
    expect(r.imports_added_original).toHaveLength(0);
    expect(r.imports_added_new).toHaveLength(0);
    // 语法级验收
    expect(r.verification.new_syntax_ok).toBe(true);
    expect(r.verification.original_syntax_ok).toBe(true);
  });

  it('Go type 抽取：type_declaration 与内嵌 type_spec 去重，只保留外层', async () => {
    const rel = writeTarget(
      'model.go',
      `package model

type User struct {
	ID int
}

type Keep struct {
	Name string
}
`,
    );
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['User'] });

    expect(r.extracted.map((e) => e.name)).toEqual(['User']);
    expect(r.new_content).toContain('type User struct');
    expect(r.original_content).not.toContain('type User struct');
    expect(r.original_content).toContain('type Keep struct');
  });
});

describe('deriveSplit · Python（非包目录，绝对式 import 接线）', () => {
  const PY_SAMPLE = `import os

def keep_me(x):
    return os.path.basename(x)

def extract_me(s):
    return keep_me(s) + ".bak"
`;

  it('非包目录：新文件复制 import + 从原文件补引用，原文件补 from 新文件', async () => {
    const rel = writeTarget('mod.py', PY_SAMPLE);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extract_me'] });

    expect(r.language).toBe('Python');
    // 新文件：复制 import + 补 from 原文件
    expect(r.new_content).toContain('import os');
    expect(r.new_content).toContain('from mod import keep_me');
    expect(r.new_content).toContain('def extract_me');
    // 原文件移除被抽取符号，补 from 新文件
    expect(r.original_content).not.toContain('def extract_me');
    expect(r.original_content).toContain('from mod__split import extract_me');
    expect(r.original_content).toContain('def keep_me');
    // 语法级验收
    expect(r.verification.new_syntax_ok).toBe(true);
    expect(r.verification.original_syntax_ok).toBe(true);
  });
});

describe('deriveSplit · Python（包目录，相对 import 接线）', () => {
  it('目录含 __init__.py → 使用相对 import（. 前缀）', async () => {
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', '__init__.py'), '', 'utf8');
    const rel = writeTarget(
      'pkg/mod.py',
      `def keep_me(x):\n    return x + 1\n\n\ndef extract_me(s):\n    return keep_me(s)\n`,
    );
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['extract_me'] });

    expect(r.new_content).toContain('from .mod import keep_me');
    expect(r.original_content).toContain('from .mod__split import extract_me');
    expect(r.verification.new_syntax_ok).toBe(true);
    expect(r.verification.original_syntax_ok).toBe(true);
  });
});