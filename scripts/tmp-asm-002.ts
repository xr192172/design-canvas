/**
 * Phase 6 终点站：瘦身积木拼装 + 编译（产线全链 e2e）
 *
 * 对照组（已存在的 assembly-001，肥积木拼装区）：
 *   go 文件 42 个，go.mod 直接依赖 15 + 间接依赖 27
 * 实验组（本脚本产出 assembly-002-slim-demo）：
 *   go_logging + ocr_diff_resolver-slim → 拼装 → go build ./...
 *
 * 证明：整条线（抽取→瘦身→拼装→编译）端到端可用，且瘦身价值传导到
 * 拼装区——产品只携带它真正需要的东西。
 */
import { spawnSync } from 'node:child_process';
import { assembleBricks } from '../src/tools/assemble_bricks.js';

const target = 'D:/project_develop/assembly-002-slim-demo';
const r = await assembleBricks({
  bricks: ['go_logging', 'ocr_diff_resolver-slim'],
  target_dir: target,
  module: 'example.com/assembly-002',
  box_dir: 'D:/project_develop/design-canvas/.design-canvas/bricks',
});
console.log(r.message);
for (const b of r.bricks) {
  console.log(
    `  [搬运] ${b.name} → ${b.dest_root} ${b.files_copied} 文件 ` +
      `import重写=${b.imports_rewritten.length}` +
      (b.third_party.length ? ` 三方待补=${b.third_party.join(',')}` : ''),
  );
}
for (const o of r.overlaps) console.log(`  [重叠] ${o}`);
console.log(`  go_mod=${r.go_mod_written} assembly.json=${r.assembly_manifest_written}`);

// ── 编译验证（产线最后一段）──
const build = spawnSync('go', ['build', './...'], {
  cwd: target,
  encoding: 'utf8',
  timeout: 300_000,
  maxBuffer: 32 * 1024 * 1024,
  windowsHide: true,
});
const out = `${build.stdout || ''}\n${build.stderr || ''}`.trim();
console.log(`\n[编译] exit=${build.status}${out ? '\n' + out.slice(-3000) : '（零输出）'}`);
