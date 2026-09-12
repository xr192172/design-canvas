/**
 * project —— 项目级 Go→TS 翻译测试
 *
 * 覆盖：walkGoFiles（跳 _test.go / node_modules）、跨文件 import 落地、同名冲突诊断、
 * stdlib 未定义诊断、outDir 镜像落盘。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { translateGoProject, walkGoFiles, buildProjectCallNote } from '../../src/translate/project.js';

/** 模拟 LLM 的确定性填孔翻译器：按 unit.id 产出引用"调用约定"里名字的函数体 */
function deterministicFiller(notesSeen: string[]): (ctx: { unit: { id: string }; prompt: string; projectNote?: string }) => string {
  return (ctx) => {
    if (ctx.projectNote) notesSeen.push(ctx.projectNote);
    switch (ctx.unit.id) {
      case 'Abs':
        return 'if (a < 0) {\n  return -a;\n}\nreturn a;';
      case 'Num_Double':
        return 'return n.Value * 2;';
      case 'Total':
        return 'return Num_Double(n) + Abs(n.Value);'; // 引用本地 Num_Double + 跨文件 import 的 Abs
      default:
        return 'return 0;';
    }
  };
}

function tmpProject(files: Record<string, string>): string {
  const root = path.join(os.tmpdir(), `dc-tr-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

describe('walkGoFiles', () => {
  it('跳过 _test.go 与 node_modules', () => {
    const root = tmpProject({
      'a.go': 'package a\n',
      'a_test.go': 'package a\n',
      'node_modules/x.go': 'package x\n',
      'sub/b.go': 'package b\n',
    });
    const files = walkGoFiles(root).map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(files.sort()).toEqual(['a.go', 'sub/b.go']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('translateGoProject', () => {
  it('跨文件类型引用 → 生成相对 import，签名不悬空', async () => {
    const root = tmpProject({
      'model/user.go': 'package model\ntype User struct {\n\tName string\n}\n',
      'svc/app.go': 'package svc\nfunc F(u *User) string { return u.Name }\n',
    });
    const r = await translateGoProject(root);
    const svc = r.modules.find((m) => m.rel === 'svc/app.go');
    const model = r.modules.find((m) => m.rel === 'model/user.go');
    expect(svc?.imports).toEqual(["import { User } from '../model/user';"]);
    expect(svc?.ts).toContain("import { User } from '../model/user';");
    expect(svc?.ts).toContain('export function F(u: User): string {');
    expect(model?.ts).toContain('export interface User {');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('同名顶层符号多文件冲突 → 不 import + 诊断', async () => {
    const root = tmpProject({
      'a/x.go': 'package a\ntype X struct { A int }\n',
      'b/x.go': 'package b\ntype X struct { B int }\n',
      'c/app.go': 'package c\nfunc V(v *X) int { return 0 }\n',
    });
    const r = await translateGoProject(root);
    const app = r.modules.find((m) => m.rel === 'c/app.go')!;
    expect(app.imports).toEqual([]); // X 冲突 → 不 import
    expect(r.diagnostics.some((d) => d.includes('同名') && d.includes('X'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('项目内未定义的导出类型（stdlib/外部）→ 写诊断、不 import', async () => {
    const root = tmpProject({
      'main.go': 'package main\nimport "bytes"\nfunc G(b *bytes.Buffer) int { return b.Len() }\n',
    });
    const r = await translateGoProject(root);
    const main = r.modules.find((m) => m.rel === 'main.go')!;
    expect(main.imports).toEqual([]);
    expect(r.diagnostics.some((d) => d.includes('Buffer'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('outDir 镜像结构落盘', async () => {
    const root = tmpProject({
      'model/user.go': 'package model\ntype User struct { Name string }\n',
      'svc/app.go': 'package svc\nfunc F(u *User) string { return u.Name }\n',
    });
    const out = path.join(os.tmpdir(), `dc-tr-out-${Date.now()}`);
    const r = await translateGoProject(root, { outDir: out });
    expect(fs.existsSync(path.join(out, 'svc', 'app.ts'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'model', 'user.ts'))).toBe(true);
    expect(r.modules.length).toBe(2);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('同包跨文件自由函数调用 → 补相对 import', async () => {
    const root = tmpProject({
      'svc/help.go': 'package svc\nfunc Help(x int) int { return x + 1 }\n',
      'svc/app.go': 'package svc\nfunc F(x int) int { return Help(x) }\n',
    });
    const r = await translateGoProject(root);
    const app = r.modules.find((m) => m.rel === 'svc/app.go')!;
    const help = r.modules.find((m) => m.rel === 'svc/help.go')!;
    expect(app.callRefsRaw).toContain('Help');
    expect(app.imports).toEqual(["import { Help } from './help';"]);
    expect(help.ts).toContain('export function Help(x: number): number');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('跨包限定调用（pkg.Foo）→ 按 import 别名补 import；方法调用不盲补', async () => {
    const root = tmpProject({
      'util/util.go': 'package util\nfunc Help(x int) int { return x + 1 }\n',
      'svc/app.go': 'package svc\nimport m "util"\nfunc F(x int) int { return m.Help(x) }\n',
      'model/user.go': 'package model\ntype User struct { ID int }\n',
      'svc/use.go': 'package svc\nimport "model"\nfunc ID(u *model.User) int { return u.ID }\n',
    });
    const r = await translateGoProject(root);
    const app = r.modules.find((m) => m.rel === 'svc/app.go')!;
    expect(app.imports).toEqual(["import { Help } from '../util/util';"]); // m.Help → Help（用 import 绑定别名 m）
    expect(app.callRefsRaw).toContain('Help');
    // 方法字段访问 u.ID / receiver 前缀 u 不是 import 别名 → 不误当函数 import
    const use = r.modules.find((m) => m.rel === 'svc/use.go')!;
    expect(use.callRefsRaw).not.toContain('ID');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('verify=true 纯项目 → 全工程 tsc 零错误', async () => {
    const root = tmpProject({
      'model/user.go': 'package model\ntype User struct { Name string }\n',
      'svc/app.go': 'package svc\nfunc F(u *User) string { return u.Name }\n',
    });
    const r = await translateGoProject(root, { verify: true });
    expect(r.diagnostics.some((d) => d.startsWith('全工程 tsc'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('verify=true stdlib 类型未定义 → 如实列出 tsc 错误', async () => {
    const root = tmpProject({
      'main.go': 'package main\nimport "bytes"\nfunc G(b *bytes.Buffer) int { return b.Len() }\n',
    });
    const r = await translateGoProject(root, { verify: true });
    const tsc = r.diagnostics.find((d) => d.startsWith('全工程 tsc'));
    expect(tsc).toBeTruthy();
    expect(tsc!).toContain('bytes'); // bytes.Buffer 的命名空间未定义 → 如实报出
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('buildProjectCallNote → 列出本地/new跨文件 free func + receiver 方法约定', async () => {
    // svc/app.go 本地 func: F；裸调用 Help(user_Get); 跨文件 Help(user_Get in svc/help.go)
    const def = new Map<string, { file: string; isFunc: boolean }>([
      ['F', { file: 'svc/app.go', isFunc: true }],
      ['Help', { file: 'svc/help.go', isFunc: true }],
      ['user_Get', { file: 'svc/help.go', isFunc: true }],
      ['User', { file: 'model/user.go', isFunc: false }],
    ]);
    const m = {
      rel: 'svc/app.go',
      callRefsRaw: ['Help', 'user_Get', 'User', 'noSuch'],
      units: [
        { name: 'F', kind: 'func' } as any,
        { name: 'user_Get', kind: 'func' } as any,
        { name: 'User', kind: 'type' } as any,
      ],
    };
    const note = buildProjectCallNote(m as any, def as any);
    expect(note).toContain('Help'); // 跨文件 imported func
    expect(note).toContain('user_Get'); // 本地 func（receiver 方法译成的自由函数）
    expect(note).toContain('user_GetName'); // 方法约定提示
    expect(note).not.toContain('User'); // 类型不列
    expect(note).not.toContain('noSuch'); // 未定义不列
  });

  it('A2 buildProjectCallNote ctx：注入兄弟函数签名 + 引用类型的字段语义', () => {
    const m = {
      rel: 'svc/app.go',
      callRefsRaw: ['Resolve'],
      units: [
        { name: 'Find', kind: 'func', params: [{ name: 'addr', type: 'Address' }] } as any,
        { name: 'Addr', kind: 'type' } as any,
      ],
    };
    const ctx = {
      funcSkel: new Map([
        ['Find', 'export function Find(addr: Address): number'],
        ['Resolve', 'export function Resolve(k: string): string'],
      ]),
      typeSkel: new Map([['Address', 'export interface Address { broadcast: boolean; excludeRoles: string[] }']]),
    };
    const def2 = new Map<string, { file: string; isFunc: boolean }>([
      ['Resolve', { file: 'util/r.go', isFunc: true }],
    ]);
    const note = buildProjectCallNote(m as any, def2 as any, ctx as any);
    expect(note).toContain('export function Find'); // 兄弟函数签名
    expect(note).toContain('export function Resolve'); // 跨文件调用签名
    expect(note).toContain('broadcast'); // 字段语义语境注入（单播/广播）
    expect(note).toContain('excludeRoles');
  });

  it('fill+verify 填后 release gate：桩翻译器按调用约定填出引用对名的函数体，纯项目过闸', async () => {
    const root = tmpProject({
      'calc/num.go':
        'package calc\ntype Num struct {\n\tValue int\n}\nfunc (n Num) Double() int {\n\treturn n.Value * 2\n}\nfunc Total(n Num) int {\n\treturn n.Double() + Abs(n.Value)\n}\n',
      'calc/abs.go': 'package calc\nfunc Abs(a int) int {\n\tif a < 0 {\n\t\treturn -a\n\t}\n\treturn a\n}\n',
    });
    const notes: string[] = [];
    const r = await translateGoProject(root, { fill: true, verify: true, translator: deterministicFiller(notes) });
    const num = r.modules.find((m) => m.rel === 'calc/num.go')!;
    // 调用约定注入：num 模块的孔 prompt 应含本地 Num_Double + 跨文件 Abs
    expect(notes.join('\n')).toContain('Num_Double');
    expect(notes.join('\n')).toContain('Abs');
    // 跨文件 free func import 落地
    expect(num.imports).toEqual(["import { Abs } from './abs';"]);
    // 填后函数体引用了本地 Num_Double + import 的 Abs → 门禁 0 错
    expect(num.ts).toContain('return Num_Double(n) + Abs(n.Value);');
    expect(num.ts).not.toContain('TODO(translate)'); // 全部函数体都填上了
    expect(r.diagnostics.some((d) => d.startsWith('全工程 tsc'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('A1 显式失败清单：skeleton/skipped/ok 逐条带 Go 源行；outDir 落报告', async () => {
    const root = tmpProject({
      'main.go':
        'package main\n\ntype User struct {\n\tName string\n}\n\ntype Empty struct {\n}\n\nconst Bad = someFunc()\n\nfunc F(a int) int {\n\treturn a\n}\n',
    });
    const out = path.join(os.tmpdir(), `dc-tr-report-${Date.now()}`);
    const r = await translateGoProject(root, { outDir: out }); // 不 fill → func 为 skeleton
    const byId = new Map(r.report.map((e) => [e.id, e]));
    // type User → ok；空 struct Empty → skipped；const Bad（不可求值）→ skipped；func F（未 fill）→ skeleton
    expect(byId.get('User')?.status).toBe('ok');
    expect(byId.get('Empty')?.status).toBe('skipped');
    expect(byId.get('Bad')?.status).toBe('skipped');
    expect(byId.get('F')?.status).toBe('skeleton');
    expect(byId.get('F')?.line).toBeGreaterThanOrEqual(9); // 有 Go 源行
    expect(byId.get('Bad')?.line).toBeGreaterThan(0);
    // outDir 落 jsonl + md
    expect(fs.existsSync(path.join(out, 'translation-report.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'translation-report.md'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('C2 verify tsc 错误按根因聚类：同类错误归并为 1 类', async () => {
    const root = tmpProject({
      'a.go': 'package a\nimport "bytes"\nfunc Ga(b *bytes.Buffer) int { return b.Len() }\n',
      'b.go': 'package b\nimport "bytes"\nfunc Gb(b *bytes.Buffer) int { return b.Len() }\n',
    });
    const r = await translateGoProject(root, { verify: true });
    const tsc = r.diagnostics.find((d) => d.startsWith('全工程 tsc'));
    expect(tsc).toBeTruthy();
    expect(tsc!).toContain('1 类 / 2 条'); // 两文件 bytes 未定义 = 同一根因
    expect(tsc!).toContain('找不到命名空间');
    expect(tsc!).toContain('bytes'); // 示例保留真实标识符可定位
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('B2 types-map：声明名→源 Go 文件:行；outDir 落 json/md', async () => {
    const root = tmpProject({
      'model/user.go': 'package model\ntype User struct {\n\tName string\n}\n',
      'svc/app.go': 'package svc\nfunc F(u *User) string { return u.Name }\n',
    });
    const out = path.join(os.tmpdir(), `dc-tr-tm-${Date.now()}`);
    const r = await translateGoProject(root, { outDir: out });
    const find = (n: string) => r.typesMap.find((e) => e.name === n);
    expect(find('User')?.file).toBe('model/user.go');
    expect(find('User')?.line).toBeGreaterThan(0);
    expect(find('F')?.file).toBe('svc/app.go');
    expect(find('F')?.kind).toBe('func');
    // 落盘
    expect(fs.existsSync(path.join(out, 'types-map.json'))).toBe(true);
    expect(fs.existsSync(path.join(out, 'types-map.md'))).toBe(true);
    const md = fs.readFileSync(path.join(out, 'types-map.md'), 'utf-8');
    expect(md).toContain('User (type) @ model/user.go:2');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('B1 同类名冲突预检：type 与 func 混同同名 → 指明两处并点名', async () => {
    const root = tmpProject({
      'a/x.go': 'package a\ntype X struct { A int }\n',
      'b/x.go': 'package b\nfunc X() int { return 0 }\n',
    });
    const r = await translateGoProject(root);
    const c = r.conflicts.find((e) => e.name === 'X');
    expect(c).toBeTruthy();
    expect(c!.reason).toBe('mixed_kind');
    expect(c!.sites).toHaveLength(2);
    expect(r.diagnostics.some((d) => d.includes('同类名混同冲突「X」'))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});