/**
 * harvest_from_url 积木抽取编排测试（Brick Harvest Phase 3）
 *
 * 覆盖：
 *   - 本地目录全链（显式 bricks）：裸目录（无预建缓存）→ 索引 → 契约 → 闭包 → 入盒三件套
 *     manifest.json（闭包档案+聚合+provenance）/ contracts.json（闭包契约）/ files/（快照）
 *   - auto 模式：functional + fan_in≥2 + confidence≥0.7（静态封顶恰好 0.7）→ 按 fan_in 选种子
 *   - dry-run（write=false）：不入盒
 *   - 闭包超上限：skipped 带原因（防整项目端走）
 *   - 重抽更新：同名积木二次抽取 replaced=true
 *   - git URL e2e：本地 git 仓库 → file:// 浅克隆 → commit 记录 → 临时目录清理
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';
import { harvestFromUrl } from '../../src/tools/harvest_from_url';
import type { BrickManifest } from '../../src/dsl/contract';

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

function tmpDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** TS fixture：a→b（importee），c→a（caller）；a 另 import react / node:path */
function makeTsProject(): string {
  const root = tmpDir('brick-src-');
  put(
    root,
    'src/a.ts',
    `import { helperB } from './b';\nimport { useState } from 'react';\nimport path from 'node:path';\n\nexport interface Shape {\n  w: number;\n  h: number;\n}\n\nexport function mainA(x: number): string {\n  return path.sep + String(useState(x)) + String(helperB(x));\n}\n`,
  );
  put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
  put(
    root,
    'src/c.ts',
    `import { mainA } from './a';\n\nexport function mainC(x: number): string {\n  return mainA(x) + '!';\n}\n`,
  );
  return root;
}

/** auto fixture：main(种子,business) + task/worker 都 import util → util fan_in=3 唯一够格种子 */
function makeAutoProject(): string {
  const root = tmpDir('brick-auto-');
  put(root, 'src/main.ts', `import { util } from './util';\n\nexport function run(): string {\n  return util(1);\n}\n`);
  put(root, 'src/task.ts', `import { util } from './util';\n\nexport function task(): string {\n  return util(2);\n}\n`);
  put(root, 'src/worker.ts', `import { util } from './util';\n\nexport function work(): string {\n  return util(3);\n}\n`);
  put(root, 'src/util.ts', `export function util(x: number): string {\n  return 'u' + x;\n}\n`);
  return root;
}

/** Go fixture：svc → model（内部包），svc 另 import fmt / 三方库；go.mod 带 require 块 */
function makeGoProjectWithMod(): string {
  const root = tmpDir('brick-gomod-');
  put(
    root,
    'go.mod',
    [
      'module example.com/demo',
      '',
      'go 1.21',
      '',
      'require (',
      '\tgithub.com/openai/openai-go/v3 v3.52.0',
      '\tgithub.com/pkoukk/tiktoken-go v0.1.8 // indirect',
      '\tgo.opentelemetry.io/otel v1.45.0',
      ')',
    ].join('\n'),
  );
  put(root, 'pkg/model/model.go', 'package model\n\ntype User struct {\n\tName string\n}\n');
  put(
    root,
    'pkg/svc/svc.go',
    [
      'package svc',
      '',
      'import (',
      '\t"fmt"',
      '\t"github.com/openai/openai-go/v3/option"',
      '\t"example.com/demo/pkg/model"',
      ')',
      '',
      'func GetUser() *model.User {',
      '\tfmt.Println(option.Header{})',
      '\treturn &model.User{Name: "alice"}',
      '}',
    ].join('\n'),
  );
  return root;
}

describe('harvest_from_url 积木抽取编排', () => {
  it('本地目录 + 显式 bricks：全链入盒三件套', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({ source: root, bricks: [{ seeds: ['src/a.ts'] }], box_dir: box });

    expect(r.indexed_files).toBe(3);
    expect(r.bricks).toHaveLength(1);
    const b = r.bricks[0];
    expect(b.closure_count).toBe(2); // a + b，caller c 不进来
    expect(b.seeds).toEqual(['src/a.ts']);
    expect(b.replaced).toBe(false);
    expect(b.name).toMatch(/^brick-src-/);

    // 三件套落盘
    const brickDir = path.join(box, b.name);
    const manifest: BrickManifest = JSON.parse(fs.readFileSync(path.join(brickDir, 'manifest.json'), 'utf-8'));
    expect(manifest.seed_files).toEqual(['src/a.ts']);
    expect(manifest.closure.internal.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const extCls = new Map(manifest.closure.external.map((e) => [e.source, e.class]));
    expect(extCls.get('react')).toBe('third_party');
    expect(extCls.get('node:path')).toBe('stdlib');
    expect(manifest.provenance?.source_project).toBe(root);
    expect(manifest.provenance?.harvested_at).toBeTruthy();
    // 聚合：a.ts 暴露 Shape（interface）→ exposes 含之
    expect(manifest.aggregate.exposes.map((s) => s.name)).toContain('Shape');

    const contracts = JSON.parse(fs.readFileSync(path.join(brickDir, 'contracts.json'), 'utf-8'));
    expect(Object.keys(contracts).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(contracts['src/a.ts'].role.class).toBe('functional');

    expect(fs.existsSync(path.join(brickDir, 'files', 'src', 'a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(brickDir, 'files', 'src', 'b.ts'))).toBe(true);
    expect(fs.existsSync(path.join(brickDir, 'files', 'src', 'c.ts'))).toBe(false); // caller 不入快照

    // 本地路径模式：commit 无（非 git 仓库）
    expect(r.commit).toBe('');
  });

  it('auto 模式：functional + fan_in≥2 + confidence≥0.7 → 选 util', async () => {
    const root = makeAutoProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({ source: root, box_dir: box });

    // 唯一够格种子 = src/util.ts（fan_in=3）；main 是 business 种子、task/worker fan_in=0 不足
    expect(r.bricks.map((b) => b.seeds)).toEqual([['src/util.ts']]);
    expect(r.bricks[0].closure_count).toBe(1); // util 无内部依赖，闭包只有自己
    const manifest: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, r.bricks[0].name, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.seed_files).toEqual(['src/util.ts']);
  });

  it('dry-run（write=false）：预演不入盒', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({ source: root, bricks: [{ seeds: ['src/a.ts'] }], box_dir: box, write: false });

    expect(r.written).toBe(false);
    expect(r.bricks).toHaveLength(1);
    expect(r.bricks[0].brick_dir).toBe('');
    expect(fs.readdirSync(box)).toHaveLength(0); // 盒空
  });

  it('闭包超上限：跳过并给原因', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({
      source: root,
      bricks: [{ seeds: ['src/a.ts'] }],
      max_closure: 1, // a 闭包 2 文件，超限
      box_dir: box,
    });

    expect(r.bricks).toHaveLength(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toContain('超上限');
    expect(fs.readdirSync(box)).toHaveLength(0);
  });

  it('重抽更新：同名积木二次抽取 replaced=true', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');
    const bricks = [{ name: 'demo_brick', seeds: ['src/a.ts'] }];

    const r1 = await harvestFromUrl({ source: root, bricks, box_dir: box });
    const r2 = await harvestFromUrl({ source: root, bricks, box_dir: box });

    expect(r1.bricks[0].replaced).toBe(false);
    expect(r2.bricks[0].replaced).toBe(true);
    // 盒里只有一个积木目录（覆盖而非并存）
    expect(fs.readdirSync(box)).toEqual(['demo_brick']);
    const manifest: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, 'demo_brick', 'manifest.json'), 'utf-8'),
    );
    expect(manifest.name).toBe('demo_brick');
  });

  it('重抽保留：acceptance/matches 人工沉淀不随快照覆盖丢失', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');
    const bricks = [{ name: 'demo_brick', seeds: ['src/a.ts'] }];

    await harvestFromUrl({ source: root, bricks, box_dir: box });

    // 人工沉淀（Phase 2.8 验收判据 + 匹配历史）
    const mf = path.join(box, 'demo_brick', 'manifest.json');
    const m1: BrickManifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    m1.acceptance = {
      invariants: [{ name: 'pure-fn', assertion: 'helperB(x)===x*2 对任意整数 x', source: 'source-test', ref: 'src/b.test.ts' }],
      effect_check: '眼见 mainA 输出以路径分隔符开头',
    };
    m1.matches = [{ port: 'helperB', verdict: 'exact', at: '2026-08-20T00:00:00Z' }];
    fs.writeFileSync(mf, JSON.stringify(m1, null, 2), 'utf-8');

    const r2 = await harvestFromUrl({ source: root, bricks, box_dir: box });

    expect(r2.bricks[0].replaced).toBe(true);
    const m2: BrickManifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    // 人工沉淀原样继承
    expect(m2.acceptance).toEqual(m1.acceptance);
    expect(m2.matches).toEqual(m1.matches);
    // 机器可重算字段照常刷新
    expect(m2.closure.internal.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(m2.provenance?.harvested_at).toBeTruthy();
  });

  it('种子不在索引中：跳过', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({ source: root, bricks: [{ seeds: ['src/nope.ts'] }], box_dir: box });

    expect(r.bricks).toHaveLength(0);
    expect(r.skipped[0].reason).toContain('种子不在索引中');
  });

  it('Go 项目入盒：go_mod_requires 存档（闭包三方归并到 module root 的版本）', async () => {
    const root = makeGoProjectWithMod();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({
      source: root,
      bricks: [{ name: 'go_demo', seeds: ['pkg/svc/svc.go'] }],
      box_dir: box,
    });

    expect(r.bricks).toHaveLength(1);
    const manifest: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, 'go_demo', 'manifest.json'), 'utf-8'),
    );
    // 闭包三方只有 openai 子路径 → 归并到 module root 存档；
    // tiktoken/otel 未被闭包直接引用不存（间接依赖由拼装区 go mod tidy 解析）
    expect(manifest.go_mod_requires).toEqual({
      'github.com/openai/openai-go/v3': 'v3.52.0',
    });
  });

  it('TS 项目入盒：无 go.mod → go_mod_requires 缺省', async () => {
    const root = makeTsProject();
    const box = tmpDir('brick-box-');

    const r = await harvestFromUrl({ source: root, bricks: [{ seeds: ['src/a.ts'] }], box_dir: box });

    const manifest: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, r.bricks[0].name, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.go_mod_requires).toBeUndefined();
  });

  it('重抽刷新：go_mod_requires 机器可重算字段随源项目 go.mod 变化更新', async () => {
    const root = makeGoProjectWithMod();
    const box = tmpDir('brick-box-');
    const bricks = [{ name: 'go_demo', seeds: ['pkg/svc/svc.go'] }];

    await harvestFromUrl({ source: root, bricks, box_dir: box });
    const mf = path.join(box, 'go_demo', 'manifest.json');

    // 源项目升级三方版本（重抽前改 go.mod）
    put(
      root,
      'go.mod',
      [
        'module example.com/demo',
        '',
        'go 1.21',
        '',
        'require (',
        '\tgithub.com/openai/openai-go/v3 v3.53.0',
        ')',
      ].join('\n'),
    );
    const r2 = await harvestFromUrl({ source: root, bricks, box_dir: box });

    expect(r2.bricks[0].replaced).toBe(true);
    const m2: BrickManifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    expect(m2.go_mod_requires).toEqual({ 'github.com/openai/openai-go/v3': 'v3.53.0' });
  });

  it('git URL e2e：浅克隆 → commit 记录 → 临时目录清理', async () => {
    // 建本地 git 仓库（file:// URL 走浅克隆分支）
    const repo = tmpDir('brick-repo-');
    put(repo, 'src/a.ts', `import { helperB } from './b';\n\nexport function mainA(x: number): string {\n  return helperB(x);\n}\n`);
    put(repo, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    execSync('git add -A', { cwd: repo, stdio: 'pipe' });
    execSync('git -c user.name=test -c user.email=t@t commit -m init', { cwd: repo, stdio: 'pipe' });

    const box = tmpDir('brick-box-');
    const url = 'file:///' + repo.replace(/\\/g, '/');
    const r = await harvestFromUrl({ source: url, bricks: [{ seeds: ['src/a.ts'] }], box_dir: box });

    expect(r.commit).toMatch(/^[0-9a-f]{40}$/); // 浅克隆仍能读 HEAD
    expect(r.repo_name).toMatch(/^brick-repo-/);
    expect(r.bricks).toHaveLength(1);
    expect(r.bricks[0].closure_count).toBe(2);

    // provenance 冷记录带 URL + commit
    const manifest: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, r.bricks[0].name, 'manifest.json'), 'utf-8'),
    );
    expect(manifest.provenance?.source_project).toBe(url);
    expect(manifest.provenance?.commit).toBe(r.commit);

    // 克隆的临时目录已清理（不留工作副本）
    expect(fs.existsSync(r.project_dir)).toBe(false);
  });
});
