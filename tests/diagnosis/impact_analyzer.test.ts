/**
 * impact_analyzer 测试：影响面分析（诊断流水线第 4 步）
 *
 * 复用与 chain_tracer 相同的 4 文件场景，把根因文件 util.ts 当"变更源"，
 * 断言 affected_files / affected_symbols 覆盖上层调用方。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getProjectCacheDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { analyzeImpact } from '../../src/diagnosis/impact_analyzer';

const TYPES_TS = `export interface User {
  profile?: { name: string };
}
`;

const UTIL_TS = `import { User } from './types';

export function getUser(id: string): User {
  const u: User = { profile: { name: 'default' } };
  return u.profile ?? u;
}
`;

const SERVICE_TS = `import { getUser } from './util';

export function runService(id: string): void {
  const u = getUser(id);
  console.log(u.profile?.name);
}
`;

const MAIN_TS = `import { runService } from './service';

export function main(): void {
  runService('a');
}
`;

let dir: string;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-impact-'));
  writeProjectFile('src/types.ts', TYPES_TS);
  writeProjectFile('src/util.ts', UTIL_TS);
  writeProjectFile('src/service.ts', SERVICE_TS);
  writeProjectFile('src/main.ts', MAIN_TS);
  // 用池化连接，与 diffImpact 内部的 getProjectCacheDb 同一句柄
  await syncProject(getProjectCacheDb(dir), dir, [
    path.join(dir, 'src', 'types.ts'),
    path.join(dir, 'src', 'util.ts'),
    path.join(dir, 'src', 'service.ts'),
    path.join(dir, 'src', 'main.ts'),
  ]);
});

afterEach(() => {
  closeAllProjectCacheDbs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('impact_analyzer 影响面分析', () => {
  it('根因文件 util.ts → 波及 service.ts 与 main.ts', () => {
    const imp = analyzeImpact({ project_dir: dir, root_file: 'src/util.ts', max_depth: 3 });
    const paths = imp.affected_files.map((f) => f.path);
    expect(paths).toContain('src/service.ts');
    expect(paths).toContain('src/main.ts');
    expect(imp.affected_symbols.some((s) => s.name === 'runService')).toBe(true);
    expect(imp.affected_symbols.some((s) => s.name === 'main')).toBe(true);
    // 根因文件本身算直接受影响
    const self = imp.affected_files.find((f) => f.path === 'src/util.ts');
    expect(self?.direct).toBe(true);
  });

  it('未同步缓存的目录 → 只报变更文件本身（无间接波及、无符号），不抛异常', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-impact-empty-'));
    try {
      const imp = analyzeImpact({ project_dir: emptyDir, root_file: 'src/util.ts' });
      // 变更文件本身恒为直接受影响；无缓存边 → 无间接波及、无符号
      expect(imp.affected_files).toEqual([
        { path: 'src/util.ts', reason: 'direct', depth: 0, direct: true },
      ]);
      expect(imp.affected_symbols).toEqual([]);
      expect(imp.dsl_contract_hits).toEqual([]);
    } finally {
      closeAllProjectCacheDbs();
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
