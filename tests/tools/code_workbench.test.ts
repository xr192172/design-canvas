/**
 * code_workbench dsl_intent 测试：设计意图改写走审批闸门
 *  - propose 阶段只算意图 diff、不写盘（DSL 未变）
 *  - approve 才调 setDesignIntent 落 goals 到 overlay+base
 *  - reject 只废弃提案，DSL 不变
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDSL, saveDSL } from '../../src/storage.js';
import { proposeChange, approveChange, rejectChange } from '../../src/tools/code_workbench.js';

describe('code_workbench · dsl_intent（设计意图改写审批）', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'cwb_'));
    process.env.DESIGN_CANVAS_HOME = home;
    saveDSL({
      feature: 'f',
      geometry: {
        nodes: [
          { id: 'a', label: 'A', x: 0, y: 0, width: 100, height: 40 },
          { id: 'b', label: 'B', x: 0, y: 0, width: 100, height: 40 },
        ],
        edges: [{ id: 'e1', from: 'a', to: 'b' }],
      },
    });
  });
  afterEach(() => {
    delete process.env.DESIGN_CANVAS_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('propose 只出意图 diff，不写盘（DSL 仍无 goals/meta.goals）', async () => {
    const before = getDSL('f');
    expect((before as any).meta?.goals).toBeUndefined();

    const r = await proposeChange({
      kind: 'dsl_intent',
      project_dir: home,
      op: {
        feature: 'f',
        goals: [{ id: 'g1', title: '统一读端', status: 'active' }],
        edge_intents: [{ from: 'a', to: 'b', reason: 'A 依赖 B 的缓存', boundary: '链路边界' }],
      },
    });
    expect(r.ok).toBe(true);
    expect(r.change.kind).toBe('dsl_intent');
    expect(r.change.status).toBe('pending');
    expect(r.change.summary.some((s) => s.includes('目标 1 条'))).toBe(true);
    // diff 里能看到意图 before/after
    const flat = r.change.diffs.map((d) => [...d.before, ...d.after].join(' '));
    expect(flat.some((t) => t.includes('统一读端'))).toBe(true);
    expect(flat.some((t) => t.includes('A 依赖 B 的缓存'))).toBe(true);

    // 关键：propose 阶段绝不写盘
    const after = getDSL('f') as any;
    expect(after.meta?.goals).toBeUndefined();
  });

  it('approve 才真写 goals 到 DSL（meta.goals 可见），reject 只弃提案不写', async () => {
    const p1 = await proposeChange({
      kind: 'dsl_intent', project_dir: home,
      op: { feature: 'f', goals: [{ id: 'g1', title: '统一读端', status: 'active' }] },
    });
    const id1 = p1.change.id;
    const appr = await approveChange(home, id1);
    expect(appr.ok).toBe(true);
    expect(appr.status).toBe('executed');
    const dsl = getDSL('f') as any;
    expect(dsl.meta?.goals).toBeDefined();
    expect(dsl.meta.goals.length).toBe(1);
    expect(dsl.meta.goals[0].title).toBe('统一读端');

    // reject 一条 → 状态 rejected，且不再新增 goals（仍 1 条）
    const p2 = await proposeChange({
      kind: 'dsl_intent', project_dir: home,
      op: { feature: 'f', goals: [{ id: 'g2', title: '别改这条', status: 'active' }] },
    });
    const rej = await rejectChange(home, p2.change.id);
    expect(rej.ok).toBe(true);
    expect(rej.status).toBe('rejected');
    expect((getDSL('f') as any).meta.goals.map((g: any) => g.title)).toEqual(['统一读端']);
  });
});