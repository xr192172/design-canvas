/**
 * explain_gen 角色文案持久化测试（讲解导览 G2）
 *
 * 覆盖：
 *   - saveGeneratedNarrations 落盘到 <dataHome>/.design-canvas/explain.gen.json
 *   - loadGeneratedNarrations 读回并按标题索引
 *   - 二次保存按标题覆盖
 *   - 空/损坏文件 → 返回空对象（不抛错）
 *   - 校验三档字段缺失时丢弃该条
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  loadGeneratedNarrations,
  saveGeneratedNarrations,
  getExplainGenFile,
} from '../../src/tools/explain_gen';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-explain-'));
process.env.DESIGN_CANVAS_HOME = root;

afterAll(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows 文件占用，留给 OS 清理
  }
});

describe('explain_gen 持久化', () => {
  it('保存后按标题读回，路径位于 <dataHome>/.design-canvas', () => {
    const file = saveGeneratedNarrations([
      { title: '入口：MCP 服务', narrations: { newbie: 'n', pm: 'p', senior: 's' } },
    ]);
    expect(file).toBe(getExplainGenFile());
    expect(fs.existsSync(file)).toBe(true);
    expect(file.startsWith(path.join(root, '.design-canvas'))).toBe(true);

    const map = loadGeneratedNarrations();
    expect(map['入口：MCP 服务']).toEqual({ newbie: 'n', pm: 'p', senior: 's' });
  });

  it('二次保存同标题覆盖，不同标题追加', () => {
    saveGeneratedNarrations([
      { title: 'A', narrations: { newbie: 'a1', pm: 'p1', senior: 's1' } },
    ]);
    saveGeneratedNarrations([
      { title: 'A', narrations: { newbie: 'a2', pm: 'p2', senior: 's2' } },
      { title: 'B', narrations: { newbie: 'b', pm: 'pb', senior: 'sb' } },
    ]);
    const map = loadGeneratedNarrations();
    expect(map.A.newbie).toBe('a2'); // 覆盖
    expect(map.B.newbie).toBe('b'); // 追加
  });

  it('无文件 / 损坏文件 / 缺三档字段 → 返回空或丢弃', () => {
    // 无文件
    fs.rmSync(getExplainGenFile(), { force: true });
    expect(loadGeneratedNarrations()).toEqual({});

    // 损坏 JSON
    fs.writeFileSync(getExplainGenFile(), '{oops', 'utf-8');
    expect(loadGeneratedNarrations()).toEqual({});

    // 三档字段不全 → 丢弃该条
    fs.writeFileSync(getExplainGenFile(), JSON.stringify({ X: { newbie: 'only' } }), 'utf-8');
    const map = loadGeneratedNarrations();
    expect(map.X).toBeUndefined();
  });
});