/**
 * watch_project 冒烟：真实 fs.watch 场景验证
 *
 * 流程：建临时项目 + import_project 建缓存 → watchProject 启动
 *   → ① 新增文件 ② 修改文件 ③ 删除文件，依次观察 onChange 回调输出
 * 验证：cache.db 实时增量（files/nodes 计数随增删变化），stop() 后停止。
 *
 * 运行：npm run build && node scripts/watch_project_smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importProject } from '../dist/src/tools/import_project.js';
import { openDb } from '../dist/src/db/db.js';
import { getIndexStats } from '../dist/src/db/symbols.js';
import { watchProject } from '../dist/src/tools/watch_project.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-smoke-'));
const src = path.join(root, 'src');
fs.mkdirSync(src, { recursive: true });
const put = (rel, content) => {
  const abs = path.join(src, rel);
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
};

put('auth.ts', `export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'x';\n}\n`);

const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
await importProject({ project_dir: root, feature: 'smoke', cache_db: db });

const stats = () => getIndexStats(db);
console.log('初始缓存: files=%d nodes=%d', stats().files, stats().nodes);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const handle = watchProject({
  project_root: root,
  db,
  debounce_ms: 100,
  onChange: (s) => {
    results.push(s);
    console.log('[onChange] changed=%d deleted=%d ignored=%d files=%s',
      s.changed, s.deleted, s.ignored, JSON.stringify(s.files));
    console.log('  缓存: files=%d nodes=%d', stats().files, stats().nodes);
  },
});

// ① 新增文件
put('render.ts', `export function renderHTML(dsl: unknown): string {\n  return '<svg>';\n}\n`);
console.log('\n→ 新增 src/render.ts');
await wait(500);

// ② 修改文件（新增一个符号）
put('auth.ts', `export function login(user: string, pass: string): boolean {\n  return user === 'admin' && pass === 'x';\n}\nexport function logout(): void {}\n`);
console.log('\n→ 修改 src/auth.ts（新增 logout）');
await wait(500);

// ③ 删除文件
fs.unlinkSync(path.join(src, 'render.ts'));
console.log('\n→ 删除 src/render.ts');
await wait(500);

handle.stop();
console.log('\nstop() 后 watching =', handle.status().watching);

const changed = results.some((s) => s.changed > 0);
const deleted = results.some((s) => s.deleted > 0);
const ok = changed && deleted;
console.log('\n[watcher smoke] ' + (ok ? '通过 ✓' : '失败 ✗') + '（新增/修改/删除均触发同步）');

db.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(ok ? 0 : 1);