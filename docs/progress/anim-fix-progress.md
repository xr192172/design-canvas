# 动画「连线乱 / 节点夹 / 拖不动」修复进度

> 用途：跨会话交接检查点。每做完一步就更新本文件，下次接管先读这里，勿重做。
> 背景：用户反馈动画系统"连线全乱、节点夹影响拖拽、部分节点拖不动"，质疑动画实现质量。

## 决策
第一刀：**砍「连线乱」**。因为连线乱（A* 绕障折角）与节点夹（resolveOverlaps 推挤）同源且互相放大，弱化绕障可同时缓解两者。

## ✅ 第一步（已完成并验证）：砍掉 A* 折角兜底
- 位置：`src/renderer/edge_geom.ts` 的 `computeEdgePath`（原 ~L650-L658）。
- 改动：删除 A* waypoint 兜底（产生折线/S 路径的根源），改为始终返回碰撞最少的平滑贝塞尔。
- 验证：
  - `npm run build` 通过。
  - 脚本 `scripts/_verify_edges_clean.mjs` 测 `self_analyze.html`：1070 条边，**折角(折线L命令)=0**。
  - 剩余 604 条含 `L` 的是直线边（非曲线边的正常 `M..L`），非问题。
  - 注意：playwright 无 headless_shell，需 `executablePath` 指向 `chromium-1228\chrome-win64\chrome.exe`。

## ✅ 第四步（已完成并验证）：修「边不跟随节点」
- 现象：拖动节点，边留在原地像背景图。
- 根因：`edgeElById` 只在 `renderFromDSL`（[scripts.ts ~L253]）填充，主渲染路径（html_renderer SSR）不走该函数 → `updateConnectedEdges` 里 `edgeElById[e.id]` 全为 undefined，`if(!edgeEl)return` 跳过 → 边不更新。与之前 `nodeElById` 是同一个坑，当初只补了节点没补边。
- 修复：在 `setupEdges()`（[scripts.ts ~L4263]）填充 `edgeElById[id] = edgeEl;`。
- 验证（`scripts/_dbg_edge_follow.mjs`）：拖节点后边 `d` 从 `M 550 784...` 更新为新位置，`edgeMoved=true`。
- 教训固化：**SSR 渲染路径下，nodeElById / edgeElById / edgesByFrom-To 等缓存都必须在 setup 阶段补齐**。

## ✅ 第三步（已完成并验证）：拖拽吸附对齐
- 位置：`src/renderer/scripts.ts`
  - `startDrag`：构建 `state.snapCandidates`（拖拽节点+后代之外的所有节点框，一次）。
  - 新增 `SNAP_THRESHOLD=8`、`computeSnapOffset`（左/中/右 + 上/中/下 3×3 对齐，取最近）、`updateSnapGuides`（画蓝色虚线参考线，内联样式）、`clearSnapGuides`。
  - `handleDrag`：对目标坐标做吸附校正后移动，DSL 用吸附后坐标。
  - `endDrag`：`clearSnapGuides()` 清参考线。
- 验证（`scripts/_verify_snap.mjs`）：拖 A 中心靠向 B 中心 → `snapped=true`（A 中心边精确= B 中心 3585）、`guideDuring` 双参考线可见、`guideAfter` 已清除、`moved=true`。
- 附：证据链脚本 `scripts/_verify_edges_clean.mjs`、`_verify_drag_hold.mjs`、`_verify_snap.mjs`。

## ⏭ 待办（下一步）
1. ~~简化/去掉 `resolveOverlaps` 推挤~~ → ✅ 已完成（见下）
2. 构建 + 预览验证 → ✅ 已完成

## ✅ 第二步（已完成并验证）：去掉 resolveOverlaps 互推
- 位置：`src/renderer/scripts.ts`
  - `endDrag`（原 ~L3438）：删除 `resolveOverlaps()` 调用 → 手动编辑允许节点自由落位，不再被弹回/挤邻居。
  - 删除整个 `resolveOverlaps()` 函数（原 ~L3638-L3702，唯一调用点已被删，属死代码）。
- 验证（`scripts/_verify_drag_hold.mjs`，注意 self_analyze.html 需 `npm run self-analyze` 重新生成，只 build 不生效）：
  - `moved: true`（能拖）· `stayed: true`（松手 900ms 零漂移=无弹回）· `sibStill: true`（邻居不被挤=无节点夹）。
- 关键教训：**改 scripts.ts 后必须 `npm run self-analyze` 重生成 output/self_analyze.html**，serve 只读 output/，仅 build（tsc+gen bundle）不会让改动进页面。

## ⚠️ 测试环境注意
- playwright 无 headless_shell，必须 `executablePath` 指向 `chromium-1228\chrome-win64\chrome.exe`。
- 画布有缩放，屏幕 px ≠ viewBox 单位（约 4.2x），断言用"松手后零漂移"而非绝对 delta。

## 参考代码定位
- `scripts.ts resolveOverlaps` ~L3638：拖拽结束推挤重叠节点。
- `scripts.ts updateConnectedEdges` ~L3558：拖动 fast 模式跳过绕障，拖完全量重算。
- `edge_geom.ts computeEdgePath` ~L554：搜素链 quad→cubic→原 A* 兜底（已删）。