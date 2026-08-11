/**
 * gen_trace_reasoning_demo：把 Go 编译期插桩采集的 trace JSON 转成 ReasoningSystem DSL，
 * 作为函数级仿真（数据流转 + 上下文折叠）的原材料，写入 output/ 供 serve 交互查看。
 *
 * 用法：
 *   npm run build
 *   node scripts/gen_trace_reasoning_demo.mjs [rounds]
 *
 * 产物：
 *   output/reasoning_trace.json     —— 合法可校验的 DesignDSL（含 reasoning）
 *   output/reasoning_viewer.html    —— 交互查看器（静态，随本脚本生成）
 * 访问：npm run serve 后打开 http://localhost:3000/reasoning_viewer.html
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveReasoning } from '../dist/src/tools/derive_reasoning.js';
import { validateDSLJson } from '../dist/src/dsl/validator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracePath = path.join(root, 'go-lab', 'agent-shell', 'internal', 'context', 'v2', '__trace', 'context_trace.json');
const rounds = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;

if (!fs.existsSync(tracePath)) {
  console.error('[gen] 找不到 trace：', tracePath);
  console.error('   请先运行 go-lab/agent-shell/cmd/context-trace 采集 trace。');
  process.exit(1);
}

const result = deriveReasoning({
  tracePath,
  feature: 'reasoning_trace',
  title: 'AI base 上下文引擎 · 函数级仿真（14 轮长任务）',
  budget: { max_tokens: 131072, fold_at: 0.8 },
  rounds,
  cap: 140,
});

// 校验 DSL 合法性
const check = validateDSLJson(JSON.stringify(result.dsl));
if (!check.valid) {
  console.error('[gen] DSL 校验失败：');
  check.errors.forEach((e) => console.error('   -', e));
  process.exit(1);
}

// 写 DSL JSON
const outJson = path.join(root, 'output', 'reasoning_trace.json');
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(result.dsl, null, 2), 'utf-8');

// 写查看器（自含模板，随本脚本生成，保证与 DSL 版本一致）
const viewerTemplate = path.join(root, 'output', 'reasoning_viewer.html');
if (!fs.existsSync(viewerTemplate)) {
  console.warn('[gen] 未找到查看器模板 reasoning_viewer.html（请先放置），仅生成 JSON。');
}

console.log('[gen] 已生成：');
console.log('   DSL   :', path.relative(root, outJson));
console.log('   counts:', JSON.stringify(result.counts));
console.log('   steps :', result.counts.steps, '| folds:', result.counts.folds, '| rounds:', result.counts.rounds, '| 唯一函数:', result.counts.unique_fns);
console.log('   DSL 校验: 通过 ✓');
console.log('   访问  : npm run serve → http://localhost:3000/reasoning_viewer.html');