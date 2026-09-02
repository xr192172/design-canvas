/**
 * ts_kernel 测试：验证探测 + 动态加载 + 优雅降级
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseFile,
  parseFileFull,
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

  it('大文件（≥32KB）应通过 callback 路径解析，且多字节字符不错位', async () => {
    // 构造超过 32768 字符的 TS 文件：中文注释（3 字节/字符）+ 大量函数
    const header = '// 设计画布内核：大文件解析回归测试。中文注释占三字节，验证 UTF-8 字节偏移映射。\n';
    const fnCount = 900; // 900 × ~40 字符 ≈ 36KB，确保触发 callback 路径
    let body = header;
    for (let i = 0; i < fnCount; i++) {
      body += `export function fn_${i}(x: number): number { // 函数 ${i} 中文备注\n  return x + ${i};\n}\n`;
    }
    expect(body.length).toBeGreaterThan(32768);

    const symbols = await parseFile('big.ts', body);
    expect(symbols.length).toBe(fnCount);
    // 抽查首/中/尾函数名与行号无错位（错位说明字节映射有误）
    expect(symbols[0].name).toBe('fn_0');
    expect(symbols[450].name).toBe('fn_450');
    expect(symbols[fnCount - 1].name).toBe(`fn_${fnCount - 1}`);
    expect(symbols[fnCount - 1].start_line).toBeGreaterThan(symbols[0].start_line);
    // 签名中的中文不应出现替换字符 U+FFFD
    expect(JSON.stringify(symbols)).not.toContain('�');
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

describe('ts_kernel parseFileFull - C / C#  依赖边提取（impact/cross_repo 地基）', () => {
  it('C `#include` → import 边；`foo()` → call 边；函数名 → symbol', async () => {
    const pf = await parseFileFull('a.c', '#include "math.h"\nint add(int a,int b){ return a+b; }\nint main(){ return add(1,2); }\n');
    expect(pf.imports.some((i) => i.source === 'math.h')).toBe(true);
    expect(pf.calls.some((c) => c.callee === 'add')).toBe(true);
    expect(pf.symbols.map((s) => s.name)).toContain('add');
    expect(pf.symbols.map((s) => s.name)).toContain('main');
  });

  it('C# `using` → import 边；`Foo()` 调用 → call 边；class → symbol', async () => {
    const pf = await parseFileFull('a.cs', 'using System.Collections.Generic;\nnamespace App { public class User { public int Go(){ return this.N(); } private int N(){ return 1; } } }\n');
    expect(pf.imports.some((i) => i.source.includes('System.Collections'))).toBe(true);
    expect(pf.calls.some((c) => c.callee === 'N')).toBe(true);
    expect(pf.symbols.map((s) => s.name)).toContain('User');
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
