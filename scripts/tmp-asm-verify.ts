/**
 * Phase 5 验证闭环：import_project 解析拼装区（新项目 → 新图谱），
 * 证明"拼装区是正规项目"——管线最后一环（新项目可再入盒滚雪球的前置）。
 */
import { importProject } from '../src/tools/import_project.js';
import { openDb } from '../src/db/db.js';

const root = 'D:/project_develop/assembly-001-brick-demo';
const db = openDb(`${root}/.design-canvas/cache.db`);
const r = await importProject({ project_dir: root, cache_db: db });
db.close();
console.log(`解析完成：${r.files_indexed} 文件入图`);
console.log(
  `社区：${(r.communities ?? []).length} 个；` +
    `DSL 文件节点：${(r.files ?? r.semantic_files ?? []).length}`,
);
console.log(r.message ?? '');
