/**
 * consistency_check 回归测试：语义契约 vs 实现的签名比对
 *
 * 背景（2026-08-30 狗食修复）：旧 compareSignatures 用 `\(([^)]*)\)` 抓参数字符串后按逗号
 * 朴素切分，把对象字面量 {file, symbol?, ...} 里的字段误算成多个参数，导致
 * `readCode(args: {file, symbol?, ...})`（语义契约）对 `readCode(args: Record<string, unknown>)`
 * 报"参数数量不匹配：期望 8 个，实际 1 个"——本代码库所有工具都是单参数解构对象模式，
 * 该误报会让一致性检查对每个 feature 都响警报。
 *
 * 修复：嵌套感知的顶层逗号切分 + 参数名对齐 + 对象形参契约校验 + 返回类型容错（含 ... 语义省略号跳过）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getFeatureFile } from '../../src/storage.js';
import { checkConsistency } from '../../src/tools/consistency.js';
import type { DesignDSL } from '../../src/dsl/types.js';

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

/** 在临时 code_dir 下生成实现文件，返回 code_dir */
function writeCode(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-consistency-code-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('consistency_check 语义契约 vs 实现签名比对', () => {
  it('单参数解构对象契约 vs Record 实现 → matched（不再误报参数数量）', async () => {
    const feature = 'v-obj-args';
    writeFeature(feature, [
      'readCode(args: {file, symbol?, parent?, start?, end?, context?, symbols?, symbols_limit?}) => {message, data:{..., symbols}}',
    ], 'src/tools/demo.ts');
    const codeDir = writeCode({
      'src/tools/demo.ts':
        'export async function readCode(args: Record<string, unknown>): Promise<{ message: string; data: unknown }> {\n' +
        '  return { message: "ok", data: {} };\n' +
        '}\n',
    });

    const r = await checkConsistency({ feature, code_dir: codeDir });
    const mc = r.fileResults[0].apis.find((a) => a.expected_signature.startsWith('readCode'));
    expect(mc?.status).toBe('matched');
    expect(mc?.match_score).toBe(100);
    expect(r.summary.matched).toBe(1);
    expect(r.summary.mismatched).toBe(0);
  });

  it('参数数量不匹配 → 仍被拦截（score 70）', async () => {
    const feature = 'v-arity';
    writeFeature(feature, ['readCode(a, b) => string'], 'src/tools/demo.ts');
    const codeDir = writeCode({
      'src/tools/demo.ts': 'export function readCode(args: unknown): string { return "x"; }\n',
    });

    const r = await checkConsistency({ feature, code_dir: codeDir });
    const mc = r.fileResults[0].apis[0];
    expect(mc?.status).toBe('mismatched');
    expect(mc?.match_score).toBe(70);
    expect(mc?.reason).toContain('参数数量不匹配');
  });

  it('对象形参契约 vs 标量实现 → 被拦截（score 80）', async () => {
    const feature = 'v-scalar';
    writeFeature(feature, ['parseOptions(opts: {x?, y?}) => number'], 'src/tools/demo.ts');
    const codeDir = writeCode({
      'src/tools/demo.ts': 'export function parseOptions(opts: number): number { return opts; }\n',
    });

    const r = await checkConsistency({ feature, code_dir: codeDir });
    const mc = r.fileResults[0].apis[0];
    expect(mc?.status).toBe('mismatched');
    expect(mc?.match_score).toBe(80);
    expect(mc?.reason).toContain('形参类型不匹配');
  });

  it('参数名不一致（同数量）→ 不完全一致（score 90）', async () => {
    const feature = 'v-name';
    writeFeature(feature, ['run(cmd: string) => boolean'], 'src/tools/demo.ts');
    const codeDir = writeCode({
      'src/tools/demo.ts': 'export function run(args: string): boolean { return !!args; }\n',
    });

    const r = await checkConsistency({ feature, code_dir: codeDir });
    const mc = r.fileResults[0].apis[0];
    expect(mc?.status).toBe('mismatched');
    expect(mc?.match_score).toBe(90);
    expect(mc?.reason).toContain('签名不完全一致');
  });

  it('DSL 中未实现的函数 → missing', async () => {
    const feature = 'v-missing';
    writeFeature(feature, ['notImplemented(x: number) => number'], 'src/tools/demo.ts');
    const codeDir = writeCode({
      'src/tools/demo.ts': 'export function other(): void {}\n',
    });

    const r = await checkConsistency({ feature, code_dir: codeDir });
    const mc = r.fileResults[0].apis[0];
    expect(mc?.status).toBe('missing');
    expect(r.summary.missing).toBe(1);
  });
});
