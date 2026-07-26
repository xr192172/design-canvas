// 真实工程验证 D2：对 ai-base summary_zone.go 跑 derive_detail_chain
// 用法：node scripts/derive_real_aibase.mjs
// 注意：会覆盖活态 design-canvas.json（先备份到 design-canvas.json.bak-ai-base）
import fs from 'node:fs';
import path from 'node:path';
import { saveDSL, getLiveDslFile, getDSL } from '../dist/src/storage.js';
import { deriveDetailChain } from '../dist/src/tools/derive_chain.js';

const FEATURE = 'smoke_aibase';
// summary_zone.go 是扁平 API 面（函数互不调用），media_replacer.go 是真流水线
const TARGET = 'd:/project_develop/ai-base/agent-shell/internal/context/v2/media_replacer.go';

// 备份活态文件（只在活态不是自身时备份——重跑时活态已是 smoke，再备份会毁掉真备份）
const live = getLiveDslFile();
const bak = live + '.bak-ai-base';
if (fs.existsSync(live)) {
  const cur = JSON.parse(fs.readFileSync(live, 'utf-8'));
  if (cur.feature !== FEATURE && !fs.existsSync(bak)) {
    fs.copyFileSync(live, bak);
    console.log('[backup] design-canvas.json → .bak-ai-base');
  }
}

// 1. 建宿主 feature + 节点（模拟 import_project 产出的文件节点）
saveDSL({
  feature: FEATURE,
  title: 'ai-base 真实验证：MediaReplacer 图片占位变形链',
  geometry: {
    nodes: [
      {
        id: 'media_replacer',
        x: 120,
        y: 60,
        width: 240,
        height: 80,
        label: 'media_replacer.go',
        type: 'file',
        description: 'MediaReplacer：首轮后把图片 ContentPart 换成 [media://hash 描述] 文本占位，省上下文 token',
      },
    ],
    edges: [],
  },
});
console.log('[setup] feature + host node created');

// 2. 推导变形链
const result = await deriveDetailChain({
  feature: FEATURE,
  node_id: 'media_replacer',
  source_path: TARGET,
});
console.log('\n===== derive_detail_chain 输出 =====');
console.log(result.message);

// 3. dump 派生节点的 shapes 详情（检查类型推导质量）
const dsl = getDSL(FEATURE);
const derived = dsl.geometry.nodes.filter((n) => n.host === 'media_replacer');
console.log('\n===== 派生节点 shapes 详情 =====');
for (const n of derived) {
  console.log(`\n--- ${n.id}`);
  console.log(`    label: ${n.label}`);
  console.log(`    desc:  ${n.description}`);
  console.log(`    shapes.in:  ${JSON.stringify(n.shapes?.in ?? null)}`);
  console.log(`    shapes.out: ${JSON.stringify(n.shapes?.out ?? null)}`);
}
console.log(`\n[done] ${derived.length} derived nodes, live DSL = feature "${getDSL(FEATURE).feature}"`);
