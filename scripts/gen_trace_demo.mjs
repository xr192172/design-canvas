/**
 * gen_trace_demo：生成 trace_demo 验证 DSL —— 链首可真实执行的演示
 * 链：flattenScope → mockValue → evaluateCond（全部为 dataflow_core.ts 真实纯函数）
 * 用法：node scripts/gen_trace_demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveDSL } from '../dist/src/storage.js';
import { renderDsl } from '../dist/src/tools/render_dsl.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcFile = 'src/renderer/dataflow_core.ts';

const dsl = {
  id: 'trace_demo',
  type: 'feature_diagram',
  feature: 'trace_demo',
  version: '1.0.0',
  title: '数据流真实执行验证',
  status: 'draft',
  geometry: {
    layout: 'vertical_flow',
    width: 900,
    height: 500,
    nodes: [
      { id: 'host_node', label: '宿主', x: 100, y: 60, width: 220, height: 60 },
      { id: 'host_node__s1_flattenScope', label: '① flattenScope', x: 100, y: 170, width: 220, height: 56, layer: 'detail', host: 'host_node' },
      { id: 'host_node__s2_mockValue', label: '② mockValue', x: 100, y: 260, width: 220, height: 56, layer: 'detail', host: 'host_node' },
      { id: 'host_node__s3_evaluateCond', label: '③ evaluateCond·分支', x: 100, y: 350, width: 220, height: 56, layer: 'detail', host: 'host_node' },
    ],
    edges: [
      { id: 'host_node__chain_1', from: 'host_node__s1_flattenScope', to: 'host_node__s2_mockValue', layer: 'detail' },
      { id: 'host_node__chain_2', from: 'host_node__s2_mockValue', to: 'host_node__s3_evaluateCond', layer: 'detail' },
    ],
  },
  semantic: {
    files: [{ id: 'host_node', path: srcFile, responsibility: '真实执行验证' }],
    multi_file_invariants: [],
  },
  annotations: [],
  _sync: { saved_at: new Date().toISOString(), source: 'gen_trace_demo', feature: 'trace_demo' },
};

const r = renderDsl({ dsl_json: JSON.stringify(dsl), output_path: path.join(root, 'output', 'trace_demo.html') });
console.log('HTML:', r.htmlFile);
const html = fs.readFileSync(r.htmlFile, 'utf-8');
console.log('含 api/trace-exec 调用:', html.includes('api/trace-exec'));
console.log('feature 存档:', r.dslFile);
