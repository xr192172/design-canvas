/**
 * archify_demo —— 演示模式服务端工具：IRView → toArchify → (装配 Archify 则) validate+deliver HTML
 *
 * 浏览器跑不了 Archify 的 Node CLI，故把"deliver HTML"放到 design-canvas serve 侧：
 *  dsl-workbench "演示模式" 按钮 → POST /api/archify-demo { view } → 本函数投影 + (可选)出 HTML。
 *
 * 优雅降级：未配置 ARCHIFY_ROOT（或 CLI 缺失）时，仍投影出 Archify IR 并如实标注"未 deliver"，
 *  让前端至少有 IR 可看/可存；装配好 Archify 后重新调用即可取到 HTML。
 * 派生只读：只读 view 的 id/label/role/sublabel/tag，绝不写回编辑真源（toArchify 保证）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toArchify, type ArchifyIR, type ProjView } from './archify_project.js';

export interface RenderArchifyDemoOptions {
  view: ProjView;
  /** Archify 仓库根；缺省取 env ARCHIFY_ROOT */
  archifyRoot?: string;
  /** 输出的 HTML 落点目录；缺省 process.cwd()/output */
  outDir?: string;
  /** 输出的 HTML 文件名；缺省 <view.id>-archify.html */
  output?: string;
}

export interface RenderArchifyDemoResult {
  archify: ArchifyIR;
  /** 已真实 deliver 的 HTML 绝对路径（未装配/失败时不返回） */
  htmlPath?: string;
  /** true = 已 deliver 出 HTML；false = 仅返回 IR（未装配或失败） */
  delivered: boolean;
  note?: string;
}

export function resolveArchifyRoot(explicit?: string): string {
  return (explicit?.trim() || process.env.ARCHIFY_ROOT?.trim() || '').replace(/[\\/]+$/, '');
}

/** 投影 IRView → Archify IR；若 Archify CLI 可用则 validate+deliver 出 HTML。 */
export function renderArchifyDemo(opts: RenderArchifyDemoOptions): RenderArchifyDemoResult {
  const archify = toArchify(opts.view);
  const root = resolveArchifyRoot(opts.archifyRoot);
  if (!root) {
    return {
      archify,
      delivered: false,
      note: 'ARCHIFY_ROOT 未配置：仅返回 Archify IR；设 ARCHIFY_ROOT 后本端点可 validate+deliver 出 HT="可交互惊艳视图".',
    };
  }
  const cli = path.join(root, 'archify', 'bin', 'archify.mjs');
  if (!fs.existsSync(cli)) {
    return { archify, delivered: false, note: `Archify CLI 未找到：${cli}` };
  }

  const cwd = process.cwd();
  const outDir = path.resolve(opts.outDir ?? path.join(cwd, 'output'));
  fs.mkdirSync(outDir, { recursive: true });
  const inputPath = path.join(outDir, `${opts.view.id || 'view'}-ir.json`);
  const htmlPath = path.resolve(outDir, opts.output || `${opts.view.id || 'view'}-archify.html`);
  fs.writeFileSync(inputPath, JSON.stringify(archify, null, 2), 'utf-8');

  const run = (args: string[]) => spawnSync('node', [cli, ...args], { encoding: 'utf8', windowsHide: true });
  const v = run(['validate', 'architecture', inputPath]);
  if (v.status !== 0) {
    return { archify, delivered: false, note: `Archify validate 失败：${(v.stderr || v.stdout || '').slice(0, 400)}` };
  }
  const d = run(['deliver', 'architecture', inputPath, htmlPath]);
  if (d.status !== 0) {
    return { archify, delivered: false, note: `Archify deliver 失败：${(d.stderr || d.stdout || '').slice(0, 400)}` };
  }
  return { archify, htmlPath, delivered: true };
}