/**
 * design-canvas serve：轻量 HTTP 服务器
 *
 * 提供：
 *   1. 静态文件服务（HTML 页面）
 *   2. /api/save —— 保存 DSL（浏览器端自动回写）
 *   3. /api/load —— 读取 DSL（页面启动时同步）
 *   4. /api/events —— SSE 实时推送（LLM 改 DSL 时画布自动刷新）
 *
 * 启动方式：
 *   node dist/src/tools/serve.js [port]
 *   或 npm run serve
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { saveDSL, getDSL, getLiveDslFile, getLiveFeature, onDslChange } from '../storage.js';
import { enableCameraFromEnv } from '../camera/run_sentinel.js';
import { judgeEvent } from '../camera/judge.js';
import { queryCameraLog } from '../camera/log_query.js';
import { judgeEvents, normalizeEvents, renderJudgeReport } from '../camera/judge_service.js';
import { judgeGuardLog } from '../camera/judge_guard.js';
import { importProject } from './import_project.js';
import { getProjectCacheDb } from '../db/db.js';
import { validateDSLJson } from '../dsl/validator.js';
import { dagLayout, forceLayout, gridAlign } from './dag_layout.js';
import { scaffold } from './scaffold.js';
import { checkConsistency } from './consistency.js';
import { diffImpact } from './diff_impact.js';
import { diffViews } from './diff_views.js';
import { watchProject } from './watch_project.js';
import { createRebuildThrottler } from './watch_project_tool.js';
import { archLayer } from './arch_layer.js';
import { guidedTour } from './guided_tour.js';
import { semanticSearch } from './semantic_search.js';
import { languageConcepts } from './language_concepts.js';
import { buildDictionaryView, getGlobalDictFile, getProjectDictFile, loadGlobalDict, loadProjectDict, saveGlobalEntry, saveProjectEntry, splitHighlights, validateProjectRoot, type DictEntry } from './dictionary.js';
import { ingestTerm, classifyTerm, generateDictEntry } from './dict_gen.js';
import { readRegistry, updateArtifact } from './registry.js';
import { checkMonolith } from './monolith.js';
import type { FileMonolithReport } from './monolith.js';
import { deriveMindMap, renderMindMapHtml } from './derive_mind_map.js';
import { getMindMapFile } from './derive_mind_map.js';
import { runMindmapAgent } from './mindmap_agent.js';
import { traceExecChain, type TraceStepSpec } from './trace_exec.js';
import { loadLlmConfig, pickKeyNodes, type ChainNodeInfo } from './llm_focus.js';
import {
  loadExplainConfig,
  generateModuleNarrations,
  loadGeneratedNarrations,
  saveGeneratedNarrations,
  getExplainGenFile,
} from './explain_gen.js';

const PORT = parseInt(process.argv[2]) || 3000;
const PUBLIC_DIR = path.join(process.cwd(), 'output');
const LIVE_FILE = getLiveDslFile();

// 项目根：默认 process.cwd()，可用 DC_PROJECT_DIR 覆盖（如聚焦 src/ 做设计图闭环演示）
function getServeProjectRoot(): string {
  const override = process.env.DC_PROJECT_DIR;
  return override ? path.resolve(process.cwd(), override) : process.cwd();
}

// SSE 客户端连接池
const sseClients: Set<http.ServerResponse> = new Set();

/** 向所有 SSE 客户端广播消息 */
export function broadcastSSE(event: string, data: unknown): void {
  const message = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

/** DSL 变更通知（供 MCP saveDSL 调用后触发） */
export function notifyDslChange(feature: string, source: string): void {
  broadcastSSE('dsl-changed', { feature, source, timestamp: new Date().toISOString() });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function handleApiSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const dslJson = body.toString('utf-8');

    const result = validateDSLJson(dslJson);
    if (!result.valid || !result.dsl) {
      sendError(res, 400, `DSL 校验失败：\n${result.errors.join('\n')}`);
      return;
    }

    // 传入 'browser' source，saveDSL 内部会以此 source 触发 SSE 回调，
    // 浏览器端 SSE 监听器据此跳过自身触发的刷新（避免循环 reload）
    saveDSL(result.dsl, 'browser');
    sendJson(res, 200, {
      success: true,
      message: 'DSL 已保存',
      feature: result.dsl.feature,
      saved_at: new Date().toISOString(),
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

function handleApiLoad(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    if (!fs.existsSync(LIVE_FILE)) {
      sendError(res, 404, 'design-canvas.json 不存在，请先使用 render_dsl 创建');
      return;
    }
    const content = fs.readFileSync(LIVE_FILE, 'utf-8');
    sendJson(res, 200, JSON.parse(content));
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

function handleApiFeatures(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const featuresDir = path.join(process.cwd(), '.design-canvas', 'features');
    if (!fs.existsSync(featuresDir)) {
      sendJson(res, 200, { features: [] });
      return;
    }
    const files = fs.readdirSync(featuresDir).filter((f) => f.endsWith('.json'));
    const features = files.map((f) => {
      const content = fs.readFileSync(path.join(featuresDir, f), 'utf-8');
      const dsl = JSON.parse(content);
      return { feature: dsl.feature, title: dsl.title || dsl.feature };
    });
    sendJson(res, 200, { features });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** GET /api/camera/log?file=<path>&file=<path>&all=1：按文件路径查询 Camera 异常日志。
 * 事件文件取自 CAMERA_EVENTS_FILE；未设置时返回 424（未启用）。可与
 * camera-dsl log --file <path> 等价使用，供 LLM/前端按文件主动拉取某条链路的日志。 */
function handleApiCameraLog(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const eventsPath = process.env.CAMERA_EVENTS_FILE;
    if (!eventsPath) {
      sendError(res, 424, 'CAMERA_EVENTS_FILE 未设置，Camera 日志未启用。请在启动 serve 前设置该环境变量。');
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const files = url.searchParams.getAll('file').filter((f) => f.trim() !== '');
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    const result = queryCameraLog(eventsPath, { files, all });
    sendJson(res, 200, result);
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** Camera 判定下沉服务（语言无关）：POST /api/camera/judge 判定一批事件。
 * body: { events: TSEvent[] } → 逐条判定 + 汇总。任何语言的探针都能 POST。
 * 可选 ?text=1 返回人类可读报告（等价 Go RenderReport）。 */
async function handleApiCameraJudge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf-8') || '{}');
    } catch {
      sendError(res, 400, '请求体需为合法 JSON：{ "events": [...] }');
      return;
    }
    const raw = (parsed as { events?: unknown }).events;
    const { events, error } = normalizeEvents(raw);
    if (error) {
      sendError(res, 400, error);
      return;
    }
    const result = judgeEvents(events);
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('text') === '1') {
      sendJson(res, 200, { text: renderJudgeReport(result), ...result });
      return;
    }
    sendJson(res, 200, result);
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** GET /api/live?feature=：读取实际 DSL（代码实时快照，live/ 目录） */
function handleApiLive(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const feature = (url.searchParams.get('feature') || '').trim();
    if (!feature) {
      sendError(res, 400, '缺少 feature 参数');
      return;
    }
    const dsl = getLiveFeature(feature);
    if (!dsl) {
      sendError(res, 404, '实际 DSL 未生成，请先 POST /api/live/rebuild 或等待自动同步');
      return;
    }
    sendJson(res, 200, dsl);
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/live/rebuild?feature=：从当前项目重建实际 DSL 到 live/（不覆盖设计 DSL） */
async function handleApiLiveRebuild(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const feature = (url.searchParams.get('feature') || '').trim();
    if (!feature) {
      sendError(res, 400, '缺少 feature 参数');
      return;
    }
    const projectRoot = getServeProjectRoot();
    let cacheDb;
    try {
      cacheDb = getProjectCacheDb(projectRoot);
    } catch {
      cacheDb = undefined;
    }
    const result = await importProject({ project_dir: projectRoot, feature, cache_db: cacheDb, live_only: true });
    // 重建成功后推送 SSE：打开的画布自动刷新并重新跑 diff 高亮（source=watch，非 browser，避免循环）
    broadcastSSE('dsl-changed', { feature, source: 'watch', timestamp: new Date().toISOString() });
    sendJson(res, 200, {
      success: true,
      message: result.message.split('\n')[0],
      files: result.files_parsed,
      symbols: result.symbols_found,
      cache: result.cache ?? null,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** 递归扫描目录下源文件：最新 mtime + 晚于 since 的变更数 */
function scanSrcMtime(dir: string, since: number): { latest: number; changed: number } {
  let latest = 0;
  let changed = 0;
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs|py|go|vue)$/.test(name)) continue;
      latest = Math.max(latest, st.mtimeMs);
      if (st.mtimeMs > since) changed++;
    }
  };
  walk(dir);
  return { latest, changed };
}

/** GET /api/report_status：报告保鲜检测（Hub 主页生成时间 vs src/ 最新变更） */
function handleApiReportStatus(_req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const hubFile = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(hubFile)) {
      sendJson(res, 200, { exists: false, stale: false });
      return;
    }
    const generatedMs = fs.statSync(hubFile).mtimeMs;
    const srcDir = path.join(process.cwd(), 'src');
    const { latest, changed } = fs.existsSync(srcDir) ? scanSrcMtime(srcDir, generatedMs) : { latest: 0, changed: 0 };
    sendJson(res, 200, {
      exists: true,
      generated_at: new Date(generatedMs).toISOString(),
      src_latest: latest ? new Date(latest).toISOString() : null,
      stale: changed > 0,
      changed_files: changed,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/regenerate：重新生成自我分析报告（跑 scripts/self_analyze.mjs，完成后 SSE 广播） */
let regenerating = false;
async function handleApiRegenerate(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const script = path.join(process.cwd(), 'scripts', 'self_analyze.mjs');
  if (!fs.existsSync(script)) {
    sendError(res, 400, 'scripts/self_analyze.mjs 不存在，当前项目不支持重新生成');
    return;
  }
  if (regenerating) {
    sendJson(res, 409, { error: '正在重新生成中，请稍候' });
    return;
  }
  regenerating = true;
  const t0 = Date.now();
  try {
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      const p = spawn('node', [script], { stdio: 'inherit' });
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`self_analyze 退出码 ${code}`))));
      p.on('error', reject);
    });
    broadcastSSE('report-regenerated', { at: new Date().toISOString() });
    sendJson(res, 200, { success: true, duration_ms: Date.now() - t0 });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  } finally {
    regenerating = false;
  }
}

/** 生成拆分任务单 Markdown（可直接喂给 LLM 执行拆分）；relPath 为相对 src/ 的展示路径 */
function buildSplitPlanMarkdown(r: FileMonolithReport, relPath: string, generatedAt: string): string {
  const statusLabel = r.status === 'critical' ? '严重' : '警告';
  const lines: string[] = [
    `# 拆分任务单：${relPath}`,
    '',
    `> 生成于 ${generatedAt} · design-canvas checkMonolith（tree-sitter 静态解析）`,
    '> 用法：本单可直接喂给 LLM 执行拆分，或人工按表搬移声明。',
    '',
    '## 现状',
    '',
    `| 项 | 值 |`,
    `|---|---|`,
    `| 行数 | ${r.lines}（阈值 警告≥300 / 严重≥600，状态：${statusLabel}） |`,
    `| 顶层声明 | ${r.decl_count} |`,
    `| 可拆社区 | ${r.communities.length} |`,
    '',
    `分析建议：${r.suggestion}`,
    '',
  ];

  if (r.communities.length === 0) {
    lines.push(
      '## 拆分方案',
      '',
      '该文件顶层声明不足 2 个（巨型单函数/类），无法自动社区划分。建议人工按职责段拆分：',
      '',
      '1. 通读文件，用注释标记职责段（如 `// ==== 相机控制 ====`）',
      '2. 每段提取为独立函数或子模块，逐个搬迁',
      '3. 搬迁完成后重新运行 `npm run self-analyze` 验证',
      '',
    );
  } else {
    lines.push('## 拆分方案（建议新文件）', '');
    r.communities.forEach((c, i) => {
      lines.push(`### ${i + 1}. \`${c.suggested_name}\`（~${c.est_lines} 行 · 内聚引用 ${c.internal_refs}）`, '');
      lines.push(`包含声明（${c.decls.length}）：`, '');
      for (const sig of c.signatures) lines.push(`- \`${sig}\``);
      lines.push('');
    });
  }

  if (r.inter_edges.length > 0) {
    lines.push('## 跨社区引用（搬迁时需补 import）', '');
    for (const [a, b, w] of r.inter_edges) {
      const from = r.communities[a]?.suggested_name ?? `社区${a}`;
      const to = r.communities[b]?.suggested_name ?? `社区${b}`;
      lines.push(`- \`${from}\` → \`${to}\`（引用权重 ${w}）`);
    }
    lines.push('');
  }

  lines.push(
    '## 执行步骤（LLM 按序执行）',
    '',
    `1. 通读 \`src/${relPath}\`，理解各声明职责`,
    '2. 按上表创建新文件，逐个搬移声明（保留 export）',
    '3. 跨社区引用处补 import 语句',
    '4. 原文件改为纯 re-export 聚合层（或删除并全局更新引用）',
    '5. `npm run build && npm test` 验证编译与测试',
    '6. `npm run self-analyze` 重新生成报告，确认巨石消除',
    '',
  );
  return lines.join('\n');
}

/** POST /api/split_plan { path }：为单个巨石文件生成拆分任务单 */
async function handleApiSplitPlan(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { path: relPath } = JSON.parse(body.toString('utf-8'));
    if (!relPath || typeof relPath !== 'string' || relPath.includes('..') || path.isAbsolute(relPath)) {
      sendError(res, 400, '非法 path（应为相对 src/ 的路径，如 renderer/scripts.ts）');
      return;
    }
    const absPath = path.join(process.cwd(), 'src', relPath);
    if (!fs.existsSync(absPath)) {
      sendError(res, 404, `文件不存在：src/${relPath}`);
      return;
    }
    const result = await checkMonolith({ files: [absPath], warn_lines: 300, crit_lines: 600 });
    const report = result.reports[0];
    if (!report) {
      sendError(res, 500, 'checkMonolith 未返回该文件报告');
      return;
    }
    if (report.status === 'ok') {
      sendJson(res, 200, { ok: true, markdown: `# ${relPath}\n\n该文件 ${report.lines} 行，未超阈值（警告≥300 行），无需拆分。\n` });
      return;
    }
    const markdown = buildSplitPlanMarkdown(report, relPath, new Date().toLocaleString('zh-CN'));
    sendJson(res, 200, {
      ok: true,
      markdown,
      filename: 'split_' + relPath.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md',
      lines: report.lines,
      communities: report.communities.length,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/**
 * 收集宿主节点下的 detail 链（含跨文件追加 __sx*，排除 CFG __alg_*）+ CFG 判定节点，
 * 供 trace-exec（真实执行）与 focus（LLM 选点）共用。
 */
function collectChainInfo(
  dsl: {
    geometry: { nodes: Array<{ id: string; x?: number; host?: string; layer?: string; label?: string; description?: string }> };
    semantic?: { files?: Array<{ id: string; path: string }> };
  },
  nodeId: string,
  projectRoot: string,
): { steps: TraceStepSpec[]; infos: ChainNodeInfo[] } {
  const rel = dsl.semantic?.files?.find((f) => f.id === nodeId)?.path;
  if (!rel) return { steps: [], infos: [] };
  const hostFile = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
  const nodes = dsl.geometry.nodes
    .filter((n) => n.host === nodeId && n.layer === 'detail' && !n.id.includes('__alg_'))
    .sort((a, b) => (a.x ?? 0) - (b.x ?? 0));

  const steps: TraceStepSpec[] = [];
  const infos: ChainNodeInfo[] = [];
  for (const n of nodes) {
    const funcName = (n.label || '').replace(/^[①-⑫]|^\d+\.\s*/, '').replace(/·.*$/, '').trim();
    if (!funcName) continue;
    const crossM = (n.description || '').match(/跨文件调用：(.+)$/m);
    let file = hostFile;
    if (crossM) {
      const t = crossM[1];
      if (path.isAbsolute(t)) {
        file = t;
      } else {
        // 跨文件目标相对 src/ 根（如 storage.ts），尝试 project_root 与 project_root/src 两候选
        const cands = [path.join(projectRoot, t), path.join(projectRoot, 'src', t)];
        file = cands.find((c) => fs.existsSync(c)) || cands[0];
      }
    }
    steps.push({ node_id: n.id, func_name: funcName, file_path: file });
    infos.push({
      node_id: n.id,
      label: n.label || n.id,
      func_name: funcName,
      description: (n.description || '').slice(0, 200),
      is_judgement: false,
      is_cross: n.id.includes('__sx'),
    });
  }
  // CFG 判定节点（跨文件 CFG 的 branch/loop，__alg_）
  const judgeNodes = (dsl.geometry.nodes as Array<{ id: string; label?: string; description?: string }>)
    .filter((n) => n.id.includes('__alg_') && /branch|loop/.test(n.description || ''));
  for (const j of judgeNodes) {
    infos.push({
      node_id: j.id,
      label: j.label || j.id,
      func_name: (j.label || '').replace(/^▶\s*/, ''),
      description: (j.description || '').slice(0, 200),
      is_judgement: true,
      is_cross: false,
    });
  }
  return { steps, infos };
}

/** POST /api/trace-exec：数据流真实执行——从宿主节点构造链路步骤，喂用户输入真实运行链上函数 */
async function handleApiTraceExec(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { feature, node_id, input_value } = JSON.parse(body.toString('utf-8'));
    const dsl = getDSL(feature);
    if (!dsl) {
      sendError(res, 404, `feature "${feature}" 不存在`);
      return;
    }
    if (!dsl.geometry.nodes.some((n) => n.id === node_id)) {
      sendError(res, 404, `节点 "${node_id}" 不存在于 feature "${feature}"`);
      return;
    }
    const projectRoot = getServeProjectRoot();
    const { steps, infos } = collectChainInfo(dsl, node_id, projectRoot);
    if (infos.length === 0) {
      sendError(res, 400, '宿主节点下无 detail 链节点可真实执行（先 derive_detail_chain）');
      return;
    }

    const result = await traceExecChain({ steps, input_value });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/focus：LLM 从全链选关键节点（只选点不造值，数据真实性仍由 trace-exec 保证） */
async function handleApiFocus(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { feature, node_id, user_focus } = JSON.parse(body.toString('utf-8'));
    const dsl = getDSL(feature);
    if (!dsl) {
      sendError(res, 404, `feature "${feature}" 不存在`);
      return;
    }
    if (!dsl.geometry.nodes.some((n) => n.id === node_id)) {
      sendError(res, 404, `节点 "${node_id}" 不存在于 feature "${feature}"`);
      return;
    }
    const { infos } = collectChainInfo(dsl, node_id, process.cwd());
    if (infos.length === 0) {
      sendError(res, 400, '宿主节点下无 detail 链节点（先 derive_detail_chain）');
      return;
    }
    const cfg = loadLlmConfig();
    const result = await pickKeyNodes(cfg, infos, { max: 5, userFocus: user_focus });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

async function handleApiLayout(req: http.IncomingMessage, res: http.ServerResponse, layoutType: 'dag' | 'force' | 'grid'): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const feature = params.feature || 'conveyor';

    let result: Record<string, unknown> = {};
    switch (layoutType) {
      case 'dag':
        result = dagLayout({
          feature,
          direction: params.direction,
          h_gap: params.h_gap,
          v_gap: params.v_gap,
          width: params.width,
          respect_swimlanes: params.respect_swimlanes,
        });
        break;
      case 'force':
        result = forceLayout({
          feature,
          repulsion: params.repulsion,
          stiffness: params.stiffness,
          damping: params.damping,
          iterations: params.iterations,
          node_radius: params.node_radius,
          width: params.width,
          height: params.height,
        });
        break;
      case 'grid':
        result = gridAlign({
          feature,
          grid_size: params.grid_size,
        });
        break;
    }

    sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

async function handleApiScaffold(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    let safeOutputDir: string | undefined;
    if (params.output_dir) {
      // 显式传了 output_dir：必须落在允许的项目根范围内（防止写入系统目录）
      safeOutputDir = validateProjectRoot(params.output_dir, '/api/scaffold output_dir');
    }
    const result = scaffold({
      feature: params.feature || 'conveyor',
      output_dir: safeOutputDir,
      overwrite: params.overwrite,
      ui_framework: params.ui_framework,
    });
    sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (e) {
    const code =
      (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') || (e as Error).message.includes('不能为空') ? 403 : 500;
    sendError(res, code, (e as Error).message);
  }
}

async function handleApiConsistency(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const result = await checkConsistency({
      feature: params.feature || 'conveyor',
      code_dir: params.code_dir,
    });
    sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

async function handleApiDiffImpact(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const safeDir = validateProjectRoot(params.project_dir || process.cwd(), '/api/diff-impact project_dir');
    const result = diffImpact({
      feature: params.feature || 'conveyor',
      project_dir: safeDir,
      changed: Array.isArray(params.changed) ? params.changed : [],
      direction: params.direction,
      max_depth: params.max_depth,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    const code =
      (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') || (e as Error).message.includes('不能为空') ? 403 : 500;
    sendError(res, code, (e as Error).message);
  }
}

/** POST /api/mind-map：生成 L3 思维导图（feature → 功能 → 社区 → 文件），返回查看器 HTML */
async function handleApiMindMap(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const feature = (params.feature || '').trim();
    if (!feature) {
      sendError(res, 400, '缺少 feature 参数');
      return;
    }
    const result = await deriveMindMap({
      feature,
      gen_descriptions: params.gen_descriptions === true,
      max_files_per_community: typeof params.max_files_per_community === 'number' ? params.max_files_per_community : 20,
    });
    sendJson(res, 200, { success: true, ...result, mind_map: result.mind_map });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** GET /api/mind-map?feature=&html=1：读取已生成的思维导图 JSON；html=1 返回查看器页面 */
function handleApiMindMapGet(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const feature = (url.searchParams.get('feature') || '').trim();
    if (!feature) {
      sendError(res, 400, '缺少 feature 参数');
      return;
    }
    const file = getMindMapFile(feature);
    if (!fs.existsSync(file)) {
      sendError(res, 404, '思维导图未生成，请先 POST /api/mind-map 或调用 derive_mind_map');
      return;
    }
    const mindMap = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (url.searchParams.get('html') === '1') {
      const html = renderMindMapHtml(mindMap, mindMap.feature || feature);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    sendJson(res, 200, { success: true, mind_map: mindMap });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/mmd/chat：L3 思维导图只读问答 Agent（SSE 流式进度） */
async function handleApiMmdChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const feature = (params.feature || '').trim();
    const message = (params.message || '').trim();
    if (!feature || !message) {
      sendError(res, 400, '缺少 feature/message 参数');
      return;
    }
    const history = Array.isArray(params.history) ? params.history : [];
    const result = await runMindmapAgent({ feature, message, history });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/diff-views：设计视图 vs 实际代码快照 图级对比（最后一英里） */
async function handleApiDiffViews(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const feature = (params.feature || '').trim();
    if (!feature) {
      sendError(res, 400, '缺少 feature 参数');
      return;
    }
    const result = diffViews({ feature, live_dir: params.live_dir });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/semantic-search：全项目符号语义搜索（序号8） */
async function handleApiSemanticSearch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const safeDir = validateProjectRoot(params.project_dir || process.cwd(), '/api/semantic-search project_dir');
    const result = await semanticSearch({
      project_dir: safeDir,
      query: params.query || '',
      limit: params.limit,
      min_score: params.min_score,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') ? 403 : 500, (e as Error).message);
  }
}

/** POST /api/arch-layer：架构分层分析（序号5+7） */
async function handleApiArchLayer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const result = archLayer({
      feature: params.feature || 'conveyor',
      persist: params.persist,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** POST /api/language-concepts：语言级编程模式识别（序号10） */
async function handleApiLanguageConcepts(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const safeDir = validateProjectRoot(params.project_dir || process.cwd(), '/api/language-concepts project_dir');
    const result = languageConcepts({
      project_dir: safeDir,
      concepts: params.concepts,
      files: params.files,
      limit: params.limit ?? 200,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') ? 403 : 500, (e as Error).message);
  }
}

/** POST /api/guided-tour：Guided Tours 学习路径生成（序号6） */
async function handleApiGuidedTour(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const result = guidedTour({
      feature: params.feature || 'conveyor',
      include_deep: params.include_deep,
      include_containers: params.include_containers,
      max_steps: params.max_steps,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

// ─────────────────────────────────────────────────────────────
// 词典 API（路线图序号12：伪维基）
// ─────────────────────────────────────────────────────────────

/** POST /api/dict/query：查词典（含全局+项目合并、互链、高亮拆分） */
async function handleApiDictQuery(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const safeRoot = validateProjectRoot(params.project_dir || process.cwd(), '/api/dict/query project_dir');
    const view = buildDictionaryView(safeRoot);
    const term = params.term;
    let entry: DictEntry | null = null;
    if (term) entry = view.entries.find((e) => e.term === term) ?? null;
    sendJson(res, 200, {
      success: true,
      entries: view.entries,
      links: view.links,
      aliasesIndex: view.aliasesIndex,
      entry,
      global_file: getGlobalDictFile(),
      project_file: getProjectDictFile(safeRoot),
    });
  } catch (e) {
    const code =
      (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') || (e as Error).message.includes('不能为空') ? 403 : 500;
    sendError(res, code, (e as Error).message);
  }
}

/** POST /api/dict/highlight：对给定文本做高亮拆分（返回命中词条片段） */
async function handleApiDictHighlight(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const safeRoot = validateProjectRoot(params.project_dir || process.cwd(), '/api/dict/highlight project_dir');
    const view = buildDictionaryView(safeRoot);
    const text = params.text ?? '';
    const pieces = splitHighlights(text, view);
    sendJson(res, 200, { success: true, pieces });
  } catch (e) {
    const code =
      (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') || (e as Error).message.includes('不能为空') ? 403 : 500;
    sendError(res, code, (e as Error).message);
  }
}

/** POST /api/dict/ingest：LLM 分类 + 生成三档 + 注入词典（伪维基动态学习）
 *  传 dry_run=true 时仅预览（分类+生成，不落库），供前端审批弹窗预览后再确认收录。 */
async function handleApiDictIngest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const source = (params.term ?? '').trim();
    if (!source) {
      sendJson(res, 400, { success: false, message: '缺少 term 参数' });
      return;
    }
    const safeRoot = validateProjectRoot(params.project_dir || process.cwd(), '/api/dict/ingest project_dir');
    const projectHint = params.project_hint ?? '';
    const dryRun = params.dry_run === true;
    const result = await ingestTerm(source, safeRoot, projectHint, { save: !dryRun });
    sendJson(res, 200, { success: true, ...result, dry_run: dryRun });
  } catch (e) {
    const code =
      (e as Error).message.includes('超出允许范围') || (e as Error).message.includes('路径穿越') || (e as Error).message.includes('不能为空') ? 403 : 500;
    sendError(res, code, (e as Error).message);
  }
}

/** POST /api/dict/generate：仅生成不落库（预览用，前端可选） */
async function handleApiDictGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8'));
    const term = (params.term ?? '').trim();
    if (!term) {
      sendJson(res, 400, { success: false, message: '缺少 term 参数' });
      return;
    }
    const cfg = loadExplainConfig();
    if (!cfg) {
      sendJson(res, 200, { success: false, message: '未配置 LLM，无法生成' });
      return;
    }
    const gen = await generateDictEntry(term, cfg);
    sendJson(res, 200, { success: true, ...gen });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** GET /api/git-diff：取当前仓库未提交/未跟踪的改动文件清单（相对 process.cwd() 的 posix 路径） */
async function handleApiGitDiff(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { execFile } = await import('node:child_process');
  const cwd = process.cwd();
  // 跑 git 命令；失败（非仓库/无 git）→ 返回该组空清单
  const run = (args: string[]): Promise<{ ok: boolean; lines: string[] }> =>
    new Promise((resolve) => {
      execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve({ ok: false, lines: [] });
        resolve({ ok: true, lines: stdout.split('\n').map((s) => s.trim()).filter(Boolean) });
      });
    });
  try {
    const [unstaged, staged, untracked] = await Promise.all([
      run(['diff', '--name-only']),
      run(['diff', '--cached', '--name-only']),
      run(['ls-files', '--others', '--exclude-standard']),
    ]);
    const gitOk = unstaged.ok || staged.ok;
    const changed = [...new Set([...unstaged.lines, ...staged.lines, ...untracked.lines])].filter((f) => !f.endsWith('/'));
    sendJson(res, 200, {
      success: true,
      changed,
      base: cwd,
      git_ok: gitOk,
      message: gitOk
        ? `git 检出 ${changed.length} 个改动文件`
        : '当前目录不是 git 仓库或 git 不可用（改为手动填文件清单）',
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/** GET /api/registry：产物总览；POST /api/registry：人工打标记/编辑单条产物 */
async function handleApiRegistry(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, { success: true, artifacts: readRegistry() });
    return;
  }
  try {
    const body = await readBody(req);
    const params = JSON.parse(body.toString('utf-8') || '{}');
    const relPath = String(params.path ?? '');
    const patch = (params.patch ?? {}) as Record<string, unknown>;
    if (!relPath) {
      sendError(res, 400, '缺少 path');
      return;
    }
    const clean: Record<string, unknown> = { ...patch };
    delete clean.path;
    const updated = updateArtifact(relPath, clean);
    if (!updated) {
      sendError(res, 404, `产物不在注册表: ${relPath}`);
      return;
    }
    sendJson(res, 200, { success: true, artifact: updated });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/**
 * 科普式讲解导览脚本（核心主链路）：按"双层DSL → 渲染器 → 自我分析星图 → 代码理解 →
 * 缓存 → 实时同步 → 语义搜索 → 导览"的顺序，逐模块讲解 design-canvas 自身的工作机制。
 * 播放器（/explain.html）每步显示字幕条，并通过 postMessage 让星图定位高亮对应节点。
 */
/**
 * 角色：新人 / PM / 资深开发。同一模块三档讲解，详细度递增。
 *   - newbie：口语、少术语，讲"这是什么、用来干嘛"
 *   - pm：偏业务，讲"解决什么问题、价值在哪"
 *   - senior：偏技术，讲"内部怎么实现、关键 API / 机制"
 */
type Narrations = { newbie: string; pm: string; senior: string };

const EXPLAIN_SCRIPT: Array<{ title: string; n: Narrations; nodeId: string }> = [
  {
    title: '入口：MCP 服务',
    n: {
      newbie: 'design-canvas 的"大门"是一个叫 MCP 服务的东西。它把画布的各种能力包装成一个个小工具，让 AI 助手（比如 Claude、Cursor）能直接调用。简单说：AI 想用画布，都得先通过这个入口。',
      pm: 'MCP 是当前 AI 编程工具的标准接口。我们把它做成标准 MCP 服务，意味着 Claude Code、Cursor、VS Code 等任何客户端都能无缝接入，不用为每个工具单独适配——这是"一次开发、处处可用"的关键投资。',
      senior: 'server.ts 实现标准 MCP stdio 传输，注册 40+ 工具（render_dsl / import_project / guided_tour 等），JSON-RPC 协议。工具集是画布能力的程序化暴露层，也是后续 MCP 收敛（路线图序号2）的改造主体。',
    },
    nodeId: 'file_server_ts',
  },
  {
    title: '协议核心：双层 DSL',
    n: {
      newbie: '所有设计都存在一个叫"双层 DSL"的结构里。它分两层：一层记录图形怎么摆（位置、大小、颜色），一层记录代码信息（哪些文件、哪些函数）。人和 AI 各改各的层，互不打扰。',
      pm: '双层 DSL 是"人机协作"的协议层：几何层给人看（拖拽改位置），语义层给 AI 读（代码分析自动填充）。两层通过 id 锚定对齐，避免人和 AI 同时改一个文件造成冲突。这是产品差异化的核心。',
      senior: 'DesignDSL 分 geometry（nodes/edges 位置样式）与 semantic（files/apis/dependencies），以 id 锚定。几何层由人编辑，语义层由 import_project 等自动填充。类型定义见 dsl/types.ts，校验由 dsl/validator.ts 保证锚定完整性。',
    },
    nodeId: 'file_dsl_types_ts',
  },
  {
    title: '几何层：人画的位置',
    n: {
      newbie: '你在图上看到的框、线、颜色，位置都记在这一层。你可以直接拖拽改位置，改完就存回这一层。',
      pm: '几何层保管"呈现"数据——每个节点拖到哪、多大、什么颜色。它让设计图可以被人肉眼直接操作，是"活图纸"体验的基础。修改自动回写持久化。',
      senior: 'geometry.nodes 记录 x/y/width/height/style，支持 layout 自动布局（dag/force/grid）与画布拖拽回写。渲染器据此定位节点，是本层唯一的"画布坐标真相源"。',
    },
    nodeId: 'file_dsl_geometry_ts',
  },
  {
    title: '语义层：LLM 理解的代码',
    n: {
      newbie: '这一层记的是代码信息：每个文件有哪些函数、依赖哪些文件、做完了没有。它是代码分析自动填的，你不用手动维护。',
      pm: '语义层把"代码讲了什么"结构化——文件、API、依赖、实现状态。它由分析工具自动生成，让 AI 能读懂设计图对应的真实代码，是"设计对得上实现"的保证。',
      senior: 'semantic.files 记录每个文件的 apis（ExpectedApi，含签名）、dependencies、status。由 import_project/backfill_scaffold 填充，consistency_check 校验与真实代码是否一致。status 驱动节点着色（待实现/实现中/已完成）。',
    },
    nodeId: 'file_dsl_semantic_ts',
  },
  {
    title: '校验器：守住 DSL 边界',
    n: {
      newbie: 'DSL 不是想怎么写就怎么写的。这个校验器会检查语法对不对、引用的编号对不对得上，防止错误数据混进来。',
      pm: '校验器相当于"质检关卡"——保证几何层和语义层引用的 id 都对得上、schema 合法。它把脏数据挡在门外，避免后续渲染和 AI 分析读到坏数据。',
      senior: 'validator.ts 校验 ①schema 字段合法性 ②锚定完整性（几何节点 id 与语义引用是否一一对应）。非法 DSL 在进入渲染/AI 分析前即被拦截，返回结构化错误。',
    },
    nodeId: 'file_dsl_validator_ts',
  },
  {
    title: '渲染器：把 DSL 变成活画布',
    n: {
      newbie: '这个部分把 DSL 变成一张你眼前这样的网页画布。整张网页是一个独立文件，双击能编辑、拖拽能改，不依赖任何外面加载的东西。',
      pm: '渲染器把协议数据变成"活"的成果——一张自包含 HTML 画布，零外部依赖、可离线打开。它是产品价值的最终呈现层：人看到的、操作的都是它渲染出来的。',
      senior: 'renderer/html_renderer.ts 将 DSL 拼成自包含 HTML（内联 CSS+JS），零外部依赖。支持双击编辑、拖拽回写、撤销重做、动画引擎（animation_engine）、图层着色等功能。scripts.ts（5290 行）是交互脑。',
    },
    nodeId: 'file_renderer_html_renderer_ts',
  },
  {
    title: '画布交互脚本',
    n: {
      newbie: '画布上的拖拽、放大缩小、搜索、撤销这些操作，都靠这个脚本来实现。它就像画布的"大脑"。',
      pm: 'scripts.ts 是画布的交互核心——决定了用户能怎么操作、反馈是否流畅。拖拽、缩放、搜索、撤销重做、右键菜单都在这层实现，直接决定上手体验。',
      senior: 'scripts.ts（5290 行）实现画布全部交互：setupNodes/Edges、拖拽回写、撤销重做（Ctrl+Z/Y，localStorage 持久化）、搜索定位、动画、以及本讲解导览的 postMessage flyToNode 接收器（source:"dc-tour"）。是单文件巨石，待拆。',
    },
    nodeId: 'file_renderer_scripts_ts',
  },
  {
    title: '自我分析：把 src 变成星图',
    n: {
      newbie: '我们用这个工具分析它自己——把我们自己的代码文件夹扫描一遍，生成一张像星空一样的图，每个点代表一个文件。你现在看的就是这张图。',
      pm: '这是"吃自己的狗粮"：用工具分析自身代码库，把 68 个文件、660 个符号、100 条依赖关系可视化。既验证工具能力，又让新人一眼看懂项目结构——这是最好的产品演示。',
      senior: 'importProject 用 TreeSitterKernel 解析 src/ 全量文件，产出符号 + 依赖边 + 目录容器节点，渲染成 self_analyze 星图（349 节点）。支持 max_files 截断（默认200）、缓存增量（content_hash）、删除侦测。',
    },
    nodeId: 'file_tools_import_project_ts',
  },
  {
    title: 'AST 内核：理解每种语言',
    n: {
      newbie: '要让 AI 读懂代码，得先有个工具能"看懂"代码的结构。这个内核就是干这个的：它把代码拆成一层层结构，找出函数、调用、依赖。',
      pm: 'AST 内核是"代码理解"的地基——它决定了工具能读懂哪些语言、读懂多深。基于 tree-sitter，动态加载语言包，是导入分析、一致性检查等能力的共同底座。',
      senior: 'ts_kernel 基于 tree-sitter，动态检测 node_modules/tree-sitter-* 语言包，无硬编码 import，支持 go/ts/py/js。提供符号、调用边、CFG 提取；优雅降级（缺语言包时解析失败不崩溃）。被 import_project/consistency/derive_* 共享。',
    },
    nodeId: 'file_tools_ts_kernel_kernel_ts',
  },
  {
    title: 'SQLite 缓存：只重算变更',
    n: {
      newbie: '代码改来改去，每次都重新分析全部太慢。这个缓存会记住分析过的结果，只有改过的文件才重新分析，快很多。',
      pm: '缓存是"效率"的关键——用 SQLite 存符号与调用边，配合文件 hash 增量，只重算变更文件。二次运行 68 个文件几乎全命中，分析从"分钟级"降到"秒级"，这是规模化使用的根基。',
      senior: 'db/ 用 node:sqlite（零原生依赖），schema v2：nodes/edges/files/imports + FTS5 trigram 索引。syncFile 按 content_hash 增量，未变更 skipped；pruneDeletedFiles 侦测删除。跨 feature 复用同一 AST 内核避免冗余。',
    },
    nodeId: 'file_db_db_ts',
  },
  {
    title: '实时同步：文件一改就更新',
    n: {
      newbie: '代码一保存，星图就能跟着变，不用手动重新生成。这个功能就是干这个的：一直盯着文件，变了就更新。',
      pm: '"永不 stale"是核心卖点：文件监听自动把代码变更同步进缓存，还能按 feature 重建"实际 DSL"。代码改了，设计图跟着走，人永远看到最新状态。',
      senior: 'watch_project 用 fs.watch 递归监听 + debounce 批量 flushBatch；SKIP_FILE_RE 过滤临时文件防反馈循环；reconcileProject 定期全量扫描兜底（目录级删除/事件丢失）；重建实际 DSL 到 live/（saveLiveFeature）。rebuild_window_ms 节流。',
    },
    nodeId: 'file_tools_watch_project_ts',
  },
  {
    title: '语义搜索：问自然语言',
    n: {
      newbie: '你可以直接打一句话问它，比如"哪个部分处理登录"，它就能在代码里找到相关的地方回答你。',
      pm: '语义搜索让"找代码"从翻目录变成提问——用 embedding 把符号向量化，支持自然语言查询。降低代码检索门槛，是产品易用性的重要一环。',
      senior: 'semantic_search 复用 cache.db 符号表，硅基流动 BAAI/bge-m3（1024维，OpenAI 兼容）向量化符号，query 余弦相似度 top-k；进程内向量缓存（model:sha256）实现向量化一次复用；未配置自动降级 FTS trigram。',
    },
    nodeId: 'file_tools_semantic_search_ts',
  },
  {
    title: '产物注册表',
    n: {
      newbie: '每次生成的网页（星图、报告、示例）都会被记到一个清单里，主页会根据这个清单展示所有成果。',
      pm: '注册表是"成果目录"——统一登记每次生成的产物，让主页动态展示、可人工打标。它让项目成果可检索、可组织，也是跨产物导览的数据基础。',
      senior: 'registry 把产物登记到 <dataHome>/output/.registry.json，render_dsl 自动注册 + 人工编辑（tags/note/title/status）。GET/POST /api/registry 暴露，Hub 首页据此动态渲染产物卡片。',
    },
    nodeId: 'file_tools_registry_ts',
  },
  {
    title: '导览：你正在用的功能',
    n: {
      newbie: '你现在看的这个"讲解"功能，就是它在起作用。它能把散落的模块按顺序连成一条学习路线，一步步带你熟悉。',
      pm: '导览把"理解项目"变成可消费的体验——按依赖顺序生成学习路径，逐个高亮。你正在用的科普式导览，就是它和注册表、播放器一起实现的。',
      senior: 'guided_tour 用 Kahn 拓扑排序（跳过 contains 边）生成学习路径；/api/explain 提供本讲解脚本，/explain.html 播放器 postMessage 驱动星图 flyToNode。G0/G1/G2 三档（单feature/串联/科普）已全落地。',
    },
    nodeId: 'file_tools_guided_tour_ts',
  },
];

/**
 * GET /api/explain?role=senior：返回科普式讲解导览脚本（核心主链路）。
 * `role` ∈ newbie | pm | senior，默认 newbie。每步返回 { title, narration, nodeId }，
 * 其中 narration 为对应角色讲解文案；同时返回本文档含全部角色（供播放器本地切换）。
 */
function handleApiExplain(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const role = (q.get('role') ?? 'newbie') as keyof Narrations;
  const validRole = role === 'senior' || role === 'pm' ? role : 'newbie';
  // 已持久化的 LLM 文案优先，覆盖手写文案；无则用内置 EXPLAIN_SCRIPT
  const persisted = loadGeneratedNarrations();
  const steps = EXPLAIN_SCRIPT.map((s) => {
    const n = persisted[s.title] ?? s.n;
    return {
      title: s.title,
      nodeId: s.nodeId,
      narration: n[validRole],
      // 附全部角色文案，播放器切换角色无需重新请求
      narrations: n,
    };
  });
  sendJson(res, 200, { success: true, role: validRole, steps, persisted: Object.keys(persisted).length });
}

/**
 * POST /api/explain/generate：用 Agnes LLM 为讲解模块生成三档角色文案。
 * body（可选）{ steps: [{ title, background }] }，缺省用内置 EXPLAIN_SCRIPT
 * （以现有 senior 文案作为权威背景）。逐模块调用 Agnes，返回可整体替换的
 * steps（含 narrations 三档），播放器据此刷新本地文案。
 * 未配置 / 调用失败：返回 { success:false, note }，播放器应回退手写文案。
 */
async function handleApiExplainGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const cfg = loadExplainConfig();
    if (!cfg) {
      sendJson(res, 200, {
        success: false,
        note: '未配置 LLM（config.json 缺 explain 段，或未设 DEEPSEEK_API_KEY / AGNES_API_KEY 环境变量），已保留手写文案',
      });
      return;
    }

    let body: { steps?: Array<{ title?: string; background?: string }> } = {};
    const raw = await readBody(req);
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf-8'));
      } catch {
        body = {};
      }
    }
    const requested = Array.isArray(body.steps) ? body.steps : [];
    const modules = requested.length > 0
      ? requested.map((s) => ({ title: s.title || '', background: s.background || '' }))
      : EXPLAIN_SCRIPT.map((s) => ({ title: s.title, background: s.n.senior }));

    const generated: Array<{ title: string; nodeId: string; narrations: { newbie: string; pm: string; senior: string } }> = [];
    const failures: Array<{ title: string; error: string }> = [];
    for (const m of modules) {
      try {
        const narrations = await generateModuleNarrations(m.title, m.background, cfg);
        const src = requested.length > 0 ? EXPLAIN_SCRIPT.find((s) => s.title === m.title) : undefined;
        generated.push({
          title: m.title,
          nodeId: src?.nodeId ?? '',
          narrations,
        });
      } catch (e) {
        failures.push({ title: m.title, error: (e as Error).message });
      }
    }

    // 持久化：把本次成功生成的文案落盘，播放器下次打开自动加载，无需重新调用 LLM
    let persistedFile = '';
    if (generated.length > 0) {
      persistedFile = saveGeneratedNarrations(generated.map((g) => ({ title: g.title, narrations: g.narrations })));
    }

    sendJson(res, 200, {
      success: true,
      model: cfg.model,
      baseURL: cfg.baseURL,
      generated,
      failures,
      persisted_file: persistedFile,
      note: failures.length > 0
        ? `${failures.length} 个模块生成失败（${failures[0]?.title}：${failures[0]?.error}），可重试或保留手写文案`
        : `已用 ${cfg.model} 生成 ${generated.length} 个模块的三档文案并持久化`,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
  }
}

/**
 * GET /api/tour?feature=X 或 ?features=A,B,C：返回产物导览序列。
 *   - feature=X：单 feature 的全部注册产物（按注册顺序）
 *   - features=A,B,C：跨 feature 串联——按给定顺序拼接各 feature 的产物（G1）
 *   - 可选 &tags=foo,bar：仅保留命中任一标签的产物
 * 返回 steps 数组，每步含 { path, title, type, feature, tags }。
 */
function handleApiTour(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const feature = q.get('feature') ?? '';
  const features = (q.get('features') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = (q.get('tags') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const all = readRegistry();
  const match = (e: { feature?: string; tags?: string[] }): boolean => {
    if (tags.length > 0 && !(e.tags ?? []).some((t) => tags.includes(t.toLowerCase()))) return false;
    return true;
  };

  // 跨 feature 串联：按 given 顺序逐 feature 拼接
  if (features.length > 0) {
    const steps: Array<{ path: string; title: string; type: string; feature: string; tags: string[] }> = [];
    for (const f of features) {
      for (const e of all) {
        if (e.feature !== f || !match(e)) continue;
        steps.push({ path: e.path, title: e.title || e.path, type: e.type || '', feature: e.feature || '', tags: e.tags ?? [] });
      }
    }
    sendJson(res, 200, { success: true, features, steps });
    return;
  }

  // 单 feature（兼容旧用法）
  const steps = all
    .filter((e) => e.feature === feature && match(e))
    .map((e) => ({ path: e.path, title: e.title || e.path, type: e.type || '', feature: e.feature || '', tags: e.tags ?? [] }));
  sendJson(res, 200, { success: true, feature, steps });
}

/** GET /tour.html：跨产物导览播放器（进度点 + iframe 嵌入当前产物 + 上一步/下一步） */
function handleTourPage(res: http.ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>导览播放器</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #02040d; color: #dbe7ff; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.85); backdrop-filter: blur(8px); }
  .head a { color: #7dd3fc; text-decoration: none; font-size: 13px; padding: 5px 12px; border: 1px solid rgba(125,211,252,.2); border-radius: 8px; }
  .head a:hover { background: rgba(125,211,252,.1); }
  .head .ftitle { font-size: 15px; font-weight: 600; }
  .head .prog { margin-left: auto; font-size: 12px; opacity: .6; }
  .head .fchip { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(125,211,252,.12); border: 1px solid rgba(125,211,252,.2); color: #7dd3fc; }
  .stage { flex: 1; position: relative; }
  .stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .nav { display: flex; align-items: center; justify-content: center; gap: 18px; padding: 10px 18px; border-top: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.85); }
  .nav-btn { background: rgba(125,211,252,.12); border: 1px solid rgba(125,211,252,.25); color: #7dd3fc; border-radius: 9px; padding: 8px 18px; font-size: 13px; cursor: pointer; }
  .nav-btn:hover:not(:disabled) { background: rgba(125,211,252,.2); }
  .nav-btn:disabled { opacity: .3; cursor: default; }
  .dots { display: flex; gap: 8px; align-items: center; }
  .dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid rgba(125,211,252,.4); background: transparent; cursor: pointer; padding: 0; }
  .dot.cur { background: #7dd3fc; box-shadow: 0 0 10px rgba(125,211,252,.8); }
  .loading { text-align: center; opacity: .6; padding-top: 40px; }
</style>
</head>
<body>
  <div class="head">
    <a href="./index.html">← 主页</a>
    <span class="ftitle" id="ftitle"></span>
    <span class="fchip" id="fchip"></span>
    <span class="prog" id="prog"></span>
  </div>
  <div class="stage">
    <div class="loading" id="loading">加载产物序列…</div>
    <iframe id="frame" title="导览内容"></iframe>
  </div>
  <div class="nav">
    <button class="nav-btn" id="prev">◀ 上一步</button>
    <div class="dots" id="dots"></div>
    <button class="nav-btn" id="next">下一步 ▶</button>
  </div>
<script>
(function(){
  var qs = new URLSearchParams(location.search);
  var feature = qs.get('feature') || '';
  var featuresParam = qs.get('features') || '';
  var url = featuresParam
    ? '/api/tour?features=' + encodeURIComponent(featuresParam)
    : '/api/tour?feature=' + encodeURIComponent(feature);
  var steps = [], i = 0;
  var frame = document.getElementById('frame');
  var loading = document.getElementById('loading');
  var fchip = document.getElementById('fchip');
  function go(k){
    if(!steps.length) return;
    i = Math.max(0, Math.min(steps.length-1, k));
    loading.style.display = 'block';
    frame.style.opacity = '0.3';
    frame.src = steps[i].path;
    if(fchip) fchip.textContent = steps[i].feature ? 'feature: ' + steps[i].feature : '';
  }
  function update(){
    document.querySelectorAll('#dots .dot').forEach(function(b, k){ b.classList.toggle('cur', k === i); b.title = steps[k].title; });
    document.getElementById('prog').textContent = (steps.length ? (i+1) + ' / ' + steps.length : '0 / 0');
    document.getElementById('prev').disabled = i === 0;
    document.getElementById('next').disabled = i === steps.length-1;
  }
  fetch(url)
    .then(function(r){ return r.json(); })
    .then(function(j){
      steps = j.steps || [];
      document.getElementById('ftitle').textContent = featuresParam ? featuresParam.split(',').join(' → ') : (j.feature || '');
      var dots = document.getElementById('dots');
      dots.innerHTML = '';
      steps.forEach(function(_, k){
        var b = document.createElement('button');
        b.className = 'dot';
        b.onclick = function(){ go(k); };
        dots.appendChild(b);
      });
      if(!steps.length){ loading.textContent = '该产物序列暂无注册产物'; return; }
      go(0);
    })
    .catch(function(){ loading.textContent = '需要 npm run serve 启动服务'; });
  frame.addEventListener('load', function(){ loading.style.display = 'none'; frame.style.opacity = '1'; });
  document.getElementById('prev').addEventListener('click', function(){ go(i-1); });
  document.getElementById('next').addEventListener('click', function(){ go(i+1); });
  var t = setInterval(update, 150);
  window.addEventListener('beforeunload', function(){ clearInterval(t); });
})();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * GET /explain.html：科普式讲解导览播放器。
 * 左侧嵌入 self_analyze.html 星图，右侧字幕条逐模块讲解。
 * 每步通过 postMessage({ source:'dc-tour', action:'fly', nodeId }) 让星图定位高亮。
 */
function handleExplainPage(res: http.ServerResponse): void {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>科普式讲解导览 · design-canvas</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #02040d; color: #dbe7ff; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  .head { display: flex; align-items: center; gap: 14px; padding: 10px 18px; border-bottom: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.85); backdrop-filter: blur(8px); }
  .head a { color: #7dd3fc; text-decoration: none; font-size: 13px; padding: 5px 12px; border: 1px solid rgba(125,211,252,.2); border-radius: 8px; }
  .head a:hover { background: rgba(125,211,252,.1); }
  .head .ftitle { font-size: 15px; font-weight: 600; }
  .head .prog { margin-left: auto; font-size: 12px; opacity: .6; }
  .body { flex: 1; display: flex; min-height: 0; }
  .stage { flex: 1; position: relative; min-width: 0; }
  .stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .side { width: 340px; min-width: 340px; border-left: 1px solid rgba(125,211,252,.15); background: rgba(6,11,31,.92); display: flex; flex-direction: column; }
  .caption { flex: 1; overflow-y: auto; padding: 18px; }
  .caption .c-title { font-size: 17px; font-weight: 700; color: #7dd3fc; margin-bottom: 10px; }
  .caption .c-body { font-size: 14px; line-height: 1.75; color: #dbe7ff; }
  .nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-top: 1px solid rgba(125,211,252,.15); }
  .nav-btn { background: rgba(125,211,252,.12); border: 1px solid rgba(125,211,252,.25); color: #7dd3fc; border-radius: 9px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
  .nav-btn:hover:not(:disabled) { background: rgba(125,211,252,.2); }
  .nav-btn:disabled { opacity: .3; cursor: default; }
  .dots { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .dot { width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(125,211,252,.4); background: transparent; cursor: pointer; padding: 0; }
  .dot.cur { background: #7dd3fc; box-shadow: 0 0 8px rgba(125,211,252,.8); }
  .loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #04060f; color: #7dd3fc; font-size: 14px; z-index: 5; }
  .hint { font-size: 11px; opacity: .5; padding: 0 16px 10px; }
  .persona { display: flex; gap: 6px; padding: 10px 16px; border-top: 1px solid rgba(125,211,252,.12); }
  .p-btn { flex: 1; background: rgba(125,211,252,.08); border: 1px solid rgba(125,211,252,.18); color: #a8c4e8; border-radius: 8px; padding: 6px 6px; font-size: 12px; cursor: pointer; text-align: center; }
  .p-btn:hover { background: rgba(125,211,252,.16); }
  .p-btn.cur { background: rgba(125,211,252,.22); color: #7dd3fc; border-color: rgba(125,211,252,.5); font-weight: 600; }
  .gen-row { padding: 0 16px; }
  .gen-btn { width: 100%; background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.25); color: #4ade80; border-radius: 8px; padding: 7px; font-size: 12px; cursor: pointer; }
  .gen-btn:hover:not(:disabled) { background: rgba(34,197,94,.18); }
  .gen-btn:disabled { opacity: .4; cursor: default; }
</style>
</head>
<body>
  <div class="head">
    <a href="./index.html">← 主页</a>
    <span class="ftitle">科普式讲解导览 · design-canvas 主链路</span>
    <span class="prog" id="prog"></span>
  </div>
  <div class="body">
    <div class="stage">
      <div class="loading" id="loading">加载星图…</div>
      <iframe id="frame" title="星图"></iframe>
    </div>
    <div class="side">
      <div class="caption">
        <div class="c-title" id="c-title"></div>
        <div class="c-body" id="c-body"></div>
      </div>
      <div class="persona" id="persona">
        <button class="p-btn cur" data-role="newbie" title="口语讲解，适合第一次接触">👤 新人</button>
        <button class="p-btn" data-role="pm" title="偏业务价值，适合产品/管理">📊 PM</button>
        <button class="p-btn" data-role="senior" title="技术实现细节，适合资深开发">🔧 资深</button>
      </div>
      <div class="gen-row">
        <button class="gen-btn" id="genBtn" title="调用 LLM（DeepSeek/Agnes）为全部模块生成三档角色文案">✨ LLM 生成文案</button>
      </div>
      <div class="hint">字幕讲解 · 右侧星图自动定位高亮对应模块</div>
      <div class="nav">
        <button class="nav-btn" id="prev">◀ 上一步</button>
        <div class="dots" id="dots"></div>
        <button class="nav-btn" id="next">下一步 ▶</button>
      </div>
    </div>
  </div>
<script>
(function(){
  var steps = [], i = 0, role = 'newbie';
  var frame = document.getElementById('frame');
  var loading = document.getElementById('loading');
  var cTitle = document.getElementById('c-title');
  var cBody = document.getElementById('c-body');
  var STAR = 'self_analyze.html';
  function go(k){
    if(!steps.length) return;
    i = Math.max(0, Math.min(steps.length-1, k));
    render();
  }
  function render(){
    var s = steps[i];
    if(!s) return;
    cTitle.textContent = (i+1) + '. ' + s.title;
    // Persona-Adaptive：按当前角色取文案（narrations 各档齐全，本地切换零请求）
    cBody.textContent = (s.narrations && s.narrations[role]) || s.narration || '';
    // 星图已加载后，通过 postMessage 定位高亮对应模块
    if(frameReady && frame.contentWindow){
      frame.contentWindow.postMessage({ source:'dc-tour', action:'fly', nodeId:s.nodeId }, '*');
    }
    update();
  }
  function update(){
    document.querySelectorAll('#dots .dot').forEach(function(b, k){ b.classList.toggle('cur', k === i); });
    document.getElementById('prog').textContent = (steps.length ? (i+1) + ' / ' + steps.length : '0 / 0');
    document.getElementById('prev').disabled = i === 0;
    document.getElementById('next').disabled = i === steps.length-1;
  }
  // Persona 角色切换：更新高亮 + 重渲染当前步文案
  document.querySelectorAll('#persona .p-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      role = btn.getAttribute('data-role');
      document.querySelectorAll('#persona .p-btn').forEach(function(b){ b.classList.toggle('cur', b === btn); });
      if(steps.length) render();
    });
  });
  var frameReady = false;
  frame.addEventListener('load', function(){
    loading.style.display = 'none';
    frameReady = true;
    // 载入后定位当前步
    if(steps.length) render();
  });

  // ✨ LLM 生成文案：调用 /api/explain/generate，成功后整体替换本地 narrations
  var genBtn = document.getElementById('genBtn');
  genBtn.addEventListener('click', function(){
    genBtn.disabled = true;
    genBtn.textContent = '⏳ 生成中…（逐模块调用 LLM）';
    fetch('/api/explain/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function(r){ return r.json(); })
      .then(function(j){
        if(!j.success || !j.generated || !j.generated.length){
          genBtn.textContent = '⚠ ' + (j.note || '生成失败');
          return;
        }
        // 按 title 匹配，替换对应步骤的 narrations
        j.generated.forEach(function(g){
          for(var k=0; k<steps.length; k++){
            if(steps[k].title === g.title){
              steps[k].narrations = g.narrations;
              break;
            }
          }
        });
        genBtn.textContent = '✅ 已用 ' + j.model + ' 生成并持久化 ' + j.generated.length + ' 个模块';
        render();
      })
      .catch(function(e){
        genBtn.textContent = '⚠ 生成失败：' + (e && e.message ? e.message : '网络错误');
      })
      .finally(function(){ setTimeout(function(){ genBtn.disabled = false; }, 800); });
  });
  fetch('/api/explain')
    .then(function(r){ return r.json(); })
    .then(function(j){
      steps = j.steps || [];
      var dots = document.getElementById('dots');
      dots.innerHTML = '';
      steps.forEach(function(_, k){
        var b = document.createElement('button');
        b.className = 'dot';
        b.title = (k+1) + '. ' + steps[k].title;
        b.onclick = function(){ go(k); };
        dots.appendChild(b);
      });
      if(!steps.length){ loading.textContent = '暂无讲解脚本'; return; }
      // 已持久化的 LLM 文案：加载时提示，避免重复生成
      if(j.persisted > 0){
        genBtn.textContent = '📦 已加载 ' + j.persisted + ' 个模块的持久化文案';
      }
      // 先载入星图
      frame.src = STAR;
      render();
    })
    .catch(function(){ loading.textContent = '需要 npm run serve 启动服务'; });
  document.getElementById('prev').addEventListener('click', function(){ go(i-1); });
  document.getElementById('next').addEventListener('click', function(){ go(i+1); });
})();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleStaticFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = req.url || '/';
  // 去除查询参数（如 ?t=v3）
  const qIdx = filePath.indexOf('?');
  if (qIdx !== -1) filePath = filePath.substring(0, qIdx);
  if (filePath === '/') {
    // Hub 主页优先（self-analyze 等流水线生成的项目入口），否则回退示例画布
    filePath = fs.existsSync(path.join(PUBLIC_DIR, 'index.html')) ? '/index.html' : '/conveyor.html';
  }

  // 活态 DSL 别名：浏览器设计视图 fetch 相对路径 design-canvas.json，
  // 静态目录（output/）不含它 → 映射到数据根目录的活态 DSL 文件，避免 404。
  if (filePath === '/design-canvas.json') {
    if (fs.existsSync(LIVE_FILE)) {
      const content = fs.readFileSync(LIVE_FILE);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(content);
      return;
    }
    sendError(res, 404, 'design-canvas.json 不存在，请先使用 render_dsl 或 import_project 创建');
    return;
  }

  const fullPath = path.join(PUBLIC_DIR, filePath);

  const relPath = path.relative(PUBLIC_DIR, fullPath);
  if (relPath.startsWith('..')) {
    sendError(res, 403, '路径不允许');
    return;
  }

  if (!fs.existsSync(fullPath)) {
    sendError(res, 404, `文件不存在: ${filePath}`);
    return;
  }

  if (fs.statSync(fullPath).isDirectory()) {
    sendError(res, 404, `目录不允许访问: ${filePath}`);
    return;
  }

  const content = fs.readFileSync(fullPath);
  const mimeType = getMimeType(fullPath);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(content);
}

const MAX_BODY_SIZE = 5 * 1024 * 1024; // 5MB

function readBody(req: http.IncomingMessage, maxSize = MAX_BODY_SIZE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > maxSize) {
        reject(new Error(`请求体过大（${totalSize} 字节），最大允许 ${maxSize} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startServer(port?: number): Promise<void> {
  const listenPort = port || PORT;

  // Camera 运行哨兵：设置 CAMERA_EVENTS_FILE 时激活全局探针 sink，
  // 运行中自动采集数据流事件（saveDSL 写盘等）。每条事件落盘后立即用轻量
  // 判定器判断，命中契约偏差就 SSE 推送给画布（开发时即时观测提示）。
  // 未设置时 no-op，不改变 serve 行为。
  enableCameraFromEnv((ev) => {
    // 长时压测守门：CAMERA_GUARD=1 时把偏差实时打印到控制台（仅打印，不中断）
    judgeGuardLog(ev);
    const v = judgeEvent(ev);
    if (v.result === 'deviation') {
      broadcastSSE('camera-alert', {
        probe: v.probe,
        rule: v.rule,
        reason: v.reason,
        fields: v.fields,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // 注册 DSL 变更回调：MCP saveDSL → SSE 广播
  onDslChange((feature, source) => {
    notifyDslChange(feature, source);
  });

  // 安全：默认仅绑定本机回环，避免局域网/公网暴露；如需跨机访问，显式设 DC_BIND=0.0.0.0
  const bindHost = process.env.DC_BIND || '127.0.0.1';
  // CORS：仅允许 localhost 系列源（含 IPv4/IPv6/hostname），阻止第三方网页通过浏览器跨域调用写入 API
  const safeOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;
  const isSafeOrigin = (origin: string | undefined): boolean => {
    if (!origin) return true; // 非浏览器直接请求（curl/self）放行
    return safeOriginPattern.test(origin);
  };

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const origin = req.headers.origin as string | undefined;

    if (isSafeOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (method === 'OPTIONS') {
      res.writeHead(isSafeOrigin(origin) ? 200 : 403);
      res.end();
      return;
    }
    // 写入类 API 严格校验 Origin，防止 CSRF/CORS 组合攻击
    const isWriteApi =
      method === 'POST' &&
      (url.startsWith('/api/save') || url.startsWith('/api/dict/ingest') ||
        url.startsWith('/api/registry') ||
        url.startsWith('/api/layout') || url.startsWith('/api/scaffold') ||
        url.startsWith('/api/mmd/chat') ||
        url.startsWith('/api/mind-map') ||
        url.startsWith('/api/regenerate'));
    if (isWriteApi && !isSafeOrigin(origin)) {
      sendError(res, 403, '跨域写入被拒绝：仅允许本机 localhost 来源调用写入 API');
      return;
    }

    if (url.startsWith('/api/events') && method === 'GET') {
      // SSE 端点：保持连接，推送 DSL 变更事件
      const sseOrigin = isSafeOrigin(origin) ? (origin ?? '*') : 'null';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': sseOrigin,
      });
      res.write('event: connected\ndata: {"message":"SSE connected"}\n\n');
      sseClients.add(res);
      req.on('close', () => { sseClients.delete(res); });
      return;
    }

    if (url.startsWith('/api/save') && method === 'POST') {
      handleApiSave(req, res);
      return;
    }

    if (url.startsWith('/api/load') && method === 'GET') {
      handleApiLoad(req, res);
      return;
    }

    if (url.startsWith('/api/features') && method === 'GET') {
      handleApiFeatures(req, res);
      return;
    }

    if (url.startsWith('/api/camera/log') && method === 'GET') {
      handleApiCameraLog(req, res);
      return;
    }

    if (url.startsWith('/api/camera/judge') && method === 'POST') {
      void handleApiCameraJudge(req, res);
      return;
    }

    if (url.startsWith('/api/live/rebuild') && method === 'POST') {
      handleApiLiveRebuild(req, res);
      return;
    }

    if (url.startsWith('/api/live') && method === 'GET') {
      handleApiLive(req, res);
      return;
    }

    if (url.startsWith('/api/report_status') && method === 'GET') {
      handleApiReportStatus(req, res);
      return;
    }

    if (url.startsWith('/api/regenerate') && method === 'POST') {
      handleApiRegenerate(req, res);
      return;
    }

    if (url.startsWith('/api/split_plan') && method === 'POST') {
      handleApiSplitPlan(req, res);
      return;
    }

    if (url.startsWith('/api/layout/dag') && method === 'POST') {
      handleApiLayout(req, res, 'dag');
      return;
    }

    if (url.startsWith('/api/layout/force') && method === 'POST') {
      handleApiLayout(req, res, 'force');
      return;
    }

    if (url.startsWith('/api/layout/grid') && method === 'POST') {
      handleApiLayout(req, res, 'grid');
      return;
    }

    if (url.startsWith('/api/scaffold') && method === 'POST') {
      handleApiScaffold(req, res);
      return;
    }

    if (url.startsWith('/api/consistency') && method === 'POST') {
      handleApiConsistency(req, res);
      return;
    }

    if (url.startsWith('/api/diff-impact') && method === 'POST') {
      handleApiDiffImpact(req, res);
      return;
    }

    if (url.startsWith('/api/diff-views') && method === 'POST') {
      handleApiDiffViews(req, res);
      return;
    }

    if (url.startsWith('/api/mind-map') && method === 'POST') {
      handleApiMindMap(req, res);
      return;
    }
    if (url.startsWith('/api/mind-map') && method === 'GET') {
      handleApiMindMapGet(req, res);
      return;
    }
    if (url.startsWith('/api/mmd/chat') && method === 'POST') {
      handleApiMmdChat(req, res);
      return;
    }

    if (url.startsWith('/api/arch-layer') && method === 'POST') {
      handleApiArchLayer(req, res);
      return;
    }

    if (url.startsWith('/api/guided-tour') && method === 'POST') {
      handleApiGuidedTour(req, res);
      return;
    }

    if (url.startsWith('/api/semantic-search') && method === 'POST') {
      handleApiSemanticSearch(req, res);
      return;
    }

    if (url.startsWith('/api/language-concepts') && method === 'POST') {
      handleApiLanguageConcepts(req, res);
      return;
    }

    if (url.startsWith('/api/git-diff') && method === 'GET') {
      handleApiGitDiff(req, res);
      return;
    }

    if (url.startsWith('/api/dict/query') && method === 'POST') {
      handleApiDictQuery(req, res);
      return;
    }
    if (url.startsWith('/api/dict/highlight') && method === 'POST') {
      handleApiDictHighlight(req, res);
      return;
    }
    if (url.startsWith('/api/dict/ingest') && method === 'POST') {
      handleApiDictIngest(req, res);
      return;
    }
    if (url.startsWith('/api/dict/generate') && method === 'POST') {
      handleApiDictGenerate(req, res);
      return;
    }

    if (url.startsWith('/api/registry')) {
      handleApiRegistry(req, res);
      return;
    }

    if (url.startsWith('/api/tour') && method === 'GET') {
      handleApiTour(req, res);
      return;
    }

    if (url.startsWith('/api/explain') && method === 'GET') {
      handleApiExplain(req, res);
      return;
    }

    if (url.startsWith('/api/explain/generate') && method === 'POST') {
      handleApiExplainGenerate(req, res);
      return;
    }

    if (url === '/explain.html' || url.startsWith('/explain.html?')) {
      handleExplainPage(res);
      return;
    }

    if ((url === '/tour.html' || url.startsWith('/tour.html?')) && method === 'GET') {
      handleTourPage(res);
      return;
    }

    if (url.startsWith('/api/trace-exec') && method === 'POST') {
      handleApiTraceExec(req, res);
      return;
    }

    if (url.startsWith('/api/focus') && method === 'POST') {
      handleApiFocus(req, res);
      return;
    }

    handleStaticFile(req, res);
  });

  return new Promise((resolve) => {
    server.listen(listenPort, bindHost, () => {
      const bound = bindHost === '0.0.0.0' ? `（已绑定 0.0.0.0，局域网可访问）` : `（仅本机 ${bindHost}）`;
      console.log(`design-canvas serve running at http://localhost:${listenPort} ${bound}`);
      console.log(`  - 静态文件: ${PUBLIC_DIR}`);
      console.log(`  - API: POST /api/save, GET /api/load, GET /api/features`);
      console.log(`  - 布局 API: POST /api/layout/dag, POST /api/layout/force, POST /api/layout/grid`);
      console.log(`  - 代码生成 API: POST /api/scaffold`);
      console.log(`  - 一致性检查 API: POST /api/consistency`);
      console.log(`  - 变更影响分析 API: POST /api/diff-impact`);
      console.log(`  - 架构分层分析 API: POST /api/arch-layer`);
      console.log(`  - 导览路径 API: POST /api/guided-tour`);
      console.log(`  - 语言概念 API: POST /api/language-concepts`);
      console.log(`  - git 改动清单 API: GET /api/git-diff`);
      console.log(`  - 产物注册表 API: GET/POST /api/registry`);
      console.log(`  - SSE 实时推送: GET /api/events`);
      console.log(`  - 访问 http://localhost:${listenPort} 打开设计画布`);

      // 常驻 watch（最后一英里实时推送）：DC_AUTO_WATCH=1 + DC_WATCH_FEATURE=X 时，
      // 监听 cwd 代码变更 → 重建实际 DSL（live/）→ SSE 推送 dsl-changed(source=watch)，
      // 打开的画布自动刷新并重新跑 /api/diff-views 图级高亮（含边级结构塌方）。
      if (process.env.DC_AUTO_WATCH === '1' && process.env.DC_WATCH_FEATURE) {
        const autoFeature = process.env.DC_WATCH_FEATURE.trim();
        try {
          const projectRoot = getServeProjectRoot();
          const db = getProjectCacheDb(projectRoot);
          let throttle: ReturnType<typeof createRebuildThrottler>;
          throttle = createRebuildThrottler({
            windowMs: 2000,
            run: async () => {
              await importProject({ project_dir: projectRoot, feature: autoFeature, cache_db: db, live_only: true });
              broadcastSSE('dsl-changed', { feature: autoFeature, source: 'watch', timestamp: new Date().toISOString() });
            },
          });
          watchProject({
            project_root: projectRoot,
            db,
            debounce_ms: 150,
            onChange: () => throttle.trigger(),
            onError: (err) => console.warn('[watch]', err.message),
          });
          console.log(`  - 常驻 watch 已启动: 代码变更 → 重建 ${autoFeature} → SSE 推送 diff 高亮`);
        } catch (e) {
          console.warn('[watch] 启动失败:', (e as Error).message);
        }
      }

      resolve();
    });
  });
}

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  startServer().catch((e) => {
    console.error('Server error:', e);
    process.exit(1);
  });
}
