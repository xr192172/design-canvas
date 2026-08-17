#!/usr/bin/env node
/** 对已导入项目补生成带 LLM 效果的 teach 导图（gen_descriptions=true，不重跑 import） */
const { deriveMindMap } = require('../dist/src/tools/derive_mind_map.js');

const targets = process.argv.slice(2);
(async () => {
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const mm = await deriveMindMap({ feature: t, view: 'teach', gen_descriptions: true });
      const root = mm.mind_map?.root;
      const feats = (root?.children || []).length;
      const comms = [];
      const walk = (n) => { if (n.kind === 'community') comms.push(n); (n.children || []).forEach(walk); };
      walk(root);
      console.log(`✓ ${t}: mode=${mm.mind_map?.mode} 功能层=${feats} 社区=${comms.length} 耗时${Date.now()-t0}ms`);
    } catch (e) {
      console.log(`✗ ${t}: ${e.message}`);
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });