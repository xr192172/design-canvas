/**
 * DSL 乐观锁原语测试（方向 F：浏览器 /api/save 与 daemon 直写共享的同一并发护栏）
 *
 * 覆盖：
 *   - saveDSL 不带 base_dsl_rev：保留旧直写语义，自增 rev 落盘
 *   - saveDSL 带匹配 base_dsl_rev：成功，rev = base + 1
 *   - saveDSL 带陈旧 base_dsl_rev：抛出冲突错误（409 语义来源），不覆盖磁盘
 *   - 冲突后磁盘 rev 不变，最新直写可覆盖（rebase 路径）
 */
import fs from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveDSL, getDSL, clearAllFeatures, getLiveDslFile, listFeatures, deleteFeature } from '../src/storage';
import { saveOverlay } from '../src/storage_overlay';
import type { DesignDSL } from '../src/dsl/types';

function mkDsl(rev?: number): DesignDSL {
  return {
    id: 'opt_lock',
    feature: 'opt_lock',
    version: '1.0',
    title: '乐观锁',
    geometry: { nodes: [], edges: [] },
    semantic: { files: [] },
    ...(rev !== undefined ? { _dsl_rev: rev } : {}),
  } as DesignDSL;
}

describe('DSL 乐观锁（saveDSL base_dsl_rev）', () => {
  beforeEach(() => {
    clearAllFeatures();
    const live = getLiveDslFile();
    if (fs.existsSync(live)) fs.unlinkSync(live);
  });
  afterEach(() => {
    clearAllFeatures();
    const live = getLiveDslFile();
    if (fs.existsSync(live)) fs.unlinkSync(live);
  });

  it('不带 base_dsl_rev：保留旧直写语义，rev 从 0 起自增', () => {
    saveDSL(mkDsl());
    expect(getDSL('opt_lock')!._dsl_rev).toBe(1);
  });

  it('携带匹配 base_dsl_rev：成功写入，rev 恰好 +1', () => {
    saveDSL(mkDsl()); // rev → 1
    saveDSL(mkDsl(1), 'browser', 1); // base 1 == 磁盘 1 → ok, rev → 2
    expect(getDSL('opt_lock')!._dsl_rev).toBe(2);
  });

  it('携带陈旧 base_dsl_rev：抛冲突错误且不覆盖磁盘（最后写者胜拒绝）', () => {
    saveDSL(mkDsl()); // rev → 1（模拟他人/MCP 先写）
    const stale = mkDsl(0); // 本地基于旧 rev 0
    expect(() => saveDSL(stale, 'browser', 0)).toThrow(/已被他人更新/);
    // 磁盘保持他人最新 rev，未被旧改动覆盖
    expect(getDSL('opt_lock')!._dsl_rev).toBe(1);
  });

  it('冲突后可重新拉取最新再写：基于最新 rev 重试成功（rebase 闭环）', () => {
    saveDSL(mkDsl()); // rev → 1
    // 模拟一次被拒的陈旧提交
    expect(() => saveDSL(mkDsl(0), 'browser', 0)).toThrow();
    // rebase：拉取当前 rev=1 为基础重做
    const latest = getDSL('opt_lock')!;
    saveDSL({ ...mkDsl(), title: 'rebase 后' }, 'browser', latest._dsl_rev);
    expect(getDSL('opt_lock')!.title).toBe('rebase 后');
    expect(getDSL('opt_lock')!._dsl_rev).toBe(2);
  });
});

describe('listFeatures 忽略 overlay 覆盖文件（Bug 2 回归）', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('overlay 文件不被当作 feature 列出（无幽灵 draft 条目）', () => {
    saveDSL(mkDsl()); // feature: opt_lock
    // 模拟 import 后 mergeDesignLayer 无条件落盘的空锚点 overlay
    saveOverlay({ version: 1, feature: 'opt_lock', anchors: {} });
    const features = listFeatures();
    expect(features.length).toBe(1);
    expect(features[0].feature).toBe('opt_lock');
    expect(features[0].id).toBeDefined();
  });

  it('deleteFeature 连带删除 overlay 文件', () => {
    saveDSL(mkDsl());
    saveOverlay({ version: 1, feature: 'opt_lock', anchors: {} });
    deleteFeature('opt_lock');
    expect(listFeatures()).toEqual([]);
  });
});