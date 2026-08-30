/**
 * 结构性摩擦 F（改码→对账需重启）修复回归测试
 *
 * 修复内容：陈旧构建警告（STALE BUILD）改为由 registerAllTools 统一注入，
 * 覆盖全部工具（此前仅 wrap/wrapData 包装的内联主工具有警告，独立工具模块
 * 改码后无提示返回旧逻辑）。
 * 本测试：① staleBuildWarningFor 纯函数全分支；② 统一注入路径覆盖所有注册工具。
 */
import { describe, it, expect } from 'vitest';
import { registerAllTools, TOOL_DEFS, staleBuildWarningFor } from '../src/server_registry';

describe('staleBuildWarningFor（陈旧构建判定纯函数）', () => {
  it('当前 mtime 晚于加载 mtime → 返回重启警告', () => {
    const warn = staleBuildWarningFor(1000, 2000);
    expect(warn).toContain('STALE BUILD');
    expect(warn).toContain('重启');
  });

  it('当前 mtime 不晚于加载 mtime → 空串（进程运行的是最新代码）', () => {
    expect(staleBuildWarningFor(2000, 1000)).toBe('');
    expect(staleBuildWarningFor(1000, 1000)).toBe('');
  });

  it('任一侧 mtime 未知（非编译产物环境）→ 空串，静默禁用', () => {
    expect(staleBuildWarningFor(null, 2000)).toBe('');
    expect(staleBuildWarningFor(1000, null)).toBe('');
    expect(staleBuildWarningFor(null, null)).toBe('');
  });
});

describe('registerAllTools 统一响应注入（摩擦 F）', () => {
  it('全部工具经统一路径注册，且统一注入通道可正常执行（防 wrap 清理后响应破坏）', async () => {
    const captured: Array<{ name: string; cb: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }> = [];
    const fakeServer = {
      registerTool: (name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>) => {
        captured.push({ name, cb });
      },
    };

    registerAllTools(fakeServer as never);

    // 注册覆盖全部 TOOL_DEFS（防漏注册回归）
    expect(new Set(captured.map((c) => c.name))).toEqual(new Set(TOOL_DEFS.map((d) => d.name)));

    // 统一路径逐一执行：无未捕获异常、text 可读；正常态（非 stale）下响应不含 STALE BUILD 标记
    const broken: string[] = [];
    const staleLeak: string[] = [];
    for (const c of captured) {
      try {
        const r = await c.cb({});
        const text = r?.content?.[0]?.text ?? '';
        if (typeof text !== 'string') broken.push(`${c.name}: text 非字符串`);
        if (text.includes('STALE BUILD')) staleLeak.push(`${c.name}: 正常态泄漏 STALE BUILD 标记`);
      } catch (e) {
        broken.push(`${c.name}: 统一路径抛未捕获异常 — ${(e as Error).message}`);
      }
    }
    expect(broken, `统一注入路径故障：\n${broken.join('\n')}`).toEqual([]);
    // 正常态（进程加载后 dist 未重建）不应出现 STALE BUILD —— 若 wrap 残留重复追加会在此暴露
    expect(staleLeak, `重复/泄漏注入：\n${staleLeak.join('\n')}`).toEqual([]);
  });
});
