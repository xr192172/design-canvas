#!/usr/bin/env node
/** 重建 teach 导图（复用旧 LLM 分镜，吃到新字段如 children/proposals） */
const { deriveMindMap, placeProposals } = require('../dist/src/tools/derive_mind_map.js');

(async () => {
  const feature = process.argv[2] || 'design-canvas';
  const r = await deriveMindMap({ feature, view: 'teach' });
  const withFiles = r.mind_map.root.children.filter((c) => c.children && c.children.length).length;
  console.log('[rebuild] mode=' + r.mode, '带关键文件的功能:', withFiles + '/' + r.mind_map.root.children.length);
  if (process.argv.includes('--proposals')) {
    const p = await placeProposals(feature);
    console.log('[proposals] mode=' + p.mode, p.proposals.length + ' 个构想:', p.proposals.map((x) => x.title + (x.parent ? '→挂:' + x.parent : '→根')).join('; ') || '(无)');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
