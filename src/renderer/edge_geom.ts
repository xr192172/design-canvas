/**
 * 边几何纯逻辑单源（服务端渲染 + 浏览器运行时双消费）
 *
 * 不依赖 DOM / DSL 类型，只操作矩形与点，因此可以：
 *   - 被 html_renderer.ts 直接 import（服务端 SSR）
 *   - 被 scripts/gen_anim_core_bundle.mjs 内联进 HTML（运行时拖拽重算）
 *
 * 绕障搜索链（逐级升级，首个零碰撞即返回，全程记录最优尽力解）：
 *   1. 二次贝塞尔：中点控制点 × 候选弯曲幅度
 *   2. 三次贝塞尔（对称）：CP1/CP2 同侧偏移，端点切向控制
 *   3. 端点滑动：出口/入口点沿节点边框滑向角落，改变出射角度
 *   4. 三次贝塞尔（非对称）：CP1/CP2 独立幅度，S 形绕行大型障碍
 *   5. A* 网格 waypoint 路由：贝塞尔族表达不了的窄通道穿行（最终兜底）
 */

export interface GRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GPoint {
  x: number;
  y: number;
}

export interface EdgePathResult {
  /** SVG path d 属性 */
  d: string;
  /** 标签锚点（曲线中点 / 直线中点） */
  cpX: number;
  cpY: number;
}

export interface EdgePathOpts {
  fromBox: GRect;
  toBox: GRect;
  /** from === to 时传 true，画自环小圆弧 */
  selfLoop?: boolean;
  /** 'curve' | 'straight' | 'dashed'，默认 'curve' */
  edgeType?: string;
  /** 同对 (from→to) 多边的垂直退避偏移，默认 0 */
  offset?: number;
  /** 障碍矩形列表；传 undefined 表示不做绕障（如 contains 边） */
  obstacles?: GRect[];
  /** 用户手动拖拽的控制点偏移（相对默认控制点），优先级最高 */
  manualCtrl?: { dx: number; dy: number } | null;
}

/** 端点对（边的起止点，均贴各自节点边框） */
interface Endpoints {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

/** 曲线选择结果 */
interface CurveChoice {
  kind: 'quad' | 'cubic';
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
  hits: number;
}

function centerOf(r: GRect): GPoint {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** 射线 (from→to) 与 rect 边框的交点（rect 中心是 from） */
export function intersectRect(from: GPoint, to: GPoint, rect: GRect): GPoint {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const tX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const tY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(tX, tY);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** 自环边：节点顶部的小圆弧 */
export function selfLoopPath(box: GRect): EdgePathResult {
  const cx = box.x + box.w / 2;
  const topY = box.y;
  const sx = cx - 15;
  const ex = cx + 15;
  const loopH = 50;
  return {
    d: `M ${sx} ${topY} C ${sx - 20} ${topY - loopH} ${ex + 20} ${topY - loopH} ${ex} ${topY}`,
    cpX: cx,
    cpY: topY - loopH,
  };
}

const MARGIN = 10;

function pointHits(x: number, y: number, obstacles: GRect[]): boolean {
  for (const o of obstacles) {
    if (x > o.x - MARGIN && x < o.x + o.w + MARGIN && y > o.y - MARGIN && y < o.y + o.h + MARGIN) {
      return true;
    }
  }
  return false;
}

/** 采样二次贝塞尔曲线，统计与障碍矩形的碰撞样本数 */
export function countQuadHits(
  fx: number, fy: number, cpX: number, cpY: number, tx: number, ty: number,
  obstacles: GRect[],
): number {
  let hits = 0;
  for (let i = 1; i <= 23; i++) {
    const t = i / 24;
    const u = 1 - t;
    const x = u * u * fx + 2 * u * t * cpX + t * t * tx;
    const y = u * u * fy + 2 * u * t * cpY + t * t * ty;
    if (pointHits(x, y, obstacles)) hits++;
  }
  return hits;
}

/** 采样三次贝塞尔曲线，统计与障碍矩形的碰撞样本数 */
export function countCubicHits(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number,
  obstacles: GRect[],
): number {
  let hits = 0;
  for (let i = 1; i <= 23; i++) {
    const t = i / 24;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
    const y = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
    if (pointHits(x, y, obstacles)) hits++;
  }
  return hits;
}

/** 候选弯曲量序列：默认侧、镜像侧，然后双侧逐步加大 */
function offsetCandidates(baseOffset: number): number[] {
  const out = [baseOffset, -baseOffset];
  for (let k = 1; k <= 4; k++) {
    out.push(baseOffset + k * 70);
    out.push(-(baseOffset + k * 70));
  }
  return out;
}

function perpOf(ep: Endpoints): { px: number; py: number; len: number } {
  const dx = ep.ex - ep.sx;
  const dy = ep.ey - ep.sy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  return { px: -dy / len, py: dx / len, len };
}

/** 二次贝塞尔搜索：中点控制点 × 候选幅度，零碰撞即返，否则最优 */
function quadSearch(ep: Endpoints, baseOffset: number, obstacles: GRect[]): CurveChoice {
  const { px, py, len } = perpOf(ep);
  const midX = (ep.sx + ep.ex) / 2;
  const midY = (ep.sy + ep.ey) / 2;
  const maxS = Math.max(len * 0.9, baseOffset);
  let best: CurveChoice = {
    kind: 'quad',
    cp1x: midX + px * baseOffset, cp1y: midY + py * baseOffset,
    cp2x: 0, cp2y: 0, hits: Infinity,
  };
  for (const s of offsetCandidates(baseOffset)) {
    if (Math.abs(s) > maxS) continue;
    const cpX = midX + px * s;
    const cpY = midY + py * s;
    const hits = countQuadHits(ep.sx, ep.sy, cpX, cpY, ep.ex, ep.ey, obstacles);
    if (hits === 0) return { kind: 'quad', cp1x: cpX, cp1y: cpY, cp2x: 0, cp2y: 0, hits: 0 };
    if (hits < best.hits) best = { kind: 'quad', cp1x: cpX, cp1y: cpY, cp2x: 0, cp2y: 0, hits };
  }
  return best;
}

/** 三次贝塞尔搜索（对称：CP1/CP2 同侧同幅度） */
function cubicSymSearch(ep: Endpoints, baseOffset: number, obstacles: GRect[]): CurveChoice {
  const { px, py, len } = perpOf(ep);
  const maxS = Math.max(len * 0.9, baseOffset);
  let best: CurveChoice = {
    kind: 'cubic',
    cp1x: ep.sx + px * baseOffset, cp1y: ep.sy + py * baseOffset,
    cp2x: ep.ex + px * baseOffset, cp2y: ep.ey + py * baseOffset,
    hits: Infinity,
  };
  for (const s of offsetCandidates(baseOffset)) {
    if (Math.abs(s) > maxS) continue;
    const r = evalCubic(ep, px * s, py * s, px * s, py * s, obstacles);
    if (r.hits === 0) return r;
    if (r.hits < best.hits) best = r;
  }
  return best;
}

function evalCubic(
  ep: Endpoints, o1x: number, o1y: number, o2x: number, o2y: number, obstacles: GRect[],
): CurveChoice {
  const cp1x = ep.sx + o1x;
  const cp1y = ep.sy + o1y;
  const cp2x = ep.ex + o2x;
  const cp2y = ep.ey + o2y;
  const hits = countCubicHits(ep.sx, ep.sy, cp1x, cp1y, cp2x, cp2y, ep.ex, ep.ey, obstacles);
  return { kind: 'cubic', cp1x, cp1y, cp2x, cp2y, hits };
}

/** 非对称幅度对缓存（按 |a|+|b| 升序，排除对称对） */
let asymPairsCache: { key: string; pairs: Array<[number, number]> } | null = null;

/** 三次贝塞尔搜索（非对称：CP1/CP2 独立幅度，S 形绕行大障碍） */
function cubicAsymSearch(ep: Endpoints, baseOffset: number, obstacles: GRect[]): CurveChoice {
  const { px, py, len } = perpOf(ep);
  const maxS = Math.max(len * 0.9, baseOffset);
  const cands = offsetCandidates(baseOffset).filter((s) => Math.abs(s) <= maxS);
  const key = cands.join(',');
  let cache = asymPairsCache;
  if (!cache || cache.key !== key) {
    const pairs: Array<[number, number]> = [];
    for (const a of cands) {
      for (const b of cands) {
        if (a === b) continue; // 对称情形已搜过
        pairs.push([a, b]);
      }
    }
    // 小幅度优先（曲线更平缓美观）
    pairs.sort((p, q) => (Math.abs(p[0]) + Math.abs(p[1])) - (Math.abs(q[0]) + Math.abs(q[1])));
    cache = { key, pairs };
    asymPairsCache = cache;
  }
  let best: CurveChoice | null = null;
  for (const [a, b] of cache.pairs) {
    const r = evalCubic(ep, px * a, py * a, px * b, py * b, obstacles);
    if (r.hits === 0) return r;
    if (!best || r.hits < best.hits) best = r;
  }
  return best ?? cubicSymSearch(ep, baseOffset, obstacles);
}

/**
 * 端点沿节点边框滑动：把出口/入口点向"面向对端的角落"推移，
 * 改变出射角度，解决障碍紧贴节点侧边时二次/三次曲线转向不足的问题。
 * pt 必须已在 rect 边框上（intersectRect 的结果）。滑动量为半边长的 70%。
 */
function slidePoint(rect: GRect, pt: GPoint, otherCenter: GPoint): GPoint {
  const eps = 0.5;
  const onTop = Math.abs(pt.y - rect.y) < eps;
  const onBottom = Math.abs(pt.y - (rect.y + rect.h)) < eps;
  const onLeft = Math.abs(pt.x - rect.x) < eps;
  const onRight = Math.abs(pt.x - (rect.x + rect.w)) < eps;
  if (onTop || onBottom) {
    // 水平边：向 otherCenter.x 方向滑
    const targetX = otherCenter.x >= rect.x + rect.w / 2 ? rect.x + rect.w : rect.x;
    return { x: pt.x + (targetX - pt.x) * 0.7, y: pt.y };
  }
  if (onLeft || onRight) {
    const targetY = otherCenter.y >= rect.y + rect.h / 2 ? rect.y + rect.h : rect.y;
    return { x: pt.x, y: pt.y + (targetY - pt.y) * 0.7 };
  }
  return pt;
}

/**
 * 备选边框中点：射线主出口所在维度之外、面向对端的另一条边框的中点。
 * 用于"换边出口"——主出口被障碍堵死时（如障碍紧贴该边框），改从邻边出入。
 */
function altBorderPoint(rect: GRect, otherCenter: GPoint): GPoint {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = otherCenter.x - cx;
  const dy = otherCenter.y - cy;
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const tX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const tY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  if (tY <= tX) {
    // 主出口在顶/底边 → 备选为面向对端的左/右边中点
    return { x: dx >= 0 ? rect.x + rect.w : rect.x, y: cy };
  }
  // 主出口在左/右边 → 备选为面向对端的顶/底边中点
  return { x: cx, y: dy >= 0 ? rect.y + rect.h : rect.y };
}

/** 线段采样碰撞检测（与 pointHits 同 MARGIN，每 8px 一个样本） */
function segmentHits(ax: number, ay: number, bx: number, by: number, obstacles: GRect[]): boolean {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(2, Math.ceil(len / 8));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (pointHits(ax + (bx - ax) * t, ay + (by - ay) * t, obstacles)) return true;
  }
  return false;
}

/** 简易二叉最小堆（A* open 列表，按 f 值排序） */
class MinHeap {
  private f: number[] = [];
  private idx: number[] = [];
  get size(): number {
    return this.f.length;
  }
  push(fv: number, ix: number): void {
    this.f.push(fv);
    this.idx.push(ix);
    let i = this.f.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= this.f[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.idx[0];
    const lastF = this.f.pop()!;
    const lastI = this.idx.pop()!;
    if (this.f.length > 0) {
      this.f[0] = lastF;
      this.idx[0] = lastI;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < this.f.length && this.f[l] < this.f[s]) s = l;
        if (r < this.f.length && this.f[r] < this.f[s]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.f[a], this.f[b]] = [this.f[b], this.f[a]];
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
  }
}

/**
 * A* 网格 waypoint 路由（贝塞尔搜索链失败后的最终兜底）。
 * 流程：网格化障碍（含 MARGIN 膨胀）→ 8 向 A*（禁切角）→ 视线拉直（LOS smoothing）
 * → 拐角圆角化（二次贝塞尔削角）→ 全路径采样校验。
 * 任一环节失败返回 null，由调用方降级到更小网格或尽力而为贝塞尔。
 */
function waypointRoute(ep: Endpoints, obstacles: GRect[], cellSize: number, pad: number): EdgePathResult | null {
  // 边界框只由两端点决定 + pad 环绕（障碍仅用于 blocked 标记，网格外自动裁剪）。
  // 历史上曾把全部障碍纳入包围盒——大图（如 600 节点画布）会把网格撑爆触发上限直接放弃路由。
  let minX = Math.min(ep.sx, ep.ex) - pad;
  let minY = Math.min(ep.sy, ep.ey) - pad;
  let maxX = Math.max(ep.sx, ep.ex) + pad;
  let maxY = Math.max(ep.sy, ep.ey) + pad;
  const cols = Math.ceil((maxX - minX) / cellSize);
  const rows = Math.ceil((maxY - minY) / cellSize);
  if (cols * rows > 400000) return null;

  // 障碍膨胀 MARGIN 后按覆盖范围标记 blocked（远比逐格检测快）
  const blocked = new Uint8Array(cols * rows);
  for (const o of obstacles) {
    const c0 = Math.max(0, Math.floor((o.x - MARGIN - minX) / cellSize));
    const c1 = Math.min(cols - 1, Math.floor((o.x + o.w + MARGIN - minX) / cellSize));
    const r0 = Math.max(0, Math.floor((o.y - MARGIN - minY) / cellSize));
    const r1 = Math.min(rows - 1, Math.floor((o.y + o.h + MARGIN - minY) / cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) blocked[r * cols + c] = 1;
    }
  }
  const clampCell = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  const sc = clampCell(Math.floor((ep.sx - minX) / cellSize), cols);
  const sr = clampCell(Math.floor((ep.sy - minY) / cellSize), rows);
  const ec = clampCell(Math.floor((ep.ex - minX) / cellSize), cols);
  const er = clampCell(Math.floor((ep.ey - minY) / cellSize), rows);
  const startIdx = sr * cols + sc;
  const endIdx = er * cols + ec;
  blocked[startIdx] = 0;
  blocked[endIdx] = 0;

  // A*：8 向移动，对角移动要求两个正交邻居均空闲（防切角穿障）
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const heap = new MinHeap();
  const heur = (idx: number) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    return Math.hypot(c - ec, r - er);
  };
  g[startIdx] = 0;
  heap.push(heur(startIdx), startIdx);
  const DIRS = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  let found = false;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === endIdx) {
      found = true;
      break;
    }
    const cc = cur % cols;
    const cr = Math.floor(cur / cols);
    for (const [dc, dr, cost] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (blocked[ni] || closed[ni]) continue;
      if (dc !== 0 && dr !== 0) {
        if (blocked[cr * cols + nc] || blocked[nr * cols + cc]) continue; // 禁切角
      }
      const ng = g[cur] + cost;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ng + heur(ni), ni);
      }
    }
  }
  if (!found) return null;

  // 回溯原始路径（格中心），首尾替换为精确端点
  const cellCenter = (idx: number): GPoint => ({
    x: minX + (idx % cols + 0.5) * cellSize,
    y: minY + (Math.floor(idx / cols) + 0.5) * cellSize,
  });
  const raw: GPoint[] = [{ x: ep.sx, y: ep.sy }];
  const chain: number[] = [];
  for (let i = endIdx; i !== startIdx && i !== -1; i = came[i]) chain.push(i);
  chain.reverse();
  for (const idx of chain) raw.push(cellCenter(idx));
  raw.push({ x: ep.ex, y: ep.ey });

  // 视线拉直：贪婪跳过中间点，保留必要拐角
  const pts: GPoint[] = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    for (; j > i + 1; j--) {
      if (!segmentHits(raw[i].x, raw[i].y, raw[j].x, raw[j].y, obstacles)) break;
    }
    pts.push(raw[j]);
    i = j;
  }

  // 拐角圆角化 + 全路径采样校验（削角会偏离原折线，需重新验证）
  for (const radius of [16, 6]) {
    const res = buildRoundedPolyline(pts, radius);
    if (res && !pathResultHits(res.segments, obstacles)) {
      const mid = pts[Math.floor(pts.length / 2)];
      return { d: res.d, cpX: mid.x, cpY: mid.y };
    }
  }
  return null;
}

/** 圆角折线构造：每个中间拐点用二次贝塞尔削角；返回 d 与分段（供校验采样） */
function buildRoundedPolyline(
  pts: GPoint[],
  radius: number,
): { d: string; segments: Array<{ kind: 'L' | 'Q'; pts: number[] }> } | null {
  if (pts.length < 2) return null;
  const segments: Array<{ kind: 'L' | 'Q'; pts: number[] }> = [];
  let d = `M ${pts[0].x} ${pts[0].y}`;
  let cursor = pts[0];
  for (let k = 1; k < pts.length - 1; k++) {
    const prev = pts[k - 1];
    const cur = pts[k];
    const next = pts[k + 1];
    const dIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const dOut = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, dIn / 2, dOut / 2);
    if (r < 2) {
      d += ` L ${cur.x} ${cur.y}`;
      segments.push({ kind: 'L', pts: [cursor.x, cursor.y, cur.x, cur.y] });
      cursor = cur;
      continue;
    }
    const p1 = { x: cur.x + ((prev.x - cur.x) / dIn) * r, y: cur.y + ((prev.y - cur.y) / dIn) * r };
    const p2 = { x: cur.x + ((next.x - cur.x) / dOut) * r, y: cur.y + ((next.y - cur.y) / dOut) * r };
    d += ` L ${p1.x} ${p1.y} Q ${cur.x} ${cur.y} ${p2.x} ${p2.y}`;
    segments.push({ kind: 'L', pts: [cursor.x, cursor.y, p1.x, p1.y] });
    segments.push({ kind: 'Q', pts: [p1.x, p1.y, cur.x, cur.y, p2.x, p2.y] });
    cursor = p2;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x} ${last.y}`;
  segments.push({ kind: 'L', pts: [cursor.x, cursor.y, last.x, last.y] });
  return { d, segments };
}

/** 对构造出的分段路径整体采样，验证仍零碰撞 */
function pathResultHits(segments: Array<{ kind: 'L' | 'Q'; pts: number[] }>, obstacles: GRect[]): boolean {
  for (const seg of segments) {
    if (seg.kind === 'L') {
      const [ax, ay, bx, by] = seg.pts;
      if (segmentHits(ax, ay, bx, by, obstacles)) return true;
    } else {
      const [x0, y0, cx, cy, x1, y1] = seg.pts;
      for (let i = 1; i < 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
        const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
        if (pointHits(x, y, obstacles)) return true;
      }
    }
  }
  return false;
}

/** 由曲线选择构造 path；offset（多边退避）：控制点全额偏移，端点 0.3 倍 */
function buildPath(ep: Endpoints, choice: CurveChoice, offset: number): EdgePathResult {
  const { px, py } = perpOf(ep);
  let sx = ep.sx;
  let sy = ep.sy;
  let ex = ep.ex;
  let ey = ep.ey;
  let cp1x = choice.cp1x;
  let cp1y = choice.cp1y;
  let cp2x = choice.cp2x;
  let cp2y = choice.cp2y;
  if (offset !== 0) {
    sx += px * offset * 0.3;
    sy += py * offset * 0.3;
    ex += px * offset * 0.3;
    ey += py * offset * 0.3;
    cp1x += px * offset;
    cp1y += py * offset;
    cp2x += px * offset;
    cp2y += py * offset;
  }
  if (choice.kind === 'quad') {
    return { d: `M ${sx} ${sy} Q ${cp1x} ${cp1y} ${ex} ${ey}`, cpX: cp1x, cpY: cp1y };
  }
  const midX = (sx + 3 * cp1x + 3 * cp2x + ex) / 8;
  const midY = (sy + 3 * cp1y + 3 * cp2y + ey) / 8;
  return { d: `M ${sx} ${sy} C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${ex} ${ey}`, cpX: midX, cpY: midY };
}

/**
 * 统一边路径计算入口。
 * 优先级：自环 > 用户手动控制点 > 绕障搜索链（二次→三次对称→端点滑动→三次非对称）。
 */
export function computeEdgePath(opts: EdgePathOpts): EdgePathResult {
  const { fromBox, toBox } = opts;
  if (opts.selfLoop) return selfLoopPath(fromBox);

  const offset = opts.offset ?? 0;
  const edgeType = opts.edgeType ?? 'curve';

  const fromC = centerOf(fromBox);
  const toC = centerOf(toBox);
  const s0 = intersectRect(fromC, toC, fromBox);
  const e0 = intersectRect(toC, fromC, toBox);
  const base: Endpoints = { sx: s0.x, sy: s0.y, ex: e0.x, ey: e0.y };

  const { px, py, len } = perpOf(base);
  const midX = (base.sx + base.ex) / 2;
  const midY = (base.sy + base.ey) / 2;
  const baseOffset = Math.min(len * 0.25, 80);

  // 1. 用户手动控制点（拖拽边时写入）：始终二次曲线，不做绕障
  if (opts.manualCtrl) {
    const choice: CurveChoice = {
      kind: 'quad',
      cp1x: midX + px * baseOffset + opts.manualCtrl.dx,
      cp1y: midY + py * baseOffset + opts.manualCtrl.dy,
      cp2x: 0, cp2y: 0, hits: 0,
    };
    return buildPath(base, choice, offset);
  }

  const obstacles = opts.obstacles;
  const curved = edgeType === 'curve';

  // 2. 不绕障（contains 边或未提供障碍集合）
  if (!obstacles) {
    if (curved || offset !== 0) {
      const choice: CurveChoice = {
        kind: 'quad',
        cp1x: midX + px * baseOffset, cp1y: midY + py * baseOffset,
        cp2x: 0, cp2y: 0, hits: 0,
      };
      return buildPath(base, choice, offset);
    }
    return { d: `M ${base.sx} ${base.sy} L ${base.ex} ${base.ey}`, cpX: midX, cpY: midY };
  }

  // 3. 绕障模式
  // 端点候选：基准 / 沿边框滑动 / 备选边框中点（换边出口）
  const slidS = slidePoint(fromBox, s0, toC);
  const slidE = slidePoint(toBox, e0, fromC);
  const altS = altBorderPoint(fromBox, toC);
  const altE = altBorderPoint(toBox, fromC);
  const mkEp = (sp: GPoint, ep2: GPoint): Endpoints => ({ sx: sp.x, sy: sp.y, ex: ep2.x, ey: ep2.y });
  const configs: Endpoints[] = [
    base,
    mkEp(slidS, e0),
    mkEp(s0, slidE),
    mkEp(slidS, slidE),
    mkEp(altS, e0),
    mkEp(s0, altE),
    mkEp(altS, slidE),
    mkEp(slidS, altE),
    mkEp(altS, altE),
  ];

  // 直线/dashed 边：任一端点配置直线无碰撞 → 保持直线（最美观）
  if (!curved && offset === 0) {
    const lineHits = (ep: Endpoints) =>
      countQuadHits(ep.sx, ep.sy, (ep.sx + ep.ex) / 2, (ep.sy + ep.ey) / 2, ep.ex, ep.ey, obstacles);
    for (const cfg of configs) {
      if (lineHits(cfg) === 0) {
        const mX = (cfg.sx + cfg.ex) / 2;
        const mY = (cfg.sy + cfg.ey) / 2;
        return { d: `M ${cfg.sx} ${cfg.sy} L ${cfg.ex} ${cfg.ey}`, cpX: mX, cpY: mY };
      }
    }
  }

  // 搜索链：端点配置 ×（二次 → 三次对称），全部失败后三次非对称（限前 4 配置控制成本）
  let best: { ep: Endpoints; choice: CurveChoice } | null = null;
  const note = (ep: Endpoints, choice: CurveChoice) => {
    if (!best || choice.hits < best.choice.hits) best = { ep, choice };
  };

  for (const ep of configs) {
    const q = quadSearch(ep, baseOffset, obstacles);
    if (q.hits === 0) return buildPath(ep, q, offset);
    note(ep, q);
    const c = cubicSymSearch(ep, baseOffset, obstacles);
    if (c.hits === 0) return buildPath(ep, c, offset);
    note(ep, c);
  }
  for (const ep of configs.slice(0, 4)) {
    const a = cubicAsymSearch(ep, baseOffset, obstacles);
    if (a.hits === 0) return buildPath(ep, a, offset);
    note(ep, a);
  }

  // 最终兜底：A* waypoint 路由（窄通道穿行，贝塞尔族表达不了的折线/S 路径）
  // pad 分档扩大（绕行空间不足时放大边界框重试），每档先粗网格后细网格；
  // 成功即返回（offset 退避在此种罕见情形下忽略）
  for (const pad of [150, 400, 1000]) {
    for (const cell of [20, 10]) {
      const routed = waypointRoute(base, obstacles, cell, pad);
      if (routed) return routed;
    }
  }

  // 尽力而为：返回碰撞最少的组合
  return buildPath(best!.ep, best!.choice, offset);
}
