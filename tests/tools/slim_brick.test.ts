/**
 * slim_brick 积木瘦身编排测试（Brick Harvest Phase 6）
 *
 * 覆盖（fixture 盒 + 真 go-slim 剪刀 + Go 工具链，全链集成）：
 *   - 全链：harvest_from_url 入盒（含 slim_candidates live 档案）→ slim_brick →
 *     -slim 衍生积木三件套；死函数文件整文件剔除、死三方依赖从 import 与依赖
 *     清单双剔除；derived_from 溯源；原积木零改动
 *   - 内部包 import（example.com/demo/...）不误入三方统计
 *   - 死依赖但源 go.mod 无 require（归并不了）：按原始路径口径进 deps_removed
 *   - dry-run（write=false）：报告完整、盒内不落 -slim 目录
 *   - 已存在拒绝：机器产物可重生成（删除后重跑），不静默覆盖
 *   - 缺 live 档案拒绝：提示重抽刷新
 *   - 路径漂移防线：live 明细零命中 → 拒绝执行剪刀
 *   - 无可剪内容：不生成空壳衍生积木
 *
 * 环境：需 go 工具链（剪刀以 `go run .` 运行）；无 go 时整组跳过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';
import { harvestFromUrl } from '../../src/tools/harvest_from_url';
import { slimBrick } from '../../src/tools/slim_brick';
import type { BrickManifest } from '../../src/dsl/contract';

const goOk = spawnSync('go', ['version'], { encoding: 'utf8' }).status === 0;

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

/** Go fixture：svc → model（内部包）；svc 活用 openai；extra.go 死函数引死三方 deadlib */
function makeGoProjectWithDead(): string {
  const root = tmpDir('slim-src-');
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
  put(
    root,
    'pkg/svc/extra.go',
    [
      'package svc',
      '',
      'import "github.com/unused/deadlib"',
      '',
      'func Extra() string {',
      '\treturn deadlib.Thing()',
      '}',
    ].join('\n'),
  );
  return root;
}

/** 干净 Go fixture：种子全活、三方全活 → 无可剪内容 */
function makeGoProjectClean(): string {
  const root = tmpDir('slim-clean-');
  put(
    root,
    'go.mod',
    ['module example.com/demo', '', 'go 1.21', '', 'require github.com/openai/openai-go/v3 v3.52.0'].join('\n'),
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

/** 版本后缀 fixture：活函数用 doublestar/v4（无 alias——真包名在前段
 *  doublestar，不是末段 v4）；死函数用同为版本后缀的 deadlib/v2 */
function makeGoProjectVersionSuffix(): string {
  const root = tmpDir('slim-vsuffix-');
  put(
    root,
    'go.mod',
    [
      'module example.com/demo',
      '',
      'go 1.21',
      '',
      'require github.com/bmatcuk/doublestar/v4 v4.9.1',
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
      '\t"github.com/bmatcuk/doublestar/v4"',
      '\t"example.com/demo/pkg/model"',
      ')',
      '',
      'func GetUser() *model.User {',
      '\tmatched, _ := doublestar.Match("a/*", "a/b")',
      '\t_ = matched',
      '\treturn &model.User{Name: "alice"}',
      '}',
    ].join('\n'),
  );
  put(
    root,
    'pkg/svc/extra.go',
    [
      'package svc',
      '',
      'import "github.com/unused/deadlib/v2"',
      '',
      'func Extra() string {',
      '\treturn deadlib.Thing()',
      '}',
    ].join('\n'),
  );
  return root;
}

/** 入盒辅助：harvest 后返回盒目录与积木名 */
async function boxGoProject(root: string, name: string): Promise<string> {
  const box = tmpDir('slim-box-');
  const r = await harvestFromUrl({ source: root, bricks: [{ name, seeds: ['pkg/svc/svc.go'] }], box_dir: box });
  expect(r.bricks).toHaveLength(1);
  return box;
}

describe.skipIf(!goOk)('slim_brick 积木瘦身编排（Go 工具链集成）', () => {
  it('全链：死函数文件剔除 + 死三方依赖双剔除 + 衍生积木三件套 + 原积木零改动', async () => {
    const root = makeGoProjectWithDead();
    const box = await boxGoProject(root, 'go_demo');

    const r = await slimBrick({ brick_name: 'go_demo', box_dir: box });

    // 报告：extra.go 整文件剔除；deadlib 双剔除（import + 依赖清单）
    expect(r.written).toBe(true);
    expect(r.dropped_files).toEqual(['pkg/svc/extra.go']);
    expect(r.files_before).toBe(3);
    expect(r.files_after).toBe(2);
    expect(r.symbols_before).toBeGreaterThan(r.symbols_after);
    // deadlib 源 go.mod 无 require → 按原始路径口径进对比（不漏报）
    expect(r.deps_removed).toEqual(['github.com/unused/deadlib']);
    expect(r.deps_after).toContain('github.com/openai/openai-go/v3');

    // 衍生积木三件套
    const slimDir = path.join(box, 'go_demo-slim');
    expect(fs.existsSync(path.join(slimDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(slimDir, 'contracts.json'))).toBe(true);
    expect(fs.existsSync(path.join(slimDir, 'files', 'pkg', 'svc', 'svc.go'))).toBe(true);
    expect(fs.existsSync(path.join(slimDir, 'files', 'pkg', 'model', 'model.go'))).toBe(true);
    expect(fs.existsSync(path.join(slimDir, 'files', 'pkg', 'svc', 'extra.go'))).toBe(false);

    // 存活源码完好：GetUser 在、fmt/openai import 在、内部包 import 在
    const svcSrc = fs.readFileSync(path.join(slimDir, 'files', 'pkg', 'svc', 'svc.go'), 'utf-8');
    expect(svcSrc).toContain('func GetUser()');
    expect(svcSrc).toContain('"fmt"');
    expect(svcSrc).toContain('github.com/openai/openai-go/v3/option');
    expect(svcSrc).toContain('example.com/demo/pkg/model');

    // 衍生 manifest：溯源 + 闭包 + 依赖分类
    const m: BrickManifest = JSON.parse(fs.readFileSync(path.join(slimDir, 'manifest.json'), 'utf-8'));
    expect(m.name).toBe('go_demo-slim');
    expect(m.derived_from?.brick).toBe('go_demo');
    expect(m.derived_from?.files_before).toBe(3);
    expect(m.derived_from?.files_after).toBe(2);
    expect(m.derived_from?.deps_removed ?? m.derived_from?.deps_before).toBeDefined();
    expect(m.closure.internal.sort()).toEqual(['pkg/model/model.go', 'pkg/svc/svc.go']);
    const extCls = new Map(m.closure.external.map((e) => [e.source, e.class]));
    expect(extCls.get('fmt')).toBe('stdlib');
    expect(extCls.get('github.com/openai/openai-go/v3')).toBe('third_party');
    expect([...extCls.keys()]).not.toContain('github.com/unused/deadlib');
    // 内部包 import（example.com/demo/pkg/model）不进外部依赖统计
    expect([...extCls.keys()].some((k) => k.startsWith('example.com/'))).toBe(false);
    // go_mod_requires 只剩活依赖（openai 版本原样取自源项目存档）
    expect(m.go_mod_requires).toEqual({ 'github.com/openai/openai-go/v3': 'v3.52.0' });
    // 未做编译验证：slim_verification 缺省
    expect(m.slim_verification).toBeUndefined();

    // contracts.json：只含存活文件
    const contracts = JSON.parse(fs.readFileSync(path.join(slimDir, 'contracts.json'), 'utf-8'));
    expect(Object.keys(contracts).sort()).toEqual(['pkg/model/model.go', 'pkg/svc/svc.go']);

    // 原积木零改动：extra.go 还在、manifest 无 derived_from
    expect(fs.existsSync(path.join(box, 'go_demo', 'files', 'pkg', 'svc', 'extra.go'))).toBe(true);
    const origM: BrickManifest = JSON.parse(fs.readFileSync(path.join(box, 'go_demo', 'manifest.json'), 'utf-8'));
    expect(origM.derived_from).toBeUndefined();
    expect(origM.closure.internal).toHaveLength(3);
  });

  it('版本后缀依赖：活引用（doublestar/v4）import 存活不进死清单，死引用（deadlib/v2）剔除', async () => {
    // 回归：ocr_diff_resolver 真实事故——限定符只认路径末段 v4，`v4.` 永不
    // 命中，活依赖被误判死 + 剪刀误剪 import → 编译报 undefined: doublestar
    const root = makeGoProjectVersionSuffix();
    const box = await boxGoProject(root, 'go_vsuffix');

    const r = await slimBrick({ brick_name: 'go_vsuffix', box_dir: box });

    expect(r.written).toBe(true);
    expect(r.dropped_files).toEqual(['pkg/svc/extra.go']);
    // doublestar 活：不进剔除清单，留在 deps_after
    expect(r.deps_removed).toEqual(['github.com/unused/deadlib/v2']);
    expect(r.deps_after).toContain('github.com/bmatcuk/doublestar/v4');
    // 剪刀产物：import 与用法都存活
    const svcSrc = fs.readFileSync(
      path.join(box, 'go_vsuffix-slim', 'files', 'pkg', 'svc', 'svc.go'),
      'utf-8',
    );
    expect(svcSrc).toContain('"github.com/bmatcuk/doublestar/v4"');
    expect(svcSrc).toContain('doublestar.Match');
    // go_mod_requires 保留活依赖（版本原样取自源项目存档）
    const m: BrickManifest = JSON.parse(
      fs.readFileSync(path.join(box, 'go_vsuffix-slim', 'manifest.json'), 'utf-8'),
    );
    expect(m.go_mod_requires).toEqual({ 'github.com/bmatcuk/doublestar/v4': 'v4.9.1' });
  });

  it('dry-run（write=false）：报告完整、盒内不落 -slim 目录', async () => {
    const root = makeGoProjectWithDead();
    const box = await boxGoProject(root, 'go_demo');

    const r = await slimBrick({ brick_name: 'go_demo', box_dir: box, write: false });

    expect(r.written).toBe(false);
    expect(r.dropped_files).toEqual(['pkg/svc/extra.go']);
    expect(r.deps_removed).toEqual(['github.com/unused/deadlib']);
    expect(fs.readdirSync(box)).toEqual(['go_demo']);
  });

  it('已存在拒绝：机器产物可重生成，不静默覆盖', async () => {
    const root = makeGoProjectWithDead();
    const box = await boxGoProject(root, 'go_demo');

    await slimBrick({ brick_name: 'go_demo', box_dir: box });
    await expect(slimBrick({ brick_name: 'go_demo', box_dir: box })).rejects.toThrow('衍生积木已存在');
  });

  it('缺 live 档案拒绝：提示重抽刷新', async () => {
    const root = makeGoProjectWithDead();
    const box = await boxGoProject(root, 'go_demo');

    // 手工抹掉 live 明细（模拟旧版入盒档案）
    const mf = path.join(box, 'go_demo', 'manifest.json');
    const m: BrickManifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    delete m.slim_candidates;
    fs.writeFileSync(mf, JSON.stringify(m, null, 2), 'utf-8');

    await expect(slimBrick({ brick_name: 'go_demo', box_dir: box })).rejects.toThrow('重抽');
  });

  it('路径漂移防线：live 明细零命中 → 拒绝执行剪刀', async () => {
    const root = makeGoProjectWithDead();
    const box = await boxGoProject(root, 'go_demo');

    const mf = path.join(box, 'go_demo', 'manifest.json');
    const m: BrickManifest = JSON.parse(fs.readFileSync(mf, 'utf-8'));
    m.slim_candidates!.live_symbols_by_file = { 'nonexistent/pkg.go': ['Ghost'] };
    fs.writeFileSync(mf, JSON.stringify(m, null, 2), 'utf-8');

    await expect(slimBrick({ brick_name: 'go_demo', box_dir: box })).rejects.toThrow('零命中');
    // 盒内未产生任何 -slim 目录（剪刀未执行）
    expect(fs.readdirSync(box)).toEqual(['go_demo']);
  });

  it('无可剪内容：不生成空壳衍生积木', async () => {
    const root = makeGoProjectClean();
    const box = await boxGoProject(root, 'go_clean');

    const r = await slimBrick({ brick_name: 'go_clean', box_dir: box });

    expect(r.written).toBe(false);
    expect(r.message).toContain('无可剪内容');
    expect(fs.readdirSync(box)).toEqual(['go_clean']);
  });

  it('非 Go 积木拒绝：剪刀只支持 Go', async () => {
    // TS fixture 入盒（无 .go 文件）
    const root = tmpDir('slim-ts-');
    put(root, 'src/a.ts', 'export function mainA(): string {\n  return "a";\n}\n');
    const box = tmpDir('slim-box-');
    await harvestFromUrl({ source: root, bricks: [{ name: 'ts_brick', seeds: ['src/a.ts'] }], box_dir: box });

    await expect(slimBrick({ brick_name: 'ts_brick', box_dir: box })).rejects.toThrow('非 Go 积木');
  });
});
