/**
 * run_trace_replay：从录制帧（runs.jsonl，go-observe 的 WithRunRecorder 产出）
 * 重建"一次操作"的调用树，供逐步回放。
 *
 * 每行是带 trace_id / frame_id / parent_id 的 enter/exit/catch 帧：
 *   - 同一 trace_id = 同一次操作（一条调用链）
 *   - frame_id = 每次函数调用一帧；parent_id 指向调用者帧（0=根）
 *   - 同一帧的 `.enter`(带入参 fields) 与 `.exit`(带 dur_ms) 合并成一步
 *
 * 输出：RunTrace[] —— 每个 trace 一棵 RunTreeNode 树（func/入参/耗时/时间 + 子节点）。
 * 仅供逐步回放消费；不做任何伪造（缺 enter 或缺 exit 如实各帧标记）。
 */
export interface RunFrame {
  frame_id: number;
  parent_id: number;
  /** 基础探针名（剥掉 .enter/.exit/.catch 后缀），如 "order.Place" */
  probe: string;
  /** enter 帧的 fields（入参等）；无 enter 帧则 undefined */
  in: unknown;
  /** exit 帧的 fields（含 dur_ms）；无 exit 帧则 undefined */
  out: unknown;
  dur_ms: number;
  /** 帧开始时间（epoch ms），enter 帧时间；无则近似 */
  start_ms: number;
  /** 合并时是否缺 enter / 缺 exit（诚实标注，不合成值） */
  missingIn?: boolean;
  missingOut?: boolean;
}

export interface RunTreeNode extends RunFrame {
  children: RunTreeNode[];
}

export interface RunTrace {
  trace_id: string;
  frames: number;
  root: RunTreeNode;
}

interface RawEvent {
  probe?: string;
  time?: string;
  source?: string;
  fields?: Record<string, unknown>;
  trace_id?: string;
  frame_id?: number;
  parent_id?: number;
}

/** 剥探针名后缀 → 基础名 */
function baseProbe(p: string): string {
  for (const s of ['.enter', '.exit', '.catch']) {
    if (p.endsWith(s)) return p.slice(0, -s.length);
  }
  return p;
}

/** 从 JSONL 文本列表出所有帧事件（仅 frame_id>0 的 scope 帧），按 trace 分组并合并 enter/exit。 */
export function parseRunTraces(jsonl: string): RunTrace[] {
  const framesByTrace = new Map<string, RunFrame[]>();
  for (const line of jsonl.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: RawEvent;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!ev.probe || !ev.trace_id || !ev.frame_id || ev.frame_id <= 0) continue;
    const isEnter = ev.probe.endsWith('.enter');
    const isExit = ev.probe.endsWith('.exit');
    if (!isEnter && !isExit) continue; // catch/其他 不构成"一步"，跳过
    const frame: RunFrame = {
      frame_id: ev.frame_id,
      parent_id: ev.parent_id ?? 0,
      probe: baseProbe(ev.probe),
      in: undefined,
      out: undefined,
      dur_ms: 0,
      start_ms: ev.time ? new Date(ev.time).getTime() : 0,
    };
    if (isEnter) {
      frame.in = ev.fields ?? undefined;
      frame.start_ms = ev.time ? new Date(ev.time).getTime() : 0;
    } else {
      frame.out = ev.fields ?? undefined;
      const d = ev.fields?.dur_ms;
      frame.dur_ms = typeof d === 'number' ? d : 0;
    }
    let list = framesByTrace.get(ev.trace_id);
    if (!list) { list = []; framesByTrace.set(ev.trace_id, list); }
    list.push(frame);
  }

  const out: RunTrace[] = [];
  for (const [trace_id, frames] of framesByTrace) {
    // 按 frame_id 合并 enter/exit（同一帧两半 → 一步）
    const merged = new Map<number, RunFrame>();
    for (const fr of frames) {
      const existing = merged.get(fr.frame_id);
      if (!existing) {
        // 先入为 enter（start/in）；后到的若带 out → 补 exit。
        merged.set(fr.frame_id, { ...fr });
      } else {
        if (fr.in !== undefined) { existing.in = fr.in; existing.start_ms = fr.start_ms; }
        if (fr.out !== undefined) { existing.out = fr.out; existing.dur_ms = fr.dur_ms; }
      }
    }
    // 诚实标注：只有 enter 或只有 exit 的帧
    const enterOnly = new Set<number>();
    const exitOnly = new Set<number>();
    for (const [id, m] of merged) {
      const hasIn = m.in !== undefined;
      const hasOut = m.out !== undefined;
      if (!hasIn) exitOnly.add(id);
      if (!hasOut) enterOnly.add(id);
    }

    // 建节点 + 挂 children（parent_id 指向）
    const nodes = new Map<number, RunTreeNode>();
    for (const m of merged.values()) {
      nodes.set(m.frame_id, {
        ...m,
        missingIn: exitOnly.has(m.frame_id),
        missingOut: enterOnly.has(m.frame_id),
        children: [],
      });
    }
    let root: RunTreeNode | null = null;
    for (const n of nodes.values()) {
      if (n.parent_id > 0 && nodes.has(n.parent_id)) {
        nodes.get(n.parent_id)!.children.push(n);
      } else if (root === null) {
        root = n;
      }
    }
    if (!root) continue;
    // 子节点按 frame_id 排序（enter 顺序 = 时间序）
    const sortRec = (n: RunTreeNode) => { n.children.sort((a, b) => a.frame_id - b.frame_id); n.children.forEach(sortRec); };
    sortRec(root);
    out.push({ trace_id, frames: merged.size, root });
  }
  out.sort((a, b) => a.root.start_ms - b.root.start_ms);
  return out;
}

/** 从文件读 runs.jsonl → 调用树列表（可供"选操作"）。 */
export function loadRunTracesFromText(text: string): RunTrace[] {
  return parseRunTraces(text);
}