/**
 * rename_symbols —— 跨文件符号批量改名测试
 *
 * 覆盖：
 *   - dry_run（默认 false）：先整体 dry-run 校验 + 结构化 diff → 全部可落盘才落盘。
 *   - dry_run=true：只出批量的所有 dry-run diff，不落盘。
 *   - 任一条目被阻断 → 整体不落盘，返回预览报告（含各条 ok/blocked）。
 *   - 重复条目（同 file+symbol）→ 阻断。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameSymbols } from '../../src/tools/rename_symbols';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'drs-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content, 'utf-8');
  }
  return dir;
}

function rmForce(dir: string): void {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 句柄未释放（Windows），稍候重试 */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略最终失败 */
  }
}

describe('renameSymbols - 批量跨文件符号改名', () => {
  it('多个符号一次落盘，previews 含每条 diff，filesWritten 累计', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/b.ts': 'export function beta(a: number) { return a; }\n',
      'src/use.ts': [
        "import { alpha } from './a';",
        "import { beta } from './b';",
        'export function run() { return alpha(1) + beta(2); }',
      ].join('\n'),
    });

    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/b.ts', symbol: 'beta', to: 'beth' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBeUndefined();
    // 累计写入次数：a.ts、b.ts 各 1，use.ts 被两轮各写 1 → 4（并列条目间同一文件可重复计数）
    expect(r.filesWritten).toBe(4);

    // 定义文件改名
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('export function aleph');
    expect(readFileSync(path.join(dir, 'src/b.ts'), 'utf-8')).toContain('export function beth');
    // 共同 importer 双处改
    const use = readFileSync(path.join(dir, 'src/use.ts'), 'utf-8');
    expect(use).toContain("import { aleph } from './a';");
    expect(use).toContain("import { beth } from './b';");
    expect(use).toContain('aleph(1) + beth(2)');

    // previews：每条都带结构化 diff
    expect(r.previews.length).toBe(2);
    expect(r.previews.every((p) => p.ok && p.result!.definition!.ops!.length > 0)).toBe(true);
    // applied：2 条都真落下
    expect(r.applied.length).toBe(2);
    rmForce(dir);
  });

  it('dry_run=true → 只出批量预览 diff，全部不落盘', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/b.ts': 'export function beta(a: number) { return a; }\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/b.ts', symbol: 'beta', to: 'beth' },
      ],
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.filesWritten).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.previews.length).toBe(2);
    expect(r.previews.every((p) => p.ok && p.result!.dryRun === true)).toBe(true);
    // 未落盘
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    expect(readFileSync(path.join(dir, 'src/b.ts'), 'utf-8')).toContain('function beta');
    rmForce(dir);
  });

  it('任一条目被阻断 → 整体不落盘，返回预览报告', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
      'src/c.java': 'public class C { public static void c() {} }\n',
      'src/use.ts': "import { alpha } from './a';\nexport function run() { return alpha(1); }\n",
    });
    // 第二个条目指向 rename_symbol 未支持扩展（Java） → 被阻断
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/c.java', symbol: 'c', to: 'd' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.dryRun).toBe(true); // 整体未落盘
    expect(r.blocked!.some((b) => b.includes('阻断'))).toBe(true);
    // previews 标出第一条可落盘、第二条被阻断
    expect(r.previews[0].ok).toBe(true);
    expect(r.previews[1].ok).toBe(false);
    expect(r.previews[1].blocked!.length).toBeGreaterThan(0);
    // 全部未落盘（即使第一条能过）
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    rmForce(dir);
  });

  it('重复条目（同 file+symbol）→ 阻断', async () => {
    const dir = mkProj({
      'src/a.ts': 'export function alpha(a: number) { return a; }\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [
        { file: 'src/a.ts', symbol: 'alpha', to: 'aleph' },
        { file: 'src/a.ts', symbol: 'alpha', to: 'other' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.blocked!.some((b) => b.includes('重复'))).toBe(true);
    expect(readFileSync(path.join(dir, 'src/a.ts'), 'utf-8')).toContain('function alpha');
    rmForce(dir);
  });

  it('report_literals=true：扫描旧符号 snake 变体的字面量引用（仅报告，不改动）', async () => {
    const dir = mkProj({
      'src/render.ts': 'export function renderDsl(): string { return "v"; }\n',
      'README.md': '# t\n\n请先 render_dsl 渲染，或用 render_dsl 预览。\n',
      'notes.txt': '非扫描扩展，render_dsl 不应计入\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
      report_literals: true,
    });
    expect(r.ok).toBe(true);
    expect(r.literals).toBeDefined();
    const l = r.literals!.find((x) => x.needle === 'render_dsl')!;
    expect(l).toBeDefined();
    expect(l.matches.length).toBeGreaterThan(0);
    // 命中 README.md 的字面量串，且返回行号
    expect(l.matches.some((m) => m.file.endsWith('README.md') && m.line >= 1)).toBe(true);
    // 非扫描扩展（.txt）不纳入
    expect(l.matches.some((m) => m.file.endsWith('notes.txt'))).toBe(false);
    // 仅报告，代码里的字面量未被动
    expect(readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('render_dsl');
    rmForce(dir);
  });

  it('report_literals 缺省：不返回 literals', async () => {
    const dir = mkProj({
      'src/render.ts': 'export function renderDsl(): string { return "v"; }\n',
      'README.md': 'render_dsl 仍在，但不扫\n',
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
    });
    expect(r.ok).toBe(true);
    expect(r.literals).toBeUndefined();
    rmForce(dir);
  });

  it('report_literals 命中按类别分类（contract/docs/history/test）', async () => {
    const dir = mkProj({
      'src/render.ts': 'export function renderDsl(): string { return "v"; }\n',
      'src/server_registry.ts': "const def = { name: 'render_dsl', title: 'x' };\n",
      'README.md': '# t\n请先 render_dsl 渲染。\n',
      'docs/tool-convergence.md': 'render_dsl(旧名) <- render_design(新)\n',
      'tests/use.test.ts': "expect(tool).toBe('render_dsl');\n",
    });
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
      report_literals: true,
    });
    expect(r.ok).toBe(true);
    const l = r.literals!.find((x) => x.needle === 'render_dsl')!;
    expect(l.matches.length).toBeGreaterThan(0);
    const byKind = (k: string) => l.matches.filter((m) => m.kind === k);
    // server_registry 的 name: 注册名 → contract（对外契约）
    expect(byKind('contract').some((m) => m.file.endsWith('server_registry.ts'))).toBe(true);
    // README → docs
    expect(byKind('docs').some((m) => m.file.endsWith('README.md'))).toBe(true);
    // tool-convergence → history（历史记录保留原貌）
    expect(byKind('history').some((m) => m.file.includes('tool-convergence'))).toBe(true);
    // tests/*.test.ts → test
    expect(byKind('test').some((m) => m.file.endsWith('use.test.ts'))).toBe(true);
    rmForce(dir);
  });
});

describe('renameSymbols - apply_literals（补全字面量感知改名闭环）', () => {
  const renderFiles = (extra: Record<string, string> = {}): Record<string, string> => ({
    'src/render.ts': 'export function renderDsl(): string { return "v"; }\n',
    'README.md': '# t\n请先 render_dsl 渲染，或用 render_dsl 预览。\n',
    'src/server_registry.ts': "const def = { name: 'render_dsl', title: 'x' };\n",
    'docs/tool-convergence.md': 'render_dsl(旧名) <- renderDesign(新)\n',
    'tests/use.test.ts': "expect(tool).toBe('render_dsl');\n",
    'src/usage.ts': "const hint = '请用 render_dsl 运行';\n",
    ...extra,
  });

  it('code/docs/test 自动替换；contract/history 保留不写盘；返回决策', async () => {
    const dir = mkProj(renderFiles());
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
      apply_literals: true,
    });
    expect(r.ok).toBe(true);
    // 符号改名照常
    expect(readFileSync(path.join(dir, 'src/render.ts'), 'utf-8')).toContain('function renderDesign');

    const l = r.literals!.find((x) => x.needle === 'render_dsl')!;
    expect(l.toSnake).toBe('render_design');
    const dec = (filePart: string) => l.matches.find((m) => m.file.endsWith(filePart));
    // 决策分层
    expect(dec('README.md')!.decision).toBe('apply');
    expect(dec('use.test.ts')!.decision).toBe('apply');
    expect(dec('usage.ts')!.decision).toBe('apply');
    expect(dec('server_registry.ts')!.decision).toBe('review'); // 契约需人审
    expect(dec('tool-convergence.md')!.decision).toBe('preserve'); // 历史保留

    // docs/test/code 已替换；contract/history 未动
    expect(readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('render_design');
    expect(readFileSync(path.join(dir, 'tests/use.test.ts'), 'utf-8')).toContain('render_design');
    expect(readFileSync(path.join(dir, 'src/usage.ts'), 'utf-8')).toContain('render_design');
    expect(readFileSync(path.join(dir, 'src/server_registry.ts'), 'utf-8')).toContain("'render_dsl'");
    expect(readFileSync(path.join(dir, 'docs/tool-convergence.md'), 'utf-8')).toContain('render_dsl');
    expect(r.literalFilesWritten).toBe(3); // README + use.test + usage
    rmForce(dir);
  });

  it('apply_literals + dry_run=true → 只预览不入盘', async () => {
    const dir = mkProj(renderFiles());
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
      apply_literals: true,
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    // 全都不落盘：符号 + 字面量
    expect(readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('render_dsl');
    expect(readFileSync(path.join(dir, 'src/render.ts'), 'utf-8')).toContain('function renderDsl');
    // 预览里有 apply 决策与替换目标
    const l = r.literals!.find((x) => x.needle === 'render_dsl')!;
    const readme = l.matches.find((m) => m.file.endsWith('README.md'))!;
    expect(readme.decision).toBe('apply');
    expect(readme.old).toBe('render_dsl');
    expect(readme.new).toBe('render_design');
    rmForce(dir);
  });

  it('冻结行保护：命中 .design-canvas.json 标记行 → decision=frozen，不写盘', async () => {
    const dir = mkProj(
      renderFiles({
        '.design-canvas.json': JSON.stringify({ rename: { protect: [{ globs: ['src/usage.*'], markers: ['请用'] }] } }),
      }),
    );
    const r = await renameSymbols({
      project_dir: dir,
      renames: [{ file: 'src/render.ts', symbol: 'renderDsl', to: 'renderDesign' }],
      apply_literals: true,
    });
    expect(r.ok).toBe(true);
    const l = r.literals!.find((x) => x.needle === 'render_dsl')!;
    const usage = l.matches.find((m) => m.file.endsWith('usage.ts'))!;
    expect(usage.decision).toBe('frozen');
    // 冻结行的字面量未被替换；其它 apply 文件照常替换
    expect(readFileSync(path.join(dir, 'src/usage.ts'), 'utf-8')).toContain('render_dsl');
    expect(readFileSync(path.join(dir, 'README.md'), 'utf-8')).toContain('render_design');
    expect(r.literalFilesWritten).toBe(2); // README + use.test
    rmForce(dir);
  });
});