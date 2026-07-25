/**
 * check_monolith 自举验证：扫描 design-canvas 自己的 src 目录
 * 运行: node scripts/verify_monolith.mjs
 */
import { checkMonolith } from '../dist/src/tools/monolith.js';

const r = await checkMonolith({
  project_dir: 'src',
  warn_lines: 300,
  crit_lines: 600,
  save_preview: true,
  preview_feature: 'self_split_preview',
});
console.log(r.message);
console.log('\n--- 结构化摘要 ---');
for (const rep of r.reports) {
  console.log(`${rep.path}: ${rep.lines}行 status=${rep.status} decls=${rep.decl_count} 社区=${rep.communities.length} 跨社区边=${rep.inter_edges.length}`);
}
