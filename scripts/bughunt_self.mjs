// 自我查 bug：对 design-canvas 自己的 import_project.ts 跑 derive_detail_chain
// 隔离存储（DESIGN_CANVAS_HOME），完全不碰活态 design-canvas.json
// 用法：npm run build && node scripts/bughunt_self.mjs
import fs from 'node:fs';
import path from 'node:path';

process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_bughunt');

const { saveDSL, getDSL } = await import('../dist/src/storage.js');
const { deriveDetailChain } = await import('../dist/src/tools/derive_chain.js');

const FEATURE = 'bughunt_self';
const TARGET = 'd:/project_develop/design-canvas/src/tools/import_project.ts';

saveDSL({
  feature: FEATURE,
  title: '自我查 bug：importProject 导入流水线',
  geometry: {
    nodes: [
      {
        id: 'import_project',
        x: 120, y: 60, width: 260, height: 90,
        label: 'import_project.ts',
        type: 'file',
        description: '项目导入流水线：扫描→解析符号/import→依赖边→目录树→递归布局→DSL',
      },
    ],
    edges: [],
  },
});

const result = await deriveDetailChain({
  feature: FEATURE,
  node_id: 'import_project',
  source_path: TARGET,
});
console.log(result.message);

const dsl = getDSL(FEATURE);
const derived = dsl.geometry.nodes.filter((n) => n.host === 'import_project');
console.log('\n===== 派生节点（工具视角的管线） =====');
for (const n of derived) {
  console.log(`${n.id}\n  in:  ${JSON.stringify(n.shapes?.in ?? null)}\n  out: ${JSON.stringify(n.shapes?.out ?? null)}`);
}

fs.rmSync('.tmp_bughunt', { recursive: true, force: true });
console.log('\n[cleanup] .tmp_bughunt removed');
