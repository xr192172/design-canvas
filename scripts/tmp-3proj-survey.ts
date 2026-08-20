/**
 * 三项目重构盘点（Phase 3R 前置）：dry-run 扫描，不写盒。
 * 产出每项目的：积木候选（auto 选种）、闭包规模、effects 风险概况——
 * 重构视角 = 功能积木（可保留/可拎走）vs 业务胶水（待绞杀对象）。
 */
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';

const projects = [
  { name: 'design-canvas', dir: 'D:/project_develop/design-canvas' },
  { name: 'agent-shell', dir: 'D:/project_develop/ai-base/agent-shell' },
  { name: 'cross-border-scout', dir: 'D:/project_develop/cross-border-scout' },
];

for (const p of projects) {
  try {
    const r = await harvestFromUrl({
      source: p.dir,
      auto: { max_bricks: 5, min_fan_in: 3 },
      write: false, // dry-run：只盘点不入盒
    });
    console.log(`\n=== ${p.name}：索引 ${r.indexed_files} 文件 ===`);
    for (const b of r.bricks) {
      console.log(
        `  [积木] seeds=${b.seeds.join(',')} closure=${b.closure_count} 深度=${b.depth} ` +
          `exposes=${b.aggregate.exposes} emits=${b.aggregate.emits} ` +
          `config=${b.aggregate.reads_config} 不可逆=${b.aggregate.irreversible_effects} ` +
          `ext(std/3rd/unres)=${b.external.stdlib}/${b.external.third_party}/${b.external.unresolved}`,
      );
    }
    for (const s of r.skipped) {
      console.log(`  [跳过] ${s.seeds.join(',')}: ${s.reason}`);
    }
  } catch (e) {
    console.log(`\n=== ${p.name}：失败 ${String(e).slice(0, 200)}`);
  }
}
