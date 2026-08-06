/**
 * watch_project 文件监听自动同步测试
 *
 * 覆盖（纯逻辑，不依赖真实 fs.watch 异步时序）：
 *   - shouldSyncRel：忽略目录 / 非支持扩展名 / 测试生成物
 *   - handleWatchEvent：新增（changed）/ 修改（hash 变化重解析）/ 删除（cleanup）/ 忽略
 *   - flushBatch：批量去重 + 跨文件调用重解析收尾
 *   - 重复同步未变：syncFile 内部 skipped（node_count=0），不重复解析
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { openDb } from '../../src/db/db';
import { getIndexStats } from '../../src/db/symbols';
import { handleWatchEvent, flushBatch, shouldSyncRel, reconcileProject } from '../../src/tools/watch_project';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** 建一个含符号的项目并建缓存，返回 { root, db } */
async function makeProject(feature: string): Promise<{ root: string; db: ReturnType<typeof openDb> }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-'));
  roots.push(root);
  put(root, 'src/auth.ts', `export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'x';\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  return { root, db };
}

describe('shouldSyncRel 过滤', () => {
  it('忽略 .design-canvas / node_modules / 非源码目录', () => {
    expect(shouldSyncRel('.design-canvas/cache.db')).toBe(false);
    expect(shouldSyncRel('node_modules/x/index.js')).toBe(false);
    expect(shouldSyncRel('src/.git/HEAD')).toBe(false);
    expect(shouldSyncRel('dist/out.js')).toBe(false);
    expect(shouldSyncRel('src/auth.ts')).toBe(true);
  });

  it('忽略非支持扩展名 / 测试生成物', () => {
    expect(shouldSyncRel('src/readme.md')).toBe(false);
    expect(shouldSyncRel('src/style.css')).toBe(false);
    expect(shouldSyncRel('src/auth.test.ts')).toBe(false);
    expect(shouldSyncRel('src/auth.ts')).toBe(true);
    expect(shouldSyncRel('src/util.ts')).toBe(true);
  });

  it('忽略编辑器临时存取文件', () => {
    // 通用临时后缀
    expect(shouldSyncRel('src/auth.ts.tmp')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.temp')).toBe(false);
    // Chrome 缓存临时
    expect(shouldSyncRel('src/auth.ts.crswap')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.crdownload')).toBe(false);
    // vim 交换文件
    expect(shouldSyncRel('src/.auth.ts.swp')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.swo')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.swx')).toBe(false);
    // 备份 / 补丁
    expect(shouldSyncRel('src/auth.ts.bak')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.orig')).toBe(false);
    expect(shouldSyncRel('src/auth.ts.rej')).toBe(false);
    // 编辑器 ~ 锁文件（后缀 ~ 开头/结尾）
    expect(shouldSyncRel('src/~$auth.ts')).toBe(false);
    expect(shouldSyncRel('src/auth.ts~')).toBe(false);
    // 正常源码不受影响
    expect(shouldSyncRel('src/auth.ts')).toBe(true);
  });
});

describe('handleWatchEvent', () => {
  it('新增文件 → changed，缓存新增符号', async () => {
    const { root, db } = await makeProject('w1');
    put(root, 'src/render.ts', `export function renderHTML(dsl: unknown): string {\n  return '<svg>';\n}\n`);
    const before = getIndexStats(db).nodes;
    const res = await handleWatchEvent(db, root, path.join(root, 'src/render.ts'));
    expect(res.type).toBe('changed');
    expect(res.node_count).toBeGreaterThan(0);
    expect(getIndexStats(db).nodes).toBeGreaterThan(before);
    db.close();
  });

  it('修改文件 → 重解析，node_count 为符号数', async () => {
    const { root, db } = await makeProject('w2');
    put(root, 'src/auth.ts', `export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'x';\n}\nexport function logout(): void {\n  return;\n}\n`);
    const res = await handleWatchEvent(db, root, path.join(root, 'src/auth.ts'));
    expect(res.type).toBe('changed');
    expect(res.node_count).toBe(2); // login + logout
    db.close();
  });

  it('重复同步未变 → 仍 changed 但 node_count=0（syncFile 内部 skipped）', async () => {
    const { root, db } = await makeProject('w3');
    const res = await handleWatchEvent(db, root, path.join(root, 'src/auth.ts'));
    expect(res.type).toBe('changed');
    expect(res.node_count).toBe(0);
    db.close();
  });

  it('删除文件 → deleted，缓存行被清理', async () => {
    const { root, db } = await makeProject('w4');
    const before = getIndexStats(db).files;
    fs.unlinkSync(path.join(root, 'src/auth.ts'));
    const res = await handleWatchEvent(db, root, path.join(root, 'src/auth.ts'));
    expect(res.type).toBe('deleted');
    expect(getIndexStats(db).files).toBe(before - 1);
    db.close();
  });

  it('非支持扩展名 → ignored', async () => {
    const { root, db } = await makeProject('w5');
    put(root, 'src/notes.md', '# note');
    const res = await handleWatchEvent(db, root, path.join(root, 'src/notes.md'));
    expect(res.type).toBe('ignored');
    db.close();
  });
});

describe('flushBatch', () => {
  it('批量去重 + 跨文件调用重解析收尾', async () => {
    const { root, db } = await makeProject('w6');
    // 新增一个调用方 + 一个被调用方，触发跨文件调用解析
    put(root, 'src/service.ts', `export function handle(u: string): string {\n  return login(u, 'x');\n}\n`);
    put(root, 'src/auth.ts', `export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'x';\n}\n`);
    const summary = await flushBatch(db, root, ['src/service.ts', 'src/service.ts', '.design-canvas/cache.db', 'src/notes.md']);
    expect(summary.changed).toBe(1); // 重复的 service.ts 去重为 1
    expect(summary.ignored).toBeGreaterThan(0); // cache.db + notes.md
    expect(summary.files).toContain('src/service.ts');
    db.close();
  });
});

describe('reconcileProject 兜底', () => {
  it('目录整树删除 → 库中被清理（deleted>0）', async () => {
    const { root, db } = await makeProject('r1');
    // 新增第二个文件，确保目录树有多个文件
    put(root, 'src/util.ts', `export function helper(): string {\n  return 'x';\n}\n`);
    await flushBatch(db, root, ['src/util.ts']);
    const before = getIndexStats(db).files;
    // 整树删除 src/ 目录（fs.watch 可能只发一次事件或漏发，reconcile 必须兜底）
    fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
    const summary = await reconcileProject(db, root);
    expect(summary.deleted).toBeGreaterThan(0);
    expect(getIndexStats(db).files).toBe(before - summary.deleted);
    db.close();
  });

  it('事件丢失导致的增改 → reconcile 补齐', async () => {
    const { root, db } = await makeProject('r2');
    // 绕过 fs.watch：直接改文件 + 新增文件，然后 reconcile（模拟事件完全丢失）
    put(root, 'src/auth.ts', `export function login(u: string, p: string): boolean {\n  return true;\n}\nexport function logout(): void {\n  return;\n}\n`);
    put(root, 'src/render.ts', `export function renderHTML(): string {\n  return '<svg>';\n}\n`);
    const beforeNodes = getIndexStats(db).nodes;
    const summary = await reconcileProject(db, root);
    expect(summary.changed).toBeGreaterThan(0);
    expect(getIndexStats(db).nodes).toBeGreaterThan(beforeNodes);
    // 幂等：再次 reconcile 无变更
    const again = await reconcileProject(db, root);
    expect(again.changed).toBe(0);
    expect(again.deleted).toBe(0);
    db.close();
  });

  it('忽略目录不入扫描（scanned 不含缓存/依赖）', async () => {
    const { root, db } = await makeProject('r3');
    put(root, 'node_modules/pkg/index.js', `export const x = 1;\n`);
    put(root, '.design-canvas/live/none.dsl.json', '{}');
    const summary = await reconcileProject(db, root);
    // scanned 只含可同步源码（本项目仅 src/auth.ts）
    expect(summary.scanned).toBe(1);
    expect(summary.changed).toBe(0);
    db.close();
  });
});