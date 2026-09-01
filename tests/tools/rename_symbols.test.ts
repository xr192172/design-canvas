/**
 * rename_symbols —— 跨文件符号批量改名测试
 *
 * 覆盖：
 *   - dry_run（默认 false）：先整体 dry-run 校验 + 结构化 diff → 全部可落盘才落盘。
 *   - dry_run=true：只出批量的所有 dry-run diff，不落盘。
 *   - 任一条目被阻断 → 整体不落盘，返回预览报告（含各条 ok/blocked）。
 *   - 重复条目（同 file+symbol）→ 阻断。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameSymbols } from '../../src/tools/rename_symbols';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'drs-'));
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

describe('renameSymbols - 批量跨文件符号改名', () => {
  it('多个符号一次落盘，previews 含每条 diff，filesWritten 累计', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/b.ts': 'export function beta(a: number) { return a; }\n',
      'src/use.ts': [
        "import { alpha } from './a';",
        "import { beta } from './b';",
        'export function run() { return alpha(1) + beta(2); }',
      ].join('\n'),
    });

    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/b.ts', symbol: 'beta', to: 'beth' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBeUndefined();
    // 累计写入次数：a.ts、b.ts 各 1，use.ts 被两轮各写 1 → 4（并列条目间同一文件可重复计数）
    expect(r.filesWritten).toBe(4);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('export function aleph');
    expect(readFileSync(path.join(dir, 'src/b.ts'), 'utf-8')).toContain('export function beth');
    // 共同 importer 双处改
    const use = readFileSync(path.join(dir, 'src/use.ts'), 'utf-8');
    expect(use).toContain("import { aleph } from './a';");
    expect(use).toContain("import { beth } from './b';");
    expect(use).toContain('aleph(1) + beth(2)');

    // previews：每条都带结构化 diff
    expect(r.previews.length).toBe(2);
    expect(r.previews.every((p) => p.ok && p.result!.definition!.ops!.length > 0)).toBe(true);
    // applied：2 条都真落下
    expect(r.applied.length).toBe(2);
    rmForce(dir);
  });

  it('dry_run=true → 只出批量预览 diff，全部不落盘', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/b.ts': 'export function beta(a: number) { return a; }\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/b.ts', symbol: 'beta', to: 'beth' },
      ],
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.previews.length).toBe(2);
    expect(r.previews.every((p) => p.ok && p.result!.dryRun === true)).toBe(true);
    // 未落盘
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    expect(readFileSync(path.join(dir, 'src/b.ts'), 'utf-8')).toContain('function beta');
    rmForce(dir);
  });

  it('任一条目被阻断 → 整体不落盘，返回预览报告', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/c.py': 'def c():\n    pass\n',
      'src/use.ts': "import { alpha } from './a';\nexport function run() { return alpha(1); }\n",
    });
    // 第二个条目指向非 TS 文件 → 被阻断
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/c.py', symbol: 'c', to: 'd' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.dryRun).toBe(true); // 整体未落盘
    expect(r.blocked!.some((b) => b.includes('阻断'))).toBe(true);
    // previews 标出第一条可落盘、第二条被阻断
    expect(r.previews[0].ok).toBe(true);
    expect(r.previews[1].ok).toBe(false);
    expect(r.previews[1].blocked!.length).toBeGreaterThan(0);
    // 全部未落盘（即使第一条能过）
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    rmForce(dir);
  });

  it('重复条目（同 file+symbol）→ 阻断', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/a.ts', symbol: 'alpha', to: 'other' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('重复'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    rmForce(dir);
  });
});