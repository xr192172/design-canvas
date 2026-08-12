// 打通设计图来源：用 import_project（file 级，非 design_mode/functional_mode）
// 从 design-canvas 自身 src 代码自反推一张设计 DSL，落盘为设计 DSL（design-canvas.json）。
// 与 live 重建使用同一 project_dir（src）、同一 node id 锚点（file_<sanitize(rel)>），
// 使 /api/diff-views 的边级 diff 在浏览器端可展示。
// cache.db 显式放项目根 .design-canvas/（跨运行增量复用，不污染 src）。
import { importProject } from '../dist/src/tools/import_project.js';
import { openDb } from '../dist/src/db/db.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const feature = process.env.DC_DESIGN_FEATURE || 'dynamic_demo';

const cacheDb = openDb(path.resolve(projectRoot, '.design-canvas', 'cache.db'));
const res = await importProject({
  project_dir: 'src',
  feature,
  title: 'design-canvas 架构（src 代码自反推设计图）',
  cache_db: cacheDb,
  gen_roles: true,
});

console.log(res.message);
console.log('设计 DSL 已自反推 →', feature, '（project_dir=src）');