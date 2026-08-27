/**
 * chain_tracer 测试：调用链追溯（诊断流水线第 3 步）
 *
 * 场景：一个 4 文件项目，形成两层调用链 + 一层类型引用：
 *   main.ts#main ──call──▶ service.ts#runService ──call──▶ util.ts#getUser
 *                                                        └─type_ref─▶ types.ts#User
 * 候选 = util.ts#getUser（报错点），应能沿 callers 追溯到上层调用方，
 * 沿 callees 摸到被引用的类型。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from '../../src/db/db';
import { openDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { traceChain } from '../../src/diagnosis/chain_tracer';
import type { Candidate } from '../../src/diagnosis/contract';

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
let db: Database;

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

const files = (): string[] => ['src/types.ts', 'src/util.ts', 'src/service.ts', 'src/main.ts'].map((f) => path.join(dir, f));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-chain-'));
  writeProjectFile('src/types.ts', TYPES_TS);
  writeProjectFile('src/util.ts', UTIL_TS);
  writeProjectFile('src/service.ts', SERVICE_TS);
  writeProjectFile('src/main.ts', MAIN_TS);
  db = openDb(path.join(dir, '.design-canvas', 'cache.db'));
  await syncProject(db, dir, files());
});

afterEach(() => {
  closeAllProjectCacheDbs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const candidate = (partial?: Partial<Candidate>): Candidate => ({
  symbol: 'getUser',
  qualified_name: 'getUser',
  file_path: 'src/util.ts',
  start_line: 3,
  kind: 'function',
  score: 1,
  source: 'exact',
  ...partial,
});

describe('chain_tracer 调用链追溯', () => {
  it('从报错符号沿 callers 追溯到上层调用方', () => {
    const r = traceChain(db, { project_dir: dir, candidates: [candidate()], max_depth: 3 });
    expect(r.chain.length).toBeGreaterThan(0);
    expect(r.chain[0].type).toBe('symbol_hit');
    // callers 方向应到达 service 与 main
    expect(r.reached).toContain('src/service.ts#runService');
    expect(r.reached).toContain('src/main.ts#main');
    // 证据链文本里应含两层调用边
    const callSteps = r.chain.filter((s) => s.type === 'call_chain');
    expect(callSteps.some((s) => s.text.includes('runService'))).toBe(true);
    expect(callSteps.some((s) => s.text.includes('main'))).toBe(true);
  });

  it('callees 方向摸到被引用的类型符号', () => {
    const r = traceChain(db, { project_dir: dir, candidates: [candidate()], max_depth: 3 });
    expect(r.reached).toContain('src/types.ts#User');
  });

  it('无候选 → 空证据链 + 提示性步骤', () => {
    const r = traceChain(db, { project_dir: dir, candidates: [], max_depth: 3 });
    expect(r.reached).toEqual([]);
    expect(r.chain.some((s) => s.text.includes('无可追溯'))).toBe(true);
  });
});
