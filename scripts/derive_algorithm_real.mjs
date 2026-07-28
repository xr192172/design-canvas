// 真实工程验证 derive_algorithm：对 ai-base media_replacer.go ReplaceImages 提取算法控制流
// 用法：node scripts/derive_algorithm_real.mjs
// 注意：会覆盖活态 design-canvas.json（幂等备份到 .bak-alg，finally 恢复）
import fs from 'node:fs';
import { saveDSL, getLiveDslFile, getDSL } from '../dist/src/storage.js';
import { deriveAlgorithm } from '../dist/src/tools/derive_algorithm.js';

const FEATURE = 'smoke_algorithm';
const TARGET = 'd:/project_develop/ai-base/agent-shell/internal/context/v2/media_replacer.go';

// 幂等备份（同 derive_real_aibase 模式）
const live = getLiveDslFile();
const bak = live + '.bak-alg';
let backedUp = false;
if (fs.existsSync(live)) {
  const cur = JSON.parse(fs.readFileSync(live, 'utf-8'));
  if (cur.feature !== FEATURE && !fs.existsSync(bak)) {
    fs.copyFileSync(live, bak);
    backedUp = true;
    console.log('[backup] design-canvas.json → .bak-alg');
  }
}

try {
  saveDSL({
    feature: FEATURE,
    title: '算法控制流真实验证：ReplaceImages',
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
  console.log('\n===== derive_algorithm 输出 =====');
  console.log(result.message);

  const dsl = getDSL(FEATURE);
  const nodes = dsl.geometry.nodes.filter((n) => n.id.startsWith('media_replacer__alg_'));
  const edges = dsl.geometry.edges.filter((e) => e.id.startsWith('media_replacer__alge_'));
  console.log('\n===== 算法图节点 =====');
  for (const n of nodes) {
    console.log(`${n.id}  [${n.style?.shape ?? 'rect'}] ${n.label}  (col=${Math.round((n.x - 120) / 280)})`);
  }
  console.log('\n===== 算法图边 =====');
  for (const e of edges) {
    const from = e.from.replace('media_replacer__alg_', '');
    const to = e.to.replace('media_replacer__alg_', '');
    console.log(`${from} --${e.label ?? ''}--> ${to}`);
  }
} finally {
  if (backedUp && fs.existsSync(bak)) {
    fs.copyFileSync(bak, live);
    console.log('\n[restore] 活态 design-canvas.json 已从 .bak-alg 恢复');
  }
}
