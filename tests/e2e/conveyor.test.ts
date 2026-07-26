/**
 * 端到端测试：conveyor 示例 → render_dsl → 检查 HTML 文件
 *
 * 测试覆盖 MVP 阶段 4 的验收标准：
 * - conveyor.json 通过 schema 校验
 * - render_dsl 成功渲染 conveyor HTML
 * - HTML 文件存在于 output/ 目录
 * - HTML 包含核心节点 / 边 / 卡片内容
 * - 持久化到 .design-canvas/features/conveyor.json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderDsl } from '../../src/tools/render_dsl';
import { getDsl } from '../../src/tools/get_dsl';
import { listFeatures } from '../../src/tools/list_features';
import { clearAllFeatures, getFeatureFile, getDataHome } from '../../src/storage';

const CONVEYOR_PATH = path.resolve(process.cwd(), 'examples/conveyor.json');
// 输出目录跟随数据主目录：测试 setup 把 DESIGN_CANVAS_HOME 指向临时目录，
// renderDsl 默认输出到 <dataHome>/output，这里读取同一位置
const OUTPUT_DIR = path.join(getDataHome(), 'output');
const CONVEYOR_HTML = path.join(OUTPUT_DIR, 'conveyor.html');

function cleanup(): void {
  // 清理持久化文件
  clearAllFeatures();
  // 清理输出 HTML（保留目录）
  if (fs.existsSync(CONVEYOR_HTML)) fs.unlinkSync(CONVEYOR_HTML);
}

describe('e2e: conveyor 端到端', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('conveyor.json 文件存在且能读取', () => {
    expect(fs.existsSync(CONVEYOR_PATH)).toBe(true);
    const content = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    // 文件可能带 UTF-8 BOM，原生 JSON.parse 不接受，validator 会处理
    const clean = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    expect(() => JSON.parse(clean)).not.toThrow();
  });

  it('render_dsl 渲染 conveyor，返回成功消息', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    const result = renderDsl({ dsl_json: dslJson });
    expect(result.message).toContain('已渲染');
    expect(result.htmlFile).toBe(CONVEYOR_HTML);
  });

  it('HTML 文件已生成', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    expect(fs.existsSync(CONVEYOR_HTML)).toBe(true);
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html.length).toBeGreaterThan(1000);
  });

  it('HTML 包含所有核心节点标签', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).toContain('L0 永久层');
    expect(html).toContain('SummaryZone');
    expect(html).toContain('SectionQueue');
    expect(html).toContain('CurrentRound');
    expect(html).toContain('DraftZone');
    expect(html).toContain('DynamicInjection');
    expect(html).toContain('ContextComposition');
  });

  it('HTML 包含 SVG 节点和边', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).toContain('<svg');
    // 33 个节点（含 4 个 detail 层形状卡节点）
    expect((html.match(/class="node[^"]*"/g) ?? []).length).toBe(33);
    // 33 条边（含 3 条 detail 变形链边）
    expect((html.match(/class="edge"/g) ?? []).length).toBe(33);
  });

  it('HTML 包含 semantic 卡片（6 个文件路径）', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).toContain('arch_knowledge.go');
    expect(html).toContain('summary_zone.go');
    expect(html).toContain('section_queue.go');
    expect(html).toContain('current_round.go');
    expect(html).toContain('draft_zone.go');
    expect(html).toContain('dynamic_injection.go');
  });

  it('HTML 包含不变式列表（3 条）', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).toContain('不变式 (3)');
    expect(html).toContain('SectionQueue 不直接调 Memory.VectorStore');
  });

  it('HTML 无外部依赖（断网也能用）', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    // 无任何 http(s) 资源引用（允许 SVG xmlns 命名空间声明和 createElementNS 中的 SVG 命名空间）
    const stripped = html
      .replace(/xmlns="https?:\/\/www\.w3\.org\/[^"]+"/g, '')
      .replace(/https?:\/\/www\.w3\.org\/2000\/svg/g, '');
    expect(stripped).not.toMatch(/https?:\/\//i);
  });

  it('HTML 包含导出按钮', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const html = fs.readFileSync(CONVEYOR_HTML, 'utf-8');
    expect(html).toContain('id="export-json"');
  });

  it('DSL 已持久化到 .design-canvas/features/conveyor.json', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const stored = getFeatureFile('conveyor');
    expect(fs.existsSync(stored)).toBe(true);
  });

  it('get_dsl 能读回 conveyor', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const result = getDsl({ feature_name: 'conveyor' });
    const parsed = JSON.parse(result.json);
    expect(parsed.feature).toBe('conveyor');
    expect(parsed.geometry.nodes).toHaveLength(33);
  });

  it('list_features 能列出 conveyor', () => {
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson });
    const result = listFeatures();
    expect(result.count).toBe(1);
    expect(result.message).toContain('conveyor');
    expect(result.message).toContain('done');
    expect(result.message).toContain('7 文件');
    expect(result.message).toContain('3 不变式');
  });

  it('非法 DSL 返回校验错误', () => {
    expect(() =>
      renderDsl({ dsl_json: '{ not valid json' }),
    ).toThrow(/json_parse|校验失败/);
  });

  it('缺必填字段的 DSL 返回校验错误', () => {
    const bad = JSON.stringify({ id: 'x', type: 'feature_diagram' }); // 缺 feature/geometry
    expect(() => renderDsl({ dsl_json: bad })).toThrow(/校验失败/);
  });

  it('自定义 output_path 生效', () => {
    const customPath = path.join(OUTPUT_DIR, 'custom.html');
    if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson, output_path: customPath });
    expect(fs.existsSync(customPath)).toBe(true);
    if (fs.existsSync(customPath)) fs.unlinkSync(customPath);
  });

  it('output 目录不存在时自动创建', () => {
    const nestedPath = path.join(OUTPUT_DIR, 'nested', 'deep', 'out.html');
    // 清理可能存在的旧目录
    const nestedDir = path.join(OUTPUT_DIR, 'nested');
    if (fs.existsSync(nestedDir)) fs.rmSync(nestedDir, { recursive: true });

    const dslJson = fs.readFileSync(CONVEYOR_PATH, 'utf-8');
    renderDsl({ dsl_json: dslJson, output_path: nestedPath });
    expect(fs.existsSync(nestedPath)).toBe(true);

    if (fs.existsSync(nestedDir)) fs.rmSync(nestedDir, { recursive: true });
  });
});
