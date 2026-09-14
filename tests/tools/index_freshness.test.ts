/**
 * 索引自动保鲜测试：外部改动（git pull / 手动编辑 / 其他 agent）后，
 * 查询前懒校验增量重同步——search 永远基于最新代码。
 *
 * ★ 2026-09-14 语义变更（agent IO 层的「零前置」）：**空库改为就地冷启 bootstrap**。
 * 旧契约是「空库不 bootstrap，查询层抛可行动错误」——那正是"改个符号前要先 import_project"
 * 这一前置成本的代码级根因。现在空库 → 有界静默建索引（上限 / 诚实标注 state·truncated）。
 *
 * 覆盖：
 *   - 外部修改文件 → 新符号立即可查（exact 命中），message 带自刷新注记
 *   - 外部删除文件 → 其符号从索引消失
 *   - 外部新增文件 → 新文件符号可查
 *   - 无变更 → 零重同步，message 无注记（不惊扰）
 *   - ★ 空库 → 冷启建索引，semanticSearch 无需先 import_project 即命中
 *   - ★ 空库 + bootstrap:false → 恢复老语义（不建）
 *   - ★ 冷启上限截断 → state='partial' + truncated=true（诚实，不假装完整）
 *   - 目录下没有可索引文件 → 查询层仍抛可行动错误
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { semanticSearch } from '../../src/tools/semantic_search';
import { ensureFreshIndex, hasChanges } from '../../src/tools/index_freshness';
import { openDb } from '../../src/db/db';

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

/** 建项目 + 建索引（无 embedding 配置环境 → semanticSearch 走 exact/fts 层） */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-'));
  roots.push(root);
  put(root, 'src/auth.ts', `export function login(user: string): boolean {\n  return user === 'admin';\n}\n`);
  put(root, 'src/render.ts', `export function renderHTML(dsl: unknown): string {\n  return '<svg>';\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

describe('索引自动保鲜（ensureFreshIndex）', () => {
  it('外部修改文件 → semanticSearch 立即可见新符号 + message 带自刷新注记', async () => {
    const root = await makeProject('fresh_modify');
    // 先查一次基线：logout 不存在（exact miss → 无配置降级 fts → 无命中）
    const before = await semanticSearch({ project_dir: root, query: 'logout' });
    expect(before.hits.length).toBe(0);
    expect(before.message).not.toContain('索引自刷新');

    // 外部改动（模拟 git pull / 手动编辑 / 其他 agent）
    put(root, 'src/auth.ts', `export function login(user: string): boolean {\n  return user === 'admin';\n}\nexport function logout(reason: string): void {\n  console.log(reason);\n}\n`);

    // 不重新 import_project，直接查——保鲜应自动重同步并命中新符号
    const after = await semanticSearch({ project_dir: root, query: 'logout' });
    expect(after.provider).toBe('exact');
    expect(after.message).toContain('索引自刷新');
    expect(after.message).toContain('重同步 1');
    expect(after.hits.some((h) => h.name === 'logout' && h.file_path === 'src/auth.ts')).toBe(true);
  });

  it('外部删除文件 → 其符号从索引消失', async () => {
    const root = await makeProject('fresh_delete');
    const before = await semanticSearch({ project_dir: root, query: 'renderHTML' });
    expect(before.provider).toBe('exact'); // 删除前可命中

    fs.rmSync(path.join(root, 'src', 'render.ts'));

    const after = await semanticSearch({ project_dir: root, query: 'renderHTML' });
    expect(after.message).toContain('删除 1');
    // 符号已清：exact miss，fts 也无此串
    expect(after.hits.some((h) => h.file_path === 'src/render.ts')).toBe(false);
  });

  it('外部新增文件 → 新文件符号可查', async () => {
    const root = await makeProject('fresh_add');
    put(root, 'src/newmod.ts', `export function freshNewSymbol(x: number): number {\n  return x * 2;\n}\n`);

    const r = await semanticSearch({ project_dir: root, query: 'freshNewSymbol' });
    expect(r.provider).toBe('exact');
    expect(r.message).toContain('新增 1');
    expect(r.hits.some((h) => h.name === 'freshNewSymbol' && h.file_path === 'src/newmod.ts')).toBe(true);
  });

  it('无变更 → 零重同步（message 无自刷新注记，不惊扰）', async () => {
    const root = await makeProject('fresh_idle');
    const r = await semanticSearch({ project_dir: root, query: 'login' });
    expect(r.provider).toBe('exact');
    expect(r.message).not.toContain('索引自刷新');
  });

  it('直接调用：报告字段语义正确（resynced/added/removed 区分）', async () => {
    const root = await makeProject('fresh_report');
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      // 无变更
      const idle = await ensureFreshIndex(db, root);
      expect(hasChanges(idle)).toBe(false);
      expect(idle.checked).toBeGreaterThanOrEqual(2);

      // 变更 + 新增 + 删除 三合一
      put(root, 'src/auth.ts', `export function login2(user: string): boolean {\n  return true;\n}\n`);
      put(root, 'src/extra.ts', `export function extraFn(): void {}\n`);
      fs.rmSync(path.join(root, 'src', 'render.ts'));
      const rep = await ensureFreshIndex(db, root);
      expect(rep.resynced).toBe(1);
      expect(rep.added).toBe(1);
      expect(rep.removed).toBe(1);
      expect(rep.failed).toBe(0);

      // 幂等：再来一次全零
      const again = await ensureFreshIndex(db, root);
      expect(hasChanges(again)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('新增超出补全上限 → 整体跳过新增（守卫 max_files 契约），变更/删除照常', async () => {
    const root = await makeProject('fresh_guard');
    // 制造 >100 个"新文件"（当初索引被 max_files 截断的项目形态）
    for (let i = 0; i < 105; i++) {
      put(root, `src/gen/f${i}.ts`, `export function gen${i}(): number { return ${i}; }\n`);
    }
    // 同时有一个正常的外部变更 + 一个删除，验证这两类不受守卫影响
    put(root, 'src/auth.ts', `export function login(user: string): boolean {\n  return true;\n}\n`);
    fs.rmSync(path.join(root, 'src', 'render.ts'));

    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const rep = await ensureFreshIndex(db, root);
      expect(rep.skipped_adds).toBe(105);
      expect(rep.added).toBe(0); // 新增整体跳过，不补一半
      expect(rep.resynced).toBe(1); // 变更照常
      expect(rep.removed).toBe(1); // 删除照常
      // 跳过的新文件确实未入索引
      const n = db.prepare("SELECT COUNT(*) c FROM nodes WHERE file_path LIKE 'src/gen/%'").get() as { c: number };
      expect(n.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('★ 空库（从未 import）→ 冷启 bootstrap，semanticSearch 零前置命中', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-boot-'));
    roots.push(root);
    put(root, 'src/a.ts', `export function bootSymbol(): number { return 1; }\n`);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const rep = await ensureFreshIndex(db, root);
      expect(rep.state).toBe('ready');
      expect(rep.bootstrapped).toBeGreaterThan(0);
      expect(rep.truncated).toBe(false);
      expect(hasChanges(rep)).toBe(true); // 冷启也算"有变更"，调用方据此提示
    } finally {
      db.close();
    }
    // 关键：没有跑过 import_project，直接查也能命中
    const r = await semanticSearch({ project_dir: root, query: 'bootSymbol' });
    expect(r.provider).toBe('exact');
    expect(r.hits.some((h) => h.name === 'bootSymbol' && h.file_path === 'src/a.ts')).toBe(true);
  });

  it('空库 + bootstrap:false → 恢复老语义（只保鲜不冷启）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-noboot-'));
    roots.push(root);
    put(root, 'src/a.ts', `export function a(): void {}\n`);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const rep = await ensureFreshIndex(db, root, { bootstrap: false });
      expect(rep.bootstrapped).toBe(0);
      expect(rep.state).toBe('empty');
      expect(hasChanges(rep)).toBe(false);
      const n = db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number };
      expect(n.c).toBe(0); // 确实没建
    } finally {
      db.close();
    }
  });

  it('★ 冷启上限截断 → state=partial + truncated（诚实标注，不假装完整）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-trunc-'));
    roots.push(root);
    for (let i = 0; i < 5; i++) put(root, `src/m${i}.ts`, `export function m${i}(): void {}\n`);
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      const rep = await ensureFreshIndex(db, root, { maxFiles: 2 });
      expect(rep.state).toBe('partial');
      expect(rep.truncated).toBe(true);
      expect(rep.bootstrapped).toBe(2);
    } finally {
      db.close();
    }
  });

  it('目录里没有可索引源码 → 查询层仍抛可行动错误（冷启也建不出符号）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-nosrc-'));
    roots.push(root);
    put(root, 'notes.txt', 'not code\n');
    await expect(semanticSearch({ project_dir: root, query: 'a' })).rejects.toThrow(/索引为空/);
  });
});

describe('★ 引用方重解析（手工改名/删符号后，引用方的边不会自己重建）', () => {
  it('编辑器中把被引用符号改名 → 刷新时重开引用并重解析（不漏报、也不留悬空）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-dangle-'));
    roots.push(root);
    put(root, 'src/b.ts', 'export function foo(): number {\n  return 1;\n}\n');
    put(root, 'src/a.ts', "import { foo } from './b';\nexport function useA(): number {\n  return foo();\n}\n");
    const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
    try {
      await importProject({ project_dir: root, feature: 'fresh_dangle', cache_db: db });
      const dangling = (): number =>
        (db
          .prepare("SELECT COUNT(*) c FROM edges e WHERE e.kind='call' AND e.target NOT IN (SELECT id FROM nodes)")
          .get() as { c: number }).c;
      const callEdges = (): number =>
        (db.prepare("SELECT COUNT(*) c FROM edges WHERE kind='call'").get() as { c: number }).c;
      expect(dangling()).toBe(0);
      expect(callEdges()).toBeGreaterThanOrEqual(1); // A→B#foo 已连上

      // ★ 模拟"在编辑器里"把 b.ts 的 foo 改名成 bar（不走 rename_symbols 工具）
      put(root, 'src/b.ts', 'export function bar(): number {\n  return 1;\n}\n');
      const rep = await ensureFreshIndex(db, root);
      expect(rep.resynced).toBeGreaterThanOrEqual(1); // b 被重同步
      // ① 不会留悬空边（FK 级联已删；实测证伪了"会悬空"的早先判断）
      expect(dangling()).toBe(0);
      // ② 引用被重新打开并重解析：A 的 foo 现在无处可连 ⇒ 明确记为 failed（而不是静默消失）
      expect(rep.refsReopened).toBeGreaterThanOrEqual(1);
      const row = db
        .prepare("SELECT status FROM unresolved_refs WHERE from_node_id = 'src/a.ts#useA' AND reference_name = 'foo'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe('failed');
      // ③ 换回原名后应能重新连上（重开是幂等可重跑的）
      put(root, 'src/b.ts', 'export function foo(): number {\n  return 1;\n}\n');
      await ensureFreshIndex(db, root);
      expect(callEdges()).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
  });
});
