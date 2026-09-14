/**
 * file_snapshot —— 代码快照 + 一键回滚（治"不可撤回"）
 *
 * 动机：本项目已有 dry_run / 原子落盘 / 单次失败回滚，但**跨调用撤不掉**；
 * 设计原则 6「危险的不是能力，是不可撤回」。
 *
 * 覆盖：
 *   - 建快照 → 改文件 → 回滚 = 内容复原
 *   - 回滚会**删除"快照时还不存在"的文件**（= 这次改动新建的）
 *   - 只回滚单个文件（filter）
 *   - 保留份数裁剪（prune）
 *   - 空清单不建快照
 *   - ★ 接线：edit_code 落盘前自动快照 → rollback 能撤回（端到端的那一条）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  createFileSnapshot,
  listFileSnapshots,
  rollbackFileSnapshot,
  pruneFileSnapshots,
  snapshotBeforeWrite,
  fileSnapshotsDir,
} from '../../src/tools/file_snapshot';
import { editCode } from '../../src/tools/edit_code';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* Windows 占用留给 OS */
    }
  }
});

function mk(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsnap-'));
  roots.push(root);
  return root;
}

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

describe('file_snapshot 基础语义', () => {
  it('建快照 → 改文件 → 回滚 = 内容复原', () => {
    const root = mk();
    put(root, 'src/a.ts', 'const a = 1;\n');
    const meta = createFileSnapshot(root, { reason: 'test', files: ['src/a.ts'] });
    expect(meta.files).toEqual([{ rel: 'src/a.ts', existed: true, bytes: 13 }]);
    expect(listFileSnapshots(root).map((m) => m.id)).toEqual([meta.id]);

    fs.writeFileSync(path.join(root, 'src/a.ts'), 'const a = 999;\n', 'utf-8');
    const r = rollbackFileSnapshot(root);
    expect(r.ok).toBe(true);
    expect(r.restored).toEqual(['src/a.ts']);
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')).toBe('const a = 1;\n');
  });

  it('★ 回滚会删除"快照时还不存在"的文件（本次新建的）', () => {
    const root = mk();
    put(root, 'src/a.ts', 'const a = 1;\n');
    createFileSnapshot(root, { reason: 'test', files: ['src/a.ts', 'src/new.ts'] });
    // 快照之后新建的文件（快照时 existed=false）
    put(root, 'src/new.ts', 'export const fresh = true;\n');

    const r = rollbackFileSnapshot(root);
    expect(r.removed).toEqual(['src/new.ts']);
    expect(fs.existsSync(path.join(root, 'src/new.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'src/a.ts'))).toBe(true);
  });

  it('只回滚单个文件（filter.file）', () => {
    const root = mk();
    put(root, 'src/a.ts', 'A0\n');
    put(root, 'src/b.ts', 'B0\n');
    createFileSnapshot(root, { reason: 'test', files: ['src/a.ts', 'src/b.ts'] });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'A1\n', 'utf-8');
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'B1\n', 'utf-8');

    const r = rollbackFileSnapshot(root, 'latest', { file: 'src/a.ts' });
    expect(r.restored).toEqual(['src/a.ts']);
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')).toBe('A0\n');
    expect(fs.readFileSync(path.join(root, 'src/b.ts'), 'utf-8')).toBe('B1\n'); // 未动
  });

  it('过滤到快照里没有的文件 → 明确报错（不静默成功）', () => {
    const root = mk();
    put(root, 'src/a.ts', 'A\n');
    createFileSnapshot(root, { reason: 'test', files: ['src/a.ts'] });
    const r = rollbackFileSnapshot(root, 'latest', { file: 'src/zzz.ts' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有文件');
  });

  it('保留份数裁剪：只留最新 N 份', () => {
    const root = mk();
    put(root, 'src/a.ts', 'A\n');
    for (let i = 0; i < 4; i++) {
      createFileSnapshot(root, { reason: `t${i}`, files: ['src/a.ts'] });
      // 保证 createdAt 有区分（同秒也可能重，靠 id 随机后缀排序不稳定）→ 直接改文件名排序不稳，
      // 这里只断言数量语义：prune 到 2
    }
    const pruned = pruneFileSnapshots(root, 2);
    expect(pruned).toBe(2);
    expect(listFileSnapshots(root)).toHaveLength(2);
  });

  it('空清单不建快照；快照目录落在 .design-canvas/code-snapshots', () => {
    const root = mk();
    expect(snapshotBeforeWrite(root, 'empty', [])).toBeNull();
    expect(fs.existsSync(fileSnapshotsDir(root))).toBe(false);
    put(root, 'src/a.ts', 'A\n');
    const meta = snapshotBeforeWrite(root, 'one', ['src/a.ts']);
    expect(meta).not.toBeNull();
    expect(fileSnapshotsDir(root).endsWith(path.join('.design-canvas', 'code-snapshots'))).toBe(true);
  });

  it('没有快照时回滚 → 明确说明（不假装成功）', () => {
    const root = mk();
    const r = rollbackFileSnapshot(root);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有可用代码快照');
  });
});

describe('★ 接线：edit_code 落盘前自动快照 → 可撤回', () => {
  it('dry_run 不快照；真落盘前快照；rollback 复原', async () => {
    const root = mk();
    put(root, 'src/a.ts', 'export function f(): number {\n  return 1;\n}\n');

    // dry_run：只预览，不该产生快照
    await editCode({
      project_dir: root,
      file: 'src/a.ts',
      op: 'replace',
      symbol: 'f',
      code: 'export function f(): number {\n  return 2;\n}',
      dry_run: true,
    } as never);
    expect(listFileSnapshots(root)).toHaveLength(0);

    // 真落盘：应自动快照
    await editCode({
      project_dir: root,
      file: 'src/a.ts',
      op: 'replace',
      symbol: 'f',
      code: 'export function f(): number {\n  return 2;\n}',
    } as never);
    const snaps = listFileSnapshots(root);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].reason).toContain('edit_code');
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')).toContain('return 2;');

    // 撤回
    const r = rollbackFileSnapshot(root);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')).toContain('return 1;');
  });
});