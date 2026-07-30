# 布局重排：从字母序改为边驱动 + 功能聚类

> 类型：开发窗口实施单 · 创建：2026-07-30 · 严重度：中（影响可读性）
>
> 现象：用户反馈"纯靠字母排，两边都不讨好——既不按功能排在一起，也不按边排在一起，乱七八糟"。审计 [import_project.ts](../../src/tools/import_project.ts) 布局逻辑，定位三处字母序硬编码。

## 1. 现状审计：字母序的三个位置

### 1.1 文件扫描顺序（[import_project.ts:128](../../src/tools/import_project.ts#L128)）

```typescript
return out.sort();   // walkFiles 返回的文件列表按字母序
```

文件被发现的顺序决定后续所有处理的顺序。这是源头——但影响有限，因为后续 rankItems/layoutGroup 会重排。

### 1.2 rankItems 的队列顺序（[import_project.ts:330,336,342](../../src/tools/import_project.ts#L330)）

```typescript
const queue = ids.filter((id) => (inDeg.get(id) || 0) === 0).sort();   // L330 根节点入队按字母
for (const next of (out.get(cur) || []).sort()) {                       // L336 后继展开按字母
const leftovers = ids.filter((id) => !rank.has(id)).sort();             // L342 环上节点按字母
```

Kahn 拓扑分列本身正确，但**同层节点的相对顺序完全由字母决定**。A 连到 Z、B 连到 C 时，A 排 B 上导致边交叉。

### 1.3 layoutGroup 的列内排序（[import_project.ts:393](../../src/tools/import_project.ts#L393)）

```typescript
const col = byRank.get(r)!.sort((a, b) => a.id.localeCompare(b.id));   // 列内按字母
```

这是最直接的可视化影响——同一列里谁在上谁在下，纯字母序，与边无关。

### 1.4 目录排序（[import_project.ts:577,584](../../src/tools/import_project.ts#L577)）

```typescript
for (const sub of [...dir.subdirs.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {   // 子目录按字母
for (const f of [...dir.files].sort((a, b) => a.rel.localeCompare(b.rel))) {                // 文件按字母
```

目录容器之间的排布也按字母序，导致 `renderer/` 排在 `tools/` 前面（即便 `tools/` 是入口）。

### 1.5 货架布局的副作用（[import_project.ts:365-387](../../src/tools/import_project.ts#L365)）

当 `ranks.length <= 2 && items.length >= 3` 时切货架算法——按高度降序贪心填行，**完全放弃拓扑列**。这是为了压高度（避免 100+ 文件单列 12834px），但代价是拓扑结构塌陷，边必然纠缠。

self_analyze 的 `📁 tools` 目录（12 文件 + 稀疏依赖）很可能命中此分支。

## 2. 用户需求拆解

用户原话："可以是按照功能排在一起，也可以是按照边来排在一起。但像现在这样纯靠字母来排，两边都不讨好。"

两个明确目标：

| 目标 | 含义 | 算法对应 |
|---|---|---|
| 按功能排在一起 | 功能相关的文件物理相邻 | 聚类（社区检测 / 公共前缀） |
| 按边排在一起 | 有依赖关系的文件位置接近，边尽量短直 | barycenter / median 启发式 |

两者不矛盾：先按功能聚类分块，块内再按 barycenter 排序——**分层优化**。

## 3. 修复方案

### 3.1 核心思路：双阶段布局

```
阶段 A：功能聚类分块（coarse）
  ├─ 目录内文件：按社区检测（louvain）或公共路径前缀聚类
  ├─ 目录容器间：按调用图社区聚类
  └─ 输出：每个块是一组功能内聚的文件

阶段 B：块内 + 块间按 barycenter 排序（fine）
  ├─ 块内：rankItems 分列 + barycenter 列内排序（边短直）
  ├─ 块间：块作为超节点，再跑一次 rankItems + barycenter
  └─ 输出：最终 x/y 坐标
```

### 3.2 阶段 A：功能聚类

**目录内文件聚类**（轻量，不引入 louvain 依赖）：

```typescript
/**
 * 按功能聚类文件：优先用公共路径前缀，回退到调用图连通分量。
 * 启发式：同目录下，文件名共享前缀（如 foo_handler.ts / foo_service.ts）
 * 通常功能相关；调用图连通分量兜底无前缀但互相调用的文件。
 */
function clusterFilesByFeature(
  files: string[],   // 相对路径
  deps: Array<[string, string]>
): string[][] {   // 返回聚类块数组
  // 1. 公共前缀聚类：foo_handler.ts / foo_service.ts / foo_types.ts → 同块
  const prefixGroups = new Map<string, string[]>();
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);   // 去目录
    // 提取下划线/连字符分隔的第一段作为功能前缀
    const prefix = base.split(/[_-]/)[0] || base.replace(/\.[^.]+$/, '');
    const key = prefix.toLowerCase();
    if (!prefixGroups.has(key)) prefixGroups.set(key, []);
    prefixGroups.get(key)!.push(f);
  }
  // 2. 单元素块合并到"杂项"块（避免孤岛）
  const blocks: string[][] = [];
  const misc: string[] = [];
  for (const [, group] of prefixGroups) {
    if (group.length >= 2) blocks.push(group);
    else misc.push(...group);
  }
  if (misc.length > 0) blocks.push(misc);
  // 3. 调用图连通分量兜底：跨块但有依赖的文件合并
  //    （可选，启发式：若两块间边数 > 阈值，合并）
  return blocks;
}
```

**目录容器间聚类**：复用 [edgeAggregation.ts](../../vendor/Understand-Anything/understand-anything-plugin/packages/dashboard/src/utils/edgeAggregation.ts) 的思路——目录间聚合边数作为权重，权重高的目录排近。但这一步可后置（v1 只做块内优化，块间仍字母序），先看块内 barycenter 效果。

### 3.3 阶段 B：barycenter 列内排序

替换 [layoutGroup:393](../../src/tools/import_project.ts#L393) 的字母序：

```typescript
// 现状：列内按字母序
const col = byRank.get(r)!.sort((a, b) => a.id.localeCompare(b.id));

// 改为：barycenter 启发式（邻居在上层的平均 y）
// 迭代 3 轮：自顶向下 2 轮 + 自底向上 1 轮
```

**完整 barycenter 实现**（替换 rankItems + layoutGroup 的排序逻辑）：

```typescript
/**
 * barycenter 列内排序：每节点按 in-neighbors 在上层的 y 均值排
 * 迭代 3 轮（top-down 2 + bottom-up 1）收敛
 */
function barycenterLayout(
  items: LayoutItem[],
  deps: Array<[string, string]>
): Map<string, { x: number; y: number }> {
  const ids = items.map((i) => i.id);
  const rank = rankItems(ids, deps);   // 复用现有 Kahn
  const byRank = new Map<number, LayoutItem[]>();
  for (const item of items) {
    const r = rank.get(item.id) || 0;
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push(item);
  }
  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  // 构建邻接索引
  const inNeighbors = new Map<string, string[]>();
  const outNeighbors = new Map<string, string[]>();
  for (const id of ids) {
    inNeighbors.set(id, []);
    outNeighbors.set(id, []);
  }
  for (const [f, t] of deps) {
    if (inNeighbors.has(t)) inNeighbors.get(t)!.push(f);
    if (outNeighbors.has(f)) outNeighbors.get(f)!.push(t);
  }

  // barycenter 计算：节点在指定列的邻居平均 y
  function baryOf(id: string, neighborCol: LayoutItem[] | undefined): number {
    if (!neighborCol) return 0;
    const neighborY = new Map(neighborCol.map((it) => [it.id, it.y]));
    // 节点的 in-neighbors（上层→本层）或 out-neighbors（下层→本层）
    const ns = inNeighbors.get(id) || [];   // 默认用 in-neighbors
    const ys = ns.map((n) => neighborY.get(n)).filter((y) => y !== undefined) as number[];
    return ys.length > 0 ? ys.reduce((s, y) => s + y, 0) / ys.length : 0;
  }

  // 迭代 3 轮
  for (let iter = 0; iter < 3; iter++) {
    const topDown = iter < 2;
    const order = topDown ? ranks : [...ranks].reverse();
    for (const r of order) {
      const col = byRank.get(r)!;
      const neighborCol = topDown
        ? byRank.get(r - 1)   // 自顶向下：看上层
        : byRank.get(r + 1);  // 自底向上：看下层
      // 计算每节点 barycenter
      const withBary = col.map((it) => ({ it, b: baryOf(it.id, neighborCol) }));
      // 第一列（无上层）或最后一列（无下层）：按出度/入度降序
      if (!neighborCol) {
        const deg = new Map<string, number>();
        for (const id of col.map((c) => c.id)) {
          deg.set(id, (inNeighbors.get(id)!.length + outNeighbors.get(id)!.length));
        }
        withBary.sort((a, b) => (deg.get(b.it.id) || 0) - (deg.get(a.it.id) || 0));
      } else {
        withBary.sort((a, b) => a.b - b.b);
      }
      // 重排并更新 y 坐标
      let yCursor = 0;
      for (const { it } of withBary) {
        it.y = yCursor;
        yCursor += it.h + ROW_GAP;
      }
      byRank.set(r, withBary.map((w) => w.it));
    }
  }

  // 写回 x 坐标（按 rank 列）
  const result = new Map<string, { x: number; y: number }>();
  let xCursor = 0;
  for (const r of ranks) {
    const col = byRank.get(r)!;
    let colW = 0;
    for (const it of col) {
      result.set(it.id, { x: xCursor, y: it.y });
      colW = Math.max(colW, it.w);
    }
    xCursor += colW + COL_GAP;
  }
  return result;
}
```

### 3.4 货架分支的处置

[layoutGroup:365-387](../../src/tools/import_project.ts#L365) 的货架分支**保留**，但只在 `items.length >= 12`（而非现在的 `>= 3`）时触发。3-11 个文件的目录改走 barycenter 列布局——这是用户反馈的"边纠缠"主要场景。

```typescript
// 现状：ranks <= 2 且 items >= 3 触发货架
if (ranks.length <= 2 && items.length >= 3) { ... }

// 改为：ranks <= 2 且 items >= 12 才触发货架（大目录压高度）
if (ranks.length <= 2 && items.length >= 12) { ... }
```

阈值 12 的依据：self_analyze 的 `📁 tools` 有 12 文件，期望它走 barycenter 而非货架。

### 3.5 目录容器间排序

[layoutDir:577,584](../../src/tools/import_project.ts#L577) 的子目录/文件排序，从字母序改为**按入口文件优先 + 子树大小降序**：

```typescript
// 现状
for (const sub of [...dir.subdirs.values()].sort((a, b) => a.rel.localeCompare(b.rel))) {

// 改为：入口目录（含 main.ts/index.ts/server.ts）优先，其余按子树节点数降序
const subdirOrder = (a: DirNode, b: DirNode): number => {
  const aIsEntry = a.files.some(f => /main|index|server|app\./.test(f.rel));
  const bIsEntry = b.files.some(f => /main|index|server|app\./.test(f.rel));
  if (aIsEntry !== bIsEntry) return aIsEntry ? -1 : 1;
  return b.subtreeSize - a.subtreeSize;   // 子树大小需在扫描阶段统计
};
for (const sub of [...dir.subdirs.values()].sort(subdirOrder)) {
```

需在 DirNode 增加 `subtreeSize` 字段（扫描阶段统计）。

## 4. 不做什么

- **不引入 louvain / graphology 依赖**——vendor/Understand-Anything 用了，但 design-canvas 坚持 [零运行时依赖自包含 HTML](../design.md)，功能聚类用公共前缀启发式即可
- **不做全局最小交叉数优化**（NP-hard）——barycenter 是启发式，不保证最优，但比字母序好得多
- **不删货架布局**——大目录仍需压高度，只调阈值
- **不改 rankItems 的拓扑分列逻辑**——Kahn 本身正确，只改列内排序
- **不做目录容器间复杂聚类**（v1）——先做块内 barycenter，块间仍简单排序，观察效果

## 5. 验证方法

### 5.1 视觉对比

修复前后，在 self_analyze.html 上对比：

1. `📁 tools` 目录（12 文件）：边交叉数应显著下降
2. `📁 renderer` 目录（多文件）：边交叉数应下降
3. 顶层目录容器排布：`tools/` 应靠近入口而非按字母排在 `renderer/` 后
4. 大目录（如 100+ 文件）仍走货架，高度不爆

### 5.2 交叉数自动统计

可写一个简单脚本统计边交叉数（两两边 bbox 是否相交），修复前后对比。但非必须——视觉判断即可。

### 5.3 回归测试

- 大目录（100+ 文件）布局高度仍 < 2000px（货架仍生效）
- 拓扑序仍正确（rank 0 是根，rank N 是叶子）
- 环上节点仍追加到最后一列
- 同层节点顺序确定性（barycenter 迭代收敛后稳定）

## 6. 实施顺序

1. **DirNode 加 subtreeSize 字段**（~10 行）——扫描阶段统计
2. **实现 clusterFilesByFeature**（~30 行）——公共前缀聚类
3. **实现 barycenterLayout**（~60 行）——替换 layoutGroup 列内排序
4. **调货架阈值**（~1 行）——`items.length >= 3` → `>= 12`
5. **改目录排序**（~10 行）——入口优先 + 子树大小降序
6. **验证**——self_analyze.html 对比

总改动 ~110 行，集中在 [import_project.ts](../../src/tools/import_project.ts)。

## 7. 风险

| 改动 | 风险 | 缓解 |
|---|---|---|
| barycenter 不收敛 | 迭代 3 轮后顺序仍抖动 | 固定 3 轮不收敛也接受（比字母序好）；可加收敛检测早停 |
| 公共前缀聚类误判 | `foo_handler.ts` 与 `foo_bar.ts` 被归一类但功能无关 | 前缀取首段（`foo`），同块不代表强相关，barycenter 仍按边重排 |
| 货架阈值 12 过高 | 10 文件目录走列布局，高度可能过高 | 阈值可调；观察后定 |
| 目录排序入口优先 | 无明显入口的项目（纯库）退化为子树大小降序 | 子树大小降序是合理回退（大目录在上） |

## 8. 与卡顿修复的关系

本实施单与 [2026-07-30-drag-perf-diagnosis.md](./2026-07-30-drag-perf-diagnosis.md) 独立——布局质量与拖拽性能是两个问题。但本单实施后，边路径更短直，A* 兜底触发减少，对拖拽性能有正向副作用。

## 9. 用户反馈的直接映射

| 用户原话 | 本单对应 |
|---|---|
| "按功能排在一起" | §3.2 功能聚类（公共前缀 + 连通分量） |
| "按边来排在一起" | §3.3 barycenter 列内排序 |
| "纯靠字母来排，两边都不讨好" | §1 审计三处字母序硬编码 |
| "线纠缠在一起" | §3.4 货架阈值调整 + barycenter 减少交叉 |
| "很多线可以直连但纠缠" | §3.3 barycenter 让边短直 |
