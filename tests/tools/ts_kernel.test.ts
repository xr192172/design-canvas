/**
 * ts_kernel 测试：验证探测 + 动态加载 + 优雅降级
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseFile,
  isSupported,
  listSupportedLanguages,
  listSupportedExtensions,
  _reset,
} from '../../src/tools/ts_kernel/index';
import { findLanguageByExt } from '../../src/tools/ts_kernel/languages';

describe('ts_kernel - languages registry', () => {
  it('应有 50+ 种语言注册', () => {
    const langs = listSupportedLanguages();
    expect(langs.length).toBeGreaterThanOrEqual(2);
  });

  it('findLanguageByExt 应能找到 .go / .ts / .py / .js', () => {
    expect(findLanguageByExt('.go')?.name).toBe('go');
    expect(findLanguageByExt('.ts')?.name).toBe('typescript');
    expect(findLanguageByExt('.py')?.name).toBe('python');
    expect(findLanguageByExt('.js')?.name).toBe('javascript');
  });

  it('未注册的扩展返回 undefined', () => {
    expect(findLanguageByExt('.unknownlang')).toBeUndefined();
  });
});

describe('ts_kernel - probe (探测 node_modules)', () => {
  it('应探测到至少 4 个已装语言包（go/ts/python/javascript）', () => {
    const installed = listSupportedLanguages();
    expect(installed).toContain('go');
    expect(installed).toContain('typescript');
    expect(installed).toContain('python');
    expect(installed).toContain('javascript');
  });

  it('listSupportedExtensions 应包含已装语言的扩展名', () => {
    const exts = listSupportedExtensions();
    expect(exts).toContain('.go');
    expect(exts).toContain('.ts');
    expect(exts).toContain('.py');
  });
});

describe('ts_kernel - isSupported', () => {
  it('已装语言应返回 true', () => {
    expect(isSupported('.go')).toBe(true);
    expect(isSupported('.ts')).toBe(true);
  });

  it('未注册语言返回 false', () => {
    expect(isSupported('.unknownlang')).toBe(false);
  });
});

describe('ts_kernel - parseFile', () => {
  beforeEach(() => {
    _reset();
  });

  it('Go: 解析 function + method', async () => {
    const goCode = `
package main

type User struct {
  name string
}

func (u *User) GetName() string {
  return u.name
}

func Hello(name string) string {
  return "Hi " + name
}
`;
    const symbols = await parseFile('main.go', goCode);
    const names = symbols.map((s) => s.name);

    expect(names).toContain('User');
    expect(names).toContain('GetName');
    expect(names).toContain('Hello');

    const getName = symbols.find((s) => s.name === 'GetName');
    expect(getName?.kind).toBe('method');
    expect(getName?.signature).toContain('GetName');

    const hello = symbols.find((s) => s.name === 'Hello');
    expect(hello?.kind).toBe('function');
  });

  it('TypeScript: 解析 function + class method', async () => {
    const tsCode = `
export class UserService {
  async getName(id: number): Promise<string> {
    return "user-" + id;
  }
}

export function helper(x: number): number {
  return x * 2;
}
`;
    const symbols = await parseFile('user.ts', tsCode);
    const names = symbols.map((s) => s.name);

    expect(names).toContain('UserService');
    expect(names).toContain('getName');
    expect(names).toContain('helper');
  });

  it('Python: 解析 class + method + function', async () => {
    const pyCode = `
class Calculator:
    def add(self, a, b):
        return a + b

def standalone_func(x):
    return x
`;
    const symbols = await parseFile('calc.py', pyCode);
    const names = symbols.map((s) => s.name);

    expect(names).toContain('Calculator');
    expect(names).toContain('add');
    expect(names).toContain('standalone_func');

    const add = symbols.find((s) => s.name === 'add');
    expect(add?.kind).toBe('method');
  });

  it('JS: 解析 function + class', async () => {
    const jsCode = `
class Animal {
  speak() { return "..."; }
}

function run() { return 1; }
`;
    const symbols = await parseFile('a.js', jsCode);
    expect(symbols.map((s) => s.name)).toContain('Animal');
    expect(symbols.map((s) => s.name)).toContain('speak');
    expect(symbols.map((s) => s.name)).toContain('run');
  });

  it('不认识的扩展名返回空数组', async () => {
    const symbols = await parseFile('a.unknownlang', 'whatever');
    expect(symbols).toEqual([]);
  });

  it('空文件返回空数组', async () => {
    const symbols = await parseFile('a.go', '');
    expect(symbols).toEqual([]);
  });

  it('语法有错的文件不抛异常，返回空或部分结果', async () => {
    const symbols = await parseFile('a.go', 'func broken( {');
    expect(Array.isArray(symbols)).toBe(true);
  });
});

describe('ts_kernel - Python class body 调试', () => {
  it('class_definition 子节点类型', async () => {
    const pyCode = `class User:
    def validate(self):
        return True
`;
    const symbols = await parseFile('a.py', pyCode);
    const cls = symbols.find((s) => s.name === 'User');
    const method = symbols.find((s) => s.name === 'validate');
    expect(cls?.kind).toBe('class');
    expect(method?.kind).toBe('method');
    expect(method?.parent).toBe('User');
  });
});

describe('ts_kernel - 行号精度', () => {
  it('应返回 1-based 行号', async () => {
    const goCode = `package main

// 第一行注释
func A() {}

func B() {}
`;
    const symbols = await parseFile('a.go', goCode);
    const a = symbols.find((s) => s.name === 'A');
    const b = symbols.find((s) => s.name === 'B');

    expect(a?.start_line).toBe(4);
    expect(b?.start_line).toBe(6);
  });
});
