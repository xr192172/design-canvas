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
import { checkMonolith } from './monolith.js';
import type { FileMonolithReport } from './monolith.js';

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
