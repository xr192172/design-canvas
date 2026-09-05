/**
 * archify_project 适配 + 视觉令牌测试
 *
 * 分层锚定：Archify 已作为内置能力接入（archify_pipeline ⇐ archify_semantics ⇐
 * archify_mappers），archify_project 只保留「编辑 IR 树 ↔ 数据层契约」的适配与
 * Archify 视觉令牌。演示层派生只读、绝不写回编辑真源。
 */
import { describe, it, expect } from 'vitest';
import { roleToType, ARCHIFY_TYPE_COLOR, adaptIRTree } from '../../src/tools/archify_project';

describe('适配层：编辑 IR 树（IRView/IRNode 渲染形状）→ ArchifyTreeNode（数据层契约形状）', () => {
  // 模拟前端 workbench 真实编辑真源：根是 IRView，节点带渲染字段，children 是 IRView（可递归）
  const irView = {
    id: 'nav:root',
    label: 'agent-shell',
    width: 560, height: 210, layout: 'grid', tint: '#3b82f6',
    nodes: [
      {
        id: 'nav:intro', label: '介绍卡', role: 'intro', type: 'module', layer: 'main',
        status: 'info', statusText: '5 个功能', x: 28, y: 32, w: 520, h: 150, hasPos: true,
        children: {
          id: 'nav:features', label: '功能介绍', width: 1200, height: 300, layout: 'grid',
          nodes: [
            {
              id: 'nav:feat:0:f1', label: '主程序编排', role: 'feature', type: 'feature',
              layer: 'main', status: 'info', statusText: '8 个步骤', x: 0, y: 0, w: 240, h: 92, hasPos: false,
              pins: { in: ['config'], out: ['AstNode'] },
              children: {
                id: 'nav:t0_f1:steps', label: '实现路径', layout: 'flow',
                nodes: [
                  {
                    id: 's0', label: '点燃启动开关', role: 'step', type: 'step', layer: 'main',
                    status: 'info', statusText: '实现步骤', x: 0, y: 0, w: 520, h: 108, hasPos: true,
                    pins: { in: [], out: ['事件'] },
                    file: 'main.go',
                  },
                  { id: 's1', label: '搭建调度中枢', role: 'step', type: 'step', layer: 'main', status: 'info', statusText: '实现步骤', x: 0, y: 108, w: 520, h: 108, hasPos: true, file: 'main_orchestrator.go' },
                ],
                edges: [
                  { id: 'seq0', from: 's0', to: 's1', label: '顺序承接', kind: 'flow', light: true, active: true },
                ],
              },
            },
          ],
          edges: [],
        },
      },
    ],
    edges: [],
  };

  it('IRView 形状 → 根包成 children.nodes/edges；渲染字段（width/height/layout/tint/statusText/panel…）被剥离', () => {
    const out = adaptIRTree(irView);
    expect(out.id).toBe('nav:root');
    expect(out.label).toBe('agent-shell');
    expect(out).not.toHaveProperty('width');
    expect(out).not.toHaveProperty('nodes');
    expect(out.children?.nodes).toHaveLength(1);
    expect(out.children?.edges).toEqual([]);
    const intro = out.children!.nodes![0];
    expect(intro.id).toBe('nav:intro');
    expect(intro).not.toHaveProperty('x');
    expect(intro).not.toHaveProperty('statusText');
    expect(intro).not.toHaveProperty('panel');
  });

  it('IRNode 形状 → 只搬运契约字段（role/type/file/pins 保真），children(IRView) 递归适配', () => {
    const out = adaptIRTree(irView);
    const feat = out.children!.nodes![0].children!.nodes![0];
    expect(feat).toMatchObject({ id: 'nav:feat:0:f1', label: '主程序编排', role: 'feature', type: 'feature' });
    expect(feat.pins).toEqual({ in: ['config'], out: ['AstNode'] });
    expect(feat.children?.nodes).toHaveLength(2);
    const s0 = feat.children!.nodes![0];
    expect(s0).toMatchObject({ id: 's0', label: '点燃启动开关', role: 'step', file: 'main.go' });
    expect(s0.pins).toEqual({ out: ['事件'] });
    expect(feat.children!.edges).toEqual([
      { id: 'seq0', from: 's0', to: 's1', label: '顺序承接', kind: 'flow' },
    ]);
  });

  it('不突变输入：适配是纯函数，原始编辑 IR 逐字节不变', () => {
    const before = JSON.stringify(irView);
    adaptIRTree(irView);
    expect(JSON.stringify(irView)).toBe(before);
  });
});

describe('视觉令牌：role → Archify type 确定性映射且落在色板内', () => {
  it('service/core → backend、client → external、data/contract → database、queue → messagebus、auth → security、cloud → cloud', () => {
    expect(roleToType('cloud')).toBe('cloud');
    expect(roleToType('service')).toBe('backend');
    expect(roleToType('client')).toBe('external');
    expect(roleToType('contract')).toBe('database');
    expect(roleToType('queue')).toBe('messagebus');
    expect(roleToType('auth')).toBe('security');
  });
  it('未知 role 落到 backend 兜底，且任何映射结果都在色板内', () => {
    const t = roleToType('whatever_x');
    expect(t).toBe('backend');
    expect(ARCHIFY_TYPE_COLOR[t]).toBeDefined();
  });
});