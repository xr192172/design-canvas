#!/usr/bin/env node
/**
 * npm run demo —— 黄金演示路径：克隆后三步看到 design-canvas 的价值
 *
 * 流程：build（缺则补）→ 渲染 examples/*.json 为「feature DSL + HTML 产物并注册」
 *       → 起 serve → 自动打开 /workbench#<首个示例>。
 * 全程复用现有工具链（render_dsl 持久化+渲染+注册、serve 静态服务），不新增业务逻辑。
 *
 * 用法（design-canvas 根）：
 *   npm run demo                 # 完整：准备示例 + 起服务 + 开浏览器
 *   npm run demo -- 8081         # 指定端口
 *   npm run demo -- --prepare    # 只准备示例（构建+渲染+注册），不起服务（适合 CI/验收）
 *   npm run demo -- --no-open    # 起服务但不自动开浏览器
 *
 * 幂等：已有同名 feature（用户数据）不会被覆盖，仅提示跳过。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGS = process.argv.slice(2);
const PREPARE_ONLY = ARGS.includes('--prepare');
const NO_OPEN = ARGS.includes('--no-open');
const PORT_ARG = ARGS.find((a) => /^\d+$/.test(a));
const PORT = PORT_ARG ? parseInt(PORT_ARG, 10) : parseInt(process.env.DC_PORT || '3000', 10);
const BASE_URL = `http://localhost:${PORT}`;
const EXAMPLES_DIR = path.join(ROOT, 'examples');
const SERVE_JS = path.join(ROOT, 'dist', 'src', 'tools', 'serve.js');

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`))));
  });
}

async function waitReady(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/** 渲染 examples/ 下所有示例 DSL → feature 存档 + HTML 产物 + 注册表 */
async function prepareExamples() {
  if (!fs.existsSync(SERVE_JS)) {
    console.log('[demo] dist 不存在，先 npm run build …');
    await run('npm', ['run', 'build'], ROOT);
  }

  const { renderDsl } = await import(pathToFileURL(path.join(ROOT, 'dist', 'src', 'tools', 'render_dsl.js')).href);
  if (!fs.existsSync(EXAMPLES_DIR)) {
    console.log('[demo] examples/ 目录不存在，无示例可渲染');
    return [];
  }

  const rendered = [];
  const files = fs.readdirSync(EXAMPLES_DIR).filter((n) => n.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log('[demo] examples/ 下没有 .json 示例');
    return [];
  }

  for (const f of files) {
    let dslJson;
    let feature;
    try {
      dslJson = fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf-8');
      feature = JSON.parse(dslJson).feature;
    } catch (e) {
      console.warn(`[demo] 跳过 ${f}（解析失败：${e.message}）`);
      continue;
    }
    if (!feature) {
      console.warn(`[demo] 跳过 ${f}（缺少 feature 字段）`);
      continue;
    }
    const featureFile = path.join(ROOT, '.design-canvas', 'features', `${feature}.json`);
    if (fs.existsSync(featureFile)) {
      console.log(`[demo] 跳过 ${feature}（已存在同名 feature，不覆盖用户数据）`);
      continue;
    }
    try {
      const r = renderDsl({ dsl_json: dslJson, persist: true });
      rendered.push(feature);
      console.log(`[demo] ✓ 渲染示例 ${feature} → ${r.htmlFile}`);
    } catch (e) {
      console.warn(`[demo] ✗ 渲染 ${feature} 失败：${e.message}`);
    }
  }
  return rendered;
}

async function main() {
  console.log(`\n[demo] design-canvas 黄金演示路径（端口 ${PORT}）\n`);
  const rendered = await prepareExamples();

  if (PREPARE_ONLY) {
    console.log(`\n[demo] 准备完成：已就绪 ${rendered.length} 个示例 feature。`);
    console.log('[demo] 执行 npm run demo 可启动服务并打开工作台。\n');
    return;
  }

  // 端口已有服务？直接复用
  if (await waitReady(BASE_URL, 1200)) {
    console.log(`[demo] 端口 ${PORT} 已有服务在跑，直接打开 ${BASE_URL}/workbench`);
    if (!NO_OPEN) openBrowser(`${BASE_URL}/workbench`);
    return;
  }

  console.log(`[demo] 启动服务（端口 ${PORT}）… Ctrl+C 停止`);
  const server = spawn(process.execPath, [SERVE_JS, String(PORT)], { stdio: 'inherit', cwd: ROOT });
  server.on('close', (code) => process.exit(code ?? 0));

  if (await waitReady(BASE_URL, 15000)) {
    const first = rendered[0] || '';
    const url = first ? `${BASE_URL}/workbench#${first}` : `${BASE_URL}/workbench`;
    console.log(`[demo] 已就绪，打开 ${url}`);
    if (!NO_OPEN) openBrowser(url);
    console.log(`
────────────────────────────────────────────────────────────
  你现在看到的是 design-canvas 的可视化协议层（工作台）。
  左边画布：示例 DSL 渲染的可交互图（点击节点看详情）。
  下一步（10 分钟闭环）：在 MCP client（Claude/Cursor）里
  让 LLM 调用 edit_dsl 改这张图 → 浏览器画布会自动刷新。
────────────────────────────────────────────────────────────`);
  } else {
    console.error('[demo] 服务启动超时，请查看上方日志排查');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[demo]', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
