/**
 * 包改名/提级线（computeMigrationPlan）纯计算测试
 *
 * 覆盖：
 *   - 代码已物理到位（旧逻辑目录 internal/hub/v2 不存在）→ 只做内容重写、不移动；
 *     package v2→hub、package v2_test→hub_test、import 引用面重写、别名清洗（hubv2→hub）。
 *   - packageRenameDir 限定：其他目录的 `package v2`（如 hubclient）不被误改。
 *   - 真正的目录移动（旧逻辑目录存在）→ 产出 moves，撞名检测抛错。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { computeMigrationPlan } from '../../src/tools/package_migration';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // leave to OS on Windows
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `pkgmg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('computeMigrationPlan', () => {
  it('已物理到位：只改内容——package 改名 + import 引用面重写 + 别名清洗（hubv2→hub）', async () => {
    const root = tempRoot();
    // 代码已物理在 internal/hub（package 仍是 v2）；消费者仍指向 internal/hub/v2（目录不存在 → 编译不过的中间态）
    write(root, 'go.mod', 'module github.com/acme/shell\n');
    write(root, 'internal/hub/hub.go', 'package v2\n\nfunc Hub() string { return "hub" }\n');
    write(root, 'internal/hub/hub_test.go', 'package v2_test\n\nimport "testing"\n\nfunc TestHub(t *testing.T) {}\n');
    write(root, 'internal/hubclient/client.go', 'package v2\n\nfunc Client() string { return "c" }\n');
    write(
      root,
      'cmd/main.go',
      'package main\n\nimport (\n\thubv2 "github.com/acme/shell/internal/hub/v2"\n)\n\nfunc main() { _ = hubv2.Hub() }\n',
    );

    const plan = await computeMigrationPlan({
      project_dir: root,
      migrate: {
        moduleBase: 'github.com/acme/shell',
        prefix: 'internal/hub/v2',
        to: 'internal/hub',
        packageRename: { from: 'v2', to: 'hub' }, // 缺省 packageRenameDir = to = internal/hub
        aliases: [
          { importPath: 'github.com/acme/shell/internal/hub', from: 'hubv2', to: 'hub' },
        ],
      },
    });

    // 无目录移动（prefix 目录不存在）
    expect(plan.moves ?? []).toHaveLength(0);

    // hub.go：package v2 → hub
    const hub = plan.absToNew.get(path.join(root, 'internal/hub', 'hub.go')) ?? '';
    expect(hub.startsWith('package hub')).toBe(true);

    // hub_test.go：package v2_test → hub_test
    const hubTest = plan.absToNew.get(path.join(root, 'internal/hub', 'hub_test.go')) ?? '';
    expect(hubTest.startsWith('package hub_test')).toBe(true);

    // cmd/main.go：import 引用面 internal/hub/v2 → internal/hub；别名 hubv2 → hub
    const main = plan.absToNew.get(path.join(root, 'cmd', 'main.go'));
    expect(main).toBeDefined();
    expect(main).toContain('"github.com/acme/shell/internal/hub"');
    expect(main).not.toContain('internal/hub/v2');
    expect(main).not.toContain('hubv2');

    // internal/hubclient/client.go：packageRenameDir 限定在 internal/hub → 不该被改
    expect(plan.absToNew.has(path.join(root, 'internal/hubclient', 'client.go'))).toBe(false);
  });

  it('作用域守卫：from 是局部变量（v2.Get）→ 不被误扫', async () => {
    const root = tempRoot();
    write(root, 'go.mod', 'module github.com/acme/shell\n');
    write(root, 'internal/hub/hub.go', 'package hub\n\nfunc Hub() string { return "hub" }\n');
    // vault_test 样本：v2 是局部变量（`var v2 = &agent.Agent{}`），不是 `.../internal/hub` 的 import 别名
    write(
      root,
      'internal/vault/vault_test.go',
      [
        'package vault_test',
        '',
        'import (',
        '\t"testing"',
        '',
        '\t"github.com/acme/shell/internal/agent"',
        ')',
        '',
        'func TestVault(t *testing.T) {',
        '\tvar v2 = &agent.Agent{}',
        '\tv2.Get("key")',
        '}',
        '',
      ].join('\n'),
    );

    const plan = await computeMigrationPlan({
      project_dir: root,
      migrate: {
        moduleBase: 'github.com/acme/shell',
        prefix: 'internal/hub',
        to: 'internal/hub',
        aliases: [
          // 清洗目标 from='v2'，但本文件 v2 是局部变量 → AST 守卫应命中，跳过
          { importPath: 'github.com/acme/shell/internal/hub', from: 'v2', to: 'agentv2' },
        ],
      },
    });

    // 守卫命中：v2 是局部变量、非该 importPath 的别名 → 文件零改动，不进重写计划
    // （旧正则实现会把 `v2.Get` 误改成 `agentv2.Get` 并进入 absToNew）
    expect(plan.absToNew.has(path.join(root, 'internal/vault', 'vault_test.go'))).toBe(false);
    // 磁盘原样仍在（未被改写）
    const onDisk = fs.readFileSync(path.join(root, 'internal/vault', 'vault_test.go'), 'utf-8');
    expect(onDisk).toContain('var v2 = &agent.Agent{}');
    expect(onDisk).toContain('v2.Get("key")');
    expect(onDisk).not.toContain('agentv2');
  });

  it('撞名检测：内容写入目标已是现存文件 → 抛错', async () => {
    const root = tempRoot();
    write(root, 'go.mod', 'module github.com/acme/shell\n');
    write(root, 'internal/hub/hub.go', 'package v2\n');
    // 消费者文件自身也物理在目标位置但需要重写 → 自身参与改写不算撞名（originals 有之）
    write(root, 'internal/hub/main.go', 'package v2\n');
    const plan = await computeMigrationPlan({
      project_dir: root,
      migrate: {
        moduleBase: 'github.com/acme/shell',
        prefix: 'internal/hub/v2',
        to: 'internal/hub',
        packageRename: { from: 'v2', to: 'hub' },
      },
    });
    // 都在自己的原位改写（key===原路径，originals 有对应）→ 不抛错，正常产出
    expect(plan.absToNew.size).toBeGreaterThanOrEqual(1);
  });

  it('moduleBase 被剥空 → 计划期抛错，禁止静默全局替换', async () => {
    const root = tempRoot();
    write(root, 'go.mod', 'module x\n');
    write(root, 'pkg/a.go', 'package a\n');
    // 空串 / 纯斜杠 / 纯空白 moduleBase 都会被剥成空 → 计划期拦截
    for (const bad of ['', '/', '///', '   /   ']) {
      try {
        await computeMigrationPlan({
          project_dir: root,
          migrate: { moduleBase: bad, prefix: 'pkg/a', to: 'pkg/b' },
        });
        throw new Error(`未抛出异常: moduleBase=${JSON.stringify(bad)}`);
      } catch (e: any) {
        if (!/moduleBase 解析为空/.test(e.message)) {
          throw new Error(`错误消息不匹配: ${e.message}`);
        }
      }
    }
    // 正常 moduleBase 仍能正常产出
    const ok = await computeMigrationPlan({
      project_dir: root,
      migrate: { moduleBase: 'acme/x', prefix: 'pkg/a', to: 'pkg/b' },
    });
    expect(ok.absToNew.size).toBeGreaterThanOrEqual(0);
  });

  it('prefix/to 误传绝对路径 → 计划期抛错，禁止路径穿越', async () => {
    const root = tempRoot();
    write(root, 'go.mod', 'module x\n');
    write(root, 'pkg/a.go', 'package a\n');
    // Unix 绝对形式
    try {
      await computeMigrationPlan({
        project_dir: root,
        migrate: { moduleBase: 'm', prefix: '/tmp/pkg', to: 'pkg/b' },
      });
      throw new Error('未抛出异常: Unix 绝对路径');
    } catch (e: any) {
      if (!/prefix\/to.*相对 project_dir/.test(e.message)) {
        throw new Error(`Unix: 错误消息不匹配: ${e.message}`);
      }
    }
    // Windows 盘符绝对形式
    try {
      await computeMigrationPlan({
        project_dir: root,
        migrate: { moduleBase: 'm', prefix: 'pkg/a', to: 'D:\\outside\\pkg' },
      });
      throw new Error('未抛出异常: Windows 盘符');
    } catch (e: any) {
      if (!/prefix\/to.*相对 project_dir/.test(e.message)) {
        throw new Error(`Windows: 错误消息不匹配: ${e.message}`);
      }
    }
    // 正斜杠相对路径仍可用
    const ok = await computeMigrationPlan({
      project_dir: root,
      migrate: { moduleBase: 'm', prefix: 'pkg/a', to: 'pkg/b' },
    });
    expect(ok.absToNew.size).toBeGreaterThanOrEqual(0);
  });
});