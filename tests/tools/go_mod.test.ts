/**
 * go_mod 单测（积木重依赖治理 Phase 5+）
 *
 * 覆盖：
 *   - parseGoModRequires：单行 / 括号块 / indirect 注释 / 伪版本 / alias 不入 require
 *   - resolveGoThirdParty：source 本身命中 / 最长前缀归并 / 同 root 多 source 去重 /
 *     无命中进 unresolved（decline rather than guess）
 *   - compareGoVersion：数值比较 / prerelease 高低 / 伪版本时间戳序
 */
import { describe, it, expect } from 'vitest';
import { parseGoModRequires, resolveGoThirdParty, compareGoVersion } from '../../src/tools/go_mod';

describe('parseGoModRequires', () => {
  it('括号块 + 单行 + indirect 注释全收（间接依赖也是版本事实）', () => {
    const text = [
      'module example.com/demo',
      '',
      'go 1.21',
      '',
      'require (',
      '\tgithub.com/x/y v1.2.3',
      '\tgithub.com/a/b v0.0.0-20230101000000-abcdef123456 // indirect',
      '\tgo.opentelemetry.io/otel v1.45.0',
      ')',
      '',
      'require gopkg.in/yaml.v2 v2.4.0',
    ].join('\n');
    expect(parseGoModRequires(text)).toEqual({
      'github.com/x/y': 'v1.2.3',
      'github.com/a/b': 'v0.0.0-20230101000000-abcdef123456',
      'go.opentelemetry.io/otel': 'v1.45.0',
      'gopkg.in/yaml.v2': 'v2.4.0',
    });
  });

  it('module/go/toolchain 指令行不误收；空行注释行跳过', () => {
    const text = [
      'module example.com/demo',
      'go 1.21',
      'toolchain go1.21.5',
      '// comment',
      '',
      'require github.com/x/y v1.0.0',
    ].join('\n');
    expect(parseGoModRequires(text)).toEqual({ 'github.com/x/y': 'v1.0.0' });
  });

  it('无 require 返回空对象', () => {
    expect(parseGoModRequires('module m\n\ngo 1.21\n')).toEqual({});
  });
});

describe('resolveGoThirdParty', () => {
  const requires = {
    'github.com/openai/openai-go/v3': 'v3.52.0',
    'github.com/anthropics/anthropic-sdk-go': 'v1.66.0',
    'go.opentelemetry.io/otel': 'v1.45.0',
  };

  it('source 本身在 requires 里：直接命中', () => {
    const r = resolveGoThirdParty(['github.com/anthropics/anthropic-sdk-go'], requires);
    expect(r.resolved).toEqual({ 'github.com/anthropics/anthropic-sdk-go': 'v1.66.0' });
    expect(r.unresolved).toEqual([]);
  });

  it('子路径 source 归并到最长前缀 module root；同 root 多 source 只记一次', () => {
    const r = resolveGoThirdParty(
      [
        'github.com/openai/openai-go/v3/option',
        'github.com/openai/openai-go/v3/packages/ssestream',
        'go.opentelemetry.io/otel/attribute',
      ],
      requires,
    );
    expect(r.resolved).toEqual({
      'github.com/openai/openai-go/v3': 'v3.52.0',
      'go.opentelemetry.io/otel': 'v1.45.0',
    });
    expect(r.unresolved).toEqual([]);
  });

  it('无命中进 unresolved（不猜）', () => {
    const r = resolveGoThirdParty(['unknown.example.com/lib', 'fmt'], requires);
    expect(r.resolved).toEqual({});
    expect(r.unresolved).toEqual(['unknown.example.com/lib', 'fmt']);
  });

  it('空 requires：全部 unresolved', () => {
    const r = resolveGoThirdParty(['github.com/x/y'], {});
    expect(r.resolved).toEqual({});
    expect(r.unresolved).toEqual(['github.com/x/y']);
  });
});

describe('compareGoVersion', () => {
  it('数值比较（非字典序）：v1.10.0 > v1.9.0', () => {
    expect(compareGoVersion('v1.10.0', 'v1.9.0')).toBeGreaterThan(0);
    expect(compareGoVersion('v1.9.0', 'v1.10.0')).toBeLessThan(0);
  });

  it('主版本优先：v2.0.0 > v1.99.0', () => {
    expect(compareGoVersion('v2.0.0', 'v1.99.0')).toBeGreaterThan(0);
  });

  it('无 prerelease 者高：v1.0.0 > v1.0.0-rc.1', () => {
    expect(compareGoVersion('v1.0.0', 'v1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('伪版本时间戳字典序 = 时间序：新伪版本更高', () => {
    expect(compareGoVersion('v0.0.0-20240101000000-aaa', 'v0.0.0-20230101000000-bbb')).toBeGreaterThan(0);
  });

  it('相等返回 0', () => {
    expect(compareGoVersion('v1.2.3', 'v1.2.3')).toBe(0);
  });
});
