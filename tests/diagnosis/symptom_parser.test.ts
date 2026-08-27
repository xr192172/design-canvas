/**
 * symptom_parser 测试：症状解析（诊断流水线第 1 步）
 * 覆盖：
 * - 错误类型识别（TypeError / Cannot find module / TS 编译错误 / panic / 测试失败）
 * - 位置提取（TS 编译 file(12,5) / file:12:34 / Python Traceback / Windows 盘符）
 * - 符号提取（reading 'x' / x is not a function / stack at fn( / Python in fn）
 * - 关键词（去停用词、中文、去重、忽略单字符）
 */

import { describe, it, expect } from 'vitest';
import { parseSymptom, extractLocations, extractSymbols, extractKeywords } from '../../src/diagnosis/symptom_parser';

describe('symptom_parser 错误类型识别', () => {
  it('识别 TypeError', () => {
    const p = parseSymptom("TypeError: Cannot read properties of undefined (reading 'name')");
    expect(p.error_type).toBe('TypeError');
  });

  it('识别 Cannot find module', () => {
    const p = parseSymptom("Cannot find module './foo'");
    expect(p.error_type).toBe('Cannot find module');
  });

  it('识别 TS 编译错误', () => {
    const p = parseSymptom('src/foo.ts(5,10): error TS2307: Cannot find module "lodash"');
    expect(p.error_type).toBe('TS 编译错误');
  });

  it('识别 Go panic', () => {
    const p = parseSymptom('panic: runtime error: invalid memory address or nil pointer dereference');
    expect(p.error_type).toBe('panic');
  });

  it('识别测试失败', () => {
    const p = parseSymptom('FAIL tests/foo.test.ts\nAssertionError: expected 1 to equal 2');
    expect(p.error_type).toMatch(/测试失败|AssertionError/);
  });

  it('无法识别时为空', () => {
    const p = parseSymptom('页面白屏，什么都没渲染出来');
    expect(p.error_type).toBeUndefined();
  });
});

describe('symptom_parser 位置提取', () => {
  it('提取 file.ts:12:34', () => {
    const locs = extractLocations('TypeError at src/user.ts:12:34');
    expect(locs).toContainEqual({ file: 'src/user.ts', line: 12 });
  });

  it('提取 TS 编译 file(12,5)', () => {
    const locs = extractLocations('src/foo.ts(12,5): error TS2307');
    expect(locs).toContainEqual({ file: 'src/foo.ts', line: 12 });
  });

  it('提取 Python Traceback', () => {
    const locs = extractLocations('  File "C:\\proj\\app\\main.py", line 42, in run');
    expect(locs).toContainEqual({ file: 'C:/proj/app/main.py', line: 42 });
  });

  it('提取 Go panic 行号', () => {
    const locs = extractLocations('main.main()\n\t/path/src/main.go:23 +0x39');
    expect(locs).toContainEqual({ file: '/path/src/main.go', line: 23 });
  });

  it('去重相同位置', () => {
    const locs = extractLocations('a.ts:1\nat x (a.ts:1:10)');
    expect(locs.filter((l) => l.file === 'a.ts' && l.line === 1).length).toBe(1);
  });
});

describe('symptom_parser 符号提取', () => {
  it('提取 reading 目标', () => {
    const syms = extractSymbols("TypeError: Cannot read properties of undefined (reading 'profile')");
    expect(syms).toContain('profile');
  });

  it('提取 is not a function', () => {
    const syms = extractSymbols('TypeError: user.save is not a function');
    expect(syms).toContain('user.save');
  });

  it('提取 stack frame 函数名', () => {
    const syms = extractSymbols('    at loadUser (src/user.ts:45:10)\n    at main (src/index.ts:8:3)');
    expect(syms).toContain('loadUser');
    expect(syms).toContain('main');
  });

  it('提取 Python in 函数名', () => {
    const syms = extractSymbols('File "app/main.py", line 42, in run_user');
    expect(syms).toContain('run_user');
  });
});

describe('symptom_parser 关键词', () => {
  it('去停用词、保留标识符', () => {
    const kws = extractKeywords('TypeError: user.save is not a function');
    expect(kws).toContain('user');
    expect(kws).toContain('save');
    expect(kws).not.toContain('is');
    expect(kws).not.toContain('a');
  });

  it('保留中文词（整段连续 CJK 作为一个词，供 trigram 检索）', () => {
    const kws = extractKeywords('页面白屏，表格没有数据');
    expect(kws).toContain('页面白屏');
    expect(kws).toContain('表格没有数据');
  });

  it('忽略单字符与去重', () => {
    const kws = extractKeywords('x y z x a b foo foo');
    expect(kws).toEqual(['foo']);
  });

  it('回归：绝对路径只留文件名，目录组成词不污染关键词（含空格路径）', () => {
    const kws = extractKeywords(
      'Failed to load url /C:/Users/Admin/Downloads/Browsers/Microsoft Edge/design-canvas-main/design-canvas/tests/fixtures/agent_demo.mjs. Does the file exist?',
    );
    // 路径里的 Microsoft / Edge / design / canvas 等目录组成词不应进入关键词
    for (const bad of ['microsoft', 'edge', 'design', 'canvas', 'admin', 'downloads', 'browsers']) {
      expect(kws).not.toContain(bad);
    }
    // 文件名是最强线索，必须保留；真实信息词也保留
    expect(kws).toContain('agent_demo');
    expect(kws).toContain('load');
    expect(kws).toContain('exist');
  });

  it('回归：file:// 与 http(s):// URL 剥目录、留文件名', () => {
    const kws = extractKeywords('Cannot find module "file:///C:/Users/a b/cache.db" after GET https://api.example.com/v1/chat');
    // cache.db 的文件名 cache 保留，但扩展名 db 与目录/域名噪声剥离
    expect(kws).toContain('cache');
    expect(kws).toContain('chat');
    expect(kws).not.toContain('db');
    expect(kws).not.toContain('users');
    expect(kws).not.toContain('example');
    expect(kws).not.toContain('api');
  });
});
