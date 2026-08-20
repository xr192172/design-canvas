/**
 * npm_mod 单测（TS 积木依赖治理，对标 go_mod.test.ts）
 *
 * 覆盖：
 *   - parseNpmDeps：dependencies > peerDependencies > devDependencies 优先级 /
 *     字段缺省形态 / 非对象入参
 *   - resolveNpmThirdParty：bare 名直接命中 / 子路径归并（@scope 两段、
 *     普通包一段）/ 无命中进 unresolved（decline rather than guess）
 *   - isNonRegistrySpec：workspace:/file:/link:/git+ 拦截
 *   - compareNpmVersion：range 操作符剥离 / 数值比较 / prerelease 高低
 */
import { describe, it, expect } from 'vitest';
import {
  parseNpmDeps,
  resolveNpmThirdParty,
  isNonRegistrySpec,
  compareNpmVersion,
} from '../../src/tools/npm_mod';

describe('parseNpmDeps', () => {
  it('dependencies > peerDependencies > devDependencies（同名冲突取高优先）', () => {
    const pkg = {
      dependencies: { zod: '^4.1.0' },
      peerDependencies: { zod: '^3.0.0' },
      devDependencies: { zod: '^3.9.0', vitest: '^3.0.0' },
    };
    expect(parseNpmDeps(pkg)).toEqual({ zod: '^4.1.0', vitest: '^3.0.0' });
  });

  it('peer 填 dependencies 缺的坑，dev 填剩余', () => {
    const pkg = {
      dependencies: { ignore: '^7.0.5' },
      peerDependencies: { react: '^18.0.0' },
      devDependencies: { typescript: '^5.5.0' },
    };
    expect(parseNpmDeps(pkg)).toEqual({
      ignore: '^7.0.5',
      react: '^18.0.0',
      typescript: '^5.5.0',
    });
  });

  it('字段缺省/非对象入参不炸', () => {
    expect(parseNpmDeps({})).toEqual({});
    expect(parseNpmDeps(null)).toEqual({});
    expect(parseNpmDeps('oops')).toEqual({});
  });
});

describe('resolveNpmThirdParty', () => {
  const requires = {
    ignore: '^7.0.5',
    '@anthropic-ai/sdk': '^0.30.0',
    'tree-sitter-cpp': '^0.23.4',
  };

  it('bare 名直接命中', () => {
    const r = resolveNpmThirdParty(['ignore'], requires);
    expect(r.resolved).toEqual({ ignore: '^7.0.5' });
    expect(r.unresolved).toEqual([]);
  });

  it('子路径归并：普通包取首段，@scope 取前两段', () => {
    const r = resolveNpmThirdParty(
      ['ignore/defaults', '@anthropic-ai/sdk/resources', 'tree-sitter-cpp'],
      requires,
    );
    expect(r.resolved).toEqual({
      ignore: '^7.0.5',
      '@anthropic-ai/sdk': '^0.30.0',
      'tree-sitter-cpp': '^0.23.4',
    });
    expect(r.unresolved).toEqual([]);
  });

  it('无命中进 unresolved（不猜）', () => {
    const r = resolveNpmThirdParty(['left-pad', 'fs'], requires);
    expect(r.resolved).toEqual({});
    expect(r.unresolved).toEqual(['left-pad', 'fs']);
  });
});

describe('isNonRegistrySpec', () => {
  it('workspace/file/link/git/https 协议全拦截；registry spec 放行', () => {
    expect(isNonRegistrySpec('workspace:*')).toBe(true);
    expect(isNonRegistrySpec('workspace:^')).toBe(true);
    expect(isNonRegistrySpec('file:../local')).toBe(true);
    expect(isNonRegistrySpec('link:../local')).toBe(true);
    expect(isNonRegistrySpec('git+https://github.com/x/y.git')).toBe(true);
    expect(isNonRegistrySpec('https://github.com/x/y/tarball')).toBe(true);
    expect(isNonRegistrySpec('^7.0.5')).toBe(false);
    expect(isNonRegistrySpec('~7.1.0')).toBe(false);
    expect(isNonRegistrySpec('7.2.0')).toBe(false);
  });
});

describe('compareNpmVersion', () => {
  it('range 操作符剥离后数值比较：^7.10.0 > ~7.9.0', () => {
    expect(compareNpmVersion('^7.10.0', '~7.9.0')).toBeGreaterThan(0);
    expect(compareNpmVersion('~7.9.0', '^7.10.0')).toBeLessThan(0);
  });

  it('主版本优先：^8.0.0 > ^7.99.0', () => {
    expect(compareNpmVersion('^8.0.0', '^7.99.0')).toBeGreaterThan(0);
  });

  it('无 prerelease 者高：7.0.5 > 7.0.5-beta.1', () => {
    expect(compareNpmVersion('7.0.5', '7.0.5-beta.1')).toBeGreaterThan(0);
  });

  it('相等（range 形态不同但 base 同）返回 0', () => {
    expect(compareNpmVersion('^7.0.5', '7.0.5')).toBe(0);
    expect(compareNpmVersion('~7.1.0', '7.1.0')).toBe(0);
  });
});
