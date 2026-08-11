# Visual Style Handover — design-canvas 设计层视觉风格

## 背景

设计层（`src/renderer/html_renderer.ts`）目前的视觉输出风格偏暗色、厚重，用户体验不够清爽。2026-08-10 经讨论决定：后续开发应改用 **TRAE dynamic-ui skill** 的 SVG 思维导图风格，替代当前的自定义 HTML 渲染方案。

## 核心工具：dynamic-ui skill

TRAE 内置的 `dynamic-ui` skill 可通过 `PureShowWidget` 工具生成内联 SVG 图表，无需任何外部图表库。

### 调用方式

```
1. 加载 skill: Skill(name="dynamic-ui")
2. 调用 PureShowWidget:
   - title: 唯一标识（snake_case）
   - loading_messages: 加载提示文案
   - widget_code: SVG 代码（<svg> 标签开始）
```

### 风格特征

| 特征 | 说明 |
|------|------|
| 配色 | 浅色底 + 紫色主色调（`#7c3aed`），支持 light/dark 主题 |
| 字体 | `system-ui, -apple-system, sans-serif`，14px 正文字体 |
| 边角 | `rx="8"` 圆角卡片，`rx="6"` 小圆角元素 |
| 间距 | 基于 `--spacer-*` 令牌（4/8/12/16/20/24px） |
| 线条 | 1.5px 描边，`stroke-linecap="round"` |
| 箭头 | SVG marker 三角形箭头，`viewBox="0 0 8 8"` |
| 布局 | 水平布局优先，节点 ≤ 6 个，避免拥挤 |
| 数据 | 诚实标注，不夸大，不渲染地图 |

### 参考示例

2026-08-10 生成的弹性面板架构图（`elastic_panel_architecture`）是典型风格：
- 三列布局：注册中心 → 状态管理 → 渲染
- 底部激活来源：自动/Signal/MCP/用户点击
- 每种来源用不同颜色区分
- 箭头连接表示数据流

## 对 design-canvas 的改造方向

### 当前问题

- `html_renderer.ts` 生成深色主题 HTML，视觉沉重
- 动画系统（`animation_engine.ts`）效果不理想
- 右侧 sidebar 卡片信息密度低
- 整体缺乏轻量、清晰的视觉层次

### 改造原则

1. **替换渲染引擎**：从自建 HTML 渲染改为 SVG 思维导图风格
2. **保留数据层**：DSL 结构（`src/dsl/`）和语义层不变，只改视觉输出
3. **复用布局算法**：`dag_layout.ts`、`edge_geom.ts` 等布局计算仍可复用
4. **简化动画**：移除复杂的动画引擎，用 SVG 过渡代替（如有需要）

### 建议文件变更

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/renderer/html_renderer.ts` | 重构 | 输出从 HTML 改为 SVG 字符串 |
| `src/renderer/styles.ts` | 替换 | 采用 dynamic-ui 的 token 体系 |
| `src/renderer/animation_engine.ts` | 简化/移除 | 动画效果不理想，改为 SVG 过渡 |
| `src/renderer/scripts.ts` | 移除 | SVG 不需要运行时 JS |
| `src/tools/render_dsl.ts` | 更新 | 调用新的渲染器 |

### 颜色方案（设计层输出）

```
品牌色: #7c3aed (purple)
辅助色: #0891b2 (cyan), #d97706 (gold), #16a34a (green)
中性色: #1e293b (text), #64748b (muted), #e2e8f0 (border), #f8fafc (surface)
```

## 快速开始

1. 在 TRAE 中加载 `dynamic-ui` skill
2. 阅读 `tokens/visual-tokens.md` 获取完整 CSS 令牌定义
3. 参考 `templates/manifest.json` 查看可复用的模板
4. 调用 `PureShowWidget` 生成 SVG

## 注意事项

- 不要生成 `<!DOCTYPE>`、`<html>`、`<head>`、`<body>` 标签
- 所有主题相关颜色必须引用 CSS 变量，不要硬编码
- 节点文字宽度估算：中文按 8px/字，英文按 8px/字符
- 保持 SVG 在 `viewBox="0 0 720 H"` 范围内
- 避免嵌套滚动、`position: fixed`、全局选择器

---

*本文件由 2026-08-10 讨论生成，后续开发 design-canvas 设计层时请优先参考。*