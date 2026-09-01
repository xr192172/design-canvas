/**
 * stale_check —— STALE BUILD 检测测试
 *
 * 覆盖：文件级精确（src 比 dist 新→报；一样新→不报）；产物缺失→报 missing；
 * 忽略 *.gen.ts 生成源；formatStaleText 输出摘要。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkStaleBuild, formatStaleText } from '../../src/tools/stale_check.js';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'stale-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf-8');
  }
  return dir;
}
function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放 */
    }
  }
}

describe('checkStaleBuild', () => {
  /** 显式设置文件 mtime（毫秒），消除写序/时钟粒度抖动 */
  function setMtime(p: string, ms: number): void {
    utimesSync(p, new Date(ms), new Date(ms));
  }

  it('src 比 dist 新 → 报 stale（文件级精确）', () => {
    const dir = mkProj({
      'src/a.ts': 'export const a = 1;',
      'dist/src/a.js': 'export const a = 1;',
    });
    // 显式：dist 产物时间戳旧、src 新 → stale
    setMtime(path.join(dir, 'dist/src/a.js'), 1000);
    setMtime(path.join(dir, 'src/a.ts'), 2000);
    const r = checkStaleBuild(dir);
    expect(r.stale).toBe(true);
    expect(r.entries.some((e) => e.src === 'src/a.ts' && e.missing === false)).toBe(true);
    rmForce(dir);
  });

  it('src 与 dist 同新（dist 更新）→ 不报', () => {
    const dir = mkProj({
      'src/a.ts': 'export const a = 1;',
      'dist/src/a.js': 'export const a = 1;',
    });
    // dist 产物比 src 新 → 不 stale
    setMtime(path.join(dir, 'src/a.ts'), 1000);
    setMtime(path.join(dir, 'dist/src/a.js'), 2000);
    const r = checkStaleBuild(dir);
    expect(r.stale).toBe(false);
    expect(r.entries).toEqual([]);
    rmForce(dir);
  });

  it('产物缺失 → 报 missing', () => {
    const dir = mkProj({
      'src/new.ts': 'export const n = 1;',
    });
    const r = checkStaleBuild(dir);
    expect(r.stale).toBe(true);
    expect(r.entries.some((e) => e.src === 'src/new.ts' && e.missing === true)).toBe(true);
    rmForce(dir);
  });

  it('忽略 *.gen.ts 生成源', () => {
    const dir = mkProj({
      'src/bundle.gen.ts': 'export const b = 1;', // 生成文件，改它不算待重建
      'dist/src/bundle.gen.js': 'export const b = 1;',
    });
    writeFileSync(path.join(dir, 'src/bundle.gen.ts'), 'export const b = 2; // 改', 'utf-8');
    const r = checkStaleBuild(dir);
    expect(r.entries.some((e) => e.src.includes('bundle.gen'))).toBe(false);
    rmForce(dir);
  });

  it('formatStaleText：有 stale 给摘要，无 stale 给通过', () => {
    const dir = mkProj({
      'src/a.ts': 'export const a = 1;',
    });
    const r = checkStaleBuild(dir);
    const text = formatStaleText(r);
    expect(text).toContain('STALE BUILD');
    expect(text).toContain('src/a.ts');
    // 无 stale：显式 dist 比 src 新
    const cleanDir = mkProj({
      'src/a.ts': 'export const a = 1;',
      'dist/src/a.js': 'export const a = 1;',
    });
    setMtime(path.join(cleanDir, 'src/a.ts'), 1000);
    setMtime(path.join(cleanDir, 'dist/src/a.js'), 2000);
    expect(formatStaleText(checkStaleBuild(cleanDir))).toContain('无 STALE BUILD');
    rmForce(dir);
    rmForce(cleanDir);
  });
});