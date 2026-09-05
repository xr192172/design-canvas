import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveDSL } from '../../src/storage';
import { saveAutoSnapshot, pruneSnapshots, listSnapshots } from '../../src/tools/snapshot';
import type { DesignDSL } from '../../src/dsl/types';

let tmp: string;
const FEATURE = 'sna_auto';

function dsl(by: Record<string, [number, number]>): DesignDSL {
  return {
    feature: FEATURE,
    status: 'draft',
    geometry: {
      width: 100, height: 100,
      nodes: Object.entries(by).map(([id, [x, y]]) => ({ id, x, y, width: 40, height: 40 }) as never),
      edges: [],
    },
    semantic: { files: [], unresolved_refs: [] },
  } as unknown as DesignDSL;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sna-auto-'));
  process.env.DESIGN_CANVAS_HOME = tmp;
  saveDSL(dsl({ a: [0, 0], b: [10, 20] }));
});

afterAll(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('saveAutoSnapshot / pruneSnapshots', () => {
  it('坐标变化时纳管带坐标版本，坐标未变则去重跳过', () => {
    const first = saveAutoSnapshot(FEATURE, '测试');
    expect(first).not.toBeNull();
    // 坐标未变 → 去重跳过
    expect(saveAutoSnapshot(FEATURE, '测试')).toBeNull();
    // 改变坐标后 → 新纳管
    saveDSL(dsl({ a: [0, 0], b: [99, 99] }));
    expect(saveAutoSnapshot(FEATURE, '测试')).not.toBeNull();
    expect(listSnapshots({ feature: FEATURE }).snapshots.length).toBe(2);
  });

  it('pruneSnapshots 超出 max 时裁剪最旧', async () => {
    // 再造 N 个不同坐标版本
    for (let i = 0; i < 6; i += 1) {
      saveDSL(dsl({ a: [0, 0], b: [i, i], c: [i * 2, 0] }));
      saveAutoSnapshot(FEATURE, '批量');
    }
    const before = listSnapshots({ feature: FEATURE }).snapshots.length;
    const removed = pruneSnapshots(FEATURE, 5);
    expect(removed).toBe(before - 5);
  });
});