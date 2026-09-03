/**
 * archify_demo 服务端演示工具测试：未装配 Archify 时优雅返回 IR + 如实标注，绝不写回编辑真源。
 */
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderArchifyDemo, resolveArchifyRoot } from '../../src/tools/archify_demo';
import type { ProjView } from '../../src/tools/archify_project';

const view: ProjView = {
  id: 'v1',
  label: '能力面',
  title: 'design-canvas 能力面',
  nodes: [
    { id: 'client', label: 'MCP Client', role: 'client', type: 'external' },
    { id: 'mcp', label: 'MCP core', role: 'core', type: 'backend' },
    { id: 'render', label: 'render', role: 'renderer', type: 'frontend' },
  ],
  edges: [
    { id: 'e1', from: 'client', to: 'mcp', label: 'call', kind: 'flow' },
    { id: 'e2', from: 'mcp', to: 'render', label: 'render', kind: 'flow' },
  ],
};

describe('renderArchifyDemo 优雅降级', () => {
  it('未配置 ARCHIFY_ROOT → delivered:false，返回 IR + 如实说明', () => {
    const res = renderArchifyDemo({ view, archifyRoot: '' });
    expect(res.delivered).toBe(false);
    expect(res.htmlPath).toBeUndefined();
    expect(res.archify.schema_version).toBe(1);
    expect(res.archify.meta.title).toBe('design-canvas 能力面');
    expect(res.note).toBeTruthy();
  });

  it('ARCHIFY_ROOT 指向不存在的 CLI → delivered:false 且说明', () => {
    const bad = path.join(process.cwd(), '__no_such_archify_root__');
    const res = renderArchifyDemo({ view, archifyRoot: bad });
    expect(res.delivered).toBe(false);
    expect(res.note).toContain('未找到');
  });

  it('绝不写回编辑真源（输入逐字节不变）', () => {
    const before = JSON.stringify(view);
    renderArchifyDemo({ view, archifyRoot: '' });
    expect(JSON.stringify(view)).toBe(before);
  });
});

describe('resolveArchifyRoot', () => {
  it('env 缺省 + 去尾部斜杠 + 显式优先', () => {
    process.env.ARCHIFY_ROOT = 'x/y/';
    expect(resolveArchifyRoot()).toBe('x/y');
    expect(resolveArchifyRoot('a/b///')).toBe('a/b');
    delete process.env.ARCHIFY_ROOT;
    expect(resolveArchifyRoot('')).toBe('');
  });
});