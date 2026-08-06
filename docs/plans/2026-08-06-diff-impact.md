# Diff Impact Analysis（变更影响分析）

> 类型：开发窗口实施单 · 创建：2026-08-06 · 优先级：高
>
> 来源：[evolution.md](../evolution.md) §6.3 路线图序号 4——“Diff Impact Analysis（变更影响范围追溯）”，借 Understand Anything 的 `/understand-diff`。选中它的理由见 README 路线图阶段 16 讨论结论：它直接吃已完成的调用边（序号 3）+ SQLite 缓存（序号 1），边际成本最低、杠杆最高，且产物肉眼可验证。

## 0. 目标

给 `consistency_check` 增加"变更影响分析"能力（或独立工具 `diff_impact`）：给定一组**已变更文件**，沿**调用边**反向追溯 → 找出"这次改动波及了哪些节点/函数" → 在渲染图上**标红**受影响范围，并可与动画系统联动（受影响节点粒子流变红）。

解决的核心问题：合并/评审时"我改了 A，谁会受影响？"——从人工大脑里推演，变成器材一眼可见。

## 1. 数据源（全部已就位，零新增数据管线）

| 数据 | 位置 | 说明 |
|---|---|---|
| 调用边 | SQLite `edges` 表 `kind='call'` | 同文件函数级（[symbols.ts:192](../src/db/symbols.ts#L192)）+ 跨文件（`resolveCrossFileCalls`，`metadata.cross=true`，[symbols.ts:338](../src/db/symbols.ts#L338)） |
| 符号节点 | SQLite `nodes` 表 | 符号 id = `"<file>#<qualified_name>"`，含 `file_path` / `qualified_name` / `start_line` |
| 文件 → DSL 节点 | feature 的 `semantic.files[]` | 相对路径 → DSL 文件节点 id 的映射 |
| 变更文件清单 | 调用方传入（`changed[]`） | 后续可对接 git diff 自动取（见 D4） |

**关键映射**：SQLite 调用边是**符号级**，DSL 渲染图主要是**文件级**节点。Diff Impact 在符号级图上做 BFS，再按 `file_path` 聚合回文件节点标红。

## 2. 算法

输入：`feature` + `changedFiles: string[]`（相对项目根的路径）+ 可选 `direction`（`'callers'`|`'callees'`|`'both'`，默认 `'callers'`）+ `maxDepth`（默认 3）。

```
1. 打开 feature 指向项目的 cache.db（getProjectCacheDb）
2. 直接受影响集 = 所有 file_path ∈ changedFiles 的符号节点 + 这些文件对应的 DSL 文件节点
3. 以直接受影响集为种子，按 direction 沿 kind='call' 边做有向 BFS，深度 ≤ maxDepth：
   - callers：找"调用了受影响符号"的符号（反向边 source→target 中 target ∈ 受影响）
   - callees：找"被受影响符号调用"的符号（正向边）
4. 结果聚合到文件级：受影响符号 → 其 file_path → DSL 文件节点 id
5. 输出：
   - impacted 节点 id 集（DSL 文件级）+ 每个节点的影响程度（直接/间接 + 深度）
   - 受影响符号清单（file:line + qualified_name + 调用来源）
   - 文本报告（给 LLM / 人读）
```

只读，不修改 DSL。与 `consistency_check` 逐文件 API 匹配正交：一个是"这文件对不对"，一个是"这个改动波及谁"。

## 3. 阶段划分（每阶段一个可验证产物，跑通再走下一步）

### D1：工具侧纯逻辑（`diff_impact`）

- 在 [tools/](../src/tools/) 新增 `diff_impact.ts`，实现上述算法（复用 `symbols.ts` 的节点/边查询，不重复发明 SQL）
- 暴露为 MCP 工具 + serve.ts 端点 `/api/diff-impact`
- 写测试（`tests/tools/diff_impact.test.ts`）：构造小图，验证 callers/callees/both、深度截断、跨文件边、changed 文件不存在时降级

**验证清单（D1，肉眼验收）**：
- [ ] 对 `self_analyze`（或用 ai_base 缓存）跑一个冒烟脚本：改一个文件（如 `db.ts`），输出受影响文件/函数清单
- [ ] 清单符合直觉：改 `db.ts` 应波及"import 了 db 的调用方"，而不是无关文件
- [ ] 测试通过 + tsc 零错误

### D2：渲染标记（标红）

- 渲染器接受一个 `impacted` 节点/边集合（经 DSL 注入或 serve.ts），受影响节点/边加 `.impacted` 视觉态（红色描边/填充），图例新增"受影响"说明
- 点击受影响节点 → 面板列出"它被谁调用 / 影响谁"（复用 `focusKeyNodes` 那种面板样式，[scripts.ts:1318](../src/renderer/scripts.ts#L1318)）

**验证清单（D2，肉眼验收）**：
- [x] 浏览器截图：改文件后，受影响节点/边标红，图例有说明（`scripts/_d2_verify.py` 全绿：面板弹出、3 节点标红（1 直接 2 间接）、1 边标红、清单内容与 D1 一致、点行跳转正常）
- [x] 点击受影响节点弹出影响清单面板，内容与 D1 文本报告一致

> 实现说明：渲染器工具栏新增"🖍 影响"按钮 → 输入面板（文件清单 + 方向 + 深度）→ `POST /api/diff-impact` → 受影响节点 `.impacted`/`.impacted-direct`/`.impacted-indirect` 标红 + 边 `.impacted` + 右侧影响清单面板（`state.dsl_node_id` 经 `semantic.files` 权威映射）。调试中修复两处：① `setupDiffImpact` 漏定义导致按钮无响应；② 内联脚本里 `\n` 被外层模板字符串解释成字面换行（placeholder 与 split 正则），需双转义 `\\n`。

### D3：动画联动（可选，低优先级）

- 受影响节点的粒子流默认变红（呼应"受影响"语义），未受影响正常色
- 依赖动画引擎的 flow 着色扩展点

**验证清单（D3，肉眼验收）**：
- [x] gif/截图：受影响节点粒子流红色，其余正常（`scripts/_d3_verify.py`：动画引擎新增 `impactedFlowColor()`（发射时读边 `.impacted` 类）+ `__animV2__.repaintImpacted()`（重绘已发射粒子），scripts.ts 标红后调用。实测受影响边 `dep_tools_serve_ts_tools_diff_impact_ts` 上 2 个粒子全部变红 `#ff5252`）

### D4：对接 git diff（端到端）

- serve.ts 或工具内可自动取 `git diff --name-only <base>` 得到 changedFiles，省去手动传
- 一键"本次未提交改动波及谁"

**验证清单（D4，肉眼验收）**：
- [x] 在真实仓库改一行 → 打开图 → 受影响范围自动标红，无需手填文件清单（`scripts/_d4_verify.py`：serve 新增 `GET /api/git-diff`（`git diff --name-only` + `--cached` + 未跟踪文件），渲染器输入面板新增「📡 从 git diff 取」按钮 → 自动填充并一键分析标红。实测 git 检出 37 个改动文件 → 10 个受影响节点标红）

> 非 git 仓库时 `/api/git-diff` 返回空清单 + 提示文案，可回退手动填写。

## 4. 回归风险

| 项 | 风险 | 缓解 |
|---|---|---|
| cache.db 未生成/未同步 | diff_impact 拿不到调用边 | 检测无 `kind='call'` 边时明确提示"先 import_project 建缓存"；不影响 consistency_check 现有路径 |
| 符号级→文件级聚合丢精度 | 同文件内多函数影响被合并 | 报告里保留符号级明细，渲染图用文件级标红（可接受，与现有图粒度一致） |
| 新工具注册 | MCP 工具列表继续膨胀 | 与收敛大方向冲突时，先并入 `consistency_check` 的 `changed` 参数（evolution.md 规划的形态），不新增独立工具 |

## 5. 与其他实施单的关系

- 依赖：序号 1（SQLite 缓存 ✅）、序号 3（调用边 ✅）——均为已完成项
- 与 [consistency.ts](../src/tools/consistency.ts) 正交；与 `/api/focus`（LLM 选点）无冲突
- 完成后在 evolution.md §6 序号 4 标注 ✅，并更新 README 路线图阶段 16

## 6. 建议实施顺序

先 **D1**（纯逻辑 + 测试 + 冒烟，产物是文本清单）→ 确认效果后再 D2（标红）→ D3/D4 视价值排期。D1 单独跑通即证明"变更→影响范围"链路成立，是最小可验证闭环。