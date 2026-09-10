/**
 * 跨工作区边界反馈（"不追外"）：
 * - seed 项目内某文件 import 了项目外的外部仓库文件 → rename 返回 externalRefs 边界提示
 * - 外部仓库文件绝不被改写、不被纳入落盘范围（只反馈）
 * - 项目内无外部引用 → externalRefs 为空
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renameSymbol } from '../../src/tools/rename_symbol.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-ext-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* Windows 偶发占用留给 OS */
  }
});

function write(abs: string, content: string): string {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('跨工作区边界反馈（不追外）', () => {
  it('import 外部仓库文件 → 返回 externalRefs，外部文件不被改动', async () => {
    const root = path.join(tmp, 'rootproj'); // 工作区
    const external = path.join(tmp, 'external'); // 工作区外的兄弟"仓库"
    write(path.join(root, 'tsconfig.json'), '{}');
    write(path.join(root, 'a.ts'), `export function target(): void {}\n`);
    write(
      path.join(root, 'b.ts'),
      `import { target } from './a.js';\nimport { helper } from '../external/ext.js';\n\ntarget();\nhelper();\n`,
    );
    // 外部仓库文件：绝不能被本次 rename 改动
    const extPath = write(path.join(external, 'ext.js'), `export function helper(): void {}\n`);
    const extBefore = fs.readFileSync(extPath, 'utf8');

    const r = await renameSymbol({
      project_dir: root,
      file: 'a.ts',
      symbol: 'target',
      to: 'renamed',
    });
    expect(r.ok).toBe(true);
    // 边界反馈：b.ts import 到了 root 外的 external/ext.js
    expect(r.externalRefs?.length).toBeGreaterThanOrEqual(1);
    const ref = r.externalRefs!.find((e) => e.resolved === extPath);
    expect(ref).toBeDefined();
    expect(ref!.fromAbs.endsWith(path.join('rootproj', 'b.ts')) || ref!.fromAbs.endsWith('b.ts')).toBe(true);
    // 外部文件未被改动
    expect(fs.readFileSync(extPath, 'utf8')).toBe(extBefore);
    // root 内 target 已被改名，且 b.ts 里 import 的 ./a.js 引用同步改名
    expect(fs.readFileSync(path.join(root, 'a.ts'), 'utf8')).toContain('function renamed');
    expect(fs.readFileSync(path.join(root, 'b.ts'), 'utf8')).toContain('renamed()');
  });

  it('项目内无外部引用 → externalRefs 为空/缺省', async () => {
    const root = path.join(tmp, 'selfcontained');
    write(path.join(root, 'tsconfig.json'), '{}');
    write(path.join(root, 'a.ts'), `export function target(): void {}\n`);
    write(path.join(root, 'b.ts'), `import { target } from './a.js';\n\ntarget();\n`);
    const r = await renameSymbol({
      project_dir: root,
      file: 'a.ts',
      symbol: 'target',
      to: 'renamed',
    });
    expect(r.ok).toBe(true);
    expect(r.externalRefs).toBeUndefined();
  });
});