/**
 * backfill 工具测试
 *
 * 覆盖场景：
 * - Go 文件解析（普通函数 + receiver 方法）
 * - TypeScript 文件解析（class 方法 + 顶层函数）
 * - Python 文件解析（class 方法 + 顶层函数，self 参数处理）
 * - 对比 expected / actual 差异报告
 * - feature 不存在时抛错
 * - 文件不存在时返回空 actual_apis
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { backfillScaffold } from '../../src/tools/backfill';
import { renderDsl } from '../../src/tools/render_dsl';
import { clearAllFeatures, getDSL } from '../../src/storage';
import type { DesignDSL } from '../../src/dsl/types';

function makeDSL(feature: string): DesignDSL {
  return {
    id: `id_${feature}`,
    type: 'feature_diagram',
    feature,
    geometry: {
      layout: 'free',
      width: 200,
      height: 100,
      nodes: [
        { id: 'n1', x: 0, y: 0, width: 100, height: 50, label: '服务层' },
        { id: 'n2', x: 0, y: 0, width: 100, height: 50, label: '数据层' },
        { id: 'n3', x: 0, y: 0, width: 100, height: 50, label: '模型层' },
      ],
    },
    semantic: {
      files: [
        {
          id: 'n1',
          path: 'service.go',
          responsibility: '服务层',
          expected_apis: [
            { signature: 'UserService.Login(username string, pwd string) (string, error)', notes: '登录' },
            { signature: 'HealthCheck() error', notes: '健康检查' },
          ],
        },
        {
          id: 'n2',
          path: 'store.ts',
          responsibility: '数据层',
          expected_apis: [
            { signature: 'Store.findUser(id: string): User | null', notes: '查找用户' },
            { signature: 'createStore(): Store', notes: '创建 store' },
          ],
        },
        {
          id: 'n3',
          path: 'models.py',
          responsibility: '模型层',
          expected_apis: [
            { signature: 'User.validate()', notes: '验证' },
          ],
        },
      ],
    },
  };
}

describe('backfillScaffold', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearAllFeatures();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-canvas-backfill-'));
  });

  afterEach(() => {
    clearAllFeatures();
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('feature 不存在时抛错', async () => {
    await expect(backfillScaffold({ feature: 'not_exist' })).rejects.toThrow(/feature .* 不存在/);
  });

  it('Go 文件解析与差异报告', async () => {
    const dsl = makeDSL('backfill_go');
    renderDsl({ dsl_json: JSON.stringify(dsl) });

    // 写入实现的 Go 文件（只实现了 Login，没实现 HealthCheck，新增了一个 Logout）
    const goCode = `package service

// UserService 服务
type UserService struct{}

func (u *UserService) Login(username string, pwd string) (string, error) {
	return "token", nil
}

func (u UserService) Logout() error {
	return nil
}
`;
    fs.mkdirSync(path.join(tmpDir, 'service'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'service.go'), goCode);

    const result = await backfillScaffold({ feature: 'backfill_go', scaffold_dir: tmpDir });

    expect(result.updates).toHaveLength(3);
    const u1 = result.updates.find((u) => u.id === 'n1')!;
    expect(u1.actual_count).toBe(2); // Login + Logout
    expect(u1.expected_count).toBe(2);
    expect(u1.matched).toContain('Login');
    expect(u1.missing).toContain('HealthCheck');
    expect(u1.extra).toContain('Logout');

    // DSL 已更新
    const saved = getDSL('backfill_go')!;
    expect(saved.semantic!.files[0].actual_apis).toHaveLength(2);
    expect(saved.semantic!.files[0].actual_apis![0].signature).toContain('UserService.Login');
  });

  it('TypeScript 文件解析（class 方法 + 顶层函数）', async () => {
    const dsl = makeDSL('backfill_ts');
    renderDsl({ dsl_json: JSON.stringify(dsl) });

    const tsCode = `export class Store {
  findUser(id: string): User | null {
    return null;
  }
}

export function createStore(): Store {
  return new Store();
}
`;
    fs.writeFileSync(path.join(tmpDir, 'store.ts'), tsCode);

    const result = await backfillScaffold({ feature: 'backfill_ts', scaffold_dir: tmpDir });

    const u2 = result.updates.find((u) => u.id === 'n2')!;
    expect(u2.actual_count).toBe(2);
    expect(u2.matched).toContain('findUser');
    expect(u2.matched).toContain('createStore');
    expect(u2.missing).toHaveLength(0);
    expect(u2.extra).toHaveLength(0);

    const saved = getDSL('backfill_ts')!;
    const actual = saved.semantic!.files[1].actual_apis!;
    expect(actual[0].signature).toContain('Store.findUser');
    expect(actual[1].signature).toContain('createStore');
  });

  it('Python 文件解析（self 参数处理 + class 方法）', async () => {
    const dsl = makeDSL('backfill_py');
    // 修改 expected，加入 class 方法
    dsl.semantic!.files[2].expected_apis = [
      { signature: 'User.validate()', notes: '验证' },
      { signature: 'build_user()', notes: '工厂函数' },
    ];
    renderDsl({ dsl_json: JSON.stringify(dsl) });

    const pyCode = `class User:
    def validate(self):
        return True

def build_user():
    return User()
`;
    fs.writeFileSync(path.join(tmpDir, 'models.py'), pyCode);

    const result = await backfillScaffold({ feature: 'backfill_py', scaffold_dir: tmpDir });

    const u3 = result.updates.find((u) => u.id === 'n3')!;
    expect(u3.actual_count).toBe(2);
    expect(u3.matched).toContain('validate');
    expect(u3.matched).toContain('build_user');

    const saved = getDSL('backfill_py')!;
    const actual = saved.semantic!.files[2].actual_apis!;
    // self 参数应被移除
    expect(actual[0].signature).toBe('User.validate()');
    expect(actual[1].signature).toBe('build_user()');
  });

  it('文件不存在时 actual_apis 为空', async () => {
    const dsl = makeDSL('backfill_missing');
    renderDsl({ dsl_json: JSON.stringify(dsl) });

    const result = await backfillScaffold({ feature: 'backfill_missing', scaffold_dir: tmpDir });

    const u1 = result.updates.find((u) => u.id === 'n1')!;
    expect(u1.actual_count).toBe(0);
    expect(u1.missing).toEqual(['Login', 'HealthCheck']);

    const saved = getDSL('backfill_missing')!;
    expect(saved.semantic!.files[0].actual_apis).toEqual([]);
  });

  it('backfill 只回填 actual_apis，不覆盖设计侧 expected_apis（预期只由设计产生）', async () => {
    const dsl = makeDSL('backfill_contract');
    renderDsl({ dsl_json: JSON.stringify(dsl) });
    const expectedBefore = JSON.stringify(dsl.semantic!.files.map((f) => f.expected_apis));

    // 实现代码与 expected 完全不一致（预期全部缺失 + 全新实现）
    fs.writeFileSync(
      path.join(tmpDir, 'service.go'),
      'package service\n\nfunc SomethingElse() error { return nil }\n',
    );

    const result = await backfillScaffold({ feature: 'backfill_contract', scaffold_dir: tmpDir });

    const saved = getDSL('backfill_contract')!;
    // expected_apis 保持设计侧原样（不被 backfill 覆盖）
    expect(JSON.stringify(saved.semantic!.files.map((f) => f.expected_apis))).toBe(expectedBefore);
    // actual_apis 反映实现事实
    expect(saved.semantic!.files[0].actual_apis!.some((a) => a.signature.includes('SomethingElse'))).toBe(true);
    // 报告区分「预期缺失」（red）vs「实现新增」（blue）
    expect(result.updates[0].missing).toEqual(['Login', 'HealthCheck']);
    expect(result.updates[0].extra).toContain('SomethingElse');
  });
});
