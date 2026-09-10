/**
 * memory_observe —— 外部进程内存观测工具（对象是"另一个" Node 进程，不是自己）。
 *
 * 定位：开发期对 DSH gen / 任意 node 进程做内存诊断。它通过 Chrome DevTools Protocol
 * (CDP) 从**外部**挂到目标进程（需该进程以 `--inspect=<port>` 启动），做采样/基线/追踪/
 * 强制 GC / heap snapshot —— 不必往被观测进程里塞插件，observer ≠ subject。
 *
 * 动作（一次调用覆盖"基线→追踪→触发→快照"这条通用检测壳）：
 *   status   → 一次性内存构成（RSS / V8 heap / external / arrayBuffers + 是否可强制 GC）
 *   baseline → 记基线，后续 track/gc 才有可比对象
 *   track    → 对比基线报增量 + 增长率 + 泄漏方向（JS 堆 vs native）
 *   gc       → 目标进程 Runtime.evaluate 调 global.gc()（需目标带 --expose-gc）判断瞬时/泄漏
 *   snapshot → HeapProfiler.takeHeapSnapshot 收集落盘，供 heap diff
 *
 * CDP 传输：Node >= 22 用全局 WebSocket；更老运行时回退动态 import('ws')。
 * 目标解析：target 直接给目标进程的 --inspect 端口；可用配套 memory_targets 工具自动列出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

/** 字节→MB，四舍五入 */
const MB = (b: number | undefined): number => Math.round((b ?? 0) / 1048576);

/** 单份内存采样 */
interface MemSample {
  t: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  usedHeap: number;
  heapLimit: number;
  canGc: boolean;
}

/** 跨调用基线（key = `--inspect` 端口） */
const baselines = new Map<string, MemSample>();

/** 取一个可用的 WebSocket 构造器：优先全局（Node>=22），否则动态 import ws。 */
async function getWsCtor(): Promise<new (url: string) => any> {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.WebSocket === 'function') return g.WebSocket as new (url: string) => any;
  try {
    const mod = nodeRequire('ws') as { default?: unknown };
    return (mod.default ?? mod) as unknown as new (url: string) => any;
  } catch {
    throw new Error('memory_observe 需要全局 WebSocket（Node>=22）或安装 ws 依赖；当前运行时两者皆无。');
  }
}

/** 极简 CDP JSON-RPC WebSocket 客户端。 */
interface CdpClient {
  send(method: string, params?: object): Promise<any>;
  on(method: string, cb: (params: any) => void): void;
  close(): void;
}

async function connectCdp(inspectPort: number): Promise<CdpClient> {
  const listRes = await fetch(`http://127.0.0.1:${inspectPort}/json/list`).catch((e) => {
    throw new Error(`无法访问目标进程 CDP 列表 http://127.0.0.1:${inspectPort}/json/list（${e.message}）`);
  });
  if (!listRes.ok) throw new Error(`目标端口 ${inspectPort} 的 /json/list 返回 ${listRes.status}（确认该进程带 --inspect 启动了？）`);
  const list = (await listRes.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
  const target = list.find((t) => t.type === 'node') ?? list[0];
  const wsUrl = target?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error(`端口 ${inspectPort} 的 CDP 没有可用 ws 端点`);
  const WS = await getWsCtor();
  const ws = new WS(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = (): void => resolve();
    ws.onerror = (e: { message?: string }): void => reject(new Error('CDP ws 连接失败: ' + (e?.message ?? '未知')));
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, (p: any) => void>();
  ws.onmessage = (ev: { data: unknown }): void => {
    const m = JSON.parse(String(ev.data));
    if (typeof m.id === 'number' && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message ?? 'CDP 命令失败'));
      else p.resolve(m.result);
    } else if (m.method && listeners.has(m.method)) {
      (listeners.get(m.method) as (p: any) => void)(m.params ?? {});
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        pending.delete(id);
        reject(e as Error);
      }
    });
  const on = (method: string, cb: (params: any) => void): void => {
    listeners.set(method, cb);
  };
  const close = (): void => {
    try {
      ws.close();
    } catch {
      /* 忽略 */
    }
  };
  return { send, on, close };
}

/** 目标进程内 evaluate 一个返回 JSON 字符串的表达式，解析回对象。 */
async function evalJson(c: CdpClient, expression: string): Promise<any> {
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('目标进程 evaluate 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  const v = r.result?.value;
  if (typeof v !== 'string') throw new Error('目标进程 evaluate 未返回 JSON 字符串');
  return JSON.parse(v);
}

/** 目标进程内存全量表达式（单次 evaluate 拿下 mem + heap stats + gc 可用性）。 */
const MEM_EXPR = `(()=>{const m=process.memoryUsage();const h=process.getHeapStatistics?process.getHeapStatistics():null;return JSON.stringify({t:Date.now(),rss:m.rss,heapUsed:m.heapUsed,heapTotal:m.heapTotal,external:m.external,arrayBuffers:m.arrayBuffers??0,usedHeap:h?(h.used_heap_size??0):0,heapLimit:h?(h.heap_size_limit??0):0,canGc:typeof globalThis.gc==='function'})})()`;

async function sample(c: CdpClient): Promise<MemSample> {
  return (await evalJson(c, MEM_EXPR)) as MemSample;
}

function fmt(s: MemSample, t0: number): string {
  return `t+${Math.max(0, Math.round((s.t - t0) / 1000))}s RSS=${MB(s.rss)}MB heapTotal=${MB(s.heapTotal)}MB heapUsed=${MB(s.heapUsed)}MB external=${MB(s.external)}MB arrayBuffers=${MB(s.arrayBuffers)}MB usedHeap=${MB(s.usedHeap)}MB 可GC=${s.canGc ? 'Y' : 'N(--expose-gc)'}`;
}

/** target 入参解析：数字即视为 --inspect 端口。 */
function resolvePort(target: unknown): number {
  const t = String(target ?? '').trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  throw new Error('target 需为目标进程的 --inspect 端口（纯数字）；如不知道可用 memory_targets 工具列出本机所有 --inspect 进程。');
}

/** HeapProfiler.takeHeapSnapshot 的 chunk 收集并落盘。 */
async function snapshotToFile(c: CdpClient, file: string): Promise<number> {
  await c.send('HeapProfiler.enable');
  const chunks: string[] = [];
  let finished = false;
  let wake: (() => void) | null = null;
  const done = new Promise<void>((resolve) => (wake = resolve));
  c.on('HeapProfiler.heapSnapshotChunk', (p) => {
    if (typeof p.chunk === 'string') chunks.push(p.chunk);
  });
  c.on('HeapProfiler.reportHeapSnapshotProgress', (p) => {
    if (p?.finished) finished = true;
    if (finished && wake) wake();
  });
  await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true });
  // 兜底：取快照完成信号最多等 120s（大堆 stop-the-world 遍历可能数秒~数十秒）
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      finished = true;
      wake?.();
    }, 120_000);
  });
  await Promise.race([done, timeout]);
  const text = chunks.join('');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return text.length;
}

/** memory_observe 主入口：{ message, data }。 */
export async function memoryObserveHandler(args: Record<string, unknown>): Promise<{ message: string; data?: unknown }> {
  const port = resolvePort(args.target);
  const action = String(args.action ?? 'status').toLowerCase();
  const key = String(port);
  const t0 = Date.now();
  const c = await connectCdp(port);
  try {
    const lines: string[] = [];
    let data: Record<string, unknown> = { port };

    if (action === 'baseline') {
      const s = await sample(c);
      baselines.set(key, s);
      lines.push(`[基线已记录 · 端口 ${port}] ${fmt(s, t0)}`);
    } else if (action === 'track') {
      const base = baselines.get(key);
      if (!base) {
        lines.push(`无基线。先调 memory_observe(target=${port}, action=baseline) 记起点。当前：${fmt(await sample(c), t0)}`);
      } else {
        const s = await sample(c);
        const dRss = MB(s.rss - base.rss);
        const dHeap = MB(s.heapUsed - base.heapUsed);
        const dExt = MB(s.external - base.external);
        const dtSec = Math.max(1, Math.round((s.t - base.t) / 1000));
        const rate = MB((s.rss - base.rss) / dtSec);
        lines.push(fmt(s, t0));
        lines.push(`相对基线: RSS ${dRss >= 0 ? '+' : ''}${dRss}MB  heapUsed ${dHeap >= 0 ? '+' : ''}${dHeap}MB  external ${dExt >= 0 ? '+' : ''}${dExt}MB（约 ${dtSec}s → ~${rate}MB/s）`);
        if (dHeap > 16) {
          lines.push(`判定: heapUsed 增 ${dHeap}MB → 疑似 JS 对象堆增长；可 action=gc 确认是否可回收，或 action=snapshot 落盘分析。`);
        } else if (dRss > 32 && dHeap <= 16) {
          lines.push(`判定: RSS 增 ${dRss}MB 但 heapUsed 平稳(${dHeap}MB) → 更可能 native/external(${dExt}MB)/arrayBuffers 侧，V8 heap snapshot 看不到，需盯 external。`);
        } else if (dRss <= 16 && dHeap <= 16) {
          lines.push(`判定: 相对基线基本平稳（RSS ${dRss}MB）→ 无明显增长。`);
        } else {
          lines.push('判定: 温和变化，建议多次 track 累计观察曲线。');
        }
        data = { port, last: s, base };
      }
    } else if (action === 'gc') {
      const b = await sample(c);
      const gcResult = await evalJson(
        c,
        `(()=>{const g=globalThis.gc;const b=process.memoryUsage().heapUsed;if(typeof g==='function')g();const a=process.memoryUsage().heapUsed;return JSON.stringify({available:typeof g==='function',heapBefore:b,heapAfter:a,rssAfter:process.memoryUsage().rss})})()`,
      );
      const base = baselines.get(key);
      lines.push(`[强制GC · 端口 ${port}] 前(heapUsed)=${MB(gcResult.heapBefore)}MB 后=${MB(gcResult.heapAfter)}MB（回收 ${MB(gcResult.heapBefore - gcResult.heapAfter)}MB · RSS=${MB(gcResult.rssAfter)}MB）`);
      if (!gcResult.available) {
        lines.push('目标进程未带 --expose-gc，global.gc() 不可用；请用 --expose-gc 重新拉起该进程。');
      } else if (base && gcResult.heapAfter > base.heapUsed + 16) {
        lines.push(`判定: GC 后 heapUsed 仍高于基线 ${MB(gcResult.heapAfter - base.heapUsed)}MB → 疑似泄漏（被长期持有）。建议 action=snapshot + heap diff 定位持有者。`);
      } else if (base) {
        lines.push(`判定: GC 后回落至基线附近 ${MB(gcResult.heapAfter - base.heapUsed)}MB → 更可能是瞬时工作负载，非泄漏。`);
      } else {
        lines.push('无基线对比；可先 action=baseline 再于跑活后回来 action=gc。');
      }
      data = { port, ...gcResult };
    } else if (action === 'snapshot') {
      lines.push(`[快照 · 端口 ${port}] ${fmt(await sample(c), t0)}`);
      const dir = args.project_dir ? path.join(path.resolve(String(args.project_dir)), '.design-canvas') : process.cwd();
      const file = path.join(dir, `heap-${port}-${Date.now()}.heapsnapshot`);
      const bytes = await snapshotToFile(c, file);
      lines.push(`heap snapshot 已写: ${file}（${(bytes / 1048576).toFixed(1)}MB，用 Chrome DevTools 加载或与另一份做 heap diff）`);
      data = { port, file, bytes };
    } else {
      // status（缺省）
      const s = await sample(c);
      lines.push(fmt(s, t0));
      lines.push(`用 action=baseline 记基线 → action=track/gc 追踪；或 action=snapshot 落盘深入。`);
      data = { port, sample: s };
    }
    return { message: lines.join('\n'), data };
  } finally {
    c.close();
  }
}

/** 列出本机带 --inspect 的 node 进程（Windows：Get-CimInstance；其余用 ps 降级）。 */
export async function memoryTargetsHandler(): Promise<{ message: string; data?: unknown }> {
  const isWin = typeof process !== 'undefined' && process.platform === 'win32';
  let raw = '';
  if (isWin) {
    raw = await new Promise<string>((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--inspect' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"],
        { windowsHide: true, timeout: 15_000 },
        (e, stdout) => resolve(stdout || (e ? '' : '')),
      );
    });
  } else {
    raw = await new Promise<string>((resolve) => {
      execFile('sh', ['-c', "ps -eo pid,command | grep -- '--inspect' | grep -v grep"], { timeout: 10_000 }, (e, stdout) => resolve(stdout || ''));
    });
  }
  const rows: Array<{ pid: string; port: string; pidPort: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const sep = line.indexOf('|');
    if (sep < 0) continue;
    const pid = line.slice(0, sep).trim();
    const cmd = line.slice(sep + 1);
    // --inspect=host:port 或 --inspect=port：取等号后整段，并取最后一节（端口）。
    // 不能只抓等号后第一个数字——那会把 127.0.0.1:32811 的 127 误当端口。
    const m = cmd.match(/--inspect=([^\s"']+)/);
    if (!m || !pid) continue;
    const val = m[1];
    const port = val.includes(':') ? (val.split(':').pop() ?? '') : val;
    if (!port || !/^\d+$/.test(port)) continue;
    rows.push({ pid, port, pidPort: `${pid}:${port}` });
  }
  if (rows.length === 0) {
    return {
      message: '未发现带 --inspect 的 node 进程。请用 --inspect=<port> 启动目标进程（DSH gen 由 switchboard spawner 注入 inspect 端口），再调用 memory_observe。',
      data: [],
    };
  }
  const text =
    rows.map((r) => `pid=${r.pid}  inspect端口=${r.port}  ${r.pidPort}`).join('\n') +
    `\n\n共 ${rows.length} 个。把其中一个 inspect端口 传给 memory_observe 的 target=` +
    (rows[0] ? String(rows[0].port) : '');
  return { message: text, data: rows };
}