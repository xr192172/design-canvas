// 临时产物生成脚本：用项目自身 import_project(design_mode) 生成设计 DSL，
// 渲染成 dynamic 浅色紫调主题 HTML 到 output/，供 B1 视觉验收。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importProject } from '../dist/src/tools/import_project.js';
import { getDSL } from '../dist/src/storage.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  const feature = 'dynamic_demo';
  await importProject({
    project_dir: root,
    feature,
    title: 'design-canvas 架构（dynamic 主题验收）',
    design_mode: true,
  });
  const dsl = getDSL(feature);
  if (!dsl) throw new Error('getDSL 返回空');
  // 不设 theme → 走默认 dynamic
  const html = renderHTML(dsl);
  const out = path.join(root, 'output', feature + '.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html, 'utf-8');
  const nodes = dsl.geometry?.nodes?.length ?? 0;
  const edges = dsl.geometry?.edges?.length ?? 0;
  console.log(`已生成 ${out}（节点 ${nodes}，边 ${edges}，默认主题 dynamic）`);
  console.log(`body 主题: ${html.includes('<body data-theme="dynamic">') ? 'dynamic ✓' : '异常'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});