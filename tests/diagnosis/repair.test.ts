/**
 * repair 单测（T5）：补丁生成 + 安全校验（白名单/行号越界/防编造）+ 应用/回退
 *
 * 不需要真实 LLM key：vi.stubGlobal('fetch') 注入假响应，走真实 callChat →
 * generatePatch → validate → apply → revert 全路径，确定性验证：
 *   - generatePatch：合法补丁解析 / 非法 JSON→null / 空补丁→null
 *   - 白名单：LLM 改白名单外文件 → 校验拒绝
 *   - 行号越界 → 校验拒绝
 *   - 应用后内容替换正确、回退后逐字节还原
 *   - formatPatchDiff 展示真实 diff（审批材料）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generatePatch, validatePatches, applyPatches, revertPatches, formatPatchDiff, allowedPatchFiles } from '../../src/diagnosis/repair';
import type { FixSuggestion, RootCause } from '../../src/diagnosis/contract';

const SERVICE_TS = `import { findById } from './db';

export function getUserName(id: string): string {
  const row = findById(id);
  return row.name;
}
`;

let dir: string;
let absService: string;

const ROOT_CAUSE: RootCause = {
  file_path: 'src/service.ts',
  line: 6,
  symbol: 'getUserName',
  kind: 'error_direct',
  confidence: 0.9,
  reasoning: 'row 可能 undefined 时直接解引用',
};

const FIX: FixSuggestion = {
  target_file: 'src/service.ts',
  target_line: 6,
  action: 'modify',
  description: '判空后再访问 name',
  rationale: '证据链命中',
};

function writeProjectFile(rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

function mockLlm(jsonContent: string, ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve({
        ok,
        status,
        json: async () => ({ choices: [{ message: { content: jsonContent } }] }),
        text: async () => jsonContent,
      } as unknown as Response),
    ),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-repair-'));
  absService = writeProjectFile('src/service.ts', SERVICE_TS);
  writeProjectFile('src/db.ts', `export interface Row { id: string; name: string; }\n`);
  process.env.LLM_API_KEY = 'sk-test';
  process.env.LLM_MODEL = 'gpt-test';
  process.env.LLM_BASE_URL = 'https://llm.test/v1';
  delete process.env.AGNES_API_KEY;
});

afterEach(() => {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const input = () => ({ project_dir: dir, root_cause: ROOT_CAUSE, fix_suggestions: [FIX] });

describe('generatePatch（LLM 补丁生成）', () => {
  it('合法补丁 → 解析成 PatchPlan（文件/行区间/新内容）', async () => {
    mockLlm(
      JSON.stringify({
        patches: [{ file: 'src/service.ts', start_line: 5, end_line: 6, new_content: '  if (!row) throw new Error(\'user not found\');\n  return row.name;' }],
        rationale: 'findById 可能返回 undefined，先判空',
      }),
    );
    const plan = await generatePatch(input());
    expect(plan).not.toBeNull();
    expect(plan!.patches).toHaveLength(1);
    expect(plan!.patches[0].file).toBe('src/service.ts');
    expect(plan!.patches[0].start_line).toBe(5);
    expect(plan!.patches[0].end_line).toBe(6);
    expect(plan!.patches[0].new_content).toContain('if (!row)');
    expect(plan!.rationale).toContain('判空');
  });

  it('非法 JSON → null（降级为不可自动修复）', async () => {
    mockLlm('这不是 JSON');
    expect(await generatePatch(input())).toBeNull();
  });

  it('HTTP 错误 → null', async () => {
    mockLlm('', false, 500);
    expect(await generatePatch(input())).toBeNull();
  });

  it('空 patches → null', async () => {
    mockLlm(JSON.stringify({ patches: [], rationale: '无改动' }));
    expect(await generatePatch(input())).toBeNull();
  });

  it('未配置 LLM → null', async () => {
    delete process.env.LLM_API_KEY;
    expect(await generatePatch(input())).toBeNull();
  });
});

describe('白名单 + 行号校验', () => {
  it('LLM 改白名单外文件 → 校验拒绝', () => {
    const plan = { patches: [{ file: 'src/evil.ts', start_line: 1, end_line: 1, new_content: 'x' }], rationale: '' };
    const errs = validatePatches(dir, plan, allowedPatchFiles(input()));
    expect(errs).toHaveLength(1);
    expect(errs[0].file).toBe('src/evil.ts');
    expect(errs[0].reason).toContain('白名单');
  });

  it('行号越界（end_line > 文件行数）→ 校验拒绝', () => {
    const plan = { patches: [{ file: 'src/service.ts', start_line: 5, end_line: 999, new_content: 'x' }], rationale: '' };
    const errs = validatePatches(dir, plan, allowedPatchFiles(input()));
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toContain('行号越界');
  });

  it('start_line > end_line → 校验拒绝', () => {
    const plan = { patches: [{ file: 'src/service.ts', start_line: 6, end_line: 5, new_content: 'x' }], rationale: '' };
    const errs = validatePatches(dir, plan, allowedPatchFiles(input()));
    expect(errs).toHaveLength(1);
  });

  it('文件不存在 → 校验拒绝', () => {
    // allowed 含 missing.ts（在白名单内），单独验证"文件不存在"分支
    const errs = validatePatches(dir, { patches: [{ file: 'src/missing.ts', start_line: 1, end_line: 1, new_content: 'x' }], rationale: '' }, ['src/missing.ts']);
    expect(errs).toHaveLength(1);
    expect(errs[0].reason).toContain('不存在');
  });

  it('allowedPatchFiles 只含根因文件 + 建议 target_file（去重）', () => {
    const a = allowedPatchFiles(input());
    expect(a).toEqual(['src/service.ts']);
  });
});

describe('apply / revert / diff 展示', () => {
  it('应用补丁替换行区间；revert 逐字节还原', () => {
    const plan = {
      patches: [{ file: 'src/service.ts', start_line: 5, end_line: 6, new_content: "  if (!row) throw new Error('not found');\n  return row.name;" }],
      rationale: '',
    };
    const allowed = allowedPatchFiles(input());
    const { applied, errors } = applyPatches(dir, plan, allowed);
    expect(errors).toHaveLength(0);
    expect(applied).toHaveLength(1);

    const after = fs.readFileSync(absService, 'utf-8');
    expect(after).toContain("if (!row) throw new Error('not found')");
    expect(after).toContain('return row.name');

    revertPatches(applied);
    expect(fs.readFileSync(absService, 'utf-8')).toBe(SERVICE_TS);
  });

  it('有校验错误时整体不应用（applied 为空）', () => {
    const plan = {
      patches: [{ file: 'src/evil.ts', start_line: 1, end_line: 1, new_content: 'x' }],
      rationale: '',
    };
    const { applied, errors } = applyPatches(dir, plan, allowedPatchFiles(input()));
    expect(applied).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('formatPatchDiff 输出含 +/- 行（审批材料真实展示磁盘内容）', () => {
    const plan = {
      patches: [{ file: 'src/service.ts', start_line: 5, end_line: 5, new_content: '  if (!row) throw new Error(\'x\');\n  return row.name;' }],
      rationale: '',
    };
    const diffs = formatPatchDiff(dir, plan);
    expect(diffs.join('\n')).toContain('--- a/src/service.ts');
    expect(diffs.join('\n')).toContain('-   return row.name;');
    expect(diffs.join('\n')).toContain('+   if (!row) throw new Error');
  });
});
