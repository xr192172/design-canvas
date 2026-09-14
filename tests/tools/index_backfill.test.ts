/**
 * index_backfill —— 后台续建 + 建块时长上限测试
 *
 * 用户意图：读（前台）只为"第一次读得到"；**没有其他任务时持续跑补件**（后台把整仓补齐）。
 * 两条硬纪律要钉住：
 *   ① 首次建块**有时长上限**，超时即停并如实标 partial(time)（读不到最伤使用感受）；
 *   ② 后台续建是**单飞**的、每批让出事件循环、进度如实可查（补齐前不许声称完整）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { openDb } from '../../src/db/db';
import { ensureIndexAround } from '../../src/tools/index_freshness';
import { backfillChunk, scheduleBackfill, stopBackfill, backfillState, backfillSummary } from '../../src/tools/index_backfill';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      stopBackfill(r);
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows 占用留给 OS */
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** N 个互相独立的小文件 + 一个 hub（被其它文件 import） */
function makeMany(n: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
  roots.push(root);
  put(root, 'src/hub.ts', 'export function hub(): number {\n  return 1;\n}\n');
  for (let i = 0; i < n; i++) {
    put(root, `src/m${i}.ts`, `import { hub } from './hub';\nexport function m${i}(): number {\n  return hub();\n}\n`);
  }
  return root;
}

async function waitDone(root: string, ms = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = backfillState(root);
    if (!s || !s.running) return;
    if (Date.now() - t0 > ms) throw new Error(`backfill 超时未完成：${JSON.stringify(s)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('index_backfill 后台续建', () => {
  it('backfillChunk：一批只做 batch 个，剩余量如实', async () => {
    const root = makeMany(12);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await backfillChunk(db, root, { batch: 3 });
      expect(r.total).toBe(13);
      expect(r.synced).toBeLessThanOrEqual(3);
      expect(r.remaining).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('★ 后台跑完能补齐全项目；单飞（重复调用同一实例）；进度可查', async () => {
    const root = makeMany(12);
    const s1 = scheduleBackfill(root, { batch: 2, intervalMs: 5 });
    const s2 = scheduleBackfill(root, { batch: 2, intervalMs: 5 });
    expect(s2).toBe(s1); // 单飞：返回同一个状态对象
    await waitDone(root);
    const st = backfillState(root);
    expect(st?.running).toBe(false);
    expect(st?.total).toBe(13);
    expect(st?.done).toBe(13);
    expect(st?.synced).toBeGreaterThanOrEqual(12);
    expect(backfillSummary(st)).toContain('已完成');
    // 索引里确实有 13 个文件
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    const n = (db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c;
    expect(n).toBe(13);
    db.close();
  });

  it('没有剩余时立刻收敛（不空转）', async () => {
    const root = makeMany(2);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      await backfillChunk(db, root, { batch: 99 });
    } finally {
      db.close();
    }
    const s = scheduleBackfill(root, { batch: 2, intervalMs: 5 });
    await waitDone(root);
    expect(backfillState(root)?.running).toBe(false);
    expect(s.synced).toBe(0); // 已全索引 ⇒ 没有新建
  });
});

describe('★ 首次建块有时长上限（读不到最伤使用感受）', () => {
  it('maxMs=1 → 立刻停并标 partial(time)', async () => {
    const root = makeMany(20);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await ensureIndexAround(db, root, ['src/hub.ts'], { depth: 2, maxFiles: 200, maxMs: 1 });
      expect(r.partial).toBe(true);
      expect(r.stopReason).toBe('time');
    } finally {
      db.close();
    }
  });
});
