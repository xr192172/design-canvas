// 一次性脚本：camera_v2 c1-c8/f1/f2 回填决策卡（attributes + decision），并用新 renderer 重渲染。
// 背景：会话 MCP server 为旧进程不透传新字段，故直接改 DSL JSON；渲染走本地 dist 新代码。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dslPath = root + '../.design-canvas/features/camera_v2.json';
const outHtml = root + '../camera-conformance/camera_v2_mindmap.html';

// 走正规通道：storage.saveDSL 同时更新活态文件 + feature 存档（getDSL 优先读活态）
const storage = await import(pathToFileURL(root + '../dist/src/storage.js').href);
const dsl = storage.getDSL('camera_v2');
if (!dsl) throw new Error('feature camera_v2 不存在（getDSL 返回 null）');
const nodes = new Map(dsl.geometry.nodes.map(n => [n.id, n]));

// ── 决策卡数据（2026-08-18 设计对谈的最终结论）──
const cards = {
  c1: {
    attributes: { scope: '所有事件留存层', rule: '占用 = O(探针数) 或 O(固定预算)', growth: '常数' },
    decision: {
      summary: '任何事件留存层，跑 1 秒与跑 1 年占用必须相同（常数）',
      rationale: '爆盘爆内存同源：O(事件量) 增长注定爆，只是爆得快慢（盘 TB 级、内存几十 GB）',
      alternatives: [
        { option: '全落盘', rejected_because: '实测 200MB/s 峰值，跑一小会爆盘' },
        { option: '全内存', rejected_because: '容量更小，死得更快' },
      ],
      consequences: '聚合类信息（计数/分布）永远安全；留存类必须预分配+有淘汰',
      acceptance: '审查每一层数据结构：跑一年，占用是常数',
    },
  },
  c2: {
    attributes: { probes: 3603, rate_limit_per_s: 200, bytes_per_event: 300, peak_MB_s: 200, duty_cycle: '5%', MB_per_min: 600 },
    decision: {
      summary: '爆盘根因 = 每事件必留存，与存放介质无关',
      rationale: '3603 探针×200/s×300B≈200MB/s；5% 占空比≈600MB/min',
      alternatives: [{ option: '换更大硬盘/内存', rejected_because: '治标不治本，增长率不变' }],
      consequences: 'v1 架构（每事件写 JSONL）不可用于全量模式',
      acceptance: 'v2 任何模式下磁盘写入速率有硬上限',
    },
  },
  c3: {
    attributes: { fields: 'hit, err', bytes_per_probe: 16, total_KB_at_3603: 60, mode: '常开' },
    decision: {
      summary: '每探针两个 int64 计数器（hit/err），永久常开',
      rationale: '承载趋势/频率信息（80 万次调用/3 次错误），与错误现场两类信息互不替代',
      alternatives: [{ option: '只留错误现场不要计数', rejected_because: '无错时对系统健康度失明' }],
      consequences: '不能回答"第 N 次调用参数是什么"（本来也不需要）',
      acceptance: '任意时长运行后计数器可读出总调用/错误数',
    },
  },
  c4: {
    attributes: { buckets_per_probe: 20, bytes_per_bucket: 8, total_KB_at_3603: 600, mode: '常开' },
    decision: {
      summary: '每探针固定桶耗时直方图，常开',
      rationale: '回答"平均 12ms 还是长尾 2s"——聚合态即可，无需逐条记录',
      alternatives: [{ option: '记录每次耗时的明细', rejected_because: 'O(事件量) 增长，违反 c1 铁律' }],
      acceptance: '直方图可读出 P50/P99 形态（近似）',
    },
  },
  c5: {
    attributes: { budget_MB: 64, strategy: '预分配+滚动覆盖', disk_write_normal: 0, semantics: '一直在录，坠毁才打开' },
    decision: {
      summary: '环形缓冲常录：预分配固定预算滚动覆盖，平时永不落盘',
      rationale: '构造性有界：溢出=旧事件被覆盖，数学上不可能爆。嵌入式三十年验证（黑匣子/内核 trace ring）',
      alternatives: [
        { option: '普通队列+落盘', rejected_because: '爆盘已证' },
        { option: '出事才开始录', rejected_because: '错误之前的上下文已流走，录不到' },
      ],
      consequences: '超出窗口的旧事件永久丢失（可接受：细节只在错误附近有价值）',
      acceptance: '任意压力下内存占用恒等于预算值；正常期磁盘写入为 0',
    },
  },
  c6: {
    attributes: { trigger: 'catch 探针', export_scope: '错误前后窗口+链路各层窗口', disk_mode: '仅错误时落盘' },
    decision: {
      summary: '错误开箱导出：catch 触发才落盘，导出该函数+链路对应窗口',
      rationale: '"出错才采集"的正确实现=平时常录+错误时导出；平时零磁盘开销',
      alternatives: [{ option: '持续落盘+事后过滤', rejected_because: '爆盘已证' }],
      acceptance: '注入错误后，dump 文件含错误点前后完整上下文',
    },
  },
  c7: {
    attributes: { name: 'correlation ID', gen: '调用进入时生成', propagate: '层层显式传递', scope: '跨函数/goroutine/async' },
    decision: {
      summary: '链路串联靠 trace id：进入时生成、层层显式传递',
      rationale: '没有它错误触发只能捞局部窗口；有它才能捞整条链路上下文',
      alternatives: [{ option: '全局变量隐式传递', rejected_because: 'Go goroutine / TS async 下不成立' }],
      consequences: '探针 runtime 接口要加 trace id 参数，全部探针点受益',
      acceptance: '跨 3 层调用的错误 dump 中，各层窗口 trace id 一致',
    },
  },
  c8: {
    attributes: { export_quota_per_min: 10, degrade: '超限只计数不 dump', backpressure: '降精度而非报错' },
    decision: {
      summary: '导出限流+自适应采样：每探针导出限额，超限降级',
      rationale: '防错误风暴二次爆盘（catch 在循环里疯狂触发时，导出本身成为爆盘源）；事件越密采样率越低，吞吐收敛到预算内',
      acceptance: '错误风暴注入下，磁盘写入速率仍不超过限额',
    },
  },
  f2: {
    attributes: {
      p1: 'probe runtime 分级采集+correlation ID',
      p2: '风险点推荐器（静态扫描+图上批准）',
      p3: '行为等价对拍（事件流 diff）',
      p4: '轮转探索调度',
      p5: '欠约束诊断',
    },
    decision: {
      summary: '落地顺序：先 runtime 地基，后推荐器，再对拍',
      rationale: '分级采集是其余一切的地基（没有它全量成本不可承受）；推荐器解"插哪"盲区；对拍是重构安全网',
      consequences: 'p1 完成前不动其他件',
      acceptance: '每件独立 CLI 可单独验证（模块化阶段式）',
    },
  },
};

let applied = 0;
for (const [id, card] of Object.entries(cards)) {
  const n = nodes.get(id);
  if (!n) throw new Error(`节点 ${id} 不存在`);
  n.attributes = card.attributes;
  n.decision = card.decision;
  applied++;
}
storage.saveDSL(dsl, 'backfill-script');
console.log(`已回填 ${applied} 张决策卡（saveDSL：活态+存档同步）`);

// ── 用新编译的 renderer 重渲染 ──
const { renderHTML } = await import(pathToFileURL(root + '../dist/src/renderer/html_renderer.js').href);
const html = renderHTML(dsl);
writeFileSync(outHtml, html, 'utf8');
console.log(`已重渲染 → ${outHtml}（含 ${html.split('decision-badge').length - 1} 处决策卡标记）`);
