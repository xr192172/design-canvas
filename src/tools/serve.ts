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
    filePath = '/conveyor.html';
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

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((e) => {
    console.error('Server error:', e);
    process.exit(1);
  });
}
