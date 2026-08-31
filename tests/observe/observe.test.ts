/**
 * Observe TS 接入试点测试：验证「TS 探针埋点 → TS 哨兵判定」与 Go 契约语义对齐。
 *
 * 对齐基准：Go 侧 comparator_test.go / contract.go（silent-error-discard 三类偏差、
 * op 语义：remove 仅 benign 良性；writefile/save/mkdirall 任何 err 非良性）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TSProbeCapture,
  loadTSEvents,
  TSComparator,
  silentErrorDiscardTS,
  renderTSDiffReport,
} from '../../src/observe';
import type { TSEvent } from '../../src/observe';

let dir: string;
let eventsPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-ts-'));
  eventsPath = TSProbeCapture.pathFor(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('TSProbeCapture - 探针端口', () => {
  it('emit 应追加写符合 Event schema 的 JSONL 行并自动补 time', () => {
    const p = new TSProbeCapture(eventsPath);
    const ev = p.emit('save.writefile', { op: 'writefile', err: null });
    expect(ev.probe).toBe('save.writefile');
    expect(ev.time).toBeTruthy();
    expect(ev.source).toBe('static-rule');
    expect(ev.fields['op']).toBe('writefile');

    p.emit('save.writefile', { op: 'writefile', err: 'ENOENT' }, 'llm-design');
    const { events, skipped } = loadTSEvents(eventsPath);
    expect(skipped).toBe(0);
    expect(events).toHaveLength(2);
    expect(events[1].source).toBe('llm-design');
    expect(events[0].fields['err']).toBeNull();
    expect(events[1].fields['err']).toBe('ENOENT');
  });

  it('坏行应被跳过计数而不中断读取', () => {
    const p = new TSProbeCapture(eventsPath);
    p.emit('a.b', { x: 1 });
    fs.appendFileSync(eventsPath, 'not-json\n', 'utf8');
    p.emit('c.d', { y: 2 });
    const { events, skipped } = loadTSEvents(eventsPath);
    expect(events).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('clear 应清空事件文件', () => {
    const p = new TSProbeCapture(eventsPath);
    p.emit('a.b', {});
    p.clear();
    expect(fs.existsSync(eventsPath)).toBe(false);
  });
});

describe('TSComparator - 判定哨兵（与 Go 契约语义对齐）', () => {
  it('三类偏差：unobserved / violated / undesigned', () => {
    const design = {
      version: 1,
      updated_at: new Date().toISOString(),
      decls: [
        { rule: 'design:silent-error-discard', probe: 'save.writefile', expect: 'err 必须 nil 或良性' },
        { rule: 'design:never-run', probe: 'never.touched', expect: '从未观测' },
      ],
    };
    const events: TSEvent[] = [
      { probe: 'save.writefile', time: new Date().toISOString(), fields: { op: 'writefile', err: null } },
      { probe: 'save.writefile', time: new Date().toISOString(), fields: { op: 'writefile', err: 'ENOENT' } },
      { probe: 'new.probe', time: new Date().toISOString(), fields: { x: 1 } },
    ];
    const c = new TSComparator().registerDefaultPredicates();
    const r = c.compare(design, TSComparator.aggregate(events));

    expect(r.violated).toBe(1);
    expect(r.unobserved).toBe(1);
    expect(r.undesigned).toBe(1);
    expect(r.deviations).toHaveLength(3);
    // 稳定排序：unobserved → violated → undesigned
    expect(r.deviations[0].kind).toBe('unobserved');
    expect(r.deviations[1].kind).toBe('violated');
    expect(r.deviations[2].kind).toBe('undesigned');
  });

  it('全局声明覆盖所有探针 → 无未曾声明', () => {
    const design = {
      version: 1,
      updated_at: new Date().toISOString(),
      decls: [{ rule: 'design:global', probe: '', expect: '全局契约' }],
    };
    const events: TSEvent[] = [{ probe: 'anything', time: new Date().toISOString(), fields: { x: 1 } }];
    const c = new TSComparator().registerDefaultPredicates();
    const r = c.compare(design, TSComparator.aggregate(events));
    expect(r.undesigned).toBe(0);
  });
});

describe('silentErrorDiscardTS - op 语义（与 Go contract.go 对齐）', () => {
  it('remove 仅显式 benign 为良性', () => {
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'remove', err: 'not exist', benign: true } }).result).toBe('ok');
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'remove', err: 'not exist' } }).result).toBe('deviation');
  });

  it('writefile/save/mkdirall 任何 err 都非良性', () => {
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'writefile', err: 'ENOENT', benign: true } }).result).toBe('deviation');
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'save', err: 'boom' } }).result).toBe('deviation');
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'mkdirall', err: 'perm' } }).result).toBe('deviation');
  });

  it('err 为 nil/空 → ok', () => {
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'writefile', err: null } }).result).toBe('ok');
    expect(silentErrorDiscardTS({ probe: 'p', time: '', fields: { op: 'writefile' } }).result).toBe('ok');
  });
});

describe('renderTSDiffReport - 人类可读报告', () => {
  it('无偏差时输出一致提示', () => {
    const r = new TSComparator().compare(
      { version: 1, updated_at: '', decls: [{ rule: 'r', probe: 'a', expect: 'e' }] },
      [{ probe: 'a', count: 1, errs: 0, benigns: 0, ops: [], events: [{ probe: 'a', time: '', fields: { err: null } }] }],
    );
    expect(renderTSDiffReport(r)).toContain('一致');
  });
});