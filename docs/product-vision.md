# design-canvas 产品化展望

> 类型：展望文档 · 创建：2026-07-30 · 状态：等主要功能完成后启动
>
> 定位：本文档不是实施单，是 design-canvas 从"能用的 MCP server"走向"好用的产品"的路线图。
> 触发条件：[evolution.md](./evolution.md) 路线图序号 1-15 主体完成后启动。
>
> 审计产物：本文档基于 2026-07-30 的产品化 UX 审计，覆盖 7 个维度 12 个改进点。

## 0. 现状定位

design-canvas 当前处于 **"开发者可用"阶段**：

- ✅ 核心闭环跑通（DSL → HTML → 双向编辑 → LLM 迭代）
- ✅ 37 个 MCP 工具分 11 组，写操作收敛为 update_feature
- ✅ 自包含 HTML 零依赖，可邮件分发
- ✅ 动画系统 L0-L4.5 完成
- ⚠️ 渲染产物在 188 节点规模下卡顿（见 [drag-perf-diagnosis](./plans/2026-07-30-drag-perf-diagnosis.md)）
- ⚠️ 布局字母序导致边纠缠（见 [layout-edge-driven](./plans/2026-07-30-layout-edge-driven.md)）
- ❌ 移动端/触屏完全不支持
- ❌ 无首次引导、无快捷键速查、无导出图片
- ❌ 无鉴权、无版本迁移、无空状态

**目标**：从"开发者可用"走向"非开发者好用"——让 LLM 协作开发之外的用户（设计师、PM、评审人）也能无门槛使用。

## 1. 产品化三维

```
           体验维度
              ↑
              │
   可访问性 ──┼── 可分发性
              │
              ↓
           可靠性维度
```

| 维度 | 含义 | 当前 | 目标 |
|---|---|---|---|
| 可访问性 | 谁能用？触屏/无障碍/引导 | 仅桌面+鼠标 | 全设备 + 无障碍 + 首次引导 |
| 可分发性 | 怎么分享？图片/链接/嵌入 | 仅 HTML 文件 | SVG/PNG/链接/iframe |
| 可靠性 | 会不会丢数据/被攻击？ | localStorage 无迁移 + serve 无鉴权 | 版本迁移 + 鉴权 + 错误定位 |

## 2. 可访问性（Accessibility）

### 2.1 触屏支持 ★

**现状**：[scripts.ts](../src/renderer/scripts.ts) 全部用 `mousedown/mousemove/mouseup`，触屏完全不响应。

**目标**：平板/手机可拖拽节点、框选、缩放。

**路径**：Pointer Events 统一鼠标/触屏/笔。把 `mousedown` → `pointerdown` 等，加 `touch-action: none`。预计 30 行覆盖 90% 场景。

**验证**：iPad 打开 self_analyze.html，能拖节点、能双指缩放。

### 2.2 prefers-reduced-motion 适配 ★

**现状**：12 个 `@keyframes` 强制播放，无减弱动画选项。

**目标**：前庭功能障碍/晕动症用户可关闭动画。

**路径**：3 行全局 CSS：
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

**验证**：系统设置开启"减弱动画"，星图粒子流停止。

### 2.3 首次引导 + 快捷键速查

**现状**：新用户打开 HTML 不知道能拖、能框选、能撤销。快捷键只藏在代码注释。

**目标**：
- 首次打开显示 3 步浮层（拖拽 / 搜索 / 撤销），`localStorage.onboarded` 记忆
- `?` 键弹出快捷键速查表浮层

**路径**：复用现有 [maskFadeIn 动画](../src/renderer/styles.ts#L1127) + 中央卡片。预计 50 行。

**验证**：清 localStorage 后打开，显示引导；按 `?` 弹出速查表。

### 2.4 空状态引导

**现状**：`create_feature` 后画布空白，无下一步提示。

**目标**：画布为空时显示中央卡片："让 LLM 调用 render_dsl 或 update_feature 添加节点"，附 3 个示例 DSL 片段（可复制）。

**路径**：检测 `dsl.geometry.nodes.length === 0` 时渲染引导卡片。预计 30 行。

## 3. 可分发性（Distributability）

### 3.1 导出 SVG / PNG ★

**现状**：只支持导出 JSON（[scripts.ts:3593](../src/renderer/scripts.ts#L3593)）。用户想截图发 IM 只能用系统截图工具。

**目标**：
- 工具栏加"导出图片"按钮
- SVG：直接 `XMLSerializer` 序列化 `<svg>`（几行）
- PNG：`svg → Image → canvas → toDataURL`（约 40 行，无外部依赖）

**验证**：导出 PNG 贴到 IM 群里，画质清晰。

### 3.2 分享链接（serve 场景）

**现状**：serve 在跑时，用户只能手动拼 URL。

**目标**：工具栏加"复制分享链接"按钮，生成 `http://localhost:PORT/?feature=xxx`，剪贴板写入。

**路径**：`navigator.clipboard.writeText`。约 10 行。

**前置条件**：serve 需支持 `?feature=xxx` query 参数加载对应 DSL（当前未支持，需补）。

### 3.3 iframe 嵌入

**现状**：自包含 HTML 可 iframe，但无优化。

**目标**：支持 `?embed=1` 模式——隐藏工具栏/侧边栏，只保留画布，供文档/Notion 嵌入。

**路径**：URL 参数检测 + CSS 隐藏。约 15 行。

## 4. 可靠性（Reliability）

### 4.1 localStorage 版本迁移 ★

**现状**：[scripts.ts:380-383](../src/renderer/scripts.ts#L380) 直接 `JSON.parse(localStorage.getItem(key))`，无版本检查。DSL schema 升级后旧缓存会覆盖新数据。

**目标**：localStorage 存储 `__version` 字段，启动时检查，不匹配则丢弃并提示。

**路径**：
```javascript
const SCHEMA_VERSION = 3;
function loadLocal() {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  const data = JSON.parse(raw);
  if (data.__version !== SCHEMA_VERSION) {
    localStorage.removeItem(key);
    toast('DSL schema 已升级，本地缓存已清除', 'warn');
    return null;
  }
  return data;
}
```
约 20 行。

**触发场景**：每次 DSL schema 变更（如加 lines 字段）时 bump SCHEMA_VERSION。

### 4.2 撤销栈改增量 diff

**现状**：[scripts.ts:106](../src/renderer/scripts.ts#L106) 每次 `JSON.stringify(dsl)` 整个 DSL，50 份 = 14.5MB 常驻内存（self_analyze 规模）。

**目标**：撤销栈只存操作 diff（如 `{op:'move', id, dx, dy}`），撤销时反向应用。

**路径**：
- v1（简单）：`structuredClone(dsl)` 替代 `JSON.stringify`，约 3x 快
- v2（彻底）：操作记录器，在 update_feature 各 op 入栈前记录 reverse op，约 80 行

**关联**：与 [drag-perf-diagnosis.md P3](./plans/2026-07-30-drag-perf-diagnosis.md) 合并实施。

### 4.3 serve 鉴权 + 127 绑定

**现状**：[serve.ts:446](../src/tools/serve.ts#L446) CORS `*` 全开，无 token、无 host 绑定、无 rate limit。

**目标**：
- 默认只监听 `127.0.0.1`（现在 `listen(port)` 是双栈）
- 可选 token 鉴权（`?token=xxx` 或 `Authorization` header）
- README 加安全警告"勿在公网暴露 serve"

**路径**：约 15 行代码 + README 段落。

### 4.4 DSL 校验错误定位

**现状**：`validateDSLJson` 错误信息通常是"schema 校验失败"，不含行号/字段路径。

**目标**：校验失败返回 JSON Pointer（如 `/geometry/nodes/3/label`）+ 行号。

**路径**：改 validator，捕获 ajv 错误的 instancePath。约 40 行。

**价值**：LLM 输出 290KB DSL 时，一个字段类型错误能快速定位。

## 5. 体验细节（UX Polish）

### 5.1 alert/prompt/confirm → toast/内联编辑

**现状**：6 处浏览器原生弹窗（[scripts.ts:2601,2614,2630,2657,2659,3183](../src/renderer/scripts.ts#L2601)）。

**目标**：
- 提示类（alert）→ 复用现有 [toast](../src/renderer/scripts.ts#L522)
- 输入类（prompt）→ 内联编辑器（双击节点直接编辑 label）
- 确认类（confirm）→ 内联确认浮层（不阻塞）

约 60 行。

### 5.2 搜索高亮 + 循环跳转

**现状**：[scripts.ts:3290](../src/renderer/scripts.ts#L3290) 搜索只在 Enter 时精确 find，无模糊匹配、无高亮、无下一个。

**目标**：
- 输入即搜（debounce 200ms）
- 所有匹配项高亮（复用 [searchPulse 动画](../src/renderer/styles.ts#L1112)）
- Enter 循环跳转下一个匹配

约 40 行。

### 5.3 控制台日志分级

**现状**：正常流程日志（`console.log('DSL 已同步')`）与错误日志混用，无开关。

**目标**：加 `state.debug` 开关（URL `?debug=1` 启用），正常日志用 `if (state.debug) console.log`。约 10 行。

## 6. 优先级与触发条件

### 6.1 触发原则

本文档不立即实施。触发条件：

1. [evolution.md](./evolution.md) 路线图序号 1-15 主体完成
2. [drag-perf-diagnosis](./plans/2026-07-30-drag-perf-diagnosis.md) + [layout-edge-driven](./plans/2026-07-30-layout-edge-driven.md) + [fix-dogfood-bugs](./plans/2026-07-30-fix-dogfood-bugs.md) 三个修复单落地
3. 用户反馈"核心功能够用了，想优化体验"

### 6.2 实施批次

| 批次 | 内容 | 触发 |
|---|---|---|
| 批次 1：触屏 + 无障碍 | #2.1 触屏 + #2.2 reduced-motion + #2.3 引导 | 核心功能完成后立即 |
| 批次 2：数据安全 | #4.1 版本迁移 + #4.2 撤销栈 + #4.3 鉴权 | 与卡顿修复合并 |
| 批次 3：分发能力 | #3.1 导出图片 + #3.2 分享链接 + #3.3 embed | 用户反馈"想分享"时 |
| 批次 4：UX 打磨 | #5.1 toast + #5.2 搜索 + #5.3 日志 + #2.4 空状态 | 顺手做，无紧迫性 |

### 6.3 不做什么（产品化阶段）

- **不做账号系统 / 云同步**——design-canvas 是本地工具，不上云
- **不做多人协作 / 实时同步**——SSE 已满足"LLM 改了浏览器刷新"场景，多人编辑超出定位
- **不做插件市场**——MCP 协议已是扩展机制，不再加层
- **不做主题编辑器**——现有 [star 主题](../src/renderer/styles.ts) + 可配置色板够用，编辑器过度设计
- **不做移动端原生 App**——自包含 HTML + 触屏支持已覆盖移动场景

## 7. 度量指标

产品化阶段的成功标准（非硬性 KPI，仅供参考）：

| 维度 | 指标 | 目标 |
|---|---|---|
| 可访问性 | iPad 能完成拖拽+缩放 | 是 |
| 可访问性 | 系统减弱动画后无眩晕反馈 | 是 |
| 可访问性 | 新用户首次引导后知道 3 个核心操作 | 是 |
| 可分发性 | 导出 PNG 贴 IM 清晰可读 | 是 |
| 可靠性 | DSL schema 升级后用户不丢数据 | 是 |
| 可靠性 | serve 默认不暴露公网 | 是 |
| 性能 | 188 节点拖拽帧时间 | < 30ms |
| 性能 | 188 节点松手无卡顿 | 是 |

## 8. 与现有文档的关系

| 文档 | 关系 |
|---|---|
| [README.md](../README.md) | 面向用户的产品介绍，产品化完成后需同步更新特性列表 |
| [evolution.md](./evolution.md) | 功能演进路线图，本文档是其后续阶段 |
| [design.md](./design.md) | 架构决策记录，产品化不得违反其零依赖/自包含原则 |
| [animation-design.md](./animation-design.md) | 动画设计文档，#2.2 reduced-motion 是其补充 |
| [plans/](./plans/) | 当前修复单，产品化的前置条件 |

## 9. 开放问题（待讨论）

以下问题暂无定论，留待产品化启动时讨论：

1. **是否需要"只读模式"**——分享给评审人时，评审人只能看不能改。当前 HTML 总是可编辑。
2. **是否需要版本对比**——LLM 改了 DSL 后，人想看"改了什么"。当前无 diff 视图。
3. **是否需要节点批注讨论**——评审人在节点上留言，LLM 读取回复。当前只有单次标注。
4. **是否支持 LaTeX / 公式节点**——算法/数据流场景可能需要数学表达。
5. **是否做 VSCode 插件**——vscode 内嵌预览。当前是 MCP server + 浏览器，插件是另一条路。

这些问题不影响批次 1-4 的实施，但可能影响长期产品形态。
