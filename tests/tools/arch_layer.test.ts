/**
 * arch_layer 架构分层分析测试
 *
 * 覆盖：
 *   - 目录/文件名模式命中：db.ts→data、types.ts→types、renderer→ui、server.ts→entry、tools→utility
 *   - 未匹配 → 归入 core 兜底层
 *   - persist=true 写回 feature（dsl.layers + node.arch_layer），持久化后 getDSL 可读
 *   - persist=false 仅分析不落盘
 *   - feature 不存在 → 抛错
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { importProject } from '../../src/tools/import_project';
import { archLayer } from '../../src/tools/arch_layer';
import { getDSL } from '../../src/storage';
import { openDb } from '../../src/db/db';

const roots: string[] = [];

afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** 建一个覆盖多层的项目并写入 feature（含 file 节点） */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-layer-'));
  roots.push(root);
  put(root, 'api/routes/users.ts', `export function list() { return []; }\n`);
  put(root, 'src/db/db.ts', `export const db = 1;\n`);
  put(root, 'src/dsl/types.ts', `export interface T {}\n`);
  put(root, 'src/renderer/view.ts', `export function view() {}\n`);
  put(root, 'src/server.ts', `export function main() {}\n`);
  put(root, 'src/tools/helper.ts', `export function h() {}\n`);
  put(root, 'src/oddname.ts', `export function x() {}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

const assignUnder = (r: ReturnType<typeof archLayer>, pathLike: string) =>
  r.assignments.find((a) => a.path && a.path.includes(pathLike));

describe('arch_layer 架构分层', () => {
  it('按目录/文件名模式正确推断架构层', async () => {
    const feature = `arch_${Date.now()}`;
    await makeProject(feature);
    const r = archLayer({ feature });

    expect(assignUnder(r, 'api/routes/users.ts')!.arch_layer).toBe('api');
    expect(assignUnder(r, 'src/db/db.ts')!.arch_layer).toBe('data');
    expect(assignUnder(r, 'src/dsl/types.ts')!.arch_layer).toBe('types');
    expect(assignUnder(r, 'src/renderer/view.ts')!.arch_layer).toBe('ui');
    expect(assignUnder(r, 'src/server.ts')!.arch_layer).toBe('entry');
    expect(assignUnder(r, 'src/tools/helper.ts')!.arch_layer).toBe('utility');
    // 未匹配 → core 兜底
    expect(assignUnder(r, 'src/oddname.ts')!.arch_layer).toBe('core');
  });

  it('persist=true 写回 feature（layers + arch_layer），getDSL 可读', async () => {
    const feature = `arch_persist_${Date.now()}`;
    await makeProject(feature);
    const r = archLayer({ feature, persist: true });
    expect(r.persisted).toBe(true);

    const dsl = getDSL(feature)!;
    expect(dsl.layers!.length).toBeGreaterThan(0);
    const fileNode = dsl.geometry.nodes.find((n) => n.type === 'file' && (n.description ?? '').includes('db/db.ts'));
    expect(fileNode!.arch_layer).toBe('data');
  });

  it('persist=false 仅分析不落盘', async () => {
    const feature = `arch_nopersist_${Date.now()}`;
    await makeProject(feature);
    const r = archLayer({ feature, persist: false });
    expect(r.persisted).toBe(false);
    expect(getDSL(feature)!.layers).toBeUndefined();
  });

  it('feature 不存在 → 抛错', () => {
    expect(() => archLayer({ feature: `nope_${Date.now()}` })).toThrow(/不存在/);
  });
});