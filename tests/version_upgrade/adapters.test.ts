/**
 * adapters：语言适配器注册表 + Python 适配器示范 测试
 *
 * 覆盖：
 *   - 注册表：adapterForLang / adapterForExt / adaptersForFile（.tool-versions 共享分发）
 *   - Python 声明解析：pyproject.toml（PEP 621 requires-python / poetry python 约束）、
 *     .python-version、.tool-versions
 *   - Python 版本解析与边界（minor）
 *   - Python 特性扫描（f-string / walrus / match 按边界过滤）
 *   - 工具链盘点含 Python 声明
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  adapters,
  adapterForLang,
  adapterForExt,
  adaptersForFile,
  ALL_DECLARATION_FILES,
} from '../../src/version_upgrade/adapters/registry';
import { pythonAdapter } from '../../src/version_upgrade/adapters/python';
import { javaAdapter } from '../../src/version_upgrade/adapters/java';
import { nodeAdapter } from '../../src/version_upgrade/adapters/node';
import { scanToolchainDeclarations, versionSatisfies } from '../../src/version_upgrade/toolchain';
import { scanFeatureHits } from '../../src/version_upgrade/features';
import { scanRemovedApis } from '../../src/version_upgrade/removed';

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
  const dir = path.join(os.tmpdir(), `adapter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('registry', () => {
  it('注册了 Java / Go / Node / Python 四个适配器', () => {
    expect(adapters.map((a) => a.lang).sort()).toEqual(['go', 'java', 'node', 'python']);
  });

  it('adapterForLang / adapterForExt 按代号与扩展名命中', () => {
    expect(adapterForLang('python')).toBe(pythonAdapter);
    expect(adapterForExt('.py')).toBe(pythonAdapter);
    expect(adapterForExt('java')).toBe(javaAdapter);
    expect(adapterForExt('.cpp')).toBeUndefined();
  });

  it('.tool-versions 由多语言适配器共享解析', () => {
    const langs = adaptersForFile('.tool-versions').map((a) => a.lang).sort();
    expect(langs).toEqual(['go', 'java', 'node', 'python']);
  });

  it('声明文件全集包含各语言文件', () => {
    expect(ALL_DECLARATION_FILES).toEqual(
      expect.arrayContaining(['pom.xml', 'go.mod', 'package.json', 'pyproject.toml', '.python-version', '.tool-versions'])
    );
  });
});

describe('pythonAdapter 声明解析', () => {
  it('pyproject.toml PEP 621 requires-python = ">=3.10" → 声明 3.10', () => {
    const root = tempRoot();
    write(root, 'app/pyproject.toml', '[project]\nname = "app"\nrequires-python = ">=3.10"\n');
    const d = pythonAdapter.parseDeclarationFile(path.join(root, 'app', 'pyproject.toml'));
    expect(d).toHaveLength(1);
    expect(d[0].declaredVersion).toBe('3.10');
    expect(d[0].source).toBe('pyproject.toml');
  });

  it('pyproject.toml 范围约束取最低要求（>=3.8,<3.13 → 3.8）', () => {
    const root = tempRoot();
    write(root, 'pyproject.toml', '[project]\nrequires-python = ">=3.8,<3.13"\n');
    const d = pythonAdapter.parseDeclarationFile(path.join(root, 'pyproject.toml'));
    expect(d[0].declaredVersion).toBe('3.8');
  });

  it('pyproject.toml poetry python = "^3.8" → 3.8', () => {
    const root = tempRoot();
    write(root, 'pyproject.toml', '[tool.poetry.dependencies]\npython = "^3.8"\n');
    const d = pythonAdapter.parseDeclarationFile(path.join(root, 'pyproject.toml'));
    expect(d[0].declaredVersion).toBe('3.8');
  });

  it('.python-version 内容即版本（保留原文）', () => {
    const root = tempRoot();
    write(root, '.python-version', '3.12.4\n');
    const d = pythonAdapter.parseDeclarationFile(path.join(root, '.python-version'));
    expect(d[0].declaredVersion).toBe('3.12.4');
  });

  it('.tool-versions 只取 python 行', () => {
    const root = tempRoot();
    write(root, '.tool-versions', 'nodejs 20\njava 17\npython 3.11\n');
    const d = pythonAdapter.parseDeclarationFile(path.join(root, '.tool-versions'));
    expect(d).toHaveLength(1);
    expect(d[0].declaredVersion).toBe('3.11');
  });
});

describe('pythonAdapter 版本与边界', () => {
  it('parseVersion / featureBoundary：3.10 → minor 10', () => {
    const info = pythonAdapter.parseVersion('3.10')!;
    expect(info).toEqual({ major: 3, minor: 10 });
    expect(pythonAdapter.featureBoundary(info)).toBe(10);
  });

  it('versionSatisfies：3.10 被 3.13 满足、不被 3.8 满足', () => {
    expect(pythonAdapter.versionSatisfies('3.10', '3.13.7')).toBe(true);
    expect(pythonAdapter.versionSatisfies('3.10', '3.8')).toBe(false);
  });

  it('toolchain.versionSatisfies 委托适配器（python）', () => {
    expect(versionSatisfies('python', '3.10', '3.13.7')).toBe(true);
    expect(versionSatisfies('python', '3.12', '3.10')).toBe(false);
  });
});

describe('python 契约差扫描（经通用内核）', () => {
  const PY_SRC = `def fmt(name):
    s = f"hi {name}"          # f-string（3.6）
    if (n := len(s)) > 3:     # walrus（3.8）
        return n
    match s:                  # match 语句（3.10）
        case _:
            return 0
`;

  it('边界 3.5 → 超标 f-string(6) / walrus(8) / match(10)，全命中', () => {
    const hits = scanFeatureHits([{ path: 'm.py', content: PY_SRC }], 5);
    expect(hits.map((h) => h.feature).sort()).toEqual(['f-string 字符串', 'match 语句（结构化模式匹配）', '海象运算符 :=']);
  });

  it('边界 3.9 → 仅 match 超标', () => {
    const hits = scanFeatureHits([{ path: 'm.py', content: PY_SRC }], 9);
    expect(hits).toHaveLength(1);
    expect(hits[0].feature).toBe('match 语句（结构化模式匹配）');
    expect(hits[0].since).toBe(10);
  });

  it('边界 3.12 → 无超标特性', () => {
    const hits = scanFeatureHits([{ path: 'm.py', content: PY_SRC }], 12);
    expect(hits).toHaveLength(0);
  });

  it('废弃/移除 API：声明 3.12 时命中 distutils / typing.Text', () => {
    const src = 'import distutils\nfrom typing import Text\nimport cgi\n';
    const hits = scanRemovedApis([{ path: 'a.py', content: src }], 12);
    const names = hits.map((h) => h.api).sort();
    expect(names).toContain('distutils 打包模块');
    expect(names).toContain('typing.Text');
    // cgi 3.13 起移除，声明 3.12 未到 → 不报
    expect(names).not.toContain('cgi 模块');
  });
});

describe('工具链盘点含 Python 声明', () => {
  it('pyproject.toml + .python-version 都进声明清单', () => {
    const root = tempRoot();
    write(root, 'api/pyproject.toml', '[project]\nrequires-python = ">=3.10"\n');
    write(root, 'svc/.python-version', '3.11\n');
    const decls = scanToolchainDeclarations(root);
    const pys = decls.filter((d) => d.tool === 'python').map((d) => `${d.projectDir}=${d.declaredVersion}`).sort();
    expect(pys).toEqual(['api=3.10', 'svc=3.11']);
  });
});

describe('nodeAdapter 动态闸（运行时探针真跑）', () => {
  const run = (appDir: string, file: string, content: string) =>
    nodeAdapter.dynamicGate!(appDir, 18, [{ path: file, content }]);

  it('.cjs 干净顶层代码 → ok', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    write(root, 'app/a.cjs', 'const x = 1;\nconsole.log(x);\n');
    const items = await run(appDir, 'a.cjs', 'const x = 1;\nconsole.log(x);\n');
    expect(items[0].status).toBe('ok');
  });

  it('顶层抛异常 → fail（附异常摘要）', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const src = 'throw new Error("boom");\n';
    write(root, 'app/a.cjs', src);
    const items = await run(appDir, 'a.cjs', src);
    expect(items[0].status).toBe('fail');
    expect(items[0].detail).toContain('boom');
  });

  it('跨文件引用无法隔离 → skipped', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const src = 'const { K } = require("./dep");\nconsole.log(K);\n';
    write(root, 'app/a.cjs', src);
    const items = await run(appDir, 'a.cjs', src);
    expect(items[0].status).toBe('skipped');
  });

  it('.mjs 原生 ESM 跑（import.meta 可用，零转译保留原生语义）→ ok', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const src = 'console.log(typeof import.meta.url);\n';
    write(root, 'app/a.mjs', src);
    const items = await run(appDir, 'a.mjs', src);
    expect(items[0].status).toBe('ok');
  });

  it('.js 在 type:module 项目按 ESM 原生跑 → ok', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    write(root, 'app/package.json', JSON.stringify({ type: 'module' }));
    const src = 'console.log(typeof import.meta.url);\n';
    write(root, 'app/a.js', src);
    const items = await run(appDir, 'a.js', src);
    expect(items[0].status).toBe('ok');
  });

  it('.ts 转译 CJS 后跑：干净 → ok；顶层抛异常 → fail', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const okSrc = 'const x: number = 1;\nconsole.log(x);\n';
    write(root, 'app/a.ts', okSrc);
    const okItems = await run(appDir, 'a.ts', okSrc);
    expect(okItems[0].status).toBe('ok');

    const badSrc = 'function f(): number { return 1; }\nthrow new Error("ts-boom");\n';
    write(root, 'app/b.ts', badSrc);
    const badItems = await run(appDir, 'b.ts', badSrc);
    expect(badItems[0].status).toBe('fail');
    expect(badItems[0].detail).toContain('ts-boom');
  });

  it('.ts 语法错误（转译失败）→ fail', async () => {
    const root = tempRoot();
    const appDir = path.join(root, 'app');
    const src = 'const x: number = ;\n';
    write(root, 'app/bad.ts', src);
    const items = await run(appDir, 'bad.ts', src);
    expect(items[0].status).toBe('fail');
    expect(items[0].detail).toContain('转译失败');
  });
});
