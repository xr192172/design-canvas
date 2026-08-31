/**
 * impact_report 影响报告测试（watch Step 2）
 *
 * 覆盖：
 *   - runImpactReport：生成 + 落盘 + 摘要行格式（一行、含序号/变更数/波及统计）
 *   - 序号递增：连续生成 seq +1；进程重启语义（从目录扫描续增）
 *   - readImpactReport：按序号读回全文；不存在抛错
 *   - listImpactReports：新→旧；无报告返回空
 *   - diffImpact feature 缺省：纯缓存分析不抛错（无 DSL 映射）
 *   - watch 集成（真实 fs.watch）：impact_on_change=true → 改文件 → status 带 alerts 摘要行
 *     → action=impact 取回全文（含波及文件）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import { runImpactReport, readImpactReport, listImpactReports } from '../../src/tools/impact_report';
import { diffImpact } from '../../src/tools/diff_impact';
import { importProject } from '../../src/tools/import_project';
import { openDb } from '../../src/db/db';
import { watchProjectTool, closeAllActiveWatches } from '../../src/tools/watch_project_tool';
import { setGlobalProbeSink, loadTSEvents } from '../../src/observe/probe';
import { judgeEvent } from '../../src/observe/judge';

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

/** 三文件调用图项目（b 被 a 调用，a 被 c 调用）+ 符号缓存 */
async function makeProject(feature: string): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-report-'));
  roots.push(root);
  put(root, 'src/a.ts', `import { helperB } from './b';\n\nexport function mainA(x: number): number {\n  return helperB(x);\n}\n`);
  put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 2;\n}\n`);
  put(root, 'src/c.ts', `import { mainA } from './a';\n\nexport function mainC(x: number): number {\n  return mainA(x) + 1;\n}\n`);
  const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
  await importProject({ project_dir: root, feature, cache_db: db });
  db.close();
  return root;
}

describe('impact_report 生成/落盘/读取', () => {
  it('runImpactReport 生成摘要行并落盘，readImpactReport 读回全文', async () => {
    const root = await makeProject('ir_roundtrip');
    const s = runImpactReport({ project_dir: root, changed: ['src/b.ts'], direction: 'both' });

    expect(s.seq).toBeGreaterThan(0);
    expect(s.changed_files).toEqual(['src/b.ts']);
    // 摘要行：一行、含序号与统计
    expect(s.summary_line).toContain(`[影响#${s.seq}]`);
    expect(s.summary_line).toContain('src/b.ts');
    expect(s.summary_line).toContain('watch action=impact');
    expect(s.summary_line.split('\n').length).toBe(1);
    // 波及统计：改 b → callers: a（深1）, c（深2）；both 再加 b 的 callee（无）
    expect(s.indirect_files).toBeGreaterThanOrEqual(1);
    expect(s.direct_symbols).toBe(1); // helperB

    const full = readImpactReport(root, s.seq);
    expect(full.summary.seq).toBe(s.seq);
    expect(full.message).toContain('=== 变更影响分析');
    expect(full.message).toContain('src/a.ts'); // callers 波及
    // 落盘文件存在且命名规范
    expect(fs.existsSync(path.join(root, '.design-canvas', 'impact', `rp-${String(s.seq).padStart(6, '0')}.json`))).toBe(true);
  });

  it('序号连续递增；listImpactReports 新→旧', async () => {
    const root = await makeProject('ir_seq');
    const s1 = runImpactReport({ project_dir: root, changed: ['src/a.ts'] });
    const s2 = runImpactReport({ project_dir: root, changed: ['src/b.ts'] });
    expect(s2.seq).toBe(s1.seq + 1);

    const list = listImpactReports(root, 10);
    expect(list.map((m) => m.seq)).toEqual([s2.seq, s1.seq]);
  });

  it('readImpactReport 不存在的序号抛可行动错误', async () => {
    const root = await makeProject('ir_missing');
    expect(() => readImpactReport(root, 999999)).toThrow(/影响报告 #999999 不存在/);
  });

  it('listImpactReports 无报告返回空数组', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ir-empty-'));
    roots.push(root);
    expect(listImpactReports(root)).toEqual([]);
  });

  it('diffImpact feature 缺省：纯缓存分析可用（消息头用项目名）', async () => {
    const root = await makeProject('ir_nofeature');
    const r = diffImpact({ project_dir: root, changed: ['src/b.ts'], direction: 'callers' });
    expect(r.impacted_files.map((f) => f.path)).toContain('src/a.ts');
    expect(r.message).toContain(path.basename(root));
    // 无 DSL 映射：dsl_node_id 缺省不炸
    expect(r.impacted_files.every((f) => f.dsl_node_id === undefined || typeof f.dsl_node_id === 'string')).toBe(true);
  });
});

describe('watch 集成：impact_on_change 自动报告', () => {
  it(
    '改文件 → status 带摘要 alerts → action=impact 取全文',
    async () => {
      const root = await makeProject('ir_watch');
      setGlobalProbeSink(null); // 隔离：清掉先前可能的 sink，lazy sink 应指向本项目
      const start = await watchProjectTool({
        project_dir: root,
        feature: 'ir_watch',
        impact_on_change: true,
        rebuild_on_change: false, // 只测影响报告，不触发全量重建
        debounce_ms: 50,
        rebuild_window_ms: 300,
      });
      expect(start.watching).toBe(true);
      expect(start.impact_on_change).toBe(true);

      // 真实修改文件（内容变化才会重解析；watch 增量同步 cache 后触发 doWork）
      put(root, 'src/b.ts', `export function helperB(x: number): number {\n  return x * 3;\n}\n`);

      // 轮询等待：debounce(50ms) + throttle 窗口(300ms) + doWork，5s 内应出报告
      let status: Awaited<ReturnType<typeof watchProjectTool>> | undefined;
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = await watchProjectTool({ project_dir: root, action: 'status' });
        if (status.alerts && status.alerts.length > 0) break;
      }
      expect(status?.alerts).toBeDefined();
      expect(status!.alerts!.length).toBeGreaterThan(0);
      const line = status!.alerts![0];
      expect(line).toMatch(/\[影响 #\d+\]|\[影响#\d+\]/);
      expect(line).toContain('src/b.ts');

      const seq = status!.last_impact_seq!;
      expect(seq).toBeGreaterThan(0);

      // 取全文
      const full = await watchProjectTool({ project_dir: root, action: 'impact', seq });
      expect(full.message).toContain('=== 变更影响分析');
      expect(full.message).toContain('src/a.ts'); // callers

      // Step 3 合流：影响事件应已注入 Observe 事件流（lazy sink → 项目级 events.jsonl）
      const eventsPath = path.join(root, '.design-canvas', 'observe', 'events.jsonl');
      expect(fs.existsSync(eventsPath)).toBe(true);
      const { events } = loadTSEvents(eventsPath);
      const impactEvents = events.filter((e) => e.probe === 'impact.report');
      expect(impactEvents.length).toBeGreaterThanOrEqual(1);
      const ie = impactEvents[0];
      expect(ie.fields['seq']).toBe(seq);
      expect(ie.fields['summary']).toContain(`[影响#${seq}]`);
      expect(ie.fields['file']).toBe('src/b.ts'); // observe_log 按文件过滤的锚点
      // 判定：3 文件项目半径远小于阈值 → ok；serve SSE 同此判定不会误报
      const v = judgeEvent(ie);
      expect(v.result).toBe('ok');

      await watchProjectTool({ project_dir: root, action: 'stop' });
    },
    20000,
  );
});
