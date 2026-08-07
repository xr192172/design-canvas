// 渲染 smoke_arch feature → HTML，供人工验收架构分层图层着色与图例
// 用法：npm run build && node scripts/render_arch_smoke.mjs
import path from 'node:path';
import { getDSL } from '../dist/src/storage.js';
import { renderDsl } from '../dist/src/tools/render_dsl.js';

const FEATURE = 'smoke_arch';
const dsl = getDSL(FEATURE);
if (!dsl) {
  console.error(`feature "${FEATURE}" 不存在，先运行 arch_layer_smoke.mjs 生成`);
  process.exit(1);
}

const out = path.resolve('output', 'smoke_arch_arch_layer.html');
const r = renderDsl({ dsl_json: JSON.stringify(dsl), output_path: out });
console.log(r.message);
console.log(`layers=${dsl.layers?.length ?? 0}  → 渲染产物: ${out}`);