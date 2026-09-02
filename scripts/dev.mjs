#!/usr/bin/env node
/**
 * dev —— 开发态自动重编（消除 STALE BUILD 的"忘了重跑 build"根因）
 *
 * 背景：design-canvas 的 MCP server / CLI 跑 dist/ 编译产物。改 src/** 忘了重跑
 * `npm run build`，服务就一直跑旧代码（文档 5.6 障碍 #5）。stale_check 已能在跑测试/
 * CI 时事后检测，但开发循环里仍会"静默咬人"。本脚本把"重编"变成自动：
 *
 *   - 启动即跑一次 `tsc`（确保 dist 与当下 src 一致）。
 *   - 之后每 600ms 扫描 src/ 下手写 .ts/.tsx 的 mtime，发现新增/变动 → 自动跑 `tsc`，
 *     成功/失败都打印（失败会继续监听，修好即恢复）。
 *   - 轮询而非 fs.watch：规避各平台递归监听差异，且行为确定、可在无真实文件系统时序下复现。
 *
 * 诚实边界：重编让 dist 保持新鲜，但**已在运行的长驻 MCP server 不会自动加载新 dist**——
 * 需要重启 server 才能让新代码生效（脚本启动时会打印这条提示）。
 *
 * 用法：
 *   node scripts/dev.mjs            # 前台常驻（Ctrl+C 停）
 *   node scripts/dev.mjs --once     # 只跑一次编译后退出（CI/一次重建）
 */

import { readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC = path.join(ROOT, 'src');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const POLL_MS = 600;
const once = process.argv.includes('--once');

/** 递归收集 src 下手写 .ts/.tsx（排除 *.gen.ts 生成源，与 stale_check 同口径） → {abs → mtimeMs} */
function snapshot() {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.tsx?$/.test(e.name) && !/\.gen\.ts$/.test(e.name)) out.set(p, statSync(p).mtimeMs);
    }
  };
  walk(SRC);
  return out;
}

/** 跑 tsc，返回 exit code（stdout/stderr 透传） */
function build() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [TSC], { cwd: ROOT, stdio: 'inherit' });
    p.on('close', (code) => resolve(code));
  });
}

async function runOnce() {
  const start = Date.now();
  const code = await build();
  console.log(`[dev] tsc 完成（${Date.now() - start}ms，${code === 0 ? '✓' : '✗ exit ' + code}）`);
  return code;
}

async function main() {
  console.log(`[dev] 监听 ${path.relative(ROOT, SRC)}/ 手写 .ts/.tsx，变更自动重编 → dist/`);
  const initial = await runOnce();
  if (initial !== 0) console.log('[dev] 首编有错误；继续监听，修复后会自动恢复。');
  if (once) {
    process.exit(initial === 0 ? 0 : 1);
    return;
  }
  console.log('[dev] 长驻 MCP server 需重启才能加载新 dist（本循环仅保证 dist 不 STALE）。Ctrl+C 停止。\n');

  let last = snapshot();
  let building = false;
  let dirty = false;

  setInterval(async () => {
    const cur = snapshot();
    // 任何新增/变动/删除（mtime 变化或文件集变化）→ 需要重编
    if (building) {
      dirty = true; // 编译中又有变动，完成后再补跑一次
      last = cur;
      return;
    }
    let changed = cur.size !== last.size;
    if (!changed) {
      for (const [p, m] of cur) if ((last.get(p) ?? -1) !== m) { changed = true; break; }
    }
    if (!changed) return;
    last = cur;
    building = true;
    const code = await build();
    building = false;
    const ts = Date.now();
    console.log(code === 0
      ? `[dev] ${new Date(ts).toLocaleTimeString()} 改动已重编 ✓ dist 新鲜`
      : `[dev] ${new Date(ts).toLocaleTimeString()} 重编失败（exit ${code}）— 修好后自动恢复`);
    if (dirty) {
      dirty = false;
      console.log('[dev] 编译期间存在进一步改动，补跑一次…');
      building = true;
      await build();
      building = false;
      console.log(`[dev] ${new Date().toLocaleTimeString()} 补跑完成`);
    }
  }, POLL_MS);
}

main();