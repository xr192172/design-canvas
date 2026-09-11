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
import { translateGoProject, walkGoFiles } from '../../src/translate/project.js';

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
});