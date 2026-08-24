# 沙盘工作台 · 后端数据线路对接契约

> 写给：重新设计工作台 UI 的视觉窗口 + 改造后端数据线路的实现窗口（含下一个接力的 AI）。
>
> 一句话：**工作台(可视化协作平台)是外壳，沙盘视图是积木拼搭场；后端数据线路以此为中心重塑。
> 每一块「积木」= 一个功能（Brick），积木内部挂着它的前端/后端/通用文件，积木与积木通过
> `peers` 交互（相似虚线 / 调用实线）。左侧工作台可挂多个入口（沙盘 / 屎山重构 / 问题清单…），
> 都是同一份积木数据的视图投影。**

本契约取代旧的「feature_map 独立画布」思路：不再把聚类数据做成第 N 张孤儿画布，
而是把 `feature_map` 的产物**重塑成一份积木集合（Brick Bag）**，工作台所有视图消费它。

---

## 1. 数据线路全景（改造后）

```
源工程源码
   │  (复用既有原子，零重造)
   ├─ scanSourceFiles()                    → 源文件清单
   ├─ layer_detect.matchLayer()            → 层(core/api/ui/…) → side(前端/后端/通用)
   ├─ detectDeadImports(TS/Go)+detectDeadPyImports(py) → 死 import（废弃证据,保守）
   └─ buildFeatureMap()                    → 现有 feature_map（文件明细+功能聚合+三样标注）
                                            ▼
后端新增唯一一段「组装」
   assembleBricks(feature_map)  ──────────►  BrickBag（积木集合，见 §2）＝ 数据线路的最终产物
                                            ▼
渲染管线
   bakeSandboxView(dsl, brickBag)  ───────►  沙盘视图(积木拼搭)  ←── 工作台经 MCP 拉取渲染
                                            ▼
工作台外壳（视觉窗口实现的壳，数据全部来自 BrickBag）
   左侧导航(沙盘/屎山重构/问题清单/版本/DSL源码/同步记录)
   中央沙盘(积木拼搭) / 右侧详情(选中积木明细) / 底部(版本↔AI建议 + 审批)
```

- **原则（反屎山）**：只新增 `assembleBricks()` + `bakeSandboxView()` 两段，其余全部复用既有原子。
  积木是**投影**，不是新语言、不是新 DSL、不复制一份「解析→建图→布局→渲染」。

---

## 2. 核心数据单元 —— Brick（一块积木 = 一个功能）

```ts
interface Brick {
  id: string;              // 功能 id（= source_root 下首层目录段；根文件 'root'）
  name: string;            // 显示名（当前 = id；可升级为 LLM 人话命名）
  files: {
    frontend: string[];    // 该积木的前端文件（相对 source_root）
    backend:  string[];    // 后端文件
    shared:   string[];    // 通用文件
  };
  layer: string;           // 主导架构层 id（复用 layer_detect）
  families: {              // 积木内「重复实现」家族（同词根平行管线）
    root: string; files: string[];
  }[];                     // ← 来自 feature.repeatedFamilies
  deprecation: {           // 废弃证据（死 import 聚合,保守）
    deadImportSources: number;
    deadSources: { source: string; files: string[] }[];
  };                       // ← 来自 feature.deprecation
  peers: BrickPeer[];      // 与其它积木的交互（拼/连线依据）
}

type BrickPeer =
  | { kind: 'similar'; brickId: string; score: number; sharedBasenames: string[] }   // 相似积木 → 虚线,线宽∝score
  | { kind: 'call';    brickId: string }                                              // 调用/连接边 → 实线(取自既有调用边聚合)
```

```ts
interface BrickBag {
  bricks: Brick[];
  meta: {
    project_dir: string;
    source_root: string;
    scanned_files: number;   // = feature_map.scannedFiles
    langs: string[];         // 多语言并列（ts/go/py）
  };
  limitations: string[];     // 规则说明，工作台必须展示（免责）
}
```

> 为什么是 Brick？因为用户的心智模型就是**拼积木**：掏出一块积木(功能) → 与其它积木搭建。
> `peers` 就是"能与谁拼"的接口：相似的拼成虚线边(提示可能是重复实现)，有调用关系的拼成实线边(真实交互)。
> 沙盘上一块积木可拖拽，拖到另一块旁即"拼搭"，对应一次「合并/复用」候选——进入右侧详情或屎山重构。

---

## 3. 工作台四区 ↔ 数据映射（后端数据接口）

| 区域 | 内容 | 数据来源（都来自 BrickBag） |
|---|---|---|
| 左侧导航「沙盘视图」 | 积木拼搭场 | `bricks` 全体按保形聚类排布 |
| 左侧导航「屎山重构」 | 选中一块积木 → 对它的文件跑重构管线 | `bricks[i]` ↔ `refactor_pipeline`（复用多语言执行器） |
| 左侧导航「问题清单」 | 全积木的废弃/重复族聚合待办 | 遍历 `bricks[].deprecation` + `families` |
| 左侧导航「版本历史 / 同步记录」 | 版本回溯 + 落盘审批流 | 沿用既有 DSL 修订/乐观锁（不新增） |
| 中央沙盘 | 每块积木=一个图块；内层 frontend/backend/shared 文件成簇；砖间=`peers` 连线 | §2 |
| 右侧详情 | 选中积木：文件三侧明细、相似积木、重复家族、废弃证据(dead_sources) | §2 `files`/`peers`/`families`/`deprecation` |
| 底部「当前版本 ↔ AI 建议版本」+ 审批 | 变更对比 + 逐层确认（安全模式） | 沿用「定稿同步 + 审批弹窗」机制（用户偏好） |

### 沙盘积木具体画法（沿用决定性画布的精华，别重造）

- **保留层级下钻**：项目 → 积木(功能) → 三侧(前端/后端/通用) → 真实文件簇。下钻到侧看到的是**真实文件**，不是合成新图（复用 html_renderer `bakeFeatureTreeView` 的保形聚类思想）。
- 每块积木 = 一个图块/卡片，宽高约容纳其文件簇；**frontend 蓝 / backend 橙 / shared 灰**（与主题联动）。
- `families`：同族文件**同色系描边**或用子容器标出（如 `tools` 积木内的 `derive(7)`）。
- `peers.similar`：两积木之间**虚线**，线宽 ∝ `score`，悬停列 `sharedBasenames`。
- `peers.call`：**实线**（沿用既有调用边聚合方式）。
- `deprecation`：命中的积木**红边/灰化**，`deadImportSources` 越高 → 越靠前作为可废弃候选；悬停列 `deadSources`。
- 标注层开关：默认显示，可一键切到「纯分层图」对比。

---

## 4. 后端数据线路改造点（实现窗口）

只动两处，其余复用：

1. **`assembleBricks(feature_map) → BrickBag`**（新增，纯计算，不落盘）
   - 遍历 `feature_map.features` → 每 feature 一个 Brick（`files`/`families`/`deprecation` 直接投影）。
   - `peers`：
     - `similar`：直接搬 `feature.similar[]`（已含 score + sharedBasenames，阈值 0.2）。
     - `call`：从既有**调用边/同层连通**聚合（复用几何层/调用边数据，避免重复解析）。
   - `limitations` 沿用 feature_map 的，原文展示。

2. **`bakeSandboxView(dsl, brickBag)` → 渲染**（新增）
   - 在 html_renderer 内新增沙盘渲染函数（级联下钻 + 保形聚类 + 连线），**复用**既有聚合 `contains`/调用边/图层着色引擎。
   - 沙盘不是第 6 张孤儿画布：它与 feature_tree 画布共用渲染引擎，只是把"社区"换成"积木(功能)+三侧"。

3. **MCP 工具**：`render_dsl` 支持沙盘模式；`manage_feature` 暴露「沙盘视图 / 屎山重构(选积木跑 refactor_pipeline) / 问题清单」入口；沿用审批/乐观锁与「定稿同步」。

### 反模式红线（务必避免）

- ❌ 不要为沙盘复制一份「解析→建图→布局→渲染」——只在**积木组装**和**沙盘渲染**新增，解析/分层/死码/布局全部复用。
- ❌ 不要改 `feature_map` 的判定字段（side/score/家族/废弃）去硬套积木格式——那是**注释层**的判定真源；积木只是它的投影。
- ❌ 不要丢掉 `limitations` 免责声明——相似/废弃全是启发式，需人确认，工作台必须展示"这是建议不是确证"。

---

## 5. 真实数据样例（design-canvas，已跑出，作为设计窗口的落地数据）

- meta：`project_dir=D:\project_develop\design-canvas`，`source_root=…\src`，`scanned_files=152`，`langs=["ts"]`，**积木 7 块**。
- 积木清单（约）：
  - `camera`：backend1 / shared13
  - `daemon`：backend1 / shared3；**similar→root 0.33**；deadImports 1
  - `db`：backend3；deadImports 1
  - `dsl`：shared11
  - `renderer`：**frontend14**
  - `root`：backend2 / shared1；**similar→daemon 0.33**；deadImports **5**
  - `tools`：**shared103**；**families: derive(7), ast(3), dead(3), trace(3)**；deadImports 4
- 一图看懂：`tools` 是最大积木(103 共享文件)，内有 `derive(7)` 等**重复实现家族**（典型 AI 重复实现而非扩展的症状）；`root↔daemon` 是唯一相似对(0.33)；`root` 死 import 最多(5) → 可靠的「屎山重构」首个候选积木。
- limitations：功能=首层目录；前端/后端=路径启发式；相似=基名重叠启发式；废弃=死 import 聚合(保守)。**全部需人确认。**

---

## 6. 与既有 feature-map-viz-spec 的关系

- `feature-map-viz-spec.md` 讲「把 feature_map 当作标注层长在 feature_tree 画布上」——方向被本契约**升级**：不再是"画布"，而是整个**工作台外壳**；数据也不再是"标注层"，而是**积木集合(BrickBag)**。
- 判定逻辑（§2 各字段）不变，变的只是：**产出一份积木集合，喂给工作台外壳**。
- 两个 spec 以本文为准；如并存，请并入一处，避免双头误导。