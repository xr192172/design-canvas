/**
 * Phase 5 微型拼装实战（步骤一二）：
 * ① OCR diff resolver 正式入盒（write=true，盒内第 5 块）
 * ② assemble_bricks：go_logging + ocr_diff_resolver → 拼装区（工作区平级新目录）
 */
import { harvestFromUrl } from '../src/tools/harvest_from_url.js';
import { assembleBricks } from '../src/tools/assemble_bricks.js';

// ── ① OCR resolver 入盒 ──
const h = await harvestFromUrl({
  source: 'D:/project_develop/open-code-review',
  bricks: [{ name: 'ocr_diff_resolver', seeds: ['internal/diff/resolver.go'] }],
  write: true,
});
console.log(h.message);
for (const b of h.bricks) {
  console.log(
    `  [入盒] ${b.name} closure=${b.closure_count} 深度=${b.depth} ` +
      `exposes=${b.aggregate.exposes} 不可逆=${b.aggregate.irreversible_effects} ` +
      `ext(std/3rd)=${b.external.stdlib}/${b.external.third_party} replaced=${b.replaced}`,
  );
}

// ── ② 拼装区 ──
const target = 'D:/project_develop/assembly-001-brick-demo';
const r = await assembleBricks({
  bricks: ['go_logging', 'ocr_diff_resolver'],
  target_dir: target,
  module: 'example.com/assembly-001',
  box_dir: 'D:/project_develop/design-canvas/.design-canvas/bricks',
});
console.log(r.message);
for (const b of r.bricks) {
  console.log(
    `  [搬运] ${b.name} → ${b.dest_root} ${b.files_copied} 文件 ` +
      `import重写=${b.imports_rewritten.length}` +
      (b.imports_rewritten.length ? `\n         ${b.imports_rewritten.join('\n         ')}` : '') +
      (b.third_party.length ? ` 三方待补=${b.third_party.join(',')}` : ''),
  );
}
for (const o of r.overlaps) console.log(`  [重叠] ${o}`);
console.log(`  go_mod=${r.go_mod_written} assembly.json=${r.assembly_manifest_written}`);
