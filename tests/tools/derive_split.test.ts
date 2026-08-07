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
    // 新文件：补 from 原文件；未使用的 import os 被裁剪（extract_me 不直接用 os）
    expect(r.new_content).not.toContain('import os');
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

describe('deriveSplit · 社区内子拆分编排（P3）', () => {
  const GO_TOOL = `package tool

import "fmt"

type TypeA struct{ X int }

func (a TypeA) A1() string { return fmt.Sprintf("%d", a.X) }
func (a TypeA) A2() string { return fmt.Sprintf("%d", a.X) }
func (a TypeA) A3() string { return fmt.Sprintf("%d", a.X) }

type TypeB struct{ Y int }

func (b TypeB) B1() string { return fmt.Sprintf("%d", b.Y) }
func (b TypeB) B2() string { return fmt.Sprintf("%d", b.Y) }
func (b TypeB) B3() string { return fmt.Sprintf("%d", b.Y) }

func keep(x int) int { return x }
`;

  it('消费 splittable 社区，按 owner 自动二次拆分到独立文件', async () => {
    const rel = writeTarget('tool.go', GO_TOOL);
    const subsplit = [
      {
        community_id: 0,
        community_name: 'Tool',
        splittable: true,
        groups: [
          { owner: 'TypeA', methods: [{ name: 'A1', file: rel }, { name: 'A2', file: rel }, { name: 'A3', file: rel }] },
          { owner: 'TypeB', methods: [{ name: 'B1', file: rel }, { name: 'B2', file: rel }, { name: 'B3', file: rel }] },
        ],
      },
    ];

    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: [], subsplit, dry_run: true });

    expect(r.subsplit).toHaveLength(2);
    expect(r.subsplit!.map((s) => s.owner).sort()).toEqual(['TypeA', 'TypeB']);
    expect(r.subsplit!.every((s) => s.ok)).toBe(true);
    // 新文件以 owner 命名
    expect(r.subsplit!.find((s) => s.owner === 'TypeA')!.new_file).toBe('tool_TypeA.go');
    expect(r.subsplit!.find((s) => s.owner === 'TypeB')!.new_file).toBe('tool_TypeB.go');
    // 每个 owner 的方法数正确
    expect(r.subsplit!.find((s) => s.owner === 'TypeA')!.method_count).toBe(3);
    expect(r.subsplit!.find((s) => s.owner === 'TypeB')!.method_count).toBe(3);
    // dry_run 不落盘
    expect(fs.existsSync(path.join(root, 'tool_TypeA.go'))).toBe(false);
  });

  it('非 splittable 社区被跳过，不产生拆分', async () => {
    const subsplit = [
      {
        community_id: 0,
        community_name: 'X',
        splittable: false,
        groups: [{ owner: 'TypeA', methods: [{ name: 'A1', file: 'a.go' }] }],
      },
    ];
    const r = await deriveSplit({ project_dir: root, target_file: 'a.go', symbols: [], subsplit, dry_run: true });
    expect(r.subsplit).toHaveLength(0);
    expect(r.message).toContain('无可拆社区');
  });
});

describe('deriveSplit · 测试级验收闭环（P3 收尾）', () => {
  const GO_MOD = `module probe

go 1.21
`;

  const GO_TOOL = `package tool

import "fmt"

type TypeA struct{ X int }

func (a TypeA) A1() string { return fmt.Sprintf("%d", a.X) }
func (a TypeA) A2() string { return fmt.Sprintf("%d", a.X) }
func (a TypeA) A3() string { return fmt.Sprintf("%d", a.X) }

func keep(x int) int { return x }
`;

  const GO_TEST = `package tool

import "testing"

func TestTypeA(t *testing.T) {
  a := TypeA{X: 5}
  if got := a.A1(); got != "5" {
    t.Fatalf("A1() = %q, want %q", got, "5")
  }
}
`;

  it('dry_run=true：不运行测试级验收，verification 无 test 字段', async () => {
    writeTarget('go.mod', GO_MOD);
    const rel = writeTarget('tool.go', GO_TOOL);
    writeTarget('tool_test.go', GO_TEST);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['TypeA'] });
    expect(r.dry_run).toBe(true);
    expect(r.verification.test).toBeUndefined();
    expect(r.rolled_back).toBe(false);
  });

  it('项目无测试文件：测试级验收跳过（skipped），不失败', async () => {
    writeTarget('go.mod', GO_MOD);
    const rel = writeTarget('tool.go', GO_TOOL);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['TypeA'], dry_run: false, verify_test: true });
    expect(r.verification.test).toBeDefined();
    expect(r.verification.test!.skipped).toContain('无 _test.go 测试文件');
    expect(r.rolled_back).toBe(false);
  });

  it('真实 Go 项目：编译 + 测试通过，不回滚', async () => {
    writeTarget('go.mod', GO_MOD);
    const rel = writeTarget('tool.go', GO_TOOL);
    writeTarget('tool_test.go', GO_TEST);
    const r = await deriveSplit({ project_dir: root, target_file: rel, symbols: ['TypeA'], dry_run: false, verify_test: true });
    expect(r.verification.compile).toBeDefined();
    expect(r.verification.test).toBeDefined();
    expect(r.verification.compile!.ok).toBe(true);
    expect(r.verification.test!.ok).toBe(true);
    expect(r.rolled_back).toBe(false);
    // 新文件已落盘
    expect(fs.existsSync(path.join(root, 'tool__split.go'))).toBe(true);
  });
});