/**
 * Phase 7 真实积木验证：重抽 3 块 TS 积木（刷新 live 档案）→ ts-slim 瘦身
 * 源项目：understanding-anything-plugin（盒内 TS 积木的原始来源）
 */
import fs from 'node:fs';
import path from 'node:path';
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';
import { slimBrick } from '../src/tools/slim_brick.js';

const BOX = 'D:/project_develop/design-canvas/.design-canvas/bricks';

/** 种子与 provenance 对齐（manifest.seed_files 原样抄回——路径是相对源项目根的） */
const SPECS = [
  {
    name: 'ua_ignore_filter',
    seeds: ['understand-anything-plugin/packages/core/src/ignore-filter.ts'],
    src: 'D:/project_develop/design-canvas/vendor/Understand-Anything',
  },
  {
    name: 'ua_theme_engine',
    seeds: [
      'understand-anything-plugin/packages/dashboard/src/themes/types.ts',
      'understand-anything-plugin/packages/dashboard/src/themes/presets.ts',
      'understand-anything-plugin/packages/dashboard/src/themes/theme-engine.ts',
    ],
    src: 'D:/project_develop/design-canvas/vendor/Understand-Anything',
  },
  { name: 'cg_wal_valve', seeds: ['src/db/wal-valve.ts'], src: 'D:/project_develop/design-canvas/vendor/codegraph' },
];

for (const spec of SPECS) {
  // 旧 -slim 衍生积木清理（机器产物可重生成）
  const oldSlim = path.join(BOX, spec.name + '-slim');
  if (fs.existsSync(oldSlim)) {
    fs.rmSync(oldSlim, { recursive: true, force: true });
    console.log(`[清理] ${spec.name}-slim`);
  }
  const h = await harvestFromUrl({ source: spec.src, bricks: [{ name: spec.name, seeds: spec.seeds }], box_dir: BOX, write: true });
  if (!h.bricks.length) {
    console.log(`  [skip] bricks 空，原因：${JSON.stringify(h.skipped)}`);
    continue;
  }
  const m = JSON.parse(fs.readFileSync(path.join(BOX, spec.name, 'manifest.json'), 'utf-8'));
  const sc = m.slim_candidates;
  console.log(
    `\n== ${spec.name} == 重抽 closure=${h.bricks[0].closure_count}` +
      (sc
        ? ` live=${sc.live_symbols}/${sc.total_symbols} 死三方=${(sc.dead_third_party ?? []).map((d: { source: string }) => d.source).join(',') || '无'}`
        : ' slim_candidates=缺省'),
  );
  if (!sc?.live_symbols_by_file) {
    console.log('  [跳过] 无 live 档案');
    continue;
  }
  try {
    const r = await slimBrick({ brick_name: spec.name, box_dir: BOX, verify_build: true, write: true });
    console.log(`  ${r.message}`);
    if (r.written) {
      console.log(`  dropped_files=${r.dropped_files.join(',') || '无'} deps ${r.deps_before.length}→${r.deps_after.length}（剔 ${r.deps_removed.join(',') || '无'}）`);
      if (r.go_slim_errors.length) console.log(`  剪刀错误：${r.go_slim_errors.join(' | ')}`);
      if (r.build_verification) {
        console.log(`  贫困编译：${r.build_verification.status}${r.build_verification.detail ? '\n    ' + r.build_verification.detail.slice(0, 800) : ''}`);
      }
    }
  } catch (e) {
    console.log(`  [瘦身失败] ${(e as Error).message}`);
  }
}
