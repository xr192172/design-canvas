/**
 * logging 积木正式入盒（Phase 3R 步骤一）：
 * 从 agent-shell 活仓库抽取 internal/logging 四件套（同包一组种子）。
 * 盘点已证明 design-canvas/go-lab/ 下存在手工副本——入盒后以盒为唯一事实源，
 * go-lab 副本待绞杀（步骤三处理）。
 */
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';

const r = await harvestFromUrl({
  source: 'D:/project_develop/ai-base/agent-shell',
  bricks: [
    {
      name: 'go_logging',
      seeds: [
        'internal/logging/file.go',
        'internal/logging/logging.go',
        'internal/logging/rotate.go',
        'internal/logging/router.go',
      ],
    },
  ],
  write: true,
});

console.log(r.message);
for (const b of r.bricks) {
  console.log(
    `  [入盒] ${b.name} closure=${b.closure_count} 深度=${b.depth} ` +
      `exposes=${b.aggregate.exposes} 不可逆=${b.aggregate.irreversible_effects} ` +
      `ext(std/3rd)=${b.external.stdlib}/${b.external.third_party} ` +
      `replaced=${b.replaced} dir=${b.brick_dir}`,
  );
}
for (const s of r.skipped) {
  console.log(`  [跳过] ${s.seeds.join(',')}: ${s.reason}`);
}
