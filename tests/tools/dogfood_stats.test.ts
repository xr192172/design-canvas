/**
 * dogfood_stats —— 狗食使用统计（记录/聚合/渲染）测试
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { recordDogfoodUsage, snapshotDogfoodStats, renderDogfoodSnapshot, renderDogfoodSummary } from '../../src/tools/dogfood_stats';

let origHome: string | undefined;
let tmp: string;

beforeAll(() => {
  origHome = process.env.DESIGN_CANVAS_HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dogfood-stats-'));
  process.env.DESIGN_CANVAS_HOME = tmp;
});

afterAll(() => {
  if (origHome === undefined) delete process.env.DESIGN_CANVAS_HOME;
  else process.env.DESIGN_CANVAS_HOME = origHome;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows 文件占用留给 OS
  }
});

describe('recordDogfoodUsage / snapshotDogfoodStats', () => {
  it('记录并聚合：按工具 + 子动作统计成败', () => {
    recordDogfoodUsage({ ts: 'a', tool: 'explore_code', action: 'search', ok: true, ms: 10 });
    recordDogfoodUsage({ ts: 'b', tool: 'explore_code', action: 'search', ok: true, ms: 5 });
    recordDogfoodUsage({ ts: 'c', tool: 'explore_code', action: 'impact', ok: false, ms: 20, err: 'boom' });
    recordDogfoodUsage({ ts: 'd', tool: 'edit_code', action: 'replace', ok: true, ms: 40 });
    recordDogfoodUsage({ ts: 'e', tool: 'render_design', ok: true, ms: 1 });

    const s = snapshotDogfoodStats();
    expect(s.total).toBe(5);

    const ec = s.tools.find((t) => t.tool === 'explore_code')!;
    expect(ec.calls).toBe(3);
    expect(ec.ok).toBe(2);
    expect(ec.failed).toBe(1);
    expect(ec.by_action['search'].calls).toBe(2);
    expect(ec.by_action['search'].ok).toBe(2);
    expect(ec.by_action['impact'].failed).toBe(1);

    const ec2 = s.tools.find((t) => t.tool === 'edit_code')!;
    expect(ec2.by_action['replace'].ok).toBe(1);

    const rd = s.tools.find((t) => t.tool === 'render_design')!;
    expect(rd.by_action['—'].calls).toBe(1);
  });

  it('renderDogfoodSnapshot / renderDogfoodSummary 输出可读文本', () => {
    const s = snapshotDogfoodStats();
    const snap = renderDogfoodSnapshot(s);
    expect(snap).toContain('狗食使用统计');
    expect(snap).toContain('explore_code');
    expect(snap).toContain('成功');
    const sum = renderDogfoodSummary(s);
    expect(sum).toContain('explore_code');
  });

  it('无日志 → 空快照不抛错', () => {
    process.env.DESIGN_CANVAS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dogfood-empty-'));
    const s = snapshotDogfoodStats();
    expect(s.total).toBe(0);
    expect(s.tools.length).toBe(0);
    process.env.DESIGN_CANVAS_HOME = tmp;
  });
});