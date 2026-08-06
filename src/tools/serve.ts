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
import { saveDSL, getDSL, getLiveDslFile, onDslChange } from '../storage.js';
import { validateDSLJson } from '../dsl/validator.js';
import { dagLayout, forceLayout, gridAlign } from './dag_layout.js';
import { scaffold } from './scaffold.js';
import { checkConsistency } from './consistency.js';
import { diffImpact } from './diff_impact.js';
import { archLayer } from './arch_layer.js';
import { readRegistry, updateArtifact } from './registry.js';
import { checkMonolith } from './monolith.js';
import type { FileMonolithReport } from './monolith.js';
import { traceExecChain, type TraceStepSpec } from './trace_exec.js';
import { loadLlmConfig, pickKeyNodes, type ChainNodeInfo } from './llm_focus.js';

const PORT = parseInt(process.argv[2]) || 3000;
const PUBLIC_DIR = path.join(process.cwd(), 'output');
const LIVE_FILE = getLiveDslFile();

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
    const projectRoot = process.cwd();
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
    const result = scaffold({
      feature: params.feature || 'conveyor',
      output_dir: params.output_dir,
      overwrite: params.overwrite,
      ui_framework: params.ui_framework,
    });
    sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
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
    const result = diffImpact({
      feature: params.feature || 'conveyor',
      project_dir: params.project_dir || process.cwd(),
      changed: Array.isArray(params.changed) ? params.changed : [],
      direction: params.direction,
      max_depth: params.max_depth,
    });
    sendJson(res, 200, { success: true, ...result });
  } catch (e) {
    sendError(res, 500, (e as Error).message);
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

/** GET /api/tour?feature=X：返回该 feature 的产物导览序列（按注册顺序） */
function handleApiTour(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const feature = q.get('feature') ?? '';
  const steps = readRegistry()
    .filter((e) => e.feature === feature)
    .map((e) => ({ path: e.path, title: e.title || e.path, type: e.type || '' }));
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
  var feature = new URLSearchParams(location.search).get('feature') || '';
  var steps = [], i = 0;
  var frame = document.getElementById('frame');
  var loading = document.getElementById('loading');
  function go(k){
    if(!steps.length) return;
    i = Math.max(0, Math.min(steps.length-1, k));
    loading.style.display = 'block';
    frame.style.opacity = '0.3';
    frame.src = steps[i].path;
  }
  function update(){
    document.querySelectorAll('#dots .dot').forEach(function(b, k){ b.classList.toggle('cur', k === i); b.title = steps[k].title; });
    document.getElementById('prog').textContent = (steps.length ? (i+1) + ' / ' + steps.length : '0 / 0');
    document.getElementById('prev').disabled = i === 0;
    document.getElementById('next').disabled = i === steps.length-1;
  }
  fetch('/api/tour?feature=' + encodeURIComponent(feature))
    .then(function(r){ return r.json(); })
    .then(function(j){
      steps = j.steps || [];
      document.getElementById('ftitle').textContent = j.feature || '';
      var dots = document.getElementById('dots');
      dots.innerHTML = '';
      steps.forEach(function(_, k){
        var b = document.createElement('button');
        b.className = 'dot';
        b.onclick = function(){ go(k); };
        dots.appendChild(b);
      });
      if(!steps.length){ loading.textContent = '该 feature 暂无注册产物'; return; }
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

function handleStaticFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  let filePath = req.url || '/';
  // 去除查询参数（如 ?t=v3）
  const qIdx = filePath.indexOf('?');
  if (qIdx !== -1) filePath = filePath.substring(0, qIdx);
  if (filePath === '/') {
    // Hub 主页优先（self-analyze 等流水线生成的项目入口），否则回退示例画布
    filePath = fs.existsSync(path.join(PUBLIC_DIR, 'index.html')) ? '/index.html' : '/conveyor.html';
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

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startServer(port?: number): Promise<void> {
  const listenPort = port || PORT;

  // 注册 DSL 变更回调：MCP saveDSL → SSE 广播
  onDslChange((feature, source) => {
    notifyDslChange(feature, source);
  });

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const method = req.method || 'GET';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.startsWith('/api/events') && method === 'GET') {
      // SSE 端点：保持连接，推送 DSL 变更事件
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
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

    if (url.startsWith('/api/arch-layer') && method === 'POST') {
      handleApiArchLayer(req, res);
      return;
    }

    if (url.startsWith('/api/git-diff') && method === 'GET') {
      handleApiGitDiff(req, res);
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
    server.listen(listenPort, () => {
      console.log(`design-canvas serve running at http://localhost:${listenPort}`);
      console.log(`  - 静态文件: ${PUBLIC_DIR}`);
      console.log(`  - API: POST /api/save, GET /api/load, GET /api/features`);
      console.log(`  - 布局 API: POST /api/layout/dag, POST /api/layout/force, POST /api/layout/grid`);
      console.log(`  - 代码生成 API: POST /api/scaffold`);
      console.log(`  - 一致性检查 API: POST /api/consistency`);
      console.log(`  - 变更影响分析 API: POST /api/diff-impact`);
      console.log(`  - 架构分层分析 API: POST /api/arch-layer`);
      console.log(`  - git 改动清单 API: GET /api/git-diff`);
      console.log(`  - 产物注册表 API: GET/POST /api/registry`);
      console.log(`  - SSE 实时推送: GET /api/events`);
      console.log(`  - 访问 http://localhost:${listenPort} 打开设计画布`);
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
