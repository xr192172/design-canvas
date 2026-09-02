/**
 * contract_docs_gate —— 契约变更闸门测试（新增 + 改名残留）
 *
 * 覆盖 runContractGate 核心判定（在临时目录构造最小可同步文本集）：
 *   - 新增工具名在可同步文本零提及 → blocking（missingNew 非空）
 *   - 消失工具名残留（文档/代码字符串文案）→ blocking（residueList 非空）
 *   - 代码里只有符号调用（无字符串/注释文案）→ 不算残留（AST 收敛）
 *   - 历史记录（docs/tool-convergence.md）里的旧名 → 不拦
 *   - 空变更 → ok
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runContractGate } from '../../scripts/contract_docs_gate.mjs';

function mkRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cgate-'));
  // 关键目录：collectSyncSet 扫 README/AGENTS/docs/src/tests/.trae/skills
  for (const rel of ['docs', 'src', 'tests', '.trae', 'skills']) {
    mkdirSync(path.join(dir, rel), { recursive: true });
  }
  return dir;
}
function rmForce(dir) {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放 */
    }
  }
}

describe('runContractGate', () => {
  it('空变更 → ok', async () => {
    const r = await runContractGate(mkRoot(), [], []);
    expect(r.ok).toBe(true);
    expect(r.missingNew).toEqual([]);
    expect(r.residueList).toEqual([]);
  });

  it('新增工具名零提及 → blocking（missingNew 含该名）', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'README.md'), '# 项目\n');
    const r = await runContractGate(dir, ['brand_new_tool'], []);
    expect(r.ok).toBe(false);
    expect(r.missingNew).toEqual(['brand_new_tool']);
    rmForce(dir);
  });

  it('新增工具名在 README 有提及 → ok', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'README.md'), '# 项目\n用 `cool_tool` 处理。\n');
    const r = await runContractGate(dir, ['cool_tool'], []);
    expect(r.ok).toBe(true);
    expect(r.missingNew).toEqual([]);
    rmForce(dir);
  });

  it('消失工具名残留于 README → blocking（residueList）', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'README.md'), '# 项目\n请先用 `old_tool` 渲染。\n');
    const r = await runContractGate(dir, [], ['old_tool']);
    expect(r.ok).toBe(false);
    expect(r.residueList.some((x) => x.name === 'old_tool')).toBe(true);
    rmForce(dir);
  });

  it('代码里只有符号调用（无字符串/注释提及旧名）→ 不算残留（AST 收敛）', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'src/app.ts'), 'oldTool(1); // 纯调用\nlet x = old_tool;\n');
    const r = await runContractGate(dir, [], ['old_tool']);
    // 符号名 oldTool/变量名 old_tool 不落字符串/注释文案 → 不算残留
    expect(r.residueList.filter((x) => x.name === 'old_tool')).toEqual([]);
    rmForce(dir);
  });

  it('代码字符串/注释文案残留旧名 → 算残留（AST 捕获文案）', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'src/util.ts'), 'const msg = "工具 old_tool 已废弃";\n');
    const r = await runContractGate(dir, [], ['old_tool']);
    expect(r.residueList.some((x) => x.name === 'old_tool')).toBe(true);
    rmForce(dir);
  });

  it('历史记录（docs/tool-convergence.md）里的旧名 → 不拦', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'docs', 'tool-convergence.md'), '# 决策记录\n曾用 old_tool，后改 new_tool。\n');
    const r = await runContractGate(dir, [], ['old_tool']);
    expect(r.residueList.some((x) => x.name === 'old_tool' && x.file.includes('tool-convergence'))).toBe(false);
    rmForce(dir);
  });

  it('同步后（README 更新到新名）→ ok', async () => {
    const dir = mkRoot();
    writeFileSync(path.join(dir, 'README.md'), '# 项目\n用 `new_tool`。\n');
    const r = await runContractGate(dir, ['new_tool'], ['old_tool']);
    expect(r.ok).toBe(true);
    rmForce(dir);
  });
});