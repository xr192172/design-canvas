/**
 * manage_feature 生命周期分发器测试（收敛 Step 4）
 *
 * 覆盖：
 * - create / clone / list / delete 全流程
 * - delete 联动清理设计存档 + live 快照 + 活态视图
 * - 缺必填参数报错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { manageFeature } from '../../src/tools/manage_feature';
import { createFeature } from '../../src/tools/feature_ops';
import { clearAllFeatures, getDSL, saveLiveFeature, getLiveFeature } from '../../src/storage';

describe('manage_feature', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('create + list + delete 全流程，delete 联动清理活态/live', () => {
    createFeature({ feature: 'mf_a', title: 'A' });
    const design = getDSL('mf_a')!;
    saveLiveFeature({ ...design, title: 'live A' });

    // list 能看到
    const list = manageFeature({ action: 'list', args: {} });
    expect(list.message).toContain('mf_a');

    // delete
    const r = manageFeature({ action: 'delete', args: { feature: 'mf_a' } });
    expect(r.message).toContain('已删除 feature');

    // 存档、live 快照、活态视图全部清理
    expect(getDSL('mf_a')).toBeNull();
    expect(getLiveFeature('mf_a')).toBeNull();
    const listAfter = manageFeature({ action: 'list', args: {} });
    expect(listAfter.message).not.toContain('mf_a');
  });

  it('delete 缺 feature 报错', () => {
    expect(() => manageFeature({ action: 'delete', args: {} })).toThrow(/"feature"/);
  });

  it('args 为空（undefined）时不抛 TypeError，改抛缺参错误', () => {
    // bug #5：delete/其他 action 在 args 未传（undefined）时，args[k] 直接解构会抛 TypeError
    expect(() => manageFeature({ action: 'delete' } as never)).toThrow(/"feature"/);
    expect(() => manageFeature({ action: 'create' } as never)).toThrow(/"feature"/);
  });

  it('未知 action 报错', () => {
    expect(() => manageFeature({ action: 'bogus' as never, args: {} })).toThrow(/未知 manage_feature action/);
  });
});