/**
 * render_dsl 工具实现
 *
 * 输入：dsl_json (string, 必填) + output_path (string, 可选)
 * 行为：
 *   1. 校验 DSL（schema + 语义锚定）
 *   2. 保存 DSL 到 .design-canvas/features/<feature>.json
 *   3. 调渲染器生成 HTML
 *   4. 写 HTML 到 output_path（默认 output/<feature>.html）
 *   5. 返回路径信息
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateDSLJson } from '../dsl/validator.js';
import { saveDSL } from '../storage.js';
import { renderHTML } from '../renderer/html_renderer.js';

export interface RenderDslInput {
  dsl_json: string;
  output_path?: string;
}

export interface RenderDslResult {
  /** 保存的 DSL 文件绝对路径 */
  dslFile: string;
  /** 渲染的 HTML 文件绝对路径 */
  htmlFile: string;
  /** 用户友好的消息（直接放进 MCP content） */
  message: string;
}

/** 默认输出路径：<cwd>/output/<feature>.html */
function defaultOutputPath(feature: string): string {
  return path.join(process.cwd(), 'output', `${feature}.html`);
}

/** 确保 output 目录存在 */
function ensureOutputDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 执行 render_dsl
 * @throws Error 当 DSL 校验失败时
 */
export function renderDsl(input: RenderDslInput): RenderDslResult {
  const { dsl_json, output_path } = input;

  // 1. 校验
  const result = validateDSLJson(dsl_json);
  if (!result.valid || !result.dsl) {
    throw new Error(`DSL 校验失败：\n${result.errors.join('\n')}`);
  }
  const dsl = result.dsl;

  // 2. 持久化 DSL
  const dslFile = saveDSL(dsl);

  // 3. 渲染 HTML
  const html = renderHTML(dsl);

  // 4. 写 HTML 文件
  const htmlFile = path.resolve(output_path ?? defaultOutputPath(dsl.feature));
  ensureOutputDir(htmlFile);
  fs.writeFileSync(htmlFile, html, 'utf-8');

  // 5. 返回路径信息
  const fileUrl = `file:///${htmlFile.replace(/\\/g, '/')}`;
  const message = [
    `已渲染：${htmlFile}`,
    `（浏览器打开 ${fileUrl} 查看）`,
    `DSL 已保存：${dslFile}`,
  ].join('\n');

  return { dslFile, htmlFile, message };
}
