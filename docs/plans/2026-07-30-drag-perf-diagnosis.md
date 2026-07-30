# 拖拽卡顿诊断报告与修复实施单

> 类型：开发窗口实施单 · 创建：2026-07-30 · 修订：2026-07-30（v2，采纳局部重算方案）· 严重度：高（影响核心交互）
>
> 现象：用户反馈"拖着拖着突然停住不动"。审计 188 节点 / 264 边的 self_analyze 星图渲染产物，定位三大根因。

## 0. 修订说明（v2）

v1 提出"P0 拖拽期间障碍快照"方案，v2 采纳用户建议改为**局部重算方案**——更优，原因：

- v1 快照方案拖拽期间用过期障碍位置，边路径精度有损（可能短暂穿节点）
- v1 快照方案松手后仍需全量重算（resolveOverlaps 爆炸点未根治）
- 局部重算方案缓存始终精确，松手后无需全量重算，根治 P1 爆炸点

实现复杂度从 ~50 行（v1）升至 ~150 行（v2），但收益是质变：拖拽中边路径精确 + 松手无需全量。**推荐直接实施 v2，跳过 v1**。

## 1. 诊断结论

**病根是拖拽时每次 mousemove 触发 O(N²) DOM 全量重算**——核心是 [collectObstacles](../../src/renderer/scripts.ts#L1731) 每次全量扫所有节点。修复方向是局部重算（空间网格索引 + 增量缓存），不是简单加缓存。

### 1.1 三大根因（按嫌疑度排序）

#### ① 头号嫌疑：handleDrag 链路全量重算

**位置**：[scripts.ts:2549](../../src/renderer/scripts.ts#L2549) mousemove 监听无节流 → [handleDrag](../../src/renderer/scripts.ts#L1891) → [updateConnectedEdges](../../src/renderer/scripts.ts#L2120) × N → [collectObstacles](../../src/renderer/scripts.ts#L1731) 全量扫 DOM

**调用链**（拖拽一帧的开销）：

```
mousemove 事件（每帧触发，无节流）
└─ handleDrag(e)                                   // scripts.ts:1891
   ├─ getAllDescendants(dragging)                  // 递归所有后代
   ├─ 对 [自身 + 每个后代] nid:
   │  └─ updateConnectedEdges(nid)                 // scripts.ts:2120
   │     └─ 对该 nid 的每条边:
   │        ├─ collectObstacles(excludeMap)        // scripts.ts:1731 ← O(N) 全量扫
   │        │  └─ document.querySelectorAll('.node')   // 188 次 DOM 查询
   │        │  └─ getNodePos(每个)                 // 每个节点 4 次 getAttribute
   │        └─ computeEdgePath({ obstacles })      // edge_geom.ts，含 A* 兜底
   └─ resizeParentToFitChildren(parent)            // 递归向上，每次又触发 updateConnectedEdges(parentId)
```

**量级估算**（self_analyze 星图 188 节点 / 264 边，拖一个含 10 后代的目录容器）：

- 每帧 mousemove ≈ 11 个 nid × (该 nid 的边数, 平均 2-3) × 188 次 DOM 读
- ≈ **6000+ 次 DOM 读 / 帧**
- 60fps 要求每帧 < 16ms，6000 次 DOM 读 + A* 计算远超预算
- 主线程被吃满 → mousemove 事件 backpressure → "拖着拖着突然停住"

**根因**：`collectObstacles` 每次都 `document.querySelectorAll('.node')` 全量扫，且 `getNodePos` 逐个 `getAttribute`。没有缓存，没有节流，没有增量。

#### ② 次要嫌疑：endDrag → resolveOverlaps 全量爆炸

**位置**：[scripts.ts:2046](../../src/renderer/scripts.ts#L2046) 松手时跑 [resolveOverlaps()](../../src/renderer/scripts.ts#L2240)

**开销**：

- 8 次迭代 × O(N²) 配对（188² = 35344 对）
- 每对重叠调 `moveNodeBy` → 又触发 `updateConnectedEdges` × descendants
- **致命一刀**（[scripts.ts:2301](../../src/renderer/scripts.ts#L2301)）：

```javascript
Object.keys(nodeById).forEach(function(nid) {
  updateConnectedEdges(nid);   // 全量重算所有边的所有障碍
});
```

  这一行让松手瞬间变成 O(N × E × N) ≈ 188 × 264 × 188 ≈ **930 万次 DOM 操作**。

- 表现：松手时卡 1-3 秒，然后恢复

#### ③ 第三嫌疑：pushUndo 同步 JSON.stringify

**位置**：[scripts.ts:1888](../../src/renderer/scripts.ts#L1888) 每次开始拖拽都 [pushUndo()](../../src/renderer/scripts.ts#L105) → `JSON.stringify(dsl)`

**开销**：

- DSL 几十 KB（self_analyze 949KB HTML 对应的 DSL 约 50-80KB）
- 每次拖拽开始 stringify 一次，50 条 undo 栈 = 内存中保留 50 份 DSL 副本
- 拖拽中创建的临时对象 + 粒子 DOM 堆积 → 触发浏览器 GC 暂停
- 表现：拖拽中偶发"突然卡 100ms"，与 GC 暂停特征吻合

### 1.2 排除项

**粒子动画无泄漏**：

- `state.activeParticles` 有 `remaining` 过滤清理（[animation_engine.ts:1346](../../src/renderer/animation_engine.ts#L1346)）
- chip 有 `CHIP_MAX=18` 上限淘汰（[animation_engine.ts:1194](../../src/renderer/animation_engine.ts#L1194)）
- reset 有全清理（[animation_engine.ts:1644](../../src/renderer/animation_engine.ts#L1644)）

**但粒子 rAF 与拖拽重排竞争帧时间**，会放大卡顿感——拖拽时粒子若仍在生成，rAF 回调占用部分帧时间，让拖拽的 16ms 预算更紧。

**A* 兜底有保护**：

- [edge_geom.ts:362](../../src/renderer/edge_geom.ts#L362) `cols * rows > 400000` 上限保护，单次 A* 不会爆
- 但拖拽时多条边同时走 A* 兜底，累计开销不小

## 2. 修复方案（局部重算，采纳用户建议）

### 2.1 核心思路

用户建议："鼠标拖到哪里就重算哪一部分，而非全量重算。" 这比 v1 的快照方案更优。

**三件事**：
1. **障碍数据增量维护**：全局 `Map<id, {x,y,w,h}>`，节点移动时只更新该节点条目，不再每次读 DOM
2. **障碍查询局部化**：空间网格索引，查障碍只扫边路径附近的 4-9 个网格单元，不扫全部 188 节点
3. **边重算局部化**：只重算"端点是拖拽节点"或"路径经过拖拽节点附近"的边

**为什么不直接抄 v1 快照**：v1 拖拽期间用过期障碍位置，边路径精度有损（可能短暂穿节点）；v1 松手后仍需全量重算（resolveOverlaps 爆炸点未根治）。局部重算缓存始终精确，松手无需全量。

### 2.2 P0：空间网格索引 + 增量障碍缓存（核心，~120 行）

**新增数据结构**（[scripts.ts](../../src/renderer/scripts.ts)）：

```javascript
// 全局障碍缓存：id → {x, y, w, h}
const obstacleCache = new Map();

// 空间网格索引："gx,gy" → Set<id>，网格大小 200px
const GRID_SIZE = 200;
const obstacleGrid = new Map();

function gridKey(x, y) {
  return Math.floor(x / GRID_SIZE) + ',' + Math.floor(y / GRID_SIZE);
}

// 初始化：渲染完成后遍历所有 .node 一次，建立缓存+网格
function initObstacleIndex() {
  obstacleCache.clear();
  obstacleGrid.clear();
  const els = document.querySelectorAll('.node');
  for (const el of els) {
    const id = el.getAttribute('data-id');
    const pos = getNodePos(el);
    if (id && pos) {
      obstacleCache.set(id, pos);
      const k = gridKey(pos.x + pos.w / 2, pos.y + pos.h / 2);
      if (!obstacleGrid.has(k)) obstacleGrid.set(k, new Set());
      obstacleGrid.get(k).add(id);
    }
  }
}

// 增量更新：节点移动后调用，只刷新该节点
function refreshObstacle(id) {
  // 删除旧网格条目
  const old = obstacleCache.get(id);
  if (old) {
    const k = gridKey(old.x + old.w / 2, old.y + old.h / 2);
    const cell = obstacleGrid.get(k);
    if (cell) cell.delete(id);
  }
  // 读 DOM 更新（只读这一个节点，不扫全部）
  const el = document.querySelector('.node[data-id="' + id + '"]');
  if (!el) { obstacleCache.delete(id); return; }
  const pos = getNodePos(el);
  if (!pos) { obstacleCache.delete(id); return; }
  obstacleCache.set(id, pos);
  const k = gridKey(pos.x + pos.w / 2, pos.y + pos.h / 2);
  if (!obstacleGrid.has(k)) obstacleGrid.set(k, new Set());
  obstacleGrid.get(k).add(id);
}

// 局部查询：只扫边 bbox 附近的网格单元
function collectObstaclesLocal(fromBox, toBox, excludeMap) {
  const minX = Math.min(fromBox.x, toBox.x) - GRID_SIZE;
  const maxX = Math.max(fromBox.x + fromBox.w, toBox.x + toBox.w) + GRID_SIZE;
  const minY = Math.min(fromBox.y, toBox.y) - GRID_SIZE;
  const maxY = Math.max(fromBox.y + fromBox.h, toBox.y + toBox.h) + GRID_SIZE;

  const obs = [];
  const seen = new Set();
  const gxMin = Math.floor(minX / GRID_SIZE);
  const gxMax = Math.floor(maxX / GRID_SIZE);
  const gyMin = Math.floor(minY / GRID_SIZE);
  const gyMax = Math.floor(maxY / GRID_SIZE);
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      const cell = obstacleGrid.get(gx + ',' + gy);
      if (!cell) continue;
      for (const id of cell) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (excludeMap[id]) continue;
        const pos = obstacleCache.get(id);
        if (pos) obs.push(pos);
      }
    }
  }
  return obs;
}
```

**调用点改造**：

| 位置 | 改动 |
|---|---|
| 渲染完成后（html_renderer 或 scripts init） | 调 `initObstacleIndex()` 建立缓存 |
| [updateConnectedEdges:2167](../../src/renderer/scripts.ts#L2167) | `collectObstacles(excludeMap)` → `collectObstaclesLocal(fromPos, toPos, excludeMap)` |
| [_applyNodeDelta](../../src/renderer/scripts.ts#L1782) 末尾 | 调 `refreshObstacle(nodeId)`（拖拽中节点位置变了，缓存跟着更新） |
| [moveNodeBy](../../src/renderer/scripts.ts) 末尾 | 调 `refreshObstacle(nodeId)`（resolveOverlaps 移动节点后） |
| 增删节点（如 expand/collapse） | 调 `refreshObstacle(newId)` / `obstacleCache.delete(removedId)` |

**预期收益**：

- collectObstacles 从 O(N=188) DOM 读 → O(k≈4-9) Map 读，约 **20-50x 快**
- 拖拽中每帧 6000+ 次 DOM 读 → ~50-100 次 Map 读
- 拖拽中边路径**精确**（缓存实时更新，非过期快照）

### 2.3 P0 配套：拖拽期间暂停粒子（~10 行，独立可验证）

[scripts.ts](../../src/renderer/scripts.ts) startDrag/endDrag：

```javascript
function startDrag(nodeEl, e) {
  // ... 现有逻辑 ...
  if (window.__animV2__ && window.__animV2__.pause) {
    window.__animV2__.pause();
    state.dragPausedAnim = true;
  }
}

function endDrag() {
  // ... 现有逻辑 ...
  if (state.dragPausedAnim && window.__animV2__ && window.__animV2__.resume) {
    window.__animV2__.resume();
    state.dragPausedAnim = false;
  }
}
```

**预期收益**：拖拽期间 rAF 只服务拖拽重排，不与粒子竞争帧时间。

### 2.4 P1：删 resolveOverlaps 末尾全量重算（~3 行，局部重算后可安全删）

[scripts.ts:2301](../../src/renderer/scripts.ts#L2301)：

```javascript
function resolveOverlaps() {
  // ... 现有 8 次迭代（每次 moveNodeBy 已调 refreshObstacle + updateConnectedEdges）...

  // 删除这一行（局部重算后缓存始终精确，无需全量重算）：
  // Object.keys(nodeById).forEach(function(nid) {
  //   updateConnectedEdges(nid);
  // });
}
```

**为什么 v2 能删而 v1 不能**：v1 快照方案松手时缓存过期，必须全量重算；v2 局部重算方案中，moveNodeBy 每次移动都调了 refreshObstacle，缓存始终精确，无需全量。

**预期收益**：松手瞬间从 930 万次 DOM 操作降到接近 0。

### 2.5 P2：拖拽中重算"经过 X 附近的其他边"（可选，~30 行）

**问题**：拖拽节点 X 时，X 自己的连边已重算，但"端点不是 X、路径经过 X 附近"的其他边未更新——X 移动后可能挡住这些边。

**v1 回避了此问题**（快照期间不更新 X 障碍位置）；**v2 必须处理**否则边可能穿 X。

**方案**：维护"网格单元 → 经过该单元的边 id"反向索引。

```javascript
const edgeGridIndex = new Map();  // "gx,gy" → Set<edgeId>

function reindexEdge(edgeId, fromBox, toBox) {
  // 删除旧条目（需记录 edge 之前经过的单元）
  // 加入新单元
}

function edgesNear(box) {
  // 返回路径经过 box 附近网格单元的所有 edgeId
}
```

拖拽 X 时，X 移动后：
1. `refreshObstacle(X)` 更新 X 的障碍缓存
2. `edgesNear(X 新 bbox)` 找到受影响的边
3. 对这些边调 `updateConnectedEdges`

**预期收益**：拖拽中视觉完整（所有受影响边实时更新），无穿节点。

**复杂度**：需维护 edge 的旧网格单元记录（用于删除旧条目），约 30 行。

**是否必做**：**不必，可作为后续优化**。原因：
- P0 已解决 90% 卡顿（X 自己的连边局部重算）
- "X 影响其他边"只影响视觉精度，不影响性能（不重算就不卡）
- 用户拖拽时注意力集中在 X 上，远处边短暂穿 X 不易察觉
- 建议 P0 上线后观察，若用户反馈"拖拽时其他边穿节点"再补 P2

### 2.6 P3：pushUndo 节流（~10 行，独立可验证）

[scripts.ts:1888](../../src/renderer/scripts.ts#L1888)：

```javascript
let lastUndoTs = 0;
function startDrag(nodeEl, e) {
  // ... 现有逻辑 ...
  const now = Date.now();
  if (now - lastUndoTs > 500) {
    pushUndo();
    lastUndoTs = now;
  }
}
```

**预期收益**：减少 GC 压力，降低"突然卡 100ms"频率。

## 3. 验证方法

### 3.1 复现基线

修复前，在 self_analyze.html 上：

1. 打开 Chrome DevTools Performance 面板
2. 录制拖拽一个目录容器（如 `📁 tools`）3 秒
3. 观察：主线程长任务、mousemove 事件频率、collectObstacles 调用次数
4. 记录：平均帧时间、最长帧时间、GC 事件次数

### 3.2 修复后验证

每个 P0/P1/P3 改动后，重复 3.1，对比：

- 平均帧时间应从 >100ms 降到 <30ms
- 最长帧时间应从 >500ms 降到 <100ms
- collectObstaclesLocal 每次调用应只扫 4-9 个网格单元（用 console.log 计数验证）
- 拖拽中 refreshObstacle 每帧调用次数 = 拖动子树节点数（增量更新，非全量）

### 3.3 回归测试

- 拖拽后边路径正确（实时绕障，无穿节点）
- resolveOverlaps 仍正常工作（松手后无重叠）
- 撤销/重做仍可用
- 粒子在拖拽结束后恢复流动
- **新增/删除节点后障碍索引正确**（expand/collapse 后 refreshObstacle 覆盖）
- **缓存与 DOM 一致性**：拖拽后用 console 对比 obstacleCache 与实际 DOM 位置

## 4. 实施顺序建议

1. **先做 P0（空间网格 + 增量缓存）** — 核心，~120 行，解决 90% 卡顿
2. **做 P0 配套（暂停粒子）** — ~10 行，独立可验证
3. **做 P1（删 resolveOverlaps 全量重算）** — ~3 行，P0 完成后可安全删
4. **验证** — 若帧时间已 acceptable，跳过 P2/P3
5. **若用户反馈"远处边穿拖拽节点"，做 P2（edge 反向索引）** — ~30 行
6. **若 GC 卡顿明显，做 P3（pushUndo 节流）** — ~10 行

## 5. 风险

| 改动 | 风险 | 缓解 |
|---|---|---|
| P0 空间网格 | 节点跨网格（大容器占多格）时漏查 | 用中心点入索引；查询时扫 bbox 覆盖的所有网格单元（已实现） |
| P0 缓存一致性 | 节点位置变了但未调 refreshObstacle | 审计所有节点移动路径（_applyNodeDelta / moveNodeBy / expand / collapse），确保都调 refreshObstacle |
| P0 缓存一致性 | expand/collapse 增删节点未更新索引 | expand 后调 refreshObstacle(新节点 id)；collapse 后 obstacleCache.delete(移除 id) |
| P0 暂停粒子 | 拖拽期间视觉粒子消失 | 松手立即恢复；可加 fade-in 过渡 |
| P1 删全量重算 | 极端情况某些边未更新（refreshObstacle 遗漏点） | 测试覆盖；保留 fallback 开关（performance.debug.forceFullRecompute） |
| P2 edge 反向索引 | 复杂度上升 | 先不做，观察用户反馈再决定 |

## 6. 不做什么

- **不重写整个拖拽系统**——现有架构（DOM 直接操作 + DSL 同步）是合理的，问题在性能优化层
- **不引入 React/Vue 虚拟 DOM**——MVP 阶段保持零构建链（[design.md](../design.md) 决策），虚拟 DOM 不解决 collectObstacles 的 O(N) 问题
- **不做 Web Worker**——A* 计算移 Worker 收益有限（主线程瓶颈是 DOM 读，不是计算），且增加复杂度
- **不做 v1 快照方案**——已被 v2 局部重算取代，v2 精度更高且根治 P1 爆炸点

## 7. 关于用户提出的"局部运算"

用户原话："鼠标拖到哪里就重算哪一部分，而非全量重算。"

这正是 v2 方案的核心。实现路径：

1. **障碍局部化**：空间网格索引，查障碍只扫边附近的 4-9 个网格单元（v2 P0）
2. **缓存增量更新**：节点移动只刷新该节点缓存，不扫全部 DOM（v2 P0）
3. **边重算局部化**：只重算端点是拖拽节点的边（现有 updateConnectedEdges 已实现）；"路径经过拖拽节点附近的边"留待 P2

**关于"画布拖拽"**：画布平移（pan）只改 SVG viewBox，不改节点坐标，**已不触发重算**，无需改动。卡顿只发生在节点拖拽（drag node）。

**难度评估**：中等，~120 行核心代码。比 v1 快照方案（~50 行）多 3 倍代码量，但收益是质变（精度精确 + 根治 P1）。无难点算法，核心是 Map + 网格哈希，开发窗口可直接按 §2.2 代码骨架实施。
