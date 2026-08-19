// 真实验证：design-canvas 自身 dry-run 契约提取（不写回，只看结果质量）
import { extractContracts } from '../dist/src/tools/extract_contracts.js';

const r = extractContracts({
  project_dir: 'd:/project_develop/design-canvas',
  files: [
    'src/storage.ts', 'src/server_registry.ts', 'src/tools/harvest_closure.ts',
    'src/tools/import_project.ts', 'src/db/db.ts', 'src/tools/extract_contracts.ts',
  ],
});

console.log('=== message ===');
console.log(r.message);
console.log('=== files ===');
for (const f of r.files) {
  console.log(`${f.role.class.padEnd(11)} conf=${f.role.confidence} fan=${f.fan_in}/${f.fan_out} shapes=${f.shape_count} env=[${f.reads_config.join(',')}] ${f.path}`);
  console.log(`            reason: ${f.role.reasons?.[0]}`);
}
