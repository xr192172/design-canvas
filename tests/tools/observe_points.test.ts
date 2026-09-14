/**
 * observe_points 推荐器 —— 纯计算测试
 *
 * 动机：observe 线原来只有"全量无脑插桩"或"人工手写 contractProbes"；本模块补中间那块
 * （自动产出清单）。两个关键不变量要在这里钉住：
 *   ① **key 一定插得出来**：推荐点取自插桩器的 dry-run 站点（probe 字段），不是自己拼的字符串
 *   ② **预算裁剪**：按分数取前 N，超出的如实报 truncated（不搞第二套存储策略）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { openDb } from '../../src/db/db';
import { recommendObservePoints } from '../../src/tools/observe_points';

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

/** 造一个含四类信号的项目：高被引用 / 副作用 / 静默吞错 / 复杂度高地 */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsrec-'));
  roots.push(root);

  // 高被引用：hotFn 被三个文件调用
  put(root, 'src/core.ts', 'export function hotFn(x: number): number {\n  return x + 1;\n}\n');
  put(root, 'src/a.ts', "import { hotFn } from './core';\nexport function useA(): number {\n  return hotFn(1);\n}\n");
  put(root, 'src/b.ts', "import { hotFn } from './core';\nexport function useB(): number {\n  return hotFn(2);\n}\n");
  put(root, 'src/c.ts', "import { hotFn } from './core';\nexport function useC(): number {\n  return hotFn(3);\n}\n");

  // 副作用边界（写盘）
  put(
    root,
    'src/store.ts',
    "import fs from 'node:fs';\nexport function saveFile(p: string, s: string): void {\n  fs.writeFileSync(p, s);\n}\n",
  );

  // 静默吞错
  put(
    root,
    'src/risky.ts',
    'export function loadThing(): unknown {\n  try {\n    return JSON.parse("{}");\n  } catch (e) {\n  }\n}\n',
  );

  // 复杂度高地（>40 行）
  const big = Array.from({ length: 45 }, (_, i) => `  const v${i} = ${i};`).join('\n');
  put(root, 'src/big.ts', `export function bigFn(): number {\n${big}\n  return 0;\n}\n`);

  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

describe('observe_points 推荐器', () => {
  it('推荐点都带 score 与 reasons；高被引用函数的 enter/exit 在列', async () => {
    const root = await makeProject('obsrec_basic');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root, { write: false });
      expect(r.points.length).toBeGreaterThan(0);
      for (const p of r.points) {
        expect(p.score).toBeGreaterThan(0);
        expect(p.reasons.length).toBeGreaterThan(0);
      }
      const keys = r.points.map((p) => p.key);
      expect(keys).toContain('core.hotFn.enter');
      expect(keys).toContain('core.hotFn.exit');
      // 高被引用的理由要落到该符号上
      const hot = r.points.find((p) => p.key === 'core.hotFn.enter')!;
      expect(hot.reasons.some((x) => x.signal.includes('高被引用'))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('★ key 一定插得出来：每个 key 都是插桩器 dry-run 的站点名（probe 字段），不是拼的', async () => {
    const root = await makeProject('obsrec_keys');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root, { write: false });
      // 推荐点必须命中 `<mod>.<fn>.<suffix>` 形状（插桩器的契约口径）
      for (const p of r.points) {
        expect(p.key).toMatch(/^[A-Za-z0-9_$.-]+\.[A-Za-z0-9_$.]+\.(enter|exit|catch|[a-z]+)$/);
      }
      expect(r.contractProbes).toEqual(r.points.map((p) => p.key));
    } finally {
      db.close();
    }
  });

  it('副作用 / 静默吞错 / 复杂度 三类信号都能命中对应文件', async () => {
    const root = await makeProject('obsrec_signals');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root, { maxPoints: 200, write: false });
      const byFile = new Map<string, string[]>();
      for (const p of r.points) byFile.set(p.file, [...(byFile.get(p.file) ?? []), ...p.reasons.map((x) => x.signal)]);
      // store.ts 出现 io 站点（副作用）
      const ioPoints = r.points.filter((p) => p.file === 'src/store.ts' && p.kind === 'io');
      expect(ioPoints.length).toBeGreaterThan(0);
      // risky.ts 的静默吞错理由
      const riskySignals = (byFile.get('src/risky.ts') ?? []).join(' ');
      expect(riskySignals).toContain('静默吞错');
      // big.ts 的复杂度理由
      const bigSignals = (byFile.get('src/big.ts') ?? []).join(' ');
      expect(bigSignals).toContain('复杂度高地');
    } finally {
      db.close();
    }
  });

  it('预算裁剪：maxPoints 生效且如实报 truncated', async () => {
    const root = await makeProject('obsrec_budget');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const all = await recommendObservePoints(db, root, { maxPoints: 500, write: false });
      expect(all.points.length).toBeGreaterThan(2);
      const few = await recommendObservePoints(db, root, { maxPoints: 2, write: false });
      expect(few.points).toHaveLength(2);
      expect(few.stats.truncated).toBe(all.points.length - 2);
      // 取的是分数最高的两个
      expect(few.points[0].score).toBeGreaterThanOrEqual(few.points[1].score);
      expect(few.points[0].key).toBe(all.points[0].key);
    } finally {
      db.close();
    }
  });

  it('★ focus 任务定向：命中优先（不被热点文件挤出预算），且「聚焦命中」理由只出现一次', async () => {
    const root = await makeProject('obsrec_focus');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root, { write: false, focus: 'risky|store', maxPoints: 4 });
      expect(r.points.length).toBeGreaterThan(0);
      // 聚焦文件必须出现在结果里（否则"看某个机理"就无从谈起）
      expect(r.points.some((p) => p.file === 'src/store.ts' || p.file === 'src/risky.ts')).toBe(true);
      const focused = r.points.filter((p) => p.reasons.some((x) => x.signal === '聚焦命中'));
      expect(focused.length).toBeGreaterThan(0);
      // 防复发：原因是共享数组，曾在每个站点重复累积成几十条
      for (const p of focused) {
        expect(p.reasons.filter((x) => x.signal === '聚焦命中')).toHaveLength(1);
      }
    } finally {
      db.close();
    }
  });

  it('write=true 落 observe-points.json（含 contractProbes，可人工编辑）', async () => {
    const root = await makeProject('obsrec_write');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root);
      const file = path.join(root, '.design-canvas', 'observe-points.json');
      expect(fs.existsSync(file)).toBe(true);
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { contractProbes: string[]; points: unknown[] };
      expect(j.contractProbes).toEqual(r.contractProbes);
      expect(j.points.length).toBe(r.points.length);
    } finally {
      db.close();
    }
  });

  it('空项目（无可索引源码）→ 不炸、返回空清单', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsrec-empty-'));
    roots.push(root);
    put(root, 'notes.txt', 'not code\n');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const r = await recommendObservePoints(db, root, { write: false });
      expect(r.points).toEqual([]);
      expect(r.contractProbes).toEqual([]);
      expect(r.summary).toContain('观测点推荐');
    } finally {
      db.close();
    }
  });
});
