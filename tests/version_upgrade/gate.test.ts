/**
 * gate：静态闸（编译级契约差）测试
 *
 * 覆盖：
 *   - Python 静态闸：ast.parse(feature_version) 精确抓到 match 语句等语法级契约差，
 *     达标文件通过；边界高于本机解释器时降级 skipped
 *   - runStaticGates 编排：按声明跑闸、无静态闸能力的语言标记 unavailable
 *   - Java 静态闸：无 javac 时整体 skipped（容错，不依赖本机 JDK）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterAll } from 'vitest';
import { runStaticGates } from '../../src/version_upgrade/gate';
import { pythonAdapter } from '../../src/version_upgrade/adapters/python';
import { javaAdapter } from '../../src/version_upgrade/adapters/java';
import type { SourceFile } from '../../src/version_upgrade/adapters/types';

const PY = process.platform === 'win32' ? 'python' : 'python3';
const pyAvailable = ((): boolean => {
  try {
    return spawnSync(PY, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

const javacAvailable = ((): boolean => {
  try {
    return spawnSync('javac', ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

function localJavacMajor(): number {
  const r = spawnSync('javac', ['-version'], { encoding: 'utf-8', windowsHide: true });
  const m = `${r.stdout || ''}${r.stderr || ''}`.match(/javac\s+(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // leave to OS on Windows
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('pythonAdapter.staticGate（本机 python 可用时真跑）', () => {
  const files: SourceFile[] = [
    { path: 'ok.py', content: 'def a(x):\n    return x + 1\n' },
    { path: 'new_syntax.py', content: 'def b(x):\n    match x:\n        case 1:\n            return 2\n        case _:\n            return 0\n' },
  ];

  it.skipIf(!pyAvailable)('边界 3.9 → match 文件 fail，普通文件 ok', () => {
    const items = pythonAdapter.staticGate!('', 9, files);
    const byFile = new Map(items.map((i) => [i.file, i]));
    expect(byFile.get('ok.py')?.status).toBe('ok');
    expect(byFile.get('new_syntax.py')?.status).toBe('fail');
    expect(byFile.get('new_syntax.py')?.detail ?? '').toContain('match');
  });

  it.skipIf(!pyAvailable)('边界 3.12（>=match 引入版）→ 全 ok', () => {
    const items = pythonAdapter.staticGate!('', 12, files);
    expect(items.every((i) => i.status === 'ok')).toBe(true);
  });
});

describe('javaAdapter.staticGate', () => {
  it('无外部 import 且 javac 可用时执行；否则 skipped（容错）', () => {
    const items = javaAdapter.staticGate!('', 11, [
      { path: 'A.java', content: 'public class A { public static void main(String[] a) { var x = 1; } }\n' },
      { path: 'B.java', content: 'import com.acme.Thing;\npublic class B {}\n' },
    ]);
    const byFile = new Map(items.map((i) => [i.file, i]));
    // 无 javac → 全部 skipped；有 javac → 自包含 A 编译（var 在 --release 11 合法）ok、B 因外部依赖 skipped
    if (byFile.get('A.java')?.status === 'skipped') {
      expect(byFile.get('B.java')?.status).toBe('skipped');
    } else {
      expect(byFile.get('A.java')?.status).toBe('ok');
      expect(byFile.get('B.java')?.status).toBe('skipped');
    }
  });

  it.skipIf(!javacAvailable)('声明边界低于 9 也可用 --release 编译（本机 javac 17 支持 --release 8）', () => {
    const items = javaAdapter.staticGate!('', 8, [
      { path: 'Plain.java', content: 'public class Plain { public void m() { int x = 1; } }\n' },
      { path: 'Var.java', content: 'public class Var { public void m() { var x = 1; } }\n' },
    ]);
    const byFile = new Map(items.map((i) => [i.file, i]));
    expect(byFile.get('Plain.java')?.status).toBe('ok');
    expect(byFile.get('Var.java')?.status).toBe('fail'); // var 需 JDK 10，--release 8 编译不过
  });

  it.skipIf(!javacAvailable)('声明边界高于本机 javac → 全部 skipped（本机编译器无法按目标版本编译）', () => {
    const items = javaAdapter.staticGate!('', localJavacMajor() + 1, [
      { path: 'A.java', content: 'public class A {}\n' },
    ]);
    expect(items.every((i) => i.status === 'skipped')).toBe(true);
  });
});

describe('runStaticGates 编排', () => {
  it.skipIf(!pyAvailable)('按 pyproject 声明跑闸：超标文件报 fail', () => {
    const root = tempRoot();
    write(root, 'app/pyproject.toml', '[project]\nrequires-python = ">=3.8"\n');
    write(root, 'app/main.py', 'match x:\n    case _:\n        return 0\n');
    const decls = [
      { projectDir: 'app', tool: 'python' as const, source: 'pyproject.toml', declaredVersion: '3.8', raw: 'requires-python = ">=3.8"' },
    ];
    const gates = runStaticGates(root, decls);
    expect(gates).toHaveLength(1);
    expect(gates[0].available).toBe(true);
    expect(gates[0].boundary).toBe(8);
    expect(gates[0].items.some((i) => i.status === 'fail')).toBe(true);
  });

  it('无静态闸能力的语言（go/node）→ unavailable，items 为空', () => {
    const root = tempRoot();
    write(root, 'go.mod', 'module x\n\ngo 1.21\n');
    write(root, 'main.go', 'package main\n');
    const decls = [{ projectDir: '.', tool: 'go' as const, source: 'go.mod', declaredVersion: '1.21', raw: 'go 1.21' }];
    const gates = runStaticGates(root, decls);
    expect(gates[0].available).toBe(false);
    expect(gates[0].items).toHaveLength(0);
  });
});
