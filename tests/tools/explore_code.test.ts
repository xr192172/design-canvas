/**
 * explore_code 分发器测试（收敛 Step 3）
 *
 * 覆盖不依赖真实外部项目的分发器逻辑：
 * - 未知 action 报错
 * - 缺必填参数报错（消息含缺失 key）
 * - search 空 query 温和降级
 * - 各 action 参数透传正确（以 reset_simulation 幂等为例）
 * - 返回结构统一为 { message, data? }
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { exploreCode } from '../../src/tools/explore_code';
import { createFeature } from '../../src/tools/feature_ops';
import { clearAllFeatures } from '../../src/storage';

describe('explore_code - action 路由与参数校验', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('未知 action 报错', async () => {
    await expect(
      exploreCode({ action: 'bogus' as never, args: {} }),
    ).rejects.toThrow(/未知 explore_code action/);
  });

  it('action 为 search 时 query 为空温和返回"查询为空"，不抛错', async () => {
    const r = await exploreCode({ action: 'search', args: { query: '' } });
    expect(r.data).toBeDefined();
    expect((r.data as { message?: string }).message).toContain('查询为空');
  });

  it('action 为 reset_simulation 对无 simulation 的 feature 幂等成功', async () => {
    createFeature({ feature: 'ec_sim' });
    const r = await exploreCode({ action: 'reset_simulation', args: { feature: 'ec_sim' } });
    expect(r.data).toBeDefined();
    expect((r.data as { message?: string }).message).toContain('无需重置');
  });

  it('action 为 reset_simulation 时缺 feature 报错', async () => {
    await expect(
      exploreCode({ action: 'reset_simulation', args: {} }),
    ).rejects.toThrow(/"feature"/);
  });

  it('action 为 arch_layer 时缺 feature 报错', async () => {
    await expect(
      exploreCode({ action: 'arch_layer', args: {} }),
    ).rejects.toThrow(/"feature"/);
  });
});