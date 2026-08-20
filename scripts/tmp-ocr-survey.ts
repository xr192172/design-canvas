/**
 * OCR（open-code-review）积木盘点（Phase 5 前置，纯 dry-run 预演不入盒）：
 * auto 模式看自动选出什么 Go 积木 + 显式点名 diff/resolver 一族，
 * 为微型拼装试点选源。
 */
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';

const r = await harvestFromUrl({
  source: 'D:/project_develop/open-code-review',
  write: false,
  auto: { max_bricks: 5, min_fan_in: 2 },
});

console.log('=== auto 盘点 ===');
console.log(r.message);
for (const b of r.bricks) {
  console.log(
    `  [候选] ${b.name} closure=${b.closure_count} 深度=${b.depth} ` +
      `seeds=${b.seeds.join(',')} ` +
      `exposes=${b.aggregate.exposes} emits=${b.aggregate.emits} ` +
      `config=${b.aggregate.reads_config} 不可逆=${b.aggregate.irreversible_effects} ` +
      `ext(std/3rd/unres)=${b.external.stdlib}/${b.external.third_party}/${b.external.unresolved}`,
  );
}
for (const s of r.skipped) {
  console.log(`  [跳过] ${s.seeds.join(',')}: ${s.reason}`);
}

// 显式点名：diff 行级定位一族（OCR 招牌能力）——auto 选不中它（角色判定可能偏 business）
const r2 = await harvestFromUrl({
  source: 'D:/project_develop/open-code-review',
  write: false,
  bricks: [
    {
      name: 'ocr_diff_resolver',
      seeds: ['internal/diff/resolver.go'],
    },
    {
      name: 'ocr_pathutil',
      seeds: ['internal/pathutil/path.go'],
    },
  ],
});

console.log('\n=== 显式点名 ===');
console.log(r2.message);
for (const b of r2.bricks) {
  console.log(
    `  [候选] ${b.name} closure=${b.closure_count} 深度=${b.depth} ` +
      `exposes=${b.aggregate.exposes} emits=${b.aggregate.emits} ` +
      `config=${b.aggregate.reads_config} 不可逆=${b.aggregate.irreversible_effects} ` +
      `ext(std/3rd/unres)=${b.external.stdlib}/${b.external.third_party}/${b.external.unresolved}`,
  );
}
for (const s of r2.skipped) {
  console.log(`  [跳过] ${s.seeds.join(',')}: ${s.reason}`);
}
