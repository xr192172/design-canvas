// 画布验证：derive_algorithm → renderHTML → output/demo_algorithm.html
// 用法：node scripts/render_algorithm_demo.mjs
// 幂等备份活态 design-canvas.json，finally 恢复（HTML 自包含，恢复不影响产物）
import fs from 'node:fs';
import path from 'node:path';
import { saveDSL, getLiveDslFile, getDSL } from '../dist/src/storage.js';
import { deriveAlgorithm } from '../dist/src/tools/derive_algorithm.js';
import { renderHTML } from '../dist/src/renderer/html_renderer.js';

const FEATURE = 'demo_algorithm';
const TARGET = 'd:/project_develop/ai-base/agent-shell/internal/context/v2/media_replacer.go';

const live = getLiveDslFile();
const bak = live + '.bak-algdemo';
let backedUp = false;
if (fs.existsSync(live)) {
  const cur = JSON.parse(fs.readFileSync(live, 'utf-8'));
  if (cur.feature !== FEATURE && !fs.existsSync(bak)) {
    fs.copyFileSync(live, bak);
    backedUp = true;
    console.log('[backup] design-canvas.json → .bak-algdemo');
  }
}

try {
  saveDSL({
    feature: FEATURE,
    title: '算法控制流演示：ReplaceImages',
    geometry: {
      nodes: [
        { id: 'media_replacer', x: 120, y: 60, width: 240, height: 80, label: 'media_replacer.go', type: 'file' },
      ],
      edges: [],
    },
  });

  const result = await deriveAlgorithm({
    feature: FEATURE,
    node_id: 'media_replacer',
    function: 'ReplaceImages',
    source_path: TARGET,
  });
  console.log(result.message);

  const dsl = getDSL(FEATURE);
  const html = renderHTML(dsl);
  fs.mkdirSync('output', { recursive: true });
  const out = path.resolve('output', 'demo_algorithm.html');
  fs.writeFileSync(out, html, 'utf-8');
  console.log(`\n[render] ${out} (${(html.length / 1024).toFixed(0)}KB)`);
} finally {
  if (backedUp && fs.existsSync(bak)) {
    fs.copyFileSync(bak, live);
    console.log('[restore] 活态 design-canvas.json 已恢复');
  }
}
