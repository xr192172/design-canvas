/**
 * 语言适配器注册表完备性自检：
 *  - 任何在 LANGUAGES 声明了 import_nodes 的语言，都必须有 LANG_ADAPTERS 记录（否则深度依赖提取会静默跳过）。
 *  - 深适配语言（go/python/java/rust）必须同时提供 callNode + import/binding 提取。
 *  - 兜底目标：把「平移到注册表时漏掉某个语言/某层」变成测试期错误，而非运行时静默遗漏。
 */
import { describe, it, expect } from 'vitest';
import { LANG_ADAPTERS } from '../../src/tools/ts_kernel/kernel.js';
import { LANGUAGES } from '../../src/tools/ts_kernel/languages.js';

describe('语言适配器注册表完备性', () => {
  it('每个声明 import_nodes 的语言都有 adapter 记录', () => {
    const declared = LANGUAGES.filter((l) => l.import_nodes && l.import_nodes.length > 0).map((l) => l.name);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) {
      expect(LANG_ADAPTERS[name], `语言 ${name} 声明了 import_nodes 但缺 LANG_ADAPTERS 记录`).toBeDefined();
    }
  });

  it('深适配语言（go/python/java/rust）同时具备 callNode 与 import/binding 提取', () => {
    for (const name of ['go', 'python', 'java', 'rust']) {
      const a = LANG_ADAPTERS[name]!;
      expect(a.callNode, `${name} 缺 callNode`).toBeDefined();
      expect(typeof a.extractImportSources, `${name} 缺 extractImportSources`).toBe('function');
      expect(typeof a.extractImportBindings, `${name} 缺 extractImportBindings`).toBe('function');
    }
  });

  it('TS 系走原生 ImportEdge：只登记 callNode，不要求 binding 方法', () => {
    expect(LANG_ADAPTERS.typescript.callNode).toBe('call_expression');
    expect(LANG_ADAPTERS.javascript.callNode).toBe('call_expression');
    expect(LANG_ADAPTERS.typescript.extractImportBindings).toBeUndefined();
  });

  it('无深适配/无 import_nodes 的语言不要求 adapter（保持未装语言静默禁用）', () => {
    // 任意未深适配语言（如 c_sharp）可不注册，但若有 import_nodes 则上一条测试已拦截
    const c = LANGUAGES.find((l) => l.name === 'c_sharp')!;
    expect(c.import_nodes).toBeUndefined();
  });
});