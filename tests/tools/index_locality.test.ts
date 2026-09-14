/**
 * ensureIndexAround（拼图式局部索引 S1）—— 纯逻辑测试
 *
 * 语义要点（都在这里钉住）：
 *   ① 种子周围建成"块"，**不触发全量冷启**（大仓首调 12s → 期望 <2s）
 *   ② 已在 files 表里的文件是**缝合点**：不重新解析（第二次调用应"只缝合、零新建"）
 *   ③ 预算/深度停下时 `partial=true` 且 `stopReason` 如实（调用方必须标注覆盖度）
 *   ④ 入边方向也算一块（互相引用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { openDb } from '../../src/db/db';
import { ensureIndexAround } from '../../src/tools/index_freshness';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
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

/** a → b → c → d 链 + 一个反向 importer e → b */
function makeChain(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-'));
  roots.push(root);
  put(root, 'src/a.ts', "import { b } from './b';\nexport function a(): number {\n  return b();\n}\n");
  put(root, 'src/b.ts', "import { c } from './c';\nexport function b(): number {\n  return c();\n}\n");
  put(root, 'src/c.ts', "import { d } from './d';\nexport function c(): number {\n  return d();\n}\n");
  put(root, 'src/d.ts', 'export function d(): number {\n  return 4;\n}\n');
  put(root, 'src/e.ts', "import { b } from './b';\nexport function e(): number {\n  return b();\n}\n");
  return root;
}

const countFiles = (db: ReturnType<typeof openDb>): number =>
  (db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number }).c;

describe('ensureIndexAround 拼图式局部索引', () => {
  it('出边方向建块；(出边可自发现，入边只在"对方已索引"时可知 —— S1 的如实边界)', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      // ① 先把 a.ts / e.ts 造成"已建好的拼图"
      await ensureIndexAround(db, root, ['src/a.ts', 'src/e.ts'], { depth: 0, maxFiles: 10 });
      const before = new Set((db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((x) => x.path));
      expect(before.has('src/a.ts')).toBe(true);
      expect(before.has('src/e.ts')).toBe(true);

      // ② 从 b 扩展：出边能自发现（b→c），入边只有"已索引的引用方"可见（a/e 已索引 ⇒ 可见）
      const r = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 3, maxFiles: 100 });
      const idx = new Set((db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((x) => x.path));
      expect(idx.has('src/b.ts')).toBe(true);
      expect(idx.has('src/c.ts')).toBe(true); // 出边：从 b 自己的 import 边就能发现
      expect(idx.has('src/a.ts')).toBe(true); // 入边：a 已索引 ⇒ 它的 import 边存在
      expect(idx.has('src/e.ts')).toBe(true); // 入边：e 已索引
      expect(r.newFiles).toBeGreaterThanOrEqual(2); // b + c
      expect(r.stitched).toBeGreaterThan(0); // a/e 是缝合点（不重新解析）
    } finally {
      db.close();
    }
  });

  it('★ 文本反查补入边：**未索引的引用方也能被发现**（S1 的边界已被粗层补上）', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      // 只从 b 进：a/e 还没被索引（图里没有它们的边）——靠文本反查发现
      const r = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 3, maxFiles: 100 });
      const idx = new Set((db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((x) => x.path));
      expect(idx.has('src/c.ts')).toBe(true); // 出边：自发现
      expect(idx.has('src/a.ts')).toBe(true); // 入边：文本反查（a import ./b）
      expect(idx.has('src/e.ts')).toBe(true); // 入边：文本反查
      expect(r.textCandidates).toBeGreaterThanOrEqual(2);
      expect(r.textScanned).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('关掉 textScan → 回到"只靠图"的 S1 行为（未索引引用方看不见），如实标注', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 3, maxFiles: 100, textScan: false });
      const idx = new Set((db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map((x) => x.path));
      expect(idx.has('src/c.ts')).toBe(true);
      expect(idx.has('src/a.ts')).toBe(false); // 图里没有 ⇒ 看不见（这就是必须补粗层的原因）
      expect(r.textScanned).toBe(0);
      expect(r.textCandidates).toBe(0);
    } finally {
      db.close();
    }
  });

  it('★ 深度不够时如实报 partial=depth（覆盖不完整不许装完整）', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 1, maxFiles: 100 });
      expect(r.partial).toBe(true);
      expect(r.stopReason).toBe('depth');
    } finally {
      db.close();
    }
  });

  it('★ 第二次调用只缝合、零新建（已在索引里的文件不重新解析）', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const first = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 2 });
      expect(first.newFiles).toBeGreaterThan(0);
      const before = countFiles(db);
      const second = await ensureIndexAround(db, root, ['src/b.ts'], { depth: 2 });
      expect(second.newFiles).toBe(0);
      expect(second.stitched).toBeGreaterThan(0);
      expect(countFiles(db)).toBe(before);
    } finally {
      db.close();
    }
  });

  it('预算封顶 → partial=true 且 stopReason=budget（覆盖度必须如实上报）', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await ensureIndexAround(db, root, ['src/a.ts'], { depth: 3, maxFiles: 1 });
      expect(r.partial).toBe(true);
      expect(r.stopReason).toBe('budget');
      expect(r.newFiles).toBe(1);
    } finally {
      db.close();
    }
  });

  it('无种子 → no-seed；种子在项目外 → 忽略（不越界）', async () => {
    const root = makeChain();
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const none = await ensureIndexAround(db, root, []);
      expect(none.stopReason).toBe('no-seed');
      expect(none.newFiles).toBe(0);
      const outside = await ensureIndexAround(db, root, ['../outside.ts']);
      expect(outside.stopReason).toBe('no-seed');
    } finally {
      db.close();
    }
  });
});
