/**
 * verify_trace_real：CLI 验证 trace_exec 真实执行引擎对 self 真实文件工作
 * 用法：npm run build && node scripts/verify_trace_real.mjs
 * 场景：
 *   A. 链式真实流转：flattenScope（展开用户输入）→ mockValue（按 schema 生成值）
 *   B. 真实判定求值：evaluateCond 用安全非受限求值器算条件（真实输入 → 真实走向）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceExecChain } from '../dist/src/tools/trace_exec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = path.join(root, 'src', 'renderer', 'dataflow_core.ts');

console.log('── 场景 A：flattenScope → mockValue 链式真实流转 ──');
const rA = await traceExecChain({
  steps: [
    { node_id: 'n1', func_name: 'flattenScope', file_path: coreFile },
    { node_id: 'n2', func_name: 'mockValue', file_path: coreFile },
  ],
  // 用户真实输入：一个含嵌套对象的 DSL schema
  input_value: {
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'integer' } },
    },
  },
});
console.log(JSON.stringify(rA, null, 2));

console.log('\n── 场景 B：evaluateCond 真实判定求值（score>=60 且成年）──');
const rB = await traceExecChain({
  steps: [{ node_id: 'n1', func_name: 'evaluateCond', file_path: coreFile }],
  input_value: {
    cond: 'score >= 60 && user.age > 18',
    scope: { score: 85, user: { age: 20 } },
  },
});
console.log(JSON.stringify(rB, null, 2));

console.log('\n── 场景 B2：未匹配变量（不支持的引用如实报错）──');
const rB2 = await traceExecChain({
  steps: [{ node_id: 'n1', func_name: 'evaluateCond', file_path: coreFile }],
  input_value: {
    cond: 'window.location.href',
    scope: { score: 85 },
  },
});
console.log(JSON.stringify(rB2, null, 2));

const allOk = [rA, rB, rB2].every(
  (r) => r.steps.length > 0 && r.steps.every((s) => s.status === 'ok' || s.status === 'error'),
);
console.log(allOk ? '\n✅ 验证完成' : '\n❌ 有步骤异常');
