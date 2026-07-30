# 深度自我分析工作流（deep_self_analyze）

> 类型：开发窗口实施单 · 创建：2026-07-30 · 关联：[evolution.md](../evolution.md) 2.4 / [animation-design.md](../animation-design.md) 10.5

## 1. 背景与审计结论

### 1.1 审计发现

当前 `npm run self-analyze` 跑出的星图（188 节点 / 264 边）信息密度稀薄：

- **56 个文件节点**只有骨架信息——`label = "文件名 · N APIs"`、`responsibility = "目录 — N 个 API（导入自 M 个模块）"`，是统计性描述，不是语义性说明
- **只有 5 个目标**做了深度展开（[self_analyze.mjs](../../scripts/self_analyze.mjs) 的 `CHAIN_TARGETS` 3 个 + `ALG_TARGETS` 2 个）：
  - `tools/import_project.ts`、`tools/derive_chain.ts`、`tools/derive_algorithm.ts` 有 detail 链
  - `importProject()`、`deriveAlgorithm()` 有算法控制流图
- 其余 51 个文件节点既无 detail 层、也无算法 CFG、responsibility 也只是统计串
- 星图上跑的动画是 L0 默认粒子流（沿依赖边周期性流动），没有 L2 数据值标签

### 1.2 动画分层实际进度（纠正文档滞后）

[README.md](../../README.md) 与 [evolution.md](../evolution.md) 2.4 记载"阶段 E 待完成 / L3-L5 待推进"，但 [animation-design.md](../animation-design.md) 8.4 显示实际进度：

| 阶段 | 实际状态 |
|---|---|
| A-E（L0-L2 + conveyor 迁移 + 内置 effect） | ✅ 完成 |
| F（L3 条件分支） | ✅ 完成（28 用例） |
| G（L4 函数绑定） | ✅ 完成 |
| G2（L4.5 异常语义） | ✅ 完成（44 用例） |
| H（L5 反向提取） | ⏳ 计划中 |
| I（播放控制） | ✅ 基础完成 |

**实际已做到 L4.5，只差 L5**。README/evolution 文档需同步更新（独立任务，不在本单范围内）。

### 1.3 用户需求

用户原话："里面之前似乎只是把文件结构列了出来，并没有预想中的每个文件是做什么的介绍，以及里面的算法、数据处理过程等展示。"

需要补全两件事：
1. **每个文件做什么的人话介绍**（semantic.files[].responsibility 字段）
2. **每个文件的算法 / 数据处理过程展示**（detail 层变形链 + 算法 CFG）

## 2. 产品形式决策

### 2.1 不做什么

- **不在 design-canvas 内嵌 LLM 调用**——design-canvas 是 MCP server，不持有 LLM；LLM 标注必须由 client 侧（开发窗口 / agent-shell / Cursor 等）执行
- **不做全量自动语义标注**——路线图序号 5（architecture-analyzer 角色）⏳ 未实现，且即便实现也是启发式推断，不如 LLM 标注准
- **不改 import_project 的 responsibility 生成逻辑**——统计性描述对纯机械扫描是合理的，语义标注是上层职责

### 2.2 做什么：两阶段工作流（混合来源）

依据 [animation-design.md 10.5](../animation-design.md) 的混合来源原则：机械活工具做、语义活 LLM 做。

```
阶段 1（机械活，脚本 scripts/deep_self_analyze.mjs）
  import_project（已有）
    ↓
  全量 derive_detail_chain（对每个有内部调用的文件）
    ↓
  全量 derive_algorithm（对每个文件的入口函数）
    ↓
  输出 LLM 标注任务清单（Markdown）
    ↓
  渲染深度星图（output/self_analyze_deep.html）

阶段 2（语义活，开发窗口 / LLM client）
  读取任务清单
    ↓
  对每个节点用 update_feature 工具回填 responsibility / label
    ↓
  重渲染验证
```

### 2.3 为什么是这个形式

- **符合现有架构**：design-canvas 产出任务清单，LLM client 消费，与 scaffold/backfill 的工作流同构
- **可重跑**：derive_* 工具幂等（节点前缀清理机制），LLM 标注写入 DSL 后重跑不会丢
- **可审计**：任务清单是 Markdown，开发窗口的标注结果可 diff
- **成本可控**：阶段 1 纯本地 AST 解析，秒级；阶段 2 LLM 标注按需触发

## 3. 实施步骤

### 3.1 阶段 1：deep_self_analyze.mjs 脚本

**新增文件**：`scripts/deep_self_analyze.mjs`

**流程**（基于现有 [self_analyze.mjs](../../scripts/self_analyze.mjs) 扩展，独立脚本不复用）：

```javascript
// 伪代码，实施时按现有 self_analyze.mjs 风格写
process.env.DESIGN_CANVAS_HOME = path.resolve('.tmp_self_analyze_deep');
const FEATURE = 'self_analyze_deep';

// 1. import_project（复用，含 cache_db 增量）
const cacheDb = openDb(path.resolve('.design-canvas', 'cache.db'));
const imp = await importProject({ project_dir: 'src', feature: FEATURE, cache_db: cacheDb });
cacheDb.close();

// 2. 全量 derive_detail_chain
//    遍历 import_project 生成的所有文件节点
//    跳过已知会失败的：扁平 API 面文件（无内部函数调用）
//    用 try/catch 收集失败，记入 skipped[]
const dsl = getDSL(FEATURE);
const fileNodes = dsl.geometry.nodes.filter(n => n.type === 'file');
const chainResults = [];
for (const n of fileNodes) {
  const relPath = n.description; // import_project 把相对路径放 description
  try {
    const r = await deriveDetailChain({
      feature: FEATURE,
      node_id: n.id,
      source_path: path.join('src', relPath),
    });
    chainResults.push({ path: relPath, ok: true, steps: r.chain.length });
  } catch (e) {
    chainResults.push({ path: relPath, ok: false, reason: e.message.split('\n')[0] });
  }
}

// 3. 全量 derive_algorithm
//    对每个成功展开 detail 链的文件，取其入口函数跑算法 CFG
//    入口函数从 deriveDetailChain 的 chain[0].name 取
//    再次 try/catch，因为部分函数体可能太简单或语言不支持
const algResults = [];
for (const r of chainResults.filter(r => r.ok)) {
  const chain = (await getDSL(FEATURE)).geometry.nodes
    .filter(n => n.id.startsWith(r.path.replace(/[^a-zA-Z0-9_-]/g, '_') + '__s'))
    .map(n => n.id);
  // 入口函数名需从 deriveDetailChain 返回值取（chain[0].name）
  // 实施时缓存 deriveDetailChain 的返回值，不重读 DSL
  const entryFn = r.entryName; // 需在阶段 1 步骤 2 记录
  try {
    const a = await deriveAlgorithm({
      feature: FEATURE,
      node_id: fileNodeId(r.path),
      function: entryFn,
      source_path: path.join('src', r.path),
    });
    algResults.push({ path: r.path, fn: entryFn, ok: true, stats: a.stats });
  } catch (e) {
    algResults.push({ path: r.path, fn: entryFn, ok: false, reason: e.message.split('\n')[0] });
  }
}

// 4. 输出 LLM 标注任务清单
//    Markdown 格式，每个文件一节，含：
//    - 节点 id（供 update_feature 用）
//    - 当前 label / responsibility
//    - 提取的函数签名清单（来自 semantic.files[].expected_apis）
//    - detail 链步骤名（若已展开）
//    - 占位符 "## 建议标注" 供 LLM 填写
const taskList = buildAnnotationTasks(FEATURE, chainResults, algResults);
fs.writeFileSync('output/self_analyze_tasks.md', taskList);

// 5. 渲染深度星图
const dsl2 = getDSL(FEATURE);
dsl2.theme = 'star';
saveDSL(dsl2);
const html = renderHTML(dsl2, { report: { /* 同 self_analyze + 深度指标 */ } });
fs.writeFileSync('output/self_analyze_deep.html', html);

// 6. 控制台报告
console.log(summary(chainResults, algResults));
```

**关键实现细节**：

- **入口函数名缓存**：`deriveDetailChain` 返回 `chain[].name`，第一步的 chain[0].name 是入口函数名，需记录供第三步 `deriveAlgorithm` 用，不要从 DSL 反推
- **失败容忍**：`deriveDetailChain` 对扁平 API 文件 throw "未解析到函数/方法"，对无内部调用的单节点文件 throw 退化提示——都要 try/catch 收集，不能中断全量流程
- **幂等**：两个 derive 工具都有节点前缀清理（`{node_id}__s` / `{node_id}__alg_`），重跑安全
- **缓存复用**：`cache_db` 用项目根 `.design-canvas/cache.db`（与 self_analyze.mjs 同路径），二次跑命中增量
- **隔离**：`DESIGN_CANVAS_HOME = .tmp_self_analyze_deep`，不碰活态 `design-canvas.json`，跑完清理

**npm 脚本注册**（[package.json](../../package.json)）：

```json
"scripts": {
  "self-analyze:deep": "node scripts/deep_self_analyze.mjs"
}
```

### 3.2 阶段 1 产物：LLM 标注任务清单格式

**输出文件**：`output/self_analyze_tasks.md`

**格式**（每个文件一节）：

```markdown
## tools/import_project.ts

- **节点 id**: `file_tools_import_project_ts`
- **当前 label**: `import_project.ts · 12 APIs`
- **当前 responsibility**: `tools 目录 — 12 个 API（导入自 5 个模块）`
- **函数签名**:
  - `importProject(input: ImportProjectInput): Promise<ImportProjectResult>`
  - `walkFiles(root: string, includeTests: boolean): string[]`
  - `resolveImport(...)`
  - ...
- **detail 链步骤**（已展开）: importProject → walkFiles → toPosix → buildIndex → readGoModules → resolveImport → layoutGroup → rankItems
- **算法 CFG**: importProject() 45步·16分支·13循环

### 建议标注（LLM 填写）

- **label**: `扫描项目目录并解析 Go/TS/Python 依赖，生成骨架 DSL`
- **responsibility**: `项目导入器：递归扫描 src/，tree-sitter 解析符号，推导文件依赖与目录容器层级，输出初始 DSL 供后续迭代`
```

### 3.3 阶段 2：LLM 标注执行（开发窗口职责）

开发窗口读取 `output/self_analyze_tasks.md`，对每个文件：

1. 基于函数签名 + detail 链 + 算法 CFG，写一句话 `responsibility`（人话，非开发者可读）
2. 用 `update_feature` 工具回填：

```json
{
  "op": "update",
  "type": "file",
  "id": "file_tools_import_project_ts",
  "data": {
    "responsibility": "项目导入器：递归扫描 src/，tree-sitter 解析符号，推导文件依赖与目录容器层级，输出初始 DSL 供后续迭代"
  }
}
```

3. 同时可更新节点 `label`（若人话 label 比 "文件名 · N APIs" 更清晰）

**标注原则**（写入任务清单头部供 LLM 参考）：

- 非开发者可读：避免 jargon，用"做什么"而非"怎么实现"
- 一句话长度：≤ 60 字
- 聚焦输入输出：数据进来是什么 → 经过这个文件变成什么
- 不重复文件名：label 已含文件名，responsibility 不再写"import_project 文件用于..."

### 3.4 阶段 2 后：重渲染验证

LLM 标注完成后，重跑 `npm run self-analyze:deep`（或单独渲染步骤），确认：
- 节点 tooltip / 属性面板显示新 responsibility
- 深度星图信息密度提升
- 标注可 diff（任务清单 vs DSL 实际值）

## 4. 验收标准

### 4.1 阶段 1 验收

1. `npm run self-analyze:deep` 一键跑通，无中断
2. `output/self_analyze_deep.html` 生成，节点数显著多于原 188（预期 300+，含 detail + algorithm 节点）
3. `output/self_analyze_tasks.md` 生成，覆盖所有有内部调用的文件（预期 30+ 节）
4. 控制台报告含：成功/失败计数、detail 链总步骤数、算法 CFG 总步骤数
5. 失败文件清单可见（扁平 API 文件、语言不支持文件），失败原因可读
6. 缓存命中率 ≥ 90%（二次跑）

### 4.2 阶段 2 验收（开发窗口自验）

1. 任务清单中 80%+ 文件有 LLM 标注的 responsibility
2. 标注符合"标注原则"（非开发者可读、≤60 字、聚焦输入输出）
3. `update_feature` 调用全部成功，DSL 持久化
4. 重渲染后星图节点 tooltip 显示新标注

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| derive_detail_chain 对扁平文件 throw 中断流程 | 全量 try/catch，失败收集到 skipped[] |
| 入口函数推导不准（pickEntry 偏好长链，可能选错） | 任务清单中标注"自动推导入口"，LLM 标注时可纠正 |
| detail 链节点爆炸（大文件 12 步上限已够，但全量 56 文件可能 500+ 节点） | 渲染时折叠默认展开 main 层，detail 层点击展开 |
| LLM 标注成本（56 文件 × 一句话） | 任务清单分批，开发窗口可分多次标注 |
| 标注与代码漂移（代码改了标注没改） | 后续可加 stale 检测（responsibility 字段 mtime vs 文件 mtime），本单不做 |

## 6. 与路线图的关系

- 本工作流不新增 MCP 工具，只编排现有 `derive_detail_chain` + `derive_algorithm` + `update_feature`
- 路线图序号 5（architecture-analyzer）实现后，阶段 2 的 LLM 标注可部分自动化——但人话 responsibility 仍建议 LLM 终审
- 路线图序号 6（Guided Tours）可消费本工作流的 detail 链作为学习路径素材

## 7. 文档同步（独立任务，可选）

本单实施后，建议同步更新（不在本单范围）：

- [README.md](../../README.md) 开发路线表第 8 阶段：改为"动画系统 L0-L4.5 完成，L5 计划中"
- [evolution.md](../evolution.md) 2.4 节：同步 8.4 实现进度表
- 新增本工作流到 README "开发脚本"段落
