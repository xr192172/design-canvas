/**
 * candidate_locator 测试：候选定位（诊断流水线第 2 步）
 * 覆盖：
 * - 符号精确命中（exact，含 qualified_name 点号尾段）
 * - 报错位置 文件:行 → 所在符号（file）
 * - FTS5 兜底（fts）
 * - anchor 文件 / 符号（anchor）
 * - 无缓存 → warnings + 空候选
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Database } from '../../src/db/db';
import { openDb, closeAllProjectCacheDbs } from '../../src/db/db';
import { syncProject } from '../../src/db/symbols';
import { locateCandidates } from '../../src/diagnosis/candidate_locator';
import type { SymptomParsed } from '../../src/diagnosis/contract';

const USER_TS = `import { loadConfig } from './config';

export function getUser(): { name: string } {
  const cfg = loadConfig('user');
  return cfg.profile;
}
`;

const CONFIG_TS = `export interface Config {
  profile?: { name: string };
}

export function loadConfig(key: string): Config {
  return { profile: { name: 'default' } };
}

export class ConfigLoader {
  load(key: string): Config {
    return loadConfig(key);
  }
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

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cand-'));
  writeProjectFile('src/user.ts', USER_TS);
  writeProjectFile('src/config.ts', CONFIG_TS);
  db = openDb(path.join(dir, '.design-canvas', 'cache.db'));
  await syncProject(db, dir, [path.join(dir, 'src', 'user.ts'), path.join(dir, 'src', 'config.ts')]);
});

afterEach(() => {
  closeAllProjectCacheDbs();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const parsed = (p: Partial<SymptomParsed>): SymptomParsed => ({
  error_type: 'TypeError',
  locations: [],
  symbols: [],
  keywords: [],
  ...p,
});

describe('candidate_locator 符号精确命中', () => {
  it('exact：按符号名命中', () => {
    const r = locateCandidates(db, { project_dir: dir, parsed: parsed({ symbols: ['loadConfig'] }) });
    const hit = r.candidates.find((c) => c.symbol === 'loadConfig');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('exact');
    expect(hit?.score).toBe(1.0);
    expect(hit?.file_path).toBe('src/config.ts');
  });

  it('exact：qualified_name 命中（取点号尾段）', () => {
    const r = locateCandidates(db, { project_dir: dir, parsed: parsed({ symbols: ['ConfigLoader.load'] }) });
    expect(r.candidates.some((c) => c.symbol === 'load' && c.source === 'exact')).toBe(true);
  });
});

describe('candidate_locator 报错位置定位', () => {
  it('file：文件:行 定位到所在符号', () => {
    const r = locateCandidates(db, {
      project_dir: dir,
      parsed: parsed({ locations: [{ file: 'src/user.ts', line: 5 }] }),
    });
    const hit = r.candidates.find((c) => c.file_path === 'src/user.ts');
    expect(hit?.symbol).toBe('getUser');
    expect(hit?.source).toBe('file');
  });

  it('file：相对路径带 src/ 前缀可命中', () => {
    const r = locateCandidates(db, {
      project_dir: dir,
      parsed: parsed({ locations: [{ file: 'src/config.ts', line: 10 }] }),
    });
    expect(r.candidates.some((c) => c.file_path === 'src/config.ts')).toBe(true);
  });
});

describe('candidate_locator FTS 兜底', () => {
  it('fts：关键词子串命中', () => {
    const r = locateCandidates(db, { project_dir: dir, parsed: parsed({ keywords: ['Config'] }) });
    expect(r.candidates.some((c) => c.symbol === 'loadConfig')).toBe(true);
  });
});

describe('candidate_locator anchor', () => {
  it('anchor：文件路径', () => {
    const r = locateCandidates(db, { project_dir: dir, parsed: parsed({}), anchor: 'src/config.ts' });
    expect(r.candidates.some((c) => c.source === 'anchor' && c.file_path === 'src/config.ts')).toBe(true);
  });

  it('anchor：符号名', () => {
    const r = locateCandidates(db, { project_dir: dir, parsed: parsed({}), anchor: 'loadConfig' });
    expect(r.candidates.some((c) => c.source === 'anchor' && c.symbol === 'loadConfig')).toBe(true);
  });
});

describe('candidate_locator 无缓存', () => {
  it('空库 → warnings + 空候选', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cand-empty-'));
    try {
      const emptyDb = openDb(path.join(emptyDir, '.design-canvas', 'cache.db'));
      const r = locateCandidates(emptyDb, { project_dir: emptyDir, parsed: parsed({}) });
      expect(r.candidates).toEqual([]);
      expect(r.warnings.length).toBeGreaterThan(0);
      emptyDb.close();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});
