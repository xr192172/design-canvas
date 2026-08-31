/**
 * Observe 工具注册测试：验证 observe_log / observe_judge / observe_instrument
 * 已注册进同一套 MCP server_registry，且行为正确（复用 observe/* 纯函数）。
 *
 * 验证点：
 *   1. 三个 camera_* 工具都在 TOOL_DEFS 中（与 design 主工具并列）。
 *   2. observe_judge：对一批事件判定，返回 total/ok/deviation 汇总。
 *   3. observe_judge：缺 events 参数报错。
 *   4. observe_log：缺 events_file 报错；给不存在文件返回空结果。
 *   5. observe_log：按文件过滤 + all 语义。
 *   6. observe_instrument：dry-run 不写盘；缺 target 报错。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DEFS } from '../../src/server_registry';
import { TSProbeCapture } from '../../src/observe/probe';

/** 从 TOOL_DEFS 取指定主工具的 handler */
function handlerOf(name: string) {
  const def = TOOL_DEFS.find((d) => d.name === name);
  if (!def) throw new Error(`工具 ${name} 不存在`);
  return def.handler;
}

let dir: string;
let eventsFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-mcp-'));
  eventsFile = path.join(dir, 'events.jsonl');
  const cap = new TSProbeCapture(eventsFile);
  cap.emit('save.enter', { op: 'enter', file: 'src/a.ts', level: 'core' });
  cap.emit('save.writefile', { op: 'writefile', file: 'src/a.ts', err: '', level: 'event' });
  cap.emit('save.writefile', { op: 'writefile', file: 'src/b.ts', err: 'EISDIR: illegal', level: 'event' });
  cap.emit('cleanup.rm', { op: 'cleanup', file: 'tmp/x', err: 'ENOENT', benign: true, level: 'event' });
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Observe 工具注册', () => {
  it('observe_log/observe_judge/observe_instrument 都在 TOOL_DEFS 中', () => {
    expect(TOOL_DEFS.some((d) => d.name === 'observe_log')).toBe(true);
    expect(TOOL_DEFS.some((d) => d.name === 'observe_judge')).toBe(true);
    expect(TOOL_DEFS.some((d) => d.name === 'observe_instrument')).toBe(true);
  });
});

describe('observe_judge', () => {
  it('对事件数组判定，返回汇总', async () => {
    const r = await handlerOf('observe_judge')({
      events: [
        { probe: 'save.writefile', fields: { op: 'writefile', err: 'EISDIR' } },
        { probe: 'save.writefile', fields: { op: 'writefile', err: '' } },
        { probe: 'cleanup.rm', fields: { op: 'cleanup', err: 'ENOENT', benign: true } },
      ],
    });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(r.text) as { total: number; ok: number; deviation: number };
    expect(data.total).toBe(3);
    expect(data.ok).toBe(2);
    expect(data.deviation).toBe(1);
  });

  it('缺 events 参数报错', async () => {
    const r = await handlerOf('observe_judge')({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('events');
  });
});

describe('observe_log', () => {
  it('缺 events_file 报错', async () => {
    const r = await handlerOf('observe_log')({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('events_file');
  });

  it('不传 files 默认只列偏差', async () => {
    const r = await handlerOf('observe_log')({ events_file: eventsFile });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(r.text.split('---DATA---')[1]) as Array<{ probe: string; result: string }>;
    // 4 事件中只有 writefile err 是偏差
    expect(data).toHaveLength(1);
    expect(data[0].probe).toBe('save.writefile');
    expect(data[0].result).toBe('deviation');
  });

  it('all=true 全量列出，含文件路径', async () => {
    const r = await handlerOf('observe_log')({ events_file: eventsFile, all: true });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(r.text.split('---DATA---')[1]) as Array<{ probe: string; file?: string }>;
    expect(data).toHaveLength(4);
    const bWrite = data.find((e) => e.probe === 'save.writefile' && e.file === 'src/b.ts');
    expect(bWrite).toBeDefined();
  });

  it('按文件过滤只返回命中路径', async () => {
    const r = await handlerOf('observe_log')({ events_file: eventsFile, files: ['src/b.ts'] });
    expect(r.isError).toBeFalsy();
    const data = JSON.parse(r.text.split('---DATA---')[1]) as Array<{ file?: string }>;
    expect(data).toHaveLength(1);
    expect(data[0].file).toBe('src/b.ts');
  });
});

describe('observe_instrument', () => {
  it('缺 target 报错', async () => {
    const r = await handlerOf('observe_instrument')({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain('target');
  });

  it('dry-run 预览不写盘', async () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.ts'), `export function hi() { return 1; }\n`, 'utf-8');
    const before = fs.readFileSync(path.join(proj, 'a.ts'), 'utf-8');
    const r = await handlerOf('observe_instrument')({ action: 'instrument', target: proj, dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('DRY-RUN');
    // dry-run 不改写文件
    expect(fs.readFileSync(path.join(proj, 'a.ts'), 'utf-8')).toBe(before);
  });
});