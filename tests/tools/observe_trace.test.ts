import { describe, it, expect } from 'vitest';
import { observeTrace, loadNeedles, loadEventsText } from '../../src/tools/observe_trace';

/** 一段可被 parseRunTraces 解析的录制事件（enter/exit + trace/frame/parent） */
function sampleEvents(): string {
  return [
    { probe: 'svc.handle.enter', trace_id: 't-rep', frame_id: 1, parent_id: 0, time: '2026-01-01T00:00:00.000Z', fields: { file: 'svc.ts', args: { req: 1 } } },
    { probe: 'svc.load.enter', trace_id: 't-rep', frame_id: 2, parent_id: 1, time: '2026-01-01T00:00:00.001Z', fields: { file: 'svc.ts', args: { id: 7 } } },
    { probe: 'svc.load.exit', trace_id: 't-rep', frame_id: 2, parent_id: 1, time: '2026-01-01T00:00:00.002Z', fields: { file: 'svc.ts', dur_ms: 1 } },
    { probe: 'svc.handle.exit', trace_id: 't-rep', frame_id: 1, parent_id: 0, time: '2026-01-01T00:00:00.003Z', fields: { file: 'svc.ts', dur_ms: 3 } },
    { probe: 'other.go.enter', trace_id: 't-plain', frame_id: 3, parent_id: 0, time: '2026-01-01T00:00:00.004Z', fields: { a: 1 } },
    { probe: 'other.go.exit', trace_id: 't-plain', frame_id: 3, parent_id: 0, time: '2026-01-01T00:00:00.005Z', fields: { dur_ms: 1 } },
  ].map((e) => JSON.stringify(e)).join('\n');
}

describe('observe_trace（纯后端 LLM 读回放）', () => {
  it('keep=all 返回全部链路，含根/子挂接与出入参', () => {
    const r = loadNeedles({ events_text: sampleEvents(), keep: 'all' });
    expect(r.total_traces).toBe(2);
    expect(r.kept.length).toBe(2);
    const rep = r.kept.find((k) => k.trace_id === 't-rep')!;
    expect(rep.frames).toBe(2);
    expect(rep.root.probe).toBe('svc.handle');
    expect(rep.root.children.length).toBe(1);
    expect(rep.root.children[0].probe).toBe('svc.load');
    expect(rep.root.children[0].in).toEqual({ file: 'svc.ts', args: { id: 7 } });
  });

  it('keep=default 只留代表针；needly 结构化数据可用', () => {
    const { message, data } = observeTrace({ events_text: sampleEvents() });
    // 默认没 [[KEEP]]/error → 两条都应被采样丢弃 → 无可读链路
    expect(message).toContain('可读链路');
    const d = data as { needles: unknown[] };
    expect(d.needles.length).toBe(0);
  });

  it('trace_id 命中则展开完整调用树（文本 + 结构化）', () => {
    const r = observeTrace({ events_text: sampleEvents(), keep: 'all', trace_id: 't-rep' });
    expect(r.message).toContain('命中链路 t-rep');
    expect(r.message).toContain('svc.handle');
    expect(r.message).toContain('svc.load');
    const d = r.data as { needles: Array<{ trace_id: string; root: { probe: string } }> };
    expect(d.needles.length).toBe(1);
    expect(d.needles[0].trace_id).toBe('t-rep');
    expect(d.needles[0].root.probe).toBe('svc.handle');
  });

  it('trace_id 未命中 → 诚实提示；无 events/build + 默认位置缺失 → 报可操作错误', () => {
    const miss = observeTrace({ events_text: sampleEvents(), keep: 'all', trace_id: 'nope' });
    expect(miss.message).toContain('未命中');
    // 显式 events_path 不存在 → 报可操作错误（与环境无关）
    expect(() => loadEventsText({ events_path: 'Z:/does/not/exist.jsonl' })).toThrow();
  });
});