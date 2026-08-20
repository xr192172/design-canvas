/**
 * Phase 7 终点站：TS 瘦身积木拼装 + 贫困编译（TS 产线全链 e2e）
 *
 * 对照 Go 线 assembly-002（go_logging + ocr_diff_resolver-slim → go build）：
 *   实验组（本脚本产出 assembly-ts-001）：
 *   ua_ignore_filter-slim + cg_wal_valve-slim → 拼装 → LLM 写 glue → tsc 贫困编译
 *
 * 证明：TS 线整条链（抽取→瘦身→拼装→glue→编译）端到端可用。
 * 积木来自两个不同源项目（Understand-Anything + codegraph）——跨项目拼装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { assembleBricks } from '../src/tools/assemble_bricks.js';
import { verifyTsBuild } from '../src/tools/slim_brick.js';

const target = 'D:/project_develop/assembly-ts-001';
if (fs.existsSync(target)) {
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`[清理] ${target}`);
}

const r = await assembleBricks({
  bricks: ['ua_ignore_filter-slim', 'cg_wal_valve-slim'],
  target_dir: target,
  box_dir: 'D:/project_develop/design-canvas/.design-canvas/bricks',
});
console.log(r.message);
for (const b of r.bricks) {
  console.log(`  [搬运] ${b.name} → ${b.dest_root} ${b.files_copied} 文件（TS 零重接）`);
  if (b.third_party.length) console.log(`    三方=${b.third_party.join(',')}（贫困编译口径忽略，package.json 治理下一步）`);
}

// ── glue：LLM 粘合层（跨积木、跨源项目引用）──
const glueDir = path.join(target, 'src');
fs.mkdirSync(glueDir, { recursive: true });
fs.writeFileSync(
  path.join(glueDir, 'main.ts'),
  [
    '/**',
    ' * assembly-ts-001 glue：两块跨项目 TS 积木的粘合层',
    ' * - ua_ignore_filter-slim（Understand-Anything）：文件忽略过滤',
    ' * - cg_wal_valve-slim（codegraph）：WAL 写放大治理阀',
    ' */',
    "import { createIgnoreFilter } from '../ua_ignore_filter-slim/understand-anything-plugin/packages/core/src/ignore-filter';",
    "import { WalCheckpointValve, resolveWalValveMb } from '../cg_wal_valve-slim/src/db/wal-valve';",
    "import { DatabaseConnection } from '../cg_wal_valve-slim/src/db/index';",
    '',
    'async function main(): Promise<void> {',
    '  // 积木一：忽略过滤器——扫源码前滤掉 node_modules/dist 等',
    "  const filter = createIgnoreFilter(process.cwd(), ['*.log']);",
    "  console.log('[ignore-filter] node_modules=', filter.isIgnored('node_modules/foo/index.js'));",
    "  console.log('[ignore-filter] src=', filter.isIgnored('src/index.ts'));",
    '',
    '  // 积木二：WAL 阀——按 DB 规模决定软阈值（512MB 库 → dbSize/4 档）',
    '  const softMb = resolveWalValveMb(undefined, 512 * 1024 * 1024);',
    "  const db = DatabaseConnection.open(':memory:');",
    "  const valve = new WalCheckpointValve(db, softMb, 50, (m) => console.log('[wal-valve]', m));",
    '  valve.start();',
    '  valve.stop();',
    `  console.log('[wal-valve] soft=' + softMb + 'MB，启停干净');`,
    '}',
    '',
    'void main();',
    '',
  ].join('\n'),
  'utf-8',
);
console.log('  [glue] src/main.ts 写入（跨积木 import 2 块 + 跨项目类型引用）');

// ── 贫困编译验证（tsc 进程内；三方缺类型 = 贫困预期，相对路径错误 = 真错误）──
const build = await verifyTsBuild(target);
console.log(`\n[贫困编译] ${build.status}${build.detail ? '\n' + build.detail.slice(0, 2000) : '（零真错误）'}`);
