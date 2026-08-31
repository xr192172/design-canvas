/**
 * reconcile_brick 积木盒动静对账测试（Brick Harvest Phase 3R-C 工具化）
 *
 * 覆盖：
 *   - 候选命中 → origin ast→runtime 转正 + runtime 观测字段
 *   - 候选外新观测 → 补进契约 + incomplete 告警
 *   - 未触发候选 → 保持 ast + gap_notes 归因登记
 *   - 无观测文件 → 全部候选进 unobserved（不算失败）
 *   - write=false 预演 → 不写盘
 *   - manifest.effect_verification 证据档案写入
 *   - hold 泛型名兜底（file-handle ↔ file:*）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { reconcileBrick } from '../../src/tools/reconcile_brick.js';

function writeEvent(file: string, ev: Record<string, unknown>) {
  fs.appendFileSync(file, JSON.stringify(ev) + '\n', 'utf8');
}

/** 构造最小积木盒：contracts.json（两文件）+ manifest.json + 事件 */
function setupBox(t: { name: string }): {
  boxDir: string;
  brickDir: string;
  verifyDir: string;
  eventsFile: string;
} {
  const boxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-box-'));
  const brickDir = path.join(boxDir, 'demo_brick');
  const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-verify-'));
  fs.mkdirSync(brickDir, { recursive: true });
  fs.mkdirSync(path.join(verifyDir, '.agent', 'observe'), { recursive: true });

  const contracts = {
    'internal/store/file.go': {
      effects: {
        writes: [
          { target: 'globalLogger', op: 'write', origin: 'ast' },
          { target: 'file:os.WriteFile', op: 'write', origin: 'ast' },
        ],
        holds: [
          { target: 'file:app.log', op: 'acquire', origin: 'ast' },
          { target: 'goroutine', op: 'acquire', origin: 'ast' },
        ],
        emits: [],
      },
    },
    'internal/store/router.go': {
      effects: {
        writes: [{ target: 'routeTable', op: 'write', origin: 'ast' }],
        holds: [],
        emits: ['chan:events'],
      },
    },
  };
  fs.writeFileSync(path.join(brickDir, 'contracts.json'), JSON.stringify(contracts, null, 2), 'utf8');
  fs.writeFileSync(path.join(brickDir, 'manifest.json'), JSON.stringify({ name: 'demo_brick' }, null, 2), 'utf8');

  const eventsFile = path.join(verifyDir, '.agent', 'observe', 'events-test.jsonl');
  return { boxDir, brickDir, verifyDir, eventsFile };
}

describe('reconcileBrick', () => {
  let setup: ReturnType<typeof setupBox>;

  beforeEach(() => {
    setup = setupBox({ name: 'demo' });
  });

  it('候选命中转正 + 候选外新观测 + 未观测归因 + 证据档案', async () => {
    // file.go：命中 write globalLogger + hold file:app.log；新观测 write counter（静态漏）；
    // goroutine / file:os.WriteFile 未触发
    writeEvent(setup.eventsFile, {
      probe: 'store.Init.enter',
      time: '2026-08-20T10:00:00Z',
      fields: { level: 'effect', file: 'file.go', kind: 'write', target: 'globalLogger', op: 'write' },
    });
    writeEvent(setup.eventsFile, {
      probe: 'store.Open.enter',
      time: '2026-08-20T10:00:01Z',
      fields: { level: 'effect', file: 'file.go', kind: 'hold', target: 'file:app.log', op: 'acquire' },
    });
    writeEvent(setup.eventsFile, {
      probe: 'store.Write.enter',
      time: '2026-08-20T10:00:02Z',
      fields: { level: 'effect', file: 'file.go', kind: 'write', target: 'counter', op: 'write' },
    });

    const r = await reconcileBrick({
      brick_dir: setup.brickDir,
      verify_dir: setup.verifyDir,
      gap_notes: {
        'file.go|goroutine': 'not_triggered：驱动窗口未起 goroutine',
        'file.go|file:os.WriteFile': 'not_triggered：写入走缓冲路径',
      },
      method: '单测模拟事件',
    });

    // stats：file.go 转正 2 + 新观测 1 + 未观测 2；router.go 无观测 → unobserved 1（routeTable）
    expect(r.stats.files_matched).toBe(2);
    expect(r.stats.confirmed).toBe(2);
    expect(r.stats.newly_observed).toBe(1);
    expect(r.stats.unobserved).toBe(3);
    expect(r.written).toBe(true);
    expect(r.incomplete).toEqual([{ brick_path: 'internal/store/file.go', kind: 'write', target: 'counter' }]);

    // contracts.json 转正落盘
    const contracts = JSON.parse(fs.readFileSync(path.join(setup.brickDir, 'contracts.json'), 'utf8'));
    const fileFx = contracts['internal/store/file.go'].effects;
    expect(fileFx.writes.find((w: { target: string }) => w.target === 'globalLogger').origin).toBe('runtime');
    expect(fileFx.holds.find((h: { target: string }) => h.target === 'file:app.log').origin).toBe('runtime');
    expect(fileFx.writes.find((w: { target: string }) => w.target === 'file:os.WriteFile').origin).toBe('ast');
    // 新观测补进契约
    expect(fileFx.writes.find((w: { target: string }) => w.target === 'counter').origin).toBe('runtime');
    // runtime 观测字段
    expect(contracts['internal/store/file.go'].runtime.call_count).toBe(3);

    // manifest.effect_verification 证据档案
    const manifest = JSON.parse(fs.readFileSync(path.join(setup.brickDir, 'manifest.json'), 'utf8'));
    expect(manifest.effect_verification.stats.confirmed).toBe(2);
    expect(manifest.effect_verification.method).toBe('单测模拟事件');
    const filego = manifest.effect_verification.files.find((f: { file: string }) => f.file === 'file.go');
    expect(filego.confirmed).toContain('globalLogger');
    expect(filego.unobserved.find((u: { target: string }) => u.target === 'goroutine')?.note).toContain('not_triggered');
  });

  it('hold 泛型名兜底（file-handle ↔ file:*，旧探针兼容）', async () => {
    writeEvent(setup.eventsFile, {
      probe: 'store.Open.enter',
      time: '2026-08-20T10:00:00Z',
      fields: { level: 'effect', file: 'file.go', kind: 'hold', target: 'file-handle', op: 'acquire' },
    });
    const r = await reconcileBrick({ brick_dir: setup.brickDir, verify_dir: setup.verifyDir });
    expect(r.stats.confirmed).toBe(1);
    const contracts = JSON.parse(fs.readFileSync(path.join(setup.brickDir, 'contracts.json'), 'utf8'));
    expect(contracts['internal/store/file.go'].effects.holds.find((h: { target: string }) => h.target === 'file:app.log').origin).toBe('runtime');
  });

  it('write=false 预演不写盘', async () => {
    writeEvent(setup.eventsFile, {
      probe: 'store.Init.enter',
      time: '2026-08-20T10:00:00Z',
      fields: { level: 'effect', file: 'file.go', kind: 'write', target: 'globalLogger', op: 'write' },
    });
    const r = await reconcileBrick({ brick_dir: setup.brickDir, verify_dir: setup.verifyDir, write: false });
    expect(r.written).toBe(false);
    expect(r.message).toContain('预演未写回');
    const contracts = JSON.parse(fs.readFileSync(path.join(setup.brickDir, 'contracts.json'), 'utf8'));
    expect(contracts['internal/store/file.go'].effects.writes[0].origin).toBe('ast');
  });

  it('无事件文件：明确报错提示前置链', async () => {
    const r = await reconcileBrick({ brick_dir: setup.brickDir, verify_dir: os.tmpdir() + '\\definitely-empty' });
    expect(r.message).toContain('未发现事件文件');
  });

  it('缺 brick_dir/brick_name 报错', async () => {
    await expect(reconcileBrick({})).rejects.toThrow('brick_dir');
  });
});
