// ai-base 全链路验证：derive → LLM 语义标注 → errors/branches 声明 → inject_replay
// 目标：decision_splitter.go（DecisionSplitter.Split：client 检查 → 拼对话 → LLM 调用 → JSON 提取/解析）
// 用法：npm run build && node scripts/fullchain_aibase.mjs
// 直接在 ai_base 大图上操作（活态文件即大图；改动是设计产物，保留）
import fs from 'node:fs';
import { getDSL, saveDSL } from '../dist/src/storage.js';
import { deriveDetailChain } from '../dist/src/tools/derive_chain.js';
import { updateNode } from '../dist/src/tools/edit_dsl.js';
import { injectReplay } from '../dist/src/tools/inject_replay.js';

const FEATURE = 'ai_base';
const HOST = 'file_agent-shell_internal_context_v2_decision_splitter_go';
const SRC = 'd:/project_develop/ai-base/agent-shell/internal/context/v2/decision_splitter.go';

// ═══════════ 阶段 1：derive_detail_chain 推导骨架 ═══════════
console.log('━━━ 阶段 1：derive_detail_chain ━━━');
// 扁平文件：自动入口会选构造函数 NewDecisionSplitter，工具提示后显式指定关注点函数 Split
const derived = await deriveDetailChain({ feature: FEATURE, node_id: HOST, source_path: SRC, entry: 'Split' });
console.log(derived.message);

// ═══════════ 阶段 2：LLM 语义标注（内容来自通读 decision_splitter.go） ═══════════
console.log('\n━━━ 阶段 2：LLM 语义标注 ━━━');
const dsl1 = getDSL(FEATURE);
const splitNode = dsl1.geometry.nodes.find((n) => n.host === HOST && /Split$/.test(n.id));
if (!splitNode) throw new Error('未找到 Split 派生节点');
updateNode({
  feature: FEATURE,
  node_id: splitNode.id,
  label: '① 拆分决策（ToolLLM）',
  shapes: {
    in: {
      type: 'object',
      properties: {
        msgs: { type: 'array', label: 'Section 对话消息列表' },
      },
    },
    out: {
      type: 'object',
      properties: {
        decisions: { type: 'array', label: '决策标签列表（空=纯工具执行）' },
      },
    },
  },
});
console.log(`[annotate] ${splitNode.id} → ① 拆分决策（ToolLLM）`);

// ═══════════ 阶段 3：errors / branches 声明（基于真实代码错误路径） ═══════════
console.log('\n━━━ 阶段 3：声明 animations_v2 ━━━');
const dsl2 = getDSL(FEATURE);
const host = dsl2.geometry.nodes.find((n) => n.id === HOST);

// 布局：v2 容器是 4 列密排货架（行距 104 无空隙），新节点放容器下方横条带
// 顺序叙事：3 error 层节点 → detail 变形链节点（阶段 1 派生，此处重定位）→ 2 main 下游节点
// 注意：新节点无 contains 边（非容器子级），relayout_nested 重跑会把它们当根节点重排
const v2dir = dsl2.geometry.nodes.find((n) => n.id === 'dir_agent-shell_internal_context_v2');
const stripY = v2dir.y + v2dir.height + 40;
const stripX = (i) => v2dir.x + i * 260;
const splitId = `${HOST}__s1_Split`;

// 幂等：重跑时按 id 过滤已存在节点（derive 前缀清理不覆盖手加节点）
const newNodes = [
  { id: 'node_err_cfg', x: stripX(0), y: stripY, label: '接线修复\nToolLLM 未配置', layer: 'error', host: HOST },
  { id: 'node_err_llm', x: stripX(1), y: stripY, label: 'Section 暂不拆分\nLLM 调用失败', layer: 'error', host: HOST },
  { id: 'node_err_parse', x: stripX(2), y: stripY, label: '按无决策处理\nLLM 返回损坏 JSON', layer: 'error', host: HOST },
  { id: 'node_skip_graph', x: stripX(4), y: stripY, label: '跳过建图\n（纯工具执行）' },
  { id: 'node_graph_nodes', x: stripX(5), y: stripY, label: '建 N 个图节点\n（dec-{sectionID}-N）' },
];
const newIds = new Set(newNodes.map((n) => n.id));
dsl2.geometry.nodes = dsl2.geometry.nodes.filter((n) => !newIds.has(n.id));
dsl2.geometry.nodes.push(...newNodes);

// detail 节点重定位到条带第 4 槽（derive 默认放宿主正下方，会压住货架下一行）
const splitNode3 = dsl2.geometry.nodes.find((n) => n.id === splitId);
if (splitNode3) {
  splitNode3.x = stripX(3);
  splitNode3.y = stripY;
}

dsl2.animations_v2 = {
  version: 2,
  flows: [
    {
      id: 'flow_split_decisions',
      trigger: { type: 'event', event: 'section_folded' },
      from: HOST,
      handler: {
        file_id: HOST,
        api: 'Split',
        input_mapping: { msgs: '$value.section_messages' },
        errors: [
          {
            type: 'ErrClientNotConfigured',
            condition: "result.error && String(result.error.message).indexOf('not configured') >= 0",
            severity: 'unexpected',
            to: 'node_err_cfg',
            effect: 'node_flash_red',
            log: 'DecisionSplitter: ToolLLM 未配置——组装器接线错误（bug）',
          },
          {
            type: 'ErrLLMCallFailed',
            condition: "result.error && String(result.error.message).indexOf('LLM call failed') >= 0",
            severity: 'expected',
            to: 'node_err_llm',
            effect: 'particle_red',
            log: 'DecisionSplitter: LLM 调用失败，Section 暂不拆分',
          },
          {
            type: 'ErrParseFailed',
            condition: "result.error && String(result.error.message).indexOf('parse failed') >= 0",
            severity: 'expected',
            to: 'node_err_parse',
            effect: 'particle_red',
            log: 'DecisionSplitter: LLM 返回损坏 JSON，按无决策处理',
          },
        ],
      },
      branches: [
        {
          condition: 'Array.isArray(result.decisions) && result.decisions.length === 0',
          to: 'node_skip_graph',
          value: { type: 'no_decision', label: '无决策→跳过建图' },
          effect: 'particle_gray',
        },
        {
          condition: 'else',
          to: 'node_graph_nodes',
          value: { type: 'decision_nodes', label: '建 N 个图节点' },
          effect: 'particle_green',
        },
      ],
    },
  ],
};
saveDSL(dsl2);
console.log('[flow] flow_split_decisions：3 errors 声明 + 2 branches + 5 新节点');
console.log('  severity 依据：not configured = 接线 bug（unexpected）；LLM 波动/JSON 损坏 = 业务可预期（expected）');

// ═══════════ 阶段 4：inject_replay 验证 ═══════════
console.log('\n━━━ 阶段 4：inject_replay 六场景 ━━━');
const scenes = [
  ['① 列出预设场景', { list_presets: true }],
  ['② preset=ErrLLMCallFailed（expected）', { preset: 'ErrLLMCallFailed' }],
  ['③ preset=ErrParseFailed（expected）', { preset: 'ErrParseFailed' }],
  ['④ preset=ErrClientNotConfigured（unexpected=bug）', { preset: 'ErrClientNotConfigured' }],
  ['⑤ 未声明异常 context canceled → 应触发 bug 警报', {
    inject: { error: { code: 'CONTEXT_CANCELED', message: 'context deadline exceeded' } },
  }],
  ['⑥ 正常多决策 → 建图分支', { inject: { decisions: [{ label: '选 FIFO 淘汰' }, { label: '用 ToolLLM 拆分' }] } }],
  ['⑦ 正常空决策 → 跳过分支', { inject: { decisions: [] } }],
];
for (const [title, args] of scenes) {
  console.log(`\n── ${title} ──`);
  const r = injectReplay({ feature: FEATURE, flow_id: 'flow_split_decisions', ...args });
  console.log(r.message);
}

// ═══════════ 渲染 ═══════════
const { renderHTML } = await import('../dist/src/renderer/html_renderer.js');
const html = renderHTML(getDSL(FEATURE));
fs.mkdirSync('output', { recursive: true });
fs.writeFileSync('output/ai_base.html', html, 'utf-8');
console.log('\n[render] output/ai_base.html');
