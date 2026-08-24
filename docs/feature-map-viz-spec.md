# feature_map 数据契约与可视化建议

> 本文档写给**可视窗口的重新设计者**：数据已用 `feature_map` 算好（纯数据，库里零展示逻辑），
> 新画布要怎么画、画什么、以及该重用决定性画布的哪些精华，都记在这里。
>
> 一句话：**新画布不从头造，而是把这份聚类数据当作标注层，长在既有 feature_tree 画布的精华上。**

---

## 1. 数据从哪来 / 怎么再生成

- 实现：`src/tools/feature_map.ts` 的 `buildFeatureMap({ project_dir, source_root? })`。
- 它是**纯计算**：不写库、不渲染、零副作用，返回一个 `FeatureMapResult` 对象。
- `source_root` 缺省 = `project_dir`；通常传源码根（如 `…/src`）以"功能=首层目录"切分。
- 命令样例（临时脚本，自行封装）：

```ts
import { buildFeatureMap } from '../src/tools/feature_map';
const data = buildFeatureMap({ project_dir: process.cwd(), source_root: 'src' });
console.log(JSON.stringify(data, null, 2));
```

---

## 2. 数据形态（唯一真相源 = `file_map` 扁平明细）

```ts
interface FeatureMapResult {
  file_map: FeatureMapEntry[];   // ① 扁平文件级明细（新画布的骨架原子）
  features: FeatureMapFeature[]; // ② 功能级聚合 + 标注
  scannedFiles: number;          // 参与切分的源文件数
  meta: FeatureMapMeta;          // ③ 元信息（工程定位/语言/规模）
  limitations: string[];         // ④ 规则说明（务必展示给用户看，别藏）
}
```

### ① `file_map[i]` —— 每个文件一行，前端窗口据此画"文件节点"

```ts
interface FeatureMapEntry {
  file: string;            // 相对 source_root 的路径（唯一 key）
  feature_id: string;      // 归属功能 id（= source_root 下首层目录段；根文件 'root'）
  side: 'frontend'|'backend'|'shared'; // 前端 / 后端 / 通用
  layer: string;           // 架构层 id（复用 layer_detect，如 'ui'/'api'/'service'/'data'…）
  dead_sources: string[];  // 该文件内检测到的死 import 源（废弃证据，可空）
}
```

### ② `features[i]` —— 功能级聚合 + 三样标注

```ts
interface FeatureMapFeature {
  id: string;                     // 功能 id（= file_map 的 feature_id）
  name: string;                   // 显示名（当前 = id）
  frontend: string[];             // 该功能下的前端文件（相对 source_root）
  backend: string[];              // 后端文件
  shared: string[];               // 通用文件
  similar: {                      // 相似功能（跨功能标注）
    featureId: string; score: number; sharedBasenames: string[];
  }[];
  repeatedFamilies: {             // 功能内"重复实现"家族（同词根平行管线，如 derive_*）
    root: string; files: string[];
  }[];
  deprecation: {                  // 废弃证据（该功能内死 import 聚合）
    deadImportSources: number;
    deadSources: { source: string; files: string[] }[];
  };
}
```

### ③ `meta` / ④ `limitations`

- `meta`: `{ project_dir, source_root, scanned_files, features, langs }`——前端窗口据此定位与说明（多语言混项目 `langs` 会并列）。
- `limitations`（务必展示）:功能=首层目录、前后端=路径启发式、相似功能=文件重名启发式、废弃=死 import 聚合(保守)。**这些是启发式，不是确证**，需人确认可合并/可废弃。

---

## 3. 可视化建议——该重用决定性画布的哪块精华（别重造）

决定性画布的精华在 `src/renderer/html_renderer.ts` 的 `bakeFeatureTreeView`：

1. **项目 → 功能(ft:) → 社区(ct:) → 文件** 的层级骨架，用 `contains` 边驱动**逐级折叠下钻**。
   → 新画布应沿用这个层级思想，只是把"社区"映射为 **前端/后端/通用**（`file_map.side`）。
2. **保形聚类**（L607–L703）:按"文件相对质心的偏移 × 等比缩放"排布，**保留原图真实拓扑**，
   下钻到社区看到的是真实文件簇而非一张合成新图。
   → 新画布的"前端文件/后端文件同挂一个功能下"，就该是这个形态，别退化成均匀圆环。
3. 聚合 `contains` 边之外，保留**文件级调用边**参与"功能↔功能 / 社区↔社区"连线。

### 三样标注怎么画（feature_map 独有增量）

| 数据 | 建议视觉 |
|---|---|
| `side`（前端/后端/通用） | 社区/文件节点**配色**，前端蓝、后端橙、通用灰（与主题联动） |
| `repeatedFamilies` | 同家族文件**描边高亮**或用同色系 **contains** 子容器标出（derive_* / *_ops 等成族平行管线） |
| `similar[]` | 功能节点之间连**虚线条**，线宽 ∝ `score`，tooltip 列共享基名 |
| `deprecation` | 命中的文件/功能加**红角标或灰化**，tooltip 列 `dead_sources`；`deadImportSources` 高→可废弃候选 |

### 交互建议（沿决定性画布已有交互）

- 点击功能 → 下钻到社区(前后端)；再点击社区 → 展开真实文件簇。
- 悬停标注 → 显示证据（哪几个文件重名 / 哪几个死 import 源）。
- 一个开关切换"标注层显隐"，让纯分层图与"屎山标注图"可对比。

---

## 4. 反模式（务必避免）

- ❌ **不要**把这张聚类数据做成第 6 张孤儿画布/独立 DSL，复制一份"解析→建图→布局→渲染"。
- ❌ **不要**改 record 的 `file_map` 语义去硬套 `dsl.feature_tree` 的 `{feature_id, community_id}` 格式——
  那是旧画布的私有结构；本契约以 `feature_api.file_map` 为准，可视窗口按新契约画。
- ✅ 本数据是"标注层"，落在决定性画布之上：分层/下钻/保形聚类的**渲染引擎复用**，
  新画布只新增"标注怎么呈现"。

---

## 5. 约定与边界

- 废弃证据 = 复用 `detectDeadImports`(TS/Go) + `detectDeadPyImports`(py) 的保守规则：宁多报活、不误删。
- 相似功能阈值 `score >= 0.2`、重复家族 ≥ 3 个同根文件、剔除测试族——仅供起始，可视窗口可微调展示阈值，但**不改数据的判定字段**。
- 多语言混项目（ts+go+py 并存）会并行命中，`file_map` 已含全部语言文件，前端窗口按 `side`/`layer` 上色即可，不依赖"单主导语言"。