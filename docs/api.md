# design-canvas 接口文档

> HTTP API 是产品的公共契约层：Hub 前端、AI（MCP）、外部脚本共用同一套能力。
> 本文档供前端重构（视觉模型对接）与自动化集成使用。

## 0. 基础约定

- **Base URL**：`http://localhost:3000`（仅绑定本机 127.0.0.1，`npm run hub` 或 `npm run serve` 启动）
- **请求体**：除注明外均为 JSON（`Content-Type: application/json`）
- **错误格式**：非 2xx 时返回 `{ "error": "<人类可读信息>" }`
- **成功格式**：多数接口返回 `{ "success": true, ...结果字段 }`
- **Origin 策略**：写入类接口（save/registry/import/layout/scaffold/mind-map/mmd/chat/dict.ingest）仅接受本机 localhost 来源，否则 403
- **分页**：当前数据量级别下无分页，列表接口一次性返回

## 1. 页面路由（HTML）

| 路由 | 说明 |
|------|------|
| `GET /` | 主页：项目选择器（列项目 + ＋导入按钮，动态渲染） |
| `GET /project/<feature>` | 项目专属页：地图主入口 + 递进分组产物（动态渲染） |
| `GET /tour.html?feature=X` 或 `?features=A,B,C[&tags=t1,t2]` | 产物导览播放器 |
| `GET /explain.html[?map=xxx.html]` | 科普讲解播放器（左地图右字幕，三档角色） |
| `GET /<file>` | `output/` 目录静态产物（`.html`/`.md`/`.svg` 等） |

## 2. 项目与数据

### GET /api/features — 项目列表

主页与项目页的头部数据源。

```json
{
  "features": [
    {
      "feature": "demo_proj",          // 唯一名（^[a-zA-Z0-9_-]+$）
      "title": "demo_proj",            // 人类可读标题
      "files": 12,                     // semantic.files 数量
      "nodes": 34,                     // geometry.nodes 数量
      "language": "ts",                // 主导语言（文件扩展名众数）
      "updated_at": "2026-08-17T12:00:00.000Z"
    }
  ]
}
```

### POST /api/import — 导入项目（浏览器目录上传）

前端用 `<input webkitdirectory>` 选目录，逐文件读文本后整体 POST。服务端把源码持久化到 `.design-canvas/projects/<feature>/`，解析后渲染项目地图并注册产物。

**请求**（body 上限 200MB）：

```json
{
  "files": [
    { "path": "proj/src/a.ts", "content": "..." },
    { "path": "proj/src/b.ts", "content": "..." }
  ],
  "feature": "my_name"        // 可选；缺省取上传首路径的顶层目录名
}
```

> `path` 首段（用户所选文件夹名）会被剥掉再落盘，`proj/src/a.ts` → `.design-canvas/projects/my_name/src/a.ts`。前端应预过滤 `node_modules/`、二进制、>1MB 文件、总量 ≤3000。

**响应**：`{ success, feature, html: "my_name.html", message }`。DSL 会记录 `source_root`，后续巨石体检/影响面等功能据此读源。

### GET /api/load — 读默认 feature 的 DSL

返回完整 `DesignDSL`（见 §8.1）。仅读取 serve 启动项目的默认 feature；一般项目请直接读文件或经 MCP `get_dsl`。

### POST /api/save — 保存 DSL（乐观锁）

**请求**：DSL JSON 全量（须含 `feature` 与 `_dsl_rev`）。
**响应**：`{ success, feature, saved_at, rev }`。
**冲突**：磁盘 rev 已被推进时返回 `409 { success:false, conflict:true, current_rev, message }`——客户端应取最新 base 后 rebase 重提。

### GET /api/registry — 产物注册表

```json
{ "artifacts": [ { "path": "demo_proj.html", "feature": "demo_proj", "title": "...", "type": "feature_diagram", "language": "ts", "status": "done", "tags": [], "created_at": "...", "updated_at": "..." } ] }
```

### POST /api/registry — 编辑产物元数据（打标/改名/改状态）

```json
{ "path": "demo_proj.html", "patch": { "title": "新标题", "tags": ["star","核心"], "status": "done", "note": "备注" } }
```

## 3. 换个角度看

### POST /api/mind-map — 生成思维导图

`{ feature, gen_descriptions?: boolean, max_files_per_community?: number }` → `{ success, mind_map, html, message }`。产物自动注册。

### GET /api/mind-map?feature=X[&html=1] — 读思维导图

`html=1` 返回查看器页面（text/html）；否则返回 `{ mind_map }` JSON。未生成时 404。

### POST /api/mmd/chat — 导图问答（只读 Agent）

`{ feature, message, history?: [{role,content}] }` → `{ success, reply, ... }`。

### POST /api/arch-layer — 架构分层

`{ feature, persist?: boolean }` → `{ success, layers: [...], message }`。persist 时结果写回 DSL.layers 供图层着色。

### POST /api/layout/{dag|force|grid} — 布局变换

只改几何层坐标，不动语义。

| 布局 | 参数 |
|------|------|
| dag | `feature, direction?, h_gap?, v_gap?, width?, respect_swimlanes?` |
| force | `feature, repulsion?, stiffness?, damping?, iterations?, node_radius?, width?, height?` |
| grid | `feature, grid_size?` |

### POST /api/diff-views — 设计 vs 实际图级对比

`{ feature, live_dir? }` → `{ success, added, removed, changed, ... }`。

### GET /api/live?feature=X — 读实际 DSL

代码实时快照（`live/` 目录）。未生成时 404（先 rebuild）。

### POST /api/live/rebuild?feature=X — 重建实际 DSL

从 serve 项目当前代码重建实际 DSL 到 `live/`，成功后广播 SSE `dsl-changed`（source=watch）。→ `{ success, files, symbols, cache }`。

## 4. 深入分析

### POST /api/monolith — 全项目巨石体检（只读）

三选一定位源码：`{ feature }`（推荐，自动用 DSL.source_root）｜`{ project_dir }`｜`{ files: [path...] }`；可选 `warn_lines`(默认300) / `crit_lines`(默认600) / `max_files`(默认200)。

```json
{
  "success": true, "total_files": 2, "oversized": 1,
  "reports": [
    {
      "path": "src/big.ts", "lines": 700, "status": "critical",   // ok|warning|critical
      "decl_count": 12, "communities": [ { "suggested_name": "big_split_1", "decls": [...], "signatures": [...], "est_lines": 220, "internal_refs": 18 } ],
      "inter_edges": [[0,1,3]], "suggestion": "…"
    }
  ]
}
```

### POST /api/split_plan — 单文件拆分任务单

`{ path: "renderer/scripts.ts" }`（相对 serve 项目 src/）→ `{ ok, markdown, filename, lines, communities }`。markdown 可直接喂 LLM 执行拆分。

### POST /api/diff-impact — 变更影响面

`{ feature, project_dir?, changed: [file...], direction?: "both"|"up"|"down", max_depth? }` → 影响节点/边清单。

### POST /api/consistency — 设计↔代码一致性

`{ feature, code_dir? }` → `{ success, matched, missing_in_code, missing_in_dsl, ... }`。

### POST /api/semantic-search — 语义搜索

`{ project_dir?, query, limit?, min_score? }` → `{ success, results: [{ symbol, file, line, score }] }`。未配置 LLM 时自动降级 FTS。

### POST /api/language-concepts — 语言概念识别

`{ project_dir?, concepts?: [...], files?: [...], limit? }` → 概念命中清单。

### GET /api/git-diff — git 改动清单

`{ success, changed: [path...], base, git_ok, message }`。非 git 仓库时 `git_ok:false`，前端转手动输入。

### POST /api/trace-exec — 数据流真实执行

`{ feature, node_id, input_value }` → `{ success, steps: [{ node_id, func_name, status: "ok"|"error", out_value, stdout? }] }`。要求节点已下钻（derive_detail_chain）。

### POST /api/focus — LLM 选关键节点

`{ feature, node_id, user_focus? }` → `{ success, picked: [...], ... }`。需要 LLM 配置。

## 5. 讲解与演示

### POST /api/guided-tour — 生成学习路径

`{ feature, include_deep?, include_containers?, max_steps? }` → `{ success, steps: [...] }`（Kahn 拓扑序）。

### GET /api/tour — 产物导览序列

`?feature=X` 单项目 ｜ `?features=A,B,C` 跨项目串联 ｜ 可选 `&tags=t1,t2` 过滤。

```json
{ "success": true, "feature": "X", "steps": [ { "path": "x.html", "title": "...", "type": "feature_diagram", "feature": "X", "tags": [] } ] }
```

### GET /api/explain?role=newbie|pm|senior — 科普讲解脚本

`{ success, role, steps: [{ title, nodeId, narration, narrations: {newbie,pm,senior} }], persisted }`。已持久化的 LLM 文案优先于内置手写文案。

### POST /api/explain/generate — LLM 生成三档文案

`{ steps?: [{ title, background }] }`（缺省用内置脚本）→ `{ success, generated, failures, persisted_file, note }`。未配置 LLM 时 `success:false` 并保留手写文案。

### 词典（项目术语伪维基）

| 接口 | 入参 | 出参 |
|------|------|------|
| POST /api/dict/query | `{ project_dir?, term? }` | `{ entries, links, aliasesIndex, entry, global_file, project_file }` |
| POST /api/dict/highlight | `{ project_dir?, text }` | `{ pieces: [...] }`（命中词条切分） |
| POST /api/dict/ingest | `{ term, project_dir?, project_hint?, dry_run? }` | LLM 分类生成词条；`dry_run:true` 仅预览 |
| POST /api/dict/generate | `{ term }` | 仅生成不落库 |

## 6. 工程动作

### POST /api/scaffold — 脚手架生成

`{ feature, output_dir?, overwrite?, ui_framework? }` → 生成文件清单。`output_dir` 必须落在允许的项目根内（否则 403）。

### GET /api/camera/log?file=<path>&all=1 — Camera 异常日志

需启动前设置 `CAMERA_EVENTS_FILE`，否则 424。

### POST /api/camera/judge — Camera 事件判定

`{ events: [...] }`；`?text=1` 返回人类可读报告；`?use_llm=1` 用 LLM 判定。

## 7. 实时（SSE）

### GET /api/events

`text/event-stream`，长连接。事件：

| event | data | 触发 |
|-------|------|------|
| `connected` | `{message}` | 连接建立 |
| `dsl-changed` | `{ feature, source: "browser"\|"watch"\|"mcp", timestamp }` | DSL 保存/实际 DSL 重建（source=browser 时提交方应跳过自刷新） |
| `project-imported` | `{ feature, at }` | 新项目导入完成 |

## 8. 核心数据结构

### 8.1 DesignDSL（顶层）

```jsonc
{
  "id": "imported_demo_proj",
  "type": "feature_diagram",
  "feature": "demo_proj",           // 唯一名
  "title": "…",                     // 人类可读标题
  "source_root": "D:\\…\\.design-canvas\\projects\\demo_proj",  // 源码快照根（读源类功能的锚点）
  "_dsl_rev": 3,                    // 乐观锁修订号
  "status": "done",
  "theme": "blue",
  "geometry": { "layout": "free", "width": 2000, "height": 1200, "nodes": [...], "edges": [...] },
  "semantic": { "files": [ { "id": "file_x", "path": "src/a.ts", "apis": [...], "dependencies": [...], "status": "done" } ] },
  "layers": [...],                  // arch-layer 结果
  "feature_tree": { ... }           // 功能树（下钻导航）
}
```

### 8.2 Artifact（注册表条目）

`{ path, feature, title, type, language, status, tags: string[], note?, created_at, updated_at }`

前端分组建议：`type === "feature_diagram"` → 主地图；标题/标签含「树/导图/mind」→ 换角度；含「分析/拆分/影响/报告」→ 深入分析；含「讲解/导览/demo/tour」→ 讲解演示；空组整组隐藏。

### 8.3 FileMonolithReport

见 §4 `/api/monolith` 响应示例。

## 9. 能力速查表

| 需求 | 接口 |
|------|------|
| 列项目 | GET /api/features |
| 导项目 | POST /api/import |
| 看产物列表 | GET /api/registry |
| 出思维导图 | POST /api/mind-map |
| 看架构分层 | POST /api/arch-layer |
| 巨石体检 | POST /api/monolith |
| 拆分任务单 | POST /api/split_plan |
| 改动影响面 | GET /api/git-diff + POST /api/diff-impact |
| 生成导览 | POST /api/guided-tour |
| 播放导览 | GET /tour.html |
| 实时刷新 | GET /api/events (SSE) |
