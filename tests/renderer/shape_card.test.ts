import { describe, it, expect } from 'vitest';
import { schemaToHuman } from '../../src/renderer/shape_card';
import type { AnimationValueSchema } from '../../src/dsl/types';

describe('schemaToHuman - 基本类型', () => {
  it('标量类型中文化', () => {
    expect(schemaToHuman({ type: 'string' })).toBe('字符串');
    expect(schemaToHuman({ type: 'number' })).toBe('数字');
    expect(schemaToHuman({ type: 'integer' })).toBe('整数');
    expect(schemaToHuman({ type: 'boolean' })).toBe('布尔');
    expect(schemaToHuman({ type: 'null' })).toBe('空');
  });

  it('undefined schema 显示占位符', () => {
    expect(schemaToHuman(undefined)).toBe('?');
  });

  it('label 优先（作者手写人话直接返回）', () => {
    expect(schemaToHuman({ type: 'string', label: '一串字符' })).toBe('一串字符');
  });

  it('enum 追加在类型后', () => {
    expect(schemaToHuman({ type: 'string', enum: ['active', 'banned'] })).toBe('字符串(active|banned)');
  });
});

describe('schemaToHuman - 复合类型', () => {
  it('数组：元素类型[]', () => {
    expect(schemaToHuman({ type: 'array', items: { type: 'string' } })).toBe('字符串[]');
  });

  it('数组无 items 退化为 任意[]', () => {
    expect(schemaToHuman({ type: 'array' })).toBe('任意[]');
  });

  it('对象：{k: 类型}；非 required 字段带 ?', () => {
    const s: AnimationValueSchema = {
      type: 'object',
      properties: {
        token: { type: 'string' },
        user_id: { type: 'integer' },
      },
      required: ['token'],
    };
    expect(schemaToHuman(s)).toBe('{token: 字符串, user_id?: 整数}');
  });

  it('无 required 声明时全部字段不带 ?', () => {
    const s: AnimationValueSchema = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    };
    expect(schemaToHuman(s)).toBe('{a: 字符串, b: 数字}');
  });

  it('空对象 {}', () => {
    expect(schemaToHuman({ type: 'object' })).toBe('{}');
  });

  it('嵌套对象（2 层内展开）', () => {
    const s: AnimationValueSchema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
    };
    expect(schemaToHuman(s)).toBe('{user: {name: 字符串}}');
  });
});

describe('schemaToHuman - 防爆', () => {
  it('嵌套超过 2 层退化为 {…}', () => {
    const s: AnimationValueSchema = {
      type: 'object',
      properties: {
        l1: {
          type: 'object',
          properties: {
            l2: {
              type: 'object',
              properties: { l3: { type: 'string' } },
            },
          },
        },
      },
    };
    expect(schemaToHuman(s)).toBe('{l1: {l2: {…}}}');
  });

  it('对象超过 4 个字段截断为 …+N', () => {
    const props: Record<string, AnimationValueSchema> = {};
    for (let i = 0; i < 7; i++) props['f' + i] = { type: 'string' };
    const out = schemaToHuman({ type: 'object', properties: props });
    expect(out).toContain('…+3');
    expect(out).not.toContain('f4');
  });

  it('嵌套数组不消耗深度（X[][] 仍可读）', () => {
    const s: AnimationValueSchema = {
      type: 'array',
      items: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    };
    expect(schemaToHuman(s)).toBe('字符串[][][]');
  });

  it('数组内对象按对象深度正常截断', () => {
    // root obj(d0) → arr(d1) → obj(d1) → obj(d2 超限 → {…})
    const s: AnimationValueSchema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              deep: { type: 'object', properties: { x: { type: 'string' } } },
            },
          },
        },
      },
    };
    expect(schemaToHuman(s)).toBe('{list: {deep: {…}}[]}');
  });
});
