import { it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSimilarNames } from '../../src/tools/similar_names';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = [
  'src/tools/ast_rename.ts',
  'src/server_registry.ts',
  'src/tools/derive_mind_map.ts',
  'src/tools/slim_brick.ts',
];

it('狗食：扫描 design-canvas 自身源码里的相似名聚类', async () => {
  const root = path.resolve(here, '../../');
  for (const rel of files) {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) {
      // eslint-disable-next-line no-console
      console.log(`[skip] ${rel} 不存在`);
      continue;
    }
    const src = fs.readFileSync(abs, 'utf-8');
    const clusters = await findSimilarNames(src, abs);
    // eslint-disable-next-line no-console
    console.log(`\n===== ${rel} : ${clusters.length} 个聚类 =====`);
    for (const c of clusters) {
      const lines = c.entries.map((e) => `   - ${e.name}${e.name === c.basis ? ' [basis]' : ' →改'}\n      ${e.declLine}`).join('\n');
      // eslint-disable-next-line no-console
      console.log(`[cluster #${c.id} @${c.scopeLabel}] ${c.reason}\n${lines}`);
    }
  }
});