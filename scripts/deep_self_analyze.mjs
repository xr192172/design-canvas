// npm run self-analyze:deep —— 全量深度自我分析
// 在 self_analyze.mjs（只对 3 个关键文件开 detail 链）基础上，对【每个有内部调用的文件】
//   → derive_detail_chain（函数间加工链）
//   → derive_algorithm（入口函数控制流图）
// 让星图每一层都有真实内容，而非只有 LLM 职责标题的骨架。
//
// 与 self_analyze.mjs 的分工：
//   - 语义层（每个文件的人话职责标题）：已由 import_project gen_roles=true 全量覆盖
//   - 机械层（detail 链 + 算法 CFG）：本脚本全量补齐
//
// 隔离存储 DESIGN_CANVAS_HOME=.tmp_self_analyze_deep，全程不碰活态 design-canvas.json。
// 用法：npm run self-analyze:deep（内含 build）
import fs from 'node:fs';
import path from 'node:path';

process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_self_analyze_deep');

const { getDSL, saveDSL } = await import('../dist/src/storage.js');
const { importProject } = await import('../dist/src/tools/import_project.js');
const { deriveDetailChain } = await import('../dist/src/tools/derive_chain.js');
const { deriveAlgorithm } = await import('../dist/src/tools/derive_algorithm.js');
const { renderHTML } = await import('../dist/src/renderer/html_renderer.js');
const { detectArchLayers } = await import('../dist/src/tools/layer_detect.js');
const { openDb } = await import('../dist/src/db/db.js');
const { registerArtifactTo } = await import('../dist/src/tools/registry.js');

const REG_FILE = path.resolve('output', '.registry.json');
const regArt = (rel, meta) => { try { registerArtifactTo(REG_FILE, { path: rel, ...meta }); } catch { /* 注册失败不阻塞 */ } };

const FEATURE = 'self_analyze_deep';
const SRC = 'src';

const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
const fileNodeId = (rel) => `file_${sanitize(rel)}`;

// ── 1. import_project：全量导入自身 src（含 LLM 职责标题） ─────────
console.log('═══ 1/4 import_project：全量导入自身 src（gen_roles 语义层） ═══');
const cacheDb = openDb(path.resolve('.design-canvas', 'cache.db'));
const imp = await importProject({
  project_dir: SRC,
  feature: FEATURE,
  title: 'design-canvas 全量深度自我分析',
  cache_db: cacheDb,
  gen_roles: true, // 语义层：LLM 为每个文件生成中文职责标题
});
cacheDb.close();
console.log(imp.message);

{
  const dsl = getDSL(FEATURE);
  dsl.theme = 'star';
  saveDSL(dsl);
}

// ── 2. 全量 derive_detail_chain：每个文件开加工链 ────────────────
console.log('\n═══ 2/4 全量 derive_detail_chain：每个文件加工链 ═══');
const dsl0 = getDSL(FEATURE);
const fileNodes = dsl0.geometry.nodes.filter((n) => n.type === 'file');
const chainResults = [];
let chainCreated = 0;
for (const n of fileNodes) {
  const relPath = n.description; // import_project 把相对 src 的路径放 description
  try {
    const r = await deriveDetailChain({
      feature: FEATURE,
      node_id: n.id,
      source_path: path.join(SRC, relPath),
    });
    chainResults.push({
      path: relPath,
      ok: true,
      steps: r.chain.length,
      entry: r.chain[0]?.name ?? '',
      nodes: r.nodes_created,
    });
    chainCreated += r.nodes_created;
  } catch (e) {
    chainResults.push({ path: relPath, ok: false, reason: e.message.split('\n')[0] });
  }
}
const okChains = chainResults.filter((r) => r.ok);
const flatChains = okChains.filter((r) => r.steps === 1);
console.log(`文件 ${fileNodes.length} 个 → detail 链成功 ${okChains.length}（新增节点 ${chainCreated}）· 扁平单节点 ${flatChains.length} · 失败 ${chainResults.length - okChains.length}`);
for (const f of chainResults.filter((r) => !r.ok)) {
  console.log(`  [跳过] ${f.path}: ${f.reason}`);
}

// ── 3. 全量 derive_algorithm：对每个成功文件的入口函数开控制流 ─────
console.log('\n═══ 3/4 全量 derive_algorithm：入口函数控制流 ═══');
const algResults = [];
let algCreated = 0;
for (const r of okChains) {
  if (!r.entry) {
    algResults.push({ path: r.path, fn: '', ok: false, reason: '无入口函数' });
    continue;
  }
  try {
    const a = await deriveAlgorithm({
      feature: FEATURE,
      node_id: fileNodeId(r.path),
      function: r.entry,
      source_path: path.join(SRC, r.path),
    });
    algResults.push({ path: r.path, fn: r.entry, ok: true, stats: a.stats });
    algCreated += a.nodes_created;
  } catch (e) {
    algResults.push({ path: r.path, fn: r.entry, ok: false, reason: e.message.split('\n')[0] });
  }
}
const okAlgs = algResults.filter((r) => r.ok);
console.log(`算法 CFG 成功 ${okAlgs.length}（新增节点 ${algCreated}）· 失败 ${algResults.length - okAlgs.length}`);
for (const f of algResults.filter((r) => !r.ok)) {
  console.log(`  [跳过] ${f.path}(${f.fn || '(无)'}): ${f.reason}`);
}

// ── 4. 输出 LLM 标注任务清单 + 渲染深度星图 ─────────────────────
console.log('\n═══ 4/4 渲染深度星图 + 标注任务清单 ═══');
const dsl = getDSL(FEATURE);
const dslLayered = detectArchLayers(dsl);
const nNodes = dslLayered.geometry.nodes.length;
const nDeep = dslLayered.geometry.nodes.filter((n) => (n.layer || 'main') !== 'main').length;

// 标注任务清单：每个有内部调用的文件一节，供 LLM 把 detail/算法节点 label 人话化
const escMd = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const taskLines = [
  '# design-canvas 全量深度分析 · LLM 标注任务清单',
  '',
  `> 生成于 ${new Date().toLocaleString('zh-CN')} · 语义层（文件职责标题）已由 import_project gen_roles 完成`,
  `> 本清单只列出有内部调用、已展开 detail 链/算法 CFG 的文件（${okChains.length} 个）`,
  `> 建议标注：把 detail 链步骤 label 人话化（如 "① 预算核算"），算法 CFG 节点 label 可保留（已含条件/动作）`,
  '',
  '标注原则：',
  '- 非开发者可读：说"做什么"，不说"怎么实现"',
  '- 一句话 ≤ 60 字，不重复文件名',
  '- update_node 修改节点 label / shapes.in/out 的 label',
  '',
];
for (const r of okChains) {
  taskLines.push(`## ${r.path}`);
  taskLines.push('');
  taskLines.push(`- **节点 id**: \`${fileNodeId(r.path)}\``);
  const sem = dslLayered.semantic?.files?.find((f) => f.id === fileNodeId(r.path));
  taskLines.push(`- **职责标题**: ${escMd(sem?.responsibility ?? '')}`);
  taskLines.push(`- **detail 链**: ${r.steps} 步${r.steps === 1 ? '（扁平，退化单节点）' : ''}`);
  const alg = algResults.find((a) => a.path === r.path);
  if (alg?.ok && alg.stats) {
    taskLines.push(`- **算法 CFG**: ${alg.fn}() ${alg.stats.steps}步·${alg.stats.branches}分支·${alg.stats.loops}循环·${alg.stats.returns}return`);
  }
  taskLines.push('');
}
const taskContent = taskLines.join('\n');
fs.mkdirSync('output', { recursive: true });
const taskFile = path.resolve('output', 'self_analyze_deep_tasks.md');
fs.writeFileSync(taskFile, taskContent, 'utf-8');

const report = {
  subline: `生成于 ${new Date().toLocaleString('zh-CN')} · 数据源：src/ 静态解析 + LLM 职责标注`,
  metrics: [
    { label: '文件', value: String(imp.files_parsed) },
    { label: '符号', value: String(imp.symbols_found) },
    { label: '依赖边', value: String(imp.dep_edges) },
    { label: '深层节点', value: String(nDeep) },
    { label: 'detail 链', value: String(okChains.length) },
    { label: '算法 CFG', value: String(okAlgs.length) },
  ],
  tour: [
    ...(okChains.length > 0
      ? [{ node_id: fileNodeId(okChains[0].path), text: `点 ${okChains[0].path} 左上 ▸ 角标，展开 ${okChains[0].steps} 步调用链` }]
      : []),
    ...(okAlgs.length > 0
      ? [{ node_id: fileNodeId(okAlgs[0].path), text: `再钻 ${okAlgs[0].fn}() 的算法控制流：分支=◆ 循环=⬡` }]
      : []),
  ],
};
const html = renderHTML(dslLayered, {
  report,
  nav: { home_href: './index.html', home_label: '主页' },
  compact_toolbar: true,
});
const out = path.resolve('output', 'self_analyze_deep.html');
fs.writeFileSync(out, html, 'utf-8');
regArt('self_analyze_deep.html', { feature: FEATURE, title: '全量深度星图', type: 'feature_diagram', language: 'ts', status: dsl.status || 'done' });
regArt('self_analyze_deep_tasks.md', { feature: FEATURE, title: '深度分析 LLM 标注任务清单', type: 'report', language: 'ts', status: 'done' });

console.log(`节点 ${nNodes}（深层 ${nDeep}）· 边 ${dsl.geometry.edges.length}`);
console.log(`\n[输出] ${out} (${(html.length / 1024).toFixed(0)}KB)`);
console.log(`[输出] ${taskFile}（${okChains.length} 节标注任务）`);

// ── 清理 ──────────────────────────────────────────────────────
fs.rmSync('.tmp_self_analyze_deep', { recursive: true, force: true });
console.log('[cleanup] .tmp_self_analyze_deep removed');