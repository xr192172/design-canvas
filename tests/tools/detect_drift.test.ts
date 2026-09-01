/**
 * detect_drift 回归测试：活文档↔代码漂移检测
 *
 * 验证点：
 *   1. detect_drift 已注册进 TOOL_DEFS。
 *   2. clean：design expected 与代码完全对齐 → status=clean，drifted=false，台账持久化，mode=status 可复读。
 *   3. design_stale：代码新增了设计未声明的 API（unexpected）→ 判定设计过时。
 *   4. missing_impl：设计声明了代码尚未实现的 API（missing）→ 判定实现欠账。
 *   5. 无 git 仓库时 scope=changed 安全回退（等价于全量），不抛错。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TOOL_DEFS } from '../../src/server_registry';
import { getFeatureFile } from '../../src/storage.js';
import { detectDrift } from '../../src/tools/detect_drift.js';
import type { DesignDSL } from '../../src/dsl/types.js';

function handlerOf(name: string) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`工具 ${name} 不存在`);
  return def.handler;
}

function writeFeature(feature: string, expectedSignatures: string[], filePath: string): void {
  const dsl: DesignDSL = {
    feature,
    geometry: {},
    semantic: {
      files: [
        {
          id: 'f1',
          path: filePath,
          responsibility: '测试文件',
          expected_apis: expectedSignatures.map((signature) => ({ signature })),
        },
      ],
    },
  };
  fs.mkdirSync(path.dirname(getFeatureFile(feature)), { recursive: true });
  fs.writeFileSync(getFeatureFile(feature), JSON.stringify(dsl, null, 2), 'utf-8');
}

function writeCode(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-drift-code-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('detect_drift 注册', () => {
  it('detect_drift 在 TOOL_DEFS 中，且 handler 可调用', () => {
    expect(TOOL_DEFS.some((d) => d.name === 'detect_drift')).toBe(true);
    expect(handlerOf('detect_drift')).toBeTruthy();
  });
});

describe('detect_drift 漂移判定', () => {
  it('clean：设计与代码对齐 → status=clean，非 drifted，台账可 status 复读', async () => {
    const feature = 'drift-clean';
    writeFeature(feature, ['ping()'], 'src/app.ts');
    const codeDir = writeCode({
      'src/app.ts': 'export function ping(): string { return "pong"; }\n',
    });

    const r = await detectDrift({ feature, code_dir: codeDir });
    expect(r.status).toBe('clean');
    expect(r.drifted).toBe(false);
    expect(r.summary.matched).toBe(1);
    expect(r.summary.unexpected).toBe(0);
    expect(r.summary.missing).toBe(0);
    expect(r.persisted).toBe(true);

    // 台账复读（不同 code_dir 也行，因为 status 只读台账）
    const s = await detectDrift({ feature, mode: 'status' });
    expect(s.status).toBe('clean');
    expect(s.drifted).toBe(false);
  });

  it('design_stale：代码新增设计未声明的 API → 判定设计过时', async () => {
    const feature = 'drift-stale';
    // 设计只声明 greet；代码里还有额外的 ping（unexpected）
    writeFeature(feature, ['greet(name: string)'], 'src/app.ts');
    const codeDir = writeCode({
      'src/app.ts':
        'export function greet(name: string): string { return "hi " + name; }\n' +
        'export function ping(): string { return "pong"; }\n',
    });

    const r = await detectDrift({ feature, code_dir: codeDir });
    expect(r.status).toBe('design_stale');
    expect(r.drifted).toBe(true);
    expect(r.summary.unexpected).toBe(1);
    expect(r.stale_files).toContain('src/app.ts');
    expect(r.suggestions.some((s) => s.includes('设计过时'))).toBe(true);
  });

  it('missing_impl：设计声明但代码未实现 → 判定实现欠账', async () => {
    const feature = 'drift-missing';
    writeFeature(feature, ['run() => void'], 'src/app.ts');
    const codeDir = writeCode({}); // 代码里没有 src/app.ts

    const r = await detectDrift({ feature, code_dir: codeDir });
    expect(r.status).toBe('missing_impl');
    expect(r.drifted).toBe(true);
    expect(r.summary.missing).toBe(1);
    expect(r.missing_files).toContain('src/app.ts');
    expect(r.suggestions.some((s) => s.includes('实现欠账'))).toBe(true);
  });

  it('无 git 仓库时 scope=changed 安全回退为全量，不抛错', async () => {
    const feature = 'drift-nogit';
    writeFeature(feature, ['ping()'], 'src/app.ts');
    const codeDir = writeCode({ 'src/app.ts': 'export function ping(): string { return "pong"; }\n' });

    // 临时目录不是 git 仓库 → gitRootOf 返回 null → 回退全量
    const r = await detectDrift({ feature, code_dir: codeDir, scope: 'changed' });
    expect(r.status).toBe('clean');
    expect(r.summary.checked_files).toBe(1);
  });
});