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
import { saveDSL, getDSL, clearAllFeatures, getLiveDslFile } from '../src/storage';
import type { DesignDSL } from '../src/dsl/types';

function mkDsl(rev?: number): DesignDSL {
  return {
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