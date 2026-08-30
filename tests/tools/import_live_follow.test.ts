/**
 * 摩擦 G/H 修复回归测试（2026-08-30）
 *
 * G：consistency_check 未传 code_dir 时全报"文件不存在"——现在 import_project 把
 *     project_dir 写入 DSL.source_root，checkConsistency 未传 code_dir 时自动用它对账。
 * H：live_only 刷新默认不含测试，覆盖含测试的 live 快照 → diff_views 误报"测试被删"。
 *     现在 live_only 且未显式 include_tests 时，跟随设计 DSL 的测试包含情况。
 *
 * 端到端：真实临时项目 → 主导入（含测试）→ 不传 code_dir 对账 → live_only 刷新不丢测试。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { importProject } from '../../src/tools/import_project.js';
import { checkConsistency } from '../../src/tools/consistency.js';
import { getDSL, getLiveFeature, clearAllFeatures } from '../../src/storage.js';

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-live-follow-'));
  const files: Record<string, string> = {
    'src/main.ts':
      'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
    'tests/main.test.ts':
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
      'test("greet", () => assert.equal(greet("x"), "hi x"));\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('摩擦 G/H：source_root 自动对账 + live 快照跟随测试', () => {
  it('主导入(含测试) → 不传 code_dir 可对账，live_only 刷新不丢测试', async () => {
    const root = makeProject();
    const feature = 'live-follow';

    // 1. 主导入含测试：设计 DSL + live 都应含 tests
    await importProject({ project_dir: root, feature, include_tests: true });
    const dsl = getDSL(feature);
    expect(dsl).not.toBeNull();
    // G：source_root 记录了 project_dir（未显式传 source_root 时）
    expect(dsl!.source_root).toBe(root);
    expect(dsl!.semantic.files.some((f) => f.path?.includes('tests/'))).toBe(true);
    expect(getLiveFeature(feature)?.semantic.files.some((f) => f.path?.includes('tests/'))).toBe(true);

    // 2. G：不传 code_dir → 自动用 source_root 对账，不报缺失
    const r = await checkConsistency({ feature });
    expect(r.summary.missing).toBe(0);
    expect(r.summary.matched).toBeGreaterThanOrEqual(1);

    // 3. H：live_only 刷新不带 include_tests → 跟随设计 DSL 保留测试（不误删）
    await importProject({ project_dir: root, feature, live_only: true });
    const live = getLiveFeature(feature);
    expect(live).not.toBeNull();
    expect(live!.semantic.files.some((f) => f.path?.includes('tests/'))).toBe(true);
  });

  it('live_only 时显式 include_tests=false 仍尊重显式设置（不强制跟随）', async () => {
    const root = makeProject();
    const feature = 'live-follow-explicit';

    await importProject({ project_dir: root, feature, include_tests: true });
    await importProject({ project_dir: root, feature, live_only: true, include_tests: false });
    const live = getLiveFeature(feature);
    expect(live).not.toBeNull();
    expect(live!.semantic.files.some((f) => f.path?.includes('tests/'))).toBe(false);
  });
});
