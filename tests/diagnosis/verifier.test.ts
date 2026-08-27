/**
 * verifier 测试：验证建议（诊断流水线第 6 步）
 * 覆盖：Node/Go/Python 类型探测、test_failure 重跑、design-canvas 渲染自检、未知项目 manual。
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectKind, suggestVerification } from '../../src/diagnosis/verifier';
import type { Impact, RootCause, Verification } from '../../src/diagnosis/contract';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dc-verify-'));
}

const emptyImpact: Impact = { affected_files: [], affected_symbols: [], dsl_contract_hits: [] };

describe('detectKind 项目类型探测', () => {
  it('package.json → Node/TS（含 typecheck）', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const k = detectKind(dir);
    expect(k?.label).toBe('Node/TS');
    expect(k?.typecheck).toBe('npx tsc --noEmit');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('go.mod → Go', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    expect(detectKind(dir)?.label).toBe('Go');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('无 marker → null', () => {
    const dir = tmp();
    expect(detectKind(dir)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('suggestVerification 验证建议', () => {
  const rootCause: RootCause = {
    file_path: 'src/util.ts',
    line: 5,
    symbol: 'getUser',
    kind: 'error_direct',
    confidence: 0.9,
    reasoning: 'x',
  };

  it('Node 项目 → typecheck + build + test', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const v: Verification[] = suggestVerification({ project_dir: dir, impact: emptyImpact });
    const types = v.map((x) => x.type);
    expect(types).toContain('typecheck');
    expect(types).toContain('build');
    expect(types).toContain('test');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('test_failure 症状 → 先 rerun 最窄复现', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    const v = suggestVerification({ project_dir: dir, symptom_type: 'test_failure', impact: emptyImpact });
    expect(v[0].type).toBe('rerun');
    expect(v[0].command_hint).toContain('npm test');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('design-canvas 管理项目（.design-canvas 存在）→ 追加 camera 渲染自检', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.mkdirSync(path.join(dir, '.design-canvas'));
    const v = suggestVerification({ project_dir: dir, impact: emptyImpact, root_cause: rootCause });
    expect(v.some((x) => x.type === 'camera')).toBe(true);
    expect(v.find((x) => x.type === 'camera')?.command_hint).toContain('src/util.ts');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('未知项目 → manual 兜底', () => {
    const dir = tmp();
    const v = suggestVerification({ project_dir: dir, impact: emptyImpact });
    expect(v.some((x) => x.type === 'manual')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
