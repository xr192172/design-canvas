/**
 * feature_line —— 功能线：把每个功能(DSL feature)搭成一条**可读的主链**（入口函数 → 依次调用 → 关键路径）。
 *
 * 愿景定位：每个功能直接搭一条功能线 —— 点了就能沿线单步运行、看到每步入餐/出餐；也可投大屏监视。
 * 本模块只推导链（纯计算，不执行）：
 *   - 从函数大纲（cache.db 函数+调用边）按功能分组；
 *   - 每功能选一个**入口**：功能内不被本功能函数调用的根（root），否则按名启发（main/run/handle 等）；
 *   - 从入口沿 `calls`（限定本功能内、不重复）贪心走一条主链，产出有序傅近点。
 * 执行/单步入出/投屏由上层（traceExec + 前端视图）负责。
 */
import { buildFunctionOutline, type FunctionOutlineFn } from './function_outline.js';

export interface FeatureLineNode {
  id: string;
  name: string;
  signature?: string;
  file: string;
  line: number;
  feature_id?: string;
  feature_name?: string;
  doc?: string;
}

export interface FeatureLine {
  feature: string;
  entry?: FeatureLineNode;
  chain: FeatureLineNode[];
  note?: string;
}

const ENTRY_HINT = /^(main|run|handle|execute|start|serve|process|entry|work|do|invoke|apply|boot|init)/i;

/** 从已按功能投影好的函数里，为一个功能挑选入口函数。 */
export function pickEntry(fns: FunctionOutlineFn[]): FunctionOutlineFn | undefined {
  if (!fns.length) return undefined;
  const selfIds = new Set(fns.map((f) => f.id));
  // 被本功能函数调用过的 = 非根。从 calls（被调用方）收集。
  const calledHere = new Set<string>();
  for (const f of fns) {
    for (const c of f.calls) if (selfIds.has(c.fn_id)) calledHere.add(c.fn_id);
  }
  const byScore = (f: FunctionOutlineFn): number => {
    const hitName = ENTRY_HINT.test(f.name) ? 1 : 0;
    const isRoot = calledHere.has(f.id) ? 0 : 2;
    const outCalls = f.calls.length;
    return isRoot * 10 + hitName * 5 + Math.min(outCalls, 10);
  };
  const scored = fns.map((f) => ({ f, s: byScore(f) })).sort((a, b) => b.s - a.s);
  return scored[0]?.f;
}

/** 纯函数：从入口沿功能内 calls 走一条主链（不重复、限长）。 */
export function buildMainChain(
  entry: FunctionOutlineFn,
  allFns: FunctionOutlineFn[],
  maxSteps = 24,
): FeatureLineNode[] {
  const byId = new Map(allFns.map((f) => [f.id, f]));
  const selfIds = new Set(allFns.map((f) => f.id));
  const toNode = (f: FunctionOutlineFn): FeatureLineNode => ({
    id: f.id,
    name: f.name,
    signature: f.signature,
    file: f.file,
    line: f.start_line,
    feature_id: f.feature_id,
    feature_name: f.feature_name,
    doc: f.doc,
  });
  const chain: FeatureLineNode[] = [];
  const seen = new Set<string>();
  let cur: FunctionOutlineFn | undefined = entry;
  while (cur && chain.length < maxSteps) {
    const node: FunctionOutlineFn = cur;
    chain.push(toNode(node));
    seen.add(node.id);
    // 主链：优先取"本功能内、未走过、且调用边靠前"的第一个
    const nextRef = (node.calls ?? []).find((c) => selfIds.has(c.fn_id) && !seen.has(c.fn_id));
    cur = nextRef ? byId.get(nextRef.fn_id) : undefined;
  }
  return chain;
}

/** 从函数大纲（已 feature 投影）为一功能推导入口+主链。targetId/targetName 指定功能，缺省取函数最多的功能。 */
export function deriveLineFromFunctions(
  fns: FunctionOutlineFn[],
  opts: { targetId?: string; targetName?: string; maxSteps?: number } = {},
): { line: FeatureLine; chosenFeature: string } {
  const byFeature = new Map<string, FunctionOutlineFn[]>();
  for (const f of fns) {
    const key = f.feature_name || '（未归类）';
    if (!byFeature.has(key)) byFeature.set(key, []);
    byFeature.get(key)!.push(f);
  }
  if (byFeature.size === 0) {
    return { line: { feature: '—', chain: [], note: '无可用功能数据' }, chosenFeature: '—' };
  }
  let cand = byFeature.get(opts.targetName ?? '');
  if (!cand) {
    // 按 feature_id 匹配
    for (const [k, v] of byFeature) {
      if (v[0]?.feature_id === opts.targetId) { cand = v; break; }
    }
  }
  if (!cand) {
    // 取函数最多的一功能作为默认线
    const best = [...byFeature.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    cand = best[1];
  }
  if (!cand) return { line: { feature: '—', chain: [].slice(0), note: '无可用功能数据' }, chosenFeature: '—' };
  const chosenFeature = cand[0]?.feature_name || cand[0]?.feature_id || '—';
  const entry = pickEntry(cand);
  const chain = entry ? buildMainChain(entry, cand, opts.maxSteps) : [];
  return { line: { feature: chosenFeature, entry: entry ? { id: entry.id, name: entry.name, signature: entry.signature, file: entry.file, line: entry.start_line, feature_id: entry.feature_id, feature_name: entry.feature_name, doc: entry.doc } : undefined, chain }, chosenFeature };
}

/** 从缓存+DSL 构建函数大纲并推导功能线。feature 指定项目（其 DSL.feature_tree 给全部函数标记功能）。
 *  target 缺省 → 返回每功能 入口+链长 总览；给出 → 返回该功能入口+主链。 */
export function getFeatureLine(
  feature?: string,
  sourceRoot?: string,
  opts: { target?: string; maxSteps?: number } = {},
): { ok: boolean; line?: FeatureLine; features?: Array<{ feature: string; entry: string; steps: number }>; note?: string } {
  const { ok, outline, note } = buildFunctionOutline(feature, sourceRoot);
  if (!ok) return { ok: false, note: note ?? '函数大纲不可用' };
  const fns = outline.functions;
  if (!fns.length) return { ok: false, note: '该项目暂无可生成功能线的函数数据' };

  if (!opts.target) {
    // 总览：每功能 入口 + 主链长
    const byFeature = new Map<string, FunctionOutlineFn[]>();
    for (const f of fns) {
      const key = f.feature_name || '（未归类）';
      if (!byFeature.has(key)) byFeature.set(key, []);
      byFeature.get(key)!.push(f);
    }
    const features = [...byFeature.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([k, v]) => {
        const ek = pickEntry(v);
        return { feature: k, entry: ek?.name ?? '—', steps: ek ? buildMainChain(ek, v, opts.maxSteps).length : 0 };
      });
    return { ok: true, features };
  }

  const { line, chosenFeature } = deriveLineFromFunctions(fns, { targetName: opts.target, maxSteps: opts.maxSteps });
  return { ok: true, line, note: chosenFeature !== opts.target ? `目标功能未直接命中，已取 ${chosenFeature}` : undefined };
}