/**
 * alert_inbox 响应注入收件箱测试（Step 3+ A：拉改推）
 *
 * 覆盖：
 *   - pushAlert/takeAlerts 原子读清语义（投递即已读，二次取空）
 *   - cap 丢最旧（全文已落盘，丢的只是提醒行）
 *   - appendPendingAlerts：无未读原样 / 有未读追加+清空 / watch_project 跳过（自带 piggyback）
 *   - 集成：watch impact_on_change → 改文件 → 任意工具响应文本自动带提醒（一次投递）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import {
  pushAlert,
  takeAlerts,
  peekAlerts,
  clearAlertInbox,
  appendPendingAlerts,
} from '../../src/tools/alert_inbox';
import { watchProjectTool, closeAllActiveWatches } from '../../src/tools/watch_project_tool';
import { importProject } from '../../src/tools/import_project';
import { openDb } from '../../src/db/db';
import { setGlobalProbeSink } from '../../src/camera/probe';

const roots: string[] = [];

afterAll(() => {
  closeAllActiveWatches();
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 文件占用，留给 OS 清理
    }
  }
});

function a(seq: number, project = '/proj/x'): { project_dir: string; seq: number; line: string; created_at: string } {
  return { project_dir: project, seq, line: `[影响#${seq}] src/b.ts 改 1 → 波及 2`, created_at: '2026-08-17T00:00:00Z' };
}

describe('alert_inbox · 收件箱语义', () => {
  beforeEach(() => clearAlertInbox());

  it('takeAlerts 原子读清：取走后箱空，二次取空数组', () => {
    pushAlert(a(1));
    pushAlert(a(2));
    const first = takeAlerts();
    expect(first.map((x) => x.seq)).toEqual([2, 1]); // 新在前
    expect(takeAlerts()).toEqual([]);
    expect(peekAlerts()).toEqual([]);
  });

  it('cap 10：超出丢最旧', () => {
    for (let i = 1; i <= 12; i++) pushAlert(a(i));
    const got = takeAlerts();
    expect(got.length).toBe(10);
    expect(got[0].seq).toBe(12); // 最新保留
    expect(got[9].seq).toBe(3); // 1、2 被丢
  });
});

describe('alert_inbox · appendPendingAlerts（分发中间件）', () => {
  beforeEach(() => clearAlertInbox());

  it('无未读 → 原样返回', () => {
    expect(appendPendingAlerts('ok result', 'edit_dsl')).toBe('ok result');
  });

  it('有未读 → 追加提醒块并消费（二次调用原样）', () => {
    pushAlert(a(7));
    const out = appendPendingAlerts('已保存 feature。', 'edit_dsl');
    expect(out).toContain('已保存 feature。');
    expect(out).toContain('[未读影响提醒');
    expect(out).toContain('[影响#7]');
    expect(out).toContain('watch action=impact seq=7');
    // 一次投递即消费
    expect(appendPendingAlerts('next call', 'get_dsl')).toBe('next call');
  });

  it('watch_project 自带 piggyback → 跳过注入且不消费', () => {
    pushAlert(a(9));
    const out = appendPendingAlerts('监听运行中…', 'watch_project');
    expect(out).toBe('监听运行中…'); // 原样
    expect(peekAlerts().length).toBe(1); // 未消费，留给下一个非 watch 调用
  });
});

describe('alert_inbox · watch 集成（真实 fs.watch）', () => {
  it(
    '改文件 → 收件箱收到提醒 → 任意工具响应自动附带',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-inbox-'));
      roots.push(root);
      const put = (rel: string, content: string): void => {
        const abs = path.join(root, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
      };
      put('src/a.ts', `import { b } from './b';\nexport function a(x: number): number { return b(x); }\n`);
      put('src/b.ts', `export function b(x: number): number { return x * 2; }\n`);
      const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
      await importProject({ project_dir: root, feature: 'ai_watch', cache_db: db });
      db.close();

      clearAlertInbox();
      setGlobalProbeSink(null);
      const start = await watchProjectTool({
        project_dir: root,
        impact_on_change: true,
        rebuild_on_change: false,
        debounce_ms: 50,
        rebuild_window_ms: 300,
      });
      expect(start.watching).toBe(true);

      put('src/b.ts', `export function b(x: number): number { return x * 3; }\n`);

      // 轮询等待 doWork 产出报告并入箱（5s 内）
      let inboxGot = false;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        if (peekAlerts().length > 0) {
          inboxGot = true;
          break;
        }
      }
      expect(inboxGot).toBe(true);
      const entry = peekAlerts()[0];
      expect(entry.project_dir).toBe(path.resolve(root));
      expect(entry.line).toContain('src/b.ts');

      // 模拟 LLM 调任意工具（如 get_dsl）：响应尾部自动带提醒
      const injected = appendPendingAlerts('查询完成。', 'get_dsl');
      expect(injected).toContain('[未读影响提醒');
      expect(injected).toContain('src/b.ts');
      // 已投递：下一次调用不再重复
      expect(appendPendingAlerts('again', 'get_dsl')).toBe('again');

      await watchProjectTool({ project_dir: root, action: 'stop' });
    },
    20000,
  );
});
