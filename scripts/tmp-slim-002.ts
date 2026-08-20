/**
 * Phase 6 验证线（新「包活才活」规则首跑）：
 * ① 重抽 ocr_diff_resolver（刷新 slim_candidates live 档案——init/包级变量
 *    改为包活才活后，llm/telemetry/config 等死包应不再被 init 误活）
 * ② 删除旧 -slim 衍生积木（机器产物，可重生成）
 * ③ slim_brick + verify_build：剪枝 → 按需搬资产 → 贫困依赖编译验证
 */
import fs from 'node:fs';
import path from 'node:path';
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';
import { slimBrick } from '../src/tools/slim_brick.js';

const BOX = 'D:/project_develop/design-canvas/.design-canvas/bricks';

// ── ① 重抽（刷新 live 档案） ──
const h = await harvestFromUrl({
  source: 'D:/project_develop/open-code-review',
  bricks: [{ name: 'ocr_diff_resolver', seeds: ['internal/diff/resolver.go'] }],
  write: true,
});
console.log(h.message);
for (const b of h.bricks) {
  const sc = (b as { slim_candidates?: { dead?: Array<{ source: string; reason: string }>; live_symbols?: number } }).slim_candidates;
  console.log(
    `  [重抽] ${b.name} closure=${b.closure_count} replaced=${b.replaced}` +
      (sc ? ` live_symbols=${sc.live_symbols} 死候选=${(sc.dead ?? []).map((d) => d.source).join(',') || '无'}` : ' slim_candidates=缺省'),
  );
}

// ── ② 清旧产物 ──
const oldSlim = path.join(BOX, 'ocr_diff_resolver-slim');
if (fs.existsSync(oldSlim)) {
  fs.rmSync(oldSlim, { recursive: true, force: true });
  console.log(`\n[清理] 旧衍生积木已删除：${oldSlim}`);
}

// ── ③ 瘦身 + 编译验证 ──
const r = await slimBrick({
  brick_name: 'ocr_diff_resolver',
  box_dir: BOX,
  verify_build: true,
  write: true,
});
console.log('\n' + r.message);
console.log(`  文件 ${r.files_before} → ${r.files_after}`);
console.log(`  顶层声明 ${r.symbols_before} → ${r.symbols_after}`);
console.log(`  剔除文件（${r.dropped_files.length}）：\n    ${r.dropped_files.join('\n    ') || '无'}`);
console.log(`  deps_before：${r.deps_before.join(', ') || '无'}`);
console.log(`  deps_after：${r.deps_after.join(', ') || '无'}`);
console.log(`  剔除依赖（${r.deps_removed.length}）：${r.deps_removed.join(', ') || '无'}`);
console.log(`  unresolved：${r.unresolved_imports.join(', ') || '无'}`);
if (r.go_slim_errors.length) console.log(`  go-slim 错误：${r.go_slim_errors.join(' | ')}`);
if (r.build_verification) {
  console.log(`  编译验证：${r.build_verification.status} @ ${r.build_verification.at}`);
  if (r.build_verification.detail) console.log(`    ${r.build_verification.detail.slice(0, 1500)}`);
}
