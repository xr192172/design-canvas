import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryObserveLog } from '../../src/observe/log_query.js';

function writeEvents(file: string, lines: string[]): void {
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

describe('Observe 日志查询 · queryObserveLog', () => {
  let dir: string;
  let eventsPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-log-test-'));
    eventsPath = path.join(dir, 'events.jsonl');
    writeEvents(eventsPath, [
      `{"probe":"a.enter","time":"2026-08-14T10:00:00Z","source":"s","fields":{"file":"src/a.ts","args":{}}}`,
      `{"probe":"b.enter","time":"2026-08-14T10:00:01Z","source":"s","fields":{"file":"src/b.ts","args":{}}}`,
      `{"probe":"aSink.writefile","time":"2026-08-14T10:00:02Z","source":"s","fields":{"file":"src/a.ts","op":"writefile","err":"EACCES","path":"x.json"}}`,
    ]);
  });

  it('事件文件不存在 → 空结果', () => {
    const r = queryObserveLog(path.join(dir, 'nope.jsonl'));
    expect(r.total).toBe(0);
    expect(r.entries).toEqual([]);
  });

  it('按文件过滤：只返回该文件事件，异常判定正确', () => {
    const r = queryObserveLog(eventsPath, { files: ['src/a.ts'] });
    expect(r.total).toBe(2);
    expect(r.anomalyCount).toBe(1);
    const probes = r.entries.map((e) => e.probe);
    expect(probes).toContain('a.enter');
    expect(probes).toContain('aSink.writefile');
    expect(probes).not.toContain('b.enter');
    const anomaly = r.entries.find((e) => e.result === 'deviation');
    expect(anomaly?.rule).toBe('design:silent-error-discard');
    expect(anomaly?.file).toBe('src/a.ts');
  });

  it('文件名片段过滤（b.ts）不串文件', () => {
    const r = queryObserveLog(eventsPath, { files: ['b.ts'] });
    expect(r.total).toBe(1);
    expect(r.entries[0].probe).toBe('b.enter');
  });

  it('未指定文件默认只列偏差', () => {
    const r = queryObserveLog(eventsPath);
    expect(r.total).toBe(3); // 池内事件总数
    expect(r.entries.length).toBe(1); // 只展示偏差
    expect(r.entries.every((e) => e.result === 'deviation')).toBe(true);
  });

  it('未指定文件且 all=true → 全量', () => {
    const r = queryObserveLog(eventsPath, { all: true });
    expect(r.total).toBe(3);
    expect(r.entries.length).toBe(3);
  });
});