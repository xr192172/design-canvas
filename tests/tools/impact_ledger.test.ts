/**
 * Impact Ledger 改前预告闭环测试（Step 3+ B）
 *
 * 项目结构（a→b、c→a、d→b）：
 *   - declare(src/b) → 预期波及 {b,a,c,d}（b 的 callers a/d + c 经 a）
 *   - 改 b → 实际波及 ⊆ 预告 → spread 事件 unexpected 空 → ok（安静）
 *   - declare(src/a) → 预期波及 {a,b,c}（a 的 callees b + callers c；d 不可达）
 *   - 再改 b → 实际波及 {b,a,d,c} → unexpected={d} → deviation（计划外扩散报警）
 *   - 一次消费：声明被报告消费后，后续报告不再对比
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { watchProjectTool, closeAllActiveWatches } from '../../src/tools/watch_project_tool';
import { importProject } from '../../src/tools/import_project';
import { openDb } from '../../src/db/db';
import { setGlobalProbeSink, loadTSEvents } from '../../src/camera/probe';
import { judgeEvent } from '../../src/camera/judge';
import { clearAlertInbox, peekAlerts } from '../../src/tools/alert_inbox';

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

function put(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

/** 四文件调用图：a→b，c→a，d→b（d 是制造"计划外"的关键独立调用方） */
async function makeProject(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-ledger-'));
  roots.push(root);
  put(root, 'src/a.ts', `import { b } from './b';\nexport function a(x: number): number { return b(x); }\n`);
  put(root, 'src/b.ts', `export function b(x: number): number { return x * 2; }\n`);
  put(root, 'src/c.ts', `import { a } from './a';\nexport function c(x: number): number { return a(x) + 1; }\n`);
  put(root, 'src/d.ts', `import { b } from './b';\nexport function d(x: number): number { return b(x) + 2; }\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature: 'ledger', cache_db: db });
  db.close();
  return root;
}

/** 轮询 status 直到 alerts 出现匹配行（或超时） */
async function waitAlert(root: string, match: (line: string) => boolean): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await watchProjectTool({ project_dir: root, action: 'status' });
    if (st.alerts?.some(match)) return st.alerts;
    if (i === 49) console.log('waitAlert 超时诊断:', JSON.stringify({ alerts: st.alerts, error: st.error, message: st.message }));
  }
  throw new Error('5s 内未出现预期 alert');
}

function eventsOf(root: string, probe: string): ReturnType<typeof loadTSEvents>['events'] {
  const p = path.join(root, '.design-canvas', 'camera', 'events.jsonl');
  return loadTSEvents(p).events.filter((e) => e.probe === probe);
}

beforeEach(() => {
  setGlobalProbeSink(null); // 每测重置 lazy sink → 指向当前项目
  clearAlertInbox();
});

describe('Impact Ledger · 改前预告-改后验证闭环', () => {
  it(
    'declare 返回预告面；改预告内文件 → spread ok；计划外波及 → deviation 报警；声明一次消费',
    async () => {
      const root = await makeProject();

      // ① declare(src/b)：预期波及 {a,b,c,d}（b 的 callers a/d，c 经 a 间接）
      const dec = await watchProjectTool({ project_dir: root, action: 'declare', files: ['src/b.ts'] });
      expect(dec.watching).toBe(true); // 未监听自动 start
      expect(dec.impact_on_change).toBe(true); // 影响报告强制开
      expect(dec.message).toContain('已登记改前预告');
      expect(dec.message).toContain('src/b.ts');
      // declare 事件同步落盘 → 直接断言
      expect(eventsOf(root, 'impact.declare').length).toBeGreaterThanOrEqual(1);

      // ② 改 b（预告面内）→ spread unexpected 空 → ok
      put(root, 'src/b.ts', `export function b(x: number): number { return x * 3; }\n`);
      await waitAlert(root, (l) => l.includes('[计划外扩散#'));
      const spreadOk = eventsOf(root, 'impact.spread').at(-1)!;
      expect(spreadOk.fields['unexpected_files']).toEqual([]);
      expect(judgeEvent(spreadOk).result).toBe('ok');

      // ③ declare(src/d)：预期波及 {d,b,a}（图直径 3：d–b–a–c，c 距 d 3 跳不可达 → 不在预告面）
      const dec2 = await watchProjectTool({ project_dir: root, action: 'declare', files: ['src/d.ts'] });
      expect(dec2.message).toContain('已登记改前预告');

      // ④ 再改 b → 实际波及 {b,a,d,c}（b 的 depth2 经 a 到 c）→ c 是计划外扩散
      clearAlertInbox();
      put(root, 'src/b.ts', `export function b(x: number): number { return x * 4; }\n`);
      await waitAlert(root, (l) => l.includes('[计划外扩散#') && l.includes('src/c.ts'));
      const spreadBad = eventsOf(root, 'impact.spread').at(-1)!;
      expect(spreadBad.fields['unexpected_files']).toEqual(['src/c.ts']);
      const v = judgeEvent(spreadBad);
      expect(v.result).toBe('deviation');
      expect(v.rule).toBe('design:impact-unplanned-spread');
      // 计划外扩散直接入响应注入收件箱
      expect(peekAlerts().some((p) => p.line.includes('src/c.ts'))).toBe(true);

      // ⑤ 一次消费：声明已被④消费，再改文件只有 report 无新 spread
      const spreadCountBefore = eventsOf(root, 'impact.spread').length;
      put(root, 'src/c.ts', `import { a } from './a';\nexport function c(x: number): number { return a(x) + 10; }\n`);
      await new Promise((r) => setTimeout(r, 1500)); // 等一轮 doWork
      expect(eventsOf(root, 'impact.spread').length).toBe(spreadCountBefore);

      await watchProjectTool({ project_dir: root, action: 'stop' });
    },
    30000,
  );

  it('declare 缺 files → 温和报错不启动监听', async () => {
    const root = await makeProject();
    const r = await watchProjectTool({ project_dir: root, action: 'declare', files: [] });
    expect(r.error).toContain('files');
    expect(r.watching).toBe(false);
    expect(r.message).toContain('缺少 files');
  });
});
