/**
 * rename_files —— 批量文件级重命名测试（对标 rename_symbols 批处理）
 *
 * 覆盖：
 *   - dry_run（默认 false）：先整体 dry-run 校验影响面 → 全部可落盘才逐条落盘。
 *   - dry_run=true：只出批量影响面预览，不落盘。
 *   - 任一条被阻断（目标已存在）→ 整体不落盘，返回预览报告。
 *   - 重复源文件（同 from）→ 阻断。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameFiles } from '../../src/tools/rename_files';
import { closeProjectCacheDb } from '../../src/db/db';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'drf-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}

function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放（Windows），稍候重试 */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略最终失败 */
  }
}

describe('renameFiles - 批量文件重命名', () => {
  it('多个文件一次移动 + import 引用改写累计', async () => {
    const dir = mkProj({
      'src/foo.ts': 'export function a() { return 1; }\n',
      'src/bar.ts': 'export function b() { return 2; }\n',
      'src/entry.ts': "import { a } from './foo';\nimport { b } from './bar';\nexport function run() { return a() + b(); }\n",
    });

    const r = await renameFiles({
      project_dir: dir,
      renames: [
        { from: 'src/foo.ts', to: 'src/f1.ts' },
        { from: 'src/bar.ts', to: 'src/b1.ts' },
      ],
    });
    expect(r.ok).toBe(true);
    // 源都被移走，目标是新文件
    expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'src/f1.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/bar.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'src/b1.ts'))).toBe(true);
    // entry 里两条 import 都联动了
    const entry = readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8');
    expect(entry).toContain("import { a } from './f1';");
    expect(entry).toContain("import { b } from './b1';");
    // applied 2 条，引用改写 2 处
    expect(r.applied.length).toBe(2);
    expect(r.filesWritten).toBe(2);
    expect(r.previews.length).toBe(2);
    expect(r.previews.every((p) => p.ok && p.result!.moved === false)).toBe(true); // dry-run 预览 moved 恒 false
    rmForce(dir);
  });

  it('dry_run=true → 只出影响面预览，一个都不动', async () => {
    const dir = mkProj({
      'src/foo.ts': 'export function a() { return 1; }\n',
      'src/entry.ts': "import { a } from './foo';\n",
    });
    const r = await renameFiles({
      project_dir: dir,
      renames: [{ from: 'src/foo.ts', to: 'src/f1.ts' }],
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0);
    expect(r.applied).toEqual([]);
    expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/f1.ts'))).toBe(false);
    expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './foo'");
    rmForce(dir);
  });

  it('任一条被阻断（目标已存在）→ 整体不落盘', async () => {
    const dir = mkProj({
      'src/foo.ts': 'export function a() { return 1; }\n',
      'src/bar.ts': 'export function b() { return 2; }\n',
      'src/f1.ts': 'export const taken = 1;\n', // 目标被占用 → 第二条被阻断
    });
    const r = await renameFiles({
      project_dir: dir,
      renames: [
        { from: 'src/foo.ts', to: 'src/foo2.ts' },
        { from: 'src/bar.ts', to: 'src/f1.ts' }, // 目标已存在
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.dryRun).toBe(true); // 整体未落盘
    expect(r.previews[0].ok).toBe(true);
    expect(r.previews[1].ok).toBe(false);
    // 第一条也未被移动（整体原子）
    expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/foo2.ts'))).toBe(false);
    rmForce(dir);
  });

  it('重复源文件（同 from）→ 阻断', async () => {
    const dir = mkProj({ 'src/foo.ts': 'export function a() { return 1; }\n' });
    const r = await renameFiles({
      project_dir: dir,
      renames: [
        { from: 'src/foo.ts', to: 'src/f1.ts' },
        { from: 'src/foo.ts', to: 'src/f2.ts' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('重复源文件'))).toBe(true);
    expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(true);
    rmForce(dir);
  });
});