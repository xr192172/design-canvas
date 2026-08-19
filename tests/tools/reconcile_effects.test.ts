/**
 * reconcile_effects（Phase 2c 动静对账）测试
 *
 * 场景构造：
 *  - DSL 契约（extract_contracts 产物形态）：worker.go 带 writes/holds/emits 候选（origin='ast'）
 *  - 合成 events.jsonl：level=effect 事件——部分命中候选（转正）、部分候选外（incomplete）、
 *    部分候选未触发（保持 ast）；另有非 effect 事件（过滤）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearAllFeatures, saveDSL, getDSL, getLiveDslFile } from '../../src/storage.js';
import { reconcileEffects } from '../../src/tools/reconcile_effects.js';
import type { DesignDSL } from '../../src/dsl/types.js';

let root = '';

function ev(fields: Record<string, unknown>, probe = 'worker.Run.effect', time = '2026-08-20T10:00:00Z'): string {
  return JSON.stringify({ probe, time, source: 'llm-design', fields });
}

beforeEach(() => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-fx-'));
});

afterEach(() => {
  clearAllFeatures();
  const live = getLiveDslFile();
  if (fs.existsSync(live)) fs.unlinkSync(live);
  fs.rmSync(root, { recursive: true, force: true });
});

/** 构造带契约的 DSL：worker.go 候选 = Count(ast)/listen:8080(ast)/chan:done(ast)，
 *  EventLog(ast)（故意不被观测触发） */
function makeDslWithContract(): void {
  const dsl: DesignDSL = {
    feature: 'f_reconcile',
    title: '对账测试',
    geometry: { nodes: [], edges: [] },
    semantic: {
      files: [
        {
          id: 'w1',
          path: 'worker.go',
          responsibility: '工作协程',
          contract: {
            schema_version: 1,
            role: { class: 'functional', basis: 'graph', confidence: 0.7 },
            shapes: { exposes: [], consumes: [] },
            effects: {
              writes: [
                { target: 'Count', op: 'write', origin: 'ast' },
                { target: 'EventLog', op: 'append', origin: 'ast' },
              ],
              holds: [{ target: 'listen:8080', op: 'acquire', origin: 'ast' }],
              emits: ['chan:done'],
              reads_config: [],
            },
          },
        },
      ],
    },
  } as unknown as DesignDSL;
  saveDSL(dsl);
}

function writeEvents(lines: string[]): void {
  const dir = path.join(root, '.agent', 'camera');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events-20260820.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

describe('reconcile_effects - 动静对账', () => {
  it('命中转正 / 候选外补录告警 / 未触发保持 ast / runtime 字段填充', async () => {
    makeDslWithContract();
    writeEvents([
      // 命中：Count 精确匹配 writes 候选
      ev({ level: 'effect', file: 'worker.go', kind: 'write', target: 'Count', op: 'write' }, 'worker.Run.effect', '2026-08-20T10:00:01Z'),
      ev({ level: 'effect', file: 'worker.go', kind: 'write', target: 'Count', op: 'write' }, 'worker.Tick.effect', '2026-08-20T10:00:02Z'),
      // 命中：listen（探针粗粒度）↔ listen:8080（静态候选带端口）
      ev({ level: 'effect', file: 'worker.go', kind: 'hold', target: 'listen', op: 'acquire' }),
      // 命中：chan:done
      ev({ level: 'effect', file: 'worker.go', kind: 'emit', target: 'chan:done', op: 'emit' }),
      // 候选外：ErrClosed 静态扫描漏了 → 补录 + incomplete
      ev({ level: 'effect', file: 'worker.go', kind: 'write', target: 'ErrClosed', op: 'write' }),
      // 非 effect 事件：过滤
      ev({ level: 'core', file: 'worker.go', args: {} }, 'worker.Run.enter'),
      // 坏行：跳过
      '{broken json',
    ]);

    const r = await reconcileEffects({ project_dir: root, feature: 'f_reconcile' });

    expect(r.effect_events).toBe(5);
    expect(r.files).toHaveLength(1);
    const f = r.files[0];
    expect(f.confirmed).toEqual({ writes: 1, holds: 1, emits: 1 });
    expect(f.newly_observed).toEqual([{ kind: 'write', target: 'ErrClosed', op: 'write' }]);
    // EventLog 候选未触发 → 保持 ast（1 个）
    expect(f.unobserved_candidates).toBe(1);
    expect(f.observed_events).toBe(5);
    expect(f.runtime.top_callers[0]).toContain('worker.Run.effect×4');
    expect(r.incomplete).toEqual([{ dsl_path: 'worker.go', kind: 'write', target: 'ErrClosed' }]);

    // DSL 深检
    const dsl = getDSL('f_reconcile')!;
    const c = dsl.semantic!.files[0].contract!;
    const count = c.effects.writes.find((w) => w.target === 'Count')!;
    expect(count.origin).toBe('runtime');
    const eventLog = c.effects.writes.find((w) => w.target === 'EventLog')!;
    expect(eventLog.origin).toBe('ast'); // 未触发不证伪
    const errClosed = c.effects.writes.find((w) => w.target === 'ErrClosed')!;
    expect(errClosed.origin).toBe('runtime'); // 候选外补录
    const listen = c.effects.holds.find((h) => h.target === 'listen:8080')!;
    expect(listen.origin).toBe('runtime'); // 前缀匹配转正
    expect(c.effects.emits).toContain('chan:done');
    expect(c.runtime?.call_count).toBe(5);
    expect(c.runtime?.observed_targets).toContain('Count');
    expect(c.runtime?.last_seen).toBe('2026-08-20T10:00:02Z');
    expect(c.provenance?.last_reconciled).toBeTruthy();
    expect(r.written_to_dsl).toBe(true);
  });

  it('src/ 前缀适配：DSL path=src/worker.go ↔ 事件 file=worker.go', async () => {
    const dsl: DesignDSL = {
      feature: 'f_prefix',
      title: '前缀测试',
      geometry: { nodes: [], edges: [] },
      semantic: {
        files: [
          {
            id: 'w1',
            path: 'src/worker.go',
            responsibility: '工作协程',
            contract: {
              schema_version: 1,
              role: { class: 'functional', basis: 'graph', confidence: 0.7 },
              shapes: { exposes: [], consumes: [] },
              effects: {
                writes: [{ target: 'Count', op: 'write', origin: 'ast' }],
                holds: [],
                emits: [],
                reads_config: [],
              },
            },
          },
        ],
      },
    } as unknown as DesignDSL;
    saveDSL(dsl);
    writeEvents([
      ev({ level: 'effect', file: 'worker.go', kind: 'write', target: 'Count', op: 'write' }),
    ]);

    const r = await reconcileEffects({ project_dir: root, feature: 'f_prefix' });
    expect(r.files).toHaveLength(1);
    expect(r.files[0].confirmed.writes).toBe(1);
  });

  it('无事件文件 / 无 effect 事件：友好提示不写回', async () => {
    makeDslWithContract();
    const r1 = await reconcileEffects({ project_dir: root, feature: 'f_reconcile' });
    expect(r1.effect_events).toBe(0);
    expect(r1.written_to_dsl).toBe(false);
    expect(r1.message).toContain('未发现事件文件');

    fs.mkdirSync(path.join(root, '.agent', 'camera'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.agent', 'camera', 'events.jsonl'),
      ev({ level: 'core', file: 'worker.go' }, 'worker.Run.enter') + '\n',
    );
    const r2 = await reconcileEffects({ project_dir: root, feature: 'f_reconcile' });
    expect(r2.message).toContain('无 level=effect 事件');
  });

  it('write_dsl=false 预演：不写回 DSL', async () => {
    makeDslWithContract();
    writeEvents([
      ev({ level: 'effect', file: 'worker.go', kind: 'write', target: 'Count', op: 'write' }),
    ]);
    const r = await reconcileEffects({ project_dir: root, feature: 'f_reconcile', write_dsl: false });
    expect(r.written_to_dsl).toBe(false);
    const dsl = getDSL('f_reconcile')!;
    const count = dsl.semantic!.files[0].contract!.effects.writes.find((w) => w.target === 'Count')!;
    expect(count.origin).toBe('ast'); // 预演不改 DSL
  });
});
