// 一次性：隔离存储重跑自导入并重渲染 output/self_import.html（不触碰活态 design-canvas.json）
import fs from 'node:fs';
import path from 'node:path';

process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_regen');

const { importProject } = await import('../dist/src/tools/import_project.js');
const { renderHTML } = await import('../dist/src/renderer/html_renderer.js');
const { getDSL } = await import('../dist/src/storage.js');

const r = await importProject({ project_dir: '.', feature: 'self_import', title: 'design-canvas 自导入' });
console.log(r.message.split('\n').slice(0, 3).join('\n'));

const dsl = getDSL('self_import');
if (!dsl) throw new Error('DSL not found after import');
fs.writeFileSync('output/self_import.html', renderHTML(dsl), 'utf-8');
console.log('self_import.html written');

fs.rmSync('.tmp_regen', { recursive: true, force: true });
