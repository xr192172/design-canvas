export function buildStyles(): string {
  return `
/* ==== 主题变量 ====
 * 每主题提供：primary 家族（含 rgb 三元组供 rgba() 组合）、面板/背景/卡片/边框、
 * input-bg/hover/text-dim 语义令牌、edge 默认色。新增主题只需复制块改色值。
 */
:root,
[data-theme="blue"] {
  --theme-primary: #4f8df7;
  --theme-primary-rgb: 79, 141, 247;
  --theme-primary-dark: #3a6fd8;
  --theme-primary-light: #8ab4ff;
  --theme-secondary: #111c36;
  --theme-background: #0a1128;
  --theme-card-bg: #152141;
  --theme-panel-bg: rgba(17, 28, 54, 0.96);
  --theme-border: #243459;
  --theme-input-bg: #0e1830;
  --theme-hover: #223a66;
  --theme-text: #e8eefc;
  --theme-text-sub: #8ea3c8;
  --theme-text-dim: #5a6f94;
  --theme-accent: #5ec8f8;
  --theme-accent-rgb: 94, 200, 248;
  --theme-edge: #4f8df7;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
  /* 动画卡片（数据 chip/折叠卡）语义令牌 */
  --anim-card-active-bg: #1e3a5f;
  --anim-card-active-border: #3a5a8a;
  --anim-card-folded-bg: #1a2440;
  --anim-card-folded-border: #33456e;
  --anim-card-title: #ffffff;
  --anim-card-folded-title: #8ea3c8;
  --anim-card-body: #8ea3c8;
}

[data-theme="sakura"] {
  --theme-primary: #ff7eb3;
  --theme-primary-rgb: 255, 126, 179;
  --theme-primary-dark: #e05a96;
  --theme-primary-light: #ffa8cd;
  --theme-secondary: #2d1b36;
  --theme-background: #1a0f1f;
  --theme-card-bg: #33203e;
  --theme-panel-bg: rgba(45, 27, 54, 0.96);
  --theme-border: #4a2c50;
  --theme-input-bg: #241329;
  --theme-hover: #4a2c56;
  --theme-text: #ffe6f2;
  --theme-text-sub: #c495b8;
  --theme-text-dim: #8a5f7d;
  --theme-accent: #ffb6c1;
  --theme-accent-rgb: 255, 182, 193;
  --theme-edge: #ff7eb3;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
  --anim-card-active-bg: #4a2c56;
  --anim-card-active-border: #6a3e78;
  --anim-card-folded-bg: #33203e;
  --anim-card-folded-border: #4a2c50;
  --anim-card-title: #ffffff;
  --anim-card-folded-title: #c495b8;
  --anim-card-body: #c495b8;
}

[data-theme="forest"] {
  --theme-primary: #4caf50;
  --theme-primary-rgb: 76, 175, 80;
  --theme-primary-dark: #3d8b40;
  --theme-primary-light: #80e27e;
  --theme-secondary: #1a2f1a;
  --theme-background: #0a140a;
  --theme-card-bg: #1f381f;
  --theme-panel-bg: rgba(26, 47, 26, 0.96);
  --theme-border: #2d4d2d;
  --theme-input-bg: #12240f;
  --theme-hover: #2f5230;
  --theme-text: #e8f5e9;
  --theme-text-sub: #81c784;
  --theme-text-dim: #5a8a5e;
  --theme-accent: #81c784;
  --theme-accent-rgb: 129, 199, 132;
  --theme-edge: #4caf50;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
  --anim-card-active-bg: #2f5230;
  --anim-card-active-border: #4a7a4c;
  --anim-card-folded-bg: #1f381f;
  --anim-card-folded-border: #2d4d2d;
  --anim-card-title: #ffffff;
  --anim-card-folded-title: #81c784;
  --anim-card-body: #81c784;
}

[data-theme="ocean"] {
  --theme-primary: #2196f3;
  --theme-primary-rgb: 33, 150, 243;
  --theme-primary-dark: #1976d2;
  --theme-primary-light: #6ec6ff;
  --theme-secondary: #0d2847;
  --theme-background: #051828;
  --theme-card-bg: #113155;
  --theme-panel-bg: rgba(13, 40, 71, 0.96);
  --theme-border: #1a3f6b;
  --theme-input-bg: #0a2138;
  --theme-hover: #1e4a7a;
  --theme-text: #e3f2fd;
  --theme-text-sub: #64b5f6;
  --theme-text-dim: #4a7ba6;
  --theme-accent: #64b5f6;
  --theme-accent-rgb: 100, 181, 246;
  --theme-edge: #2196f3;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
  --anim-card-active-bg: #1e4a7a;
  --anim-card-active-border: #2e5f94;
  --anim-card-folded-bg: #113155;
  --anim-card-folded-border: #1a3f6b;
  --anim-card-title: #ffffff;
  --anim-card-folded-title: #64b5f6;
  --anim-card-body: #64b5f6;
}

/* 星图主题：深空底 + 星光青主色 + 星云紫点缀。配套星野/发光规则见下方 star 专区 */
[data-theme="star"] {
  --theme-primary: #7dd3fc;
  --theme-primary-rgb: 125, 211, 252;
  --theme-primary-dark: #38bdf8;
  --theme-primary-light: #e0f2fe;
  --theme-secondary: #060b1f;
  --theme-background: #02040d;
  --theme-card-bg: #0d1633;
  --theme-panel-bg: rgba(6, 11, 31, 0.96);
  --theme-border: #1e2a52;
  --theme-input-bg: #0a1129;
  --theme-hover: #1c2c5c;
  --theme-text: #e6f1ff;
  --theme-text-sub: #93b4e0;
  --theme-text-dim: #54689c;
  --theme-accent: #c4b5fd;
  --theme-accent-rgb: 196, 181, 253;
  --theme-edge: #7dd3fc;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
  --anim-card-active-bg: #1c2c5c;
  --anim-card-active-border: #2e4480;
  --anim-card-folded-bg: #101a3a;
  --anim-card-folded-border: #1e2a52;
  --anim-card-title: #ffffff;
  --anim-card-folded-title: #93b4e0;
  --anim-card-body: #93b4e0;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: var(--theme-background);
  color: var(--theme-text);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
header {
  background: linear-gradient(135deg, var(--theme-secondary) 0%, var(--theme-card-bg) 100%);
  padding: 16px 24px;
  border-bottom: 1px solid var(--theme-border);
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
}
header .meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--theme-text-sub);
}
header .meta .badge {
  background: rgba(var(--theme-primary-rgb), 0.15);
  color: var(--theme-primary);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid rgba(var(--theme-primary-rgb), 0.3);
}
header .meta .badge.status-draft { background: rgba(139,155,180,0.15); color: var(--theme-text-sub); border-color: rgba(139,155,180,0.3); }
header .meta .badge.status-in_progress { background: rgba(255,193,7,0.15); color: #ffc107; border-color: rgba(255,193,7,0.3); }
header .meta .badge.status-done { background: rgba(76,175,80,0.15); color: #4caf50; border-color: rgba(76,175,80,0.3); }
header .title {
  color: var(--theme-text-sub);
  font-size: 13px;
}
main {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 0;
  overflow: hidden;
}
.canvas-wrap {
  overflow: auto;
  padding: 24px;
  background: var(--theme-background);
}
.canvas-wrap svg {
  background: var(--theme-secondary);
  border-radius: 8px;
  border: 1px solid var(--theme-border);
  display: block;
  width: 100%;
  height: auto;
}
.node rect {
  transition: filter 0.2s ease, transform 0.2s ease, stroke 0.2s ease, stroke-width 0.2s ease;
  cursor: pointer;
  transform-origin: center;
  transform-box: fill-box;
}
.node:hover rect {
  filter: brightness(1.2) drop-shadow(0 0 10px rgba(var(--theme-primary-rgb), 0.6));
  transform: scale(1.01);
}
.node.selected rect {
  stroke: var(--theme-primary) !important;
  stroke-width: 2 !important;
  filter: drop-shadow(0 0 14px rgba(var(--theme-primary-rgb), 0.7));
}
.node text {
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
  user-select: none;
  transition: fill 0.2s ease;
}
.node.selected text {
  fill: #ffffff;
}
/* 平铺布局：父节点标签作为标题栏，加粗显示在顶部 */
.label-top {
  font-weight: 700 !important;
  opacity: 0.95;
}
.node circle,
.node polygon {
  transition: filter 0.2s ease, transform 0.2s ease, stroke 0.2s ease, stroke-width 0.2s ease;
  cursor: pointer;
  transform-origin: center;
  transform-box: fill-box;
}
.node:hover circle,
.node:hover polygon {
  filter: brightness(1.2) drop-shadow(0 0 10px rgba(var(--theme-primary-rgb), 0.6));
  transform: scale(1.01);
}
.node.selected circle,
.node.selected polygon {
  stroke: var(--theme-primary) !important;
  stroke-width: 2 !important;
  filter: drop-shadow(0 0 14px rgba(var(--theme-primary-rgb), 0.7));
}

.rich-content {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.4;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rich-content .cb-text {
  word-break: break-word;
}
.rich-content .cb-image {
  border-radius: 4px;
  overflow: hidden;
}
.rich-content .cb-image img {
  display: block;
  max-width: 100%;
}
.rich-content .cb-color-block {
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-sizing: border-box;
}
.rich-content .cb-spacer {
  flex-shrink: 0;
}
.rich-content .cb-code {
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 4px;
  padding: 6px 10px;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  color: var(--theme-accent);
  overflow-x: auto;
  white-space: pre;
}
.rich-content .cb-list {
  margin: 2px 0;
  padding-left: 16px;
}
.rich-content .cb-list li {
  font-size: 11px;
  color: var(--theme-text);
  margin: 2px 0;
}
.rich-content .cb-divider {
  height: 1px;
  background: var(--theme-border);
  margin: 4px 0;
}
.rich-content .cb-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  align-self: flex-start;
}
/* D1 数据形状卡：节点上进/出料口的人话形状展示（纯展示，pointer-events:none） */
.shape-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.35;
  box-sizing: border-box;
}
.shape-card .shape-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 4px;
  padding: 3px 6px;
  overflow: hidden;
}
.shape-card .shape-dir {
  flex-shrink: 0;
  font-weight: 700;
  color: var(--theme-primary);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.shape-card .shape-row.out .shape-dir {
  color: var(--theme-accent);
}
.shape-card .shape-body {
  color: var(--theme-text);
  word-break: break-all;
  opacity: 0.92;
}
.node .collapse-btn {
  cursor: pointer;
  transition: transform 0.2s ease;
  transform-origin: center;
  transform-box: fill-box;
}
.node .collapse-btn:hover {
  transform: scale(1.15);
}
.node.collapsed rect {
  filter: brightness(0.85) saturate(0.7);
}
.node.collapsed .collapse-btn {
  transform: rotate(-90deg);
}
.node .sub-dsl-badge {
  cursor: pointer;
  transition: transform 0.2s ease;
  transform-origin: center;
  transform-box: fill-box;
}
.node .sub-dsl-badge:hover {
  transform: scale(1.15);
}
.node.has-sub-dsl rect {
  stroke-dasharray: 6 4;
  animation: borderPulse 2s ease-in-out infinite;
}
@keyframes borderPulse {
  0%, 100% { stroke-dashoffset: 0; }
  50% { stroke-dashoffset: 20; }
}
.node.status-done rect {
  stroke: #4CAF50 !important;
  stroke-width: 1.5 !important;
}
.node.status-in-progress rect {
  stroke: #FF9800 !important;
  stroke-width: 1.5 !important;
}
.node.status-draft rect {
  opacity: 0.7;
}
.node.status-done text {
  opacity: 1;
}
.node.status-in-progress text {
  opacity: 0.95;
}
.node.status-draft text {
  opacity: 0.6;
}
.edge path {
  fill: none;
  stroke-width: 2;
  transition: stroke-width 0.2s ease, stroke 0.2s ease, opacity 0.2s ease;
  stroke-dasharray: 0;
}
/* 未显式指定颜色的边：默认边色跟随主题（置于 .edge.selected 之前，确保选中态覆盖） */
.edge path.edge-themed {
  stroke: var(--theme-edge);
}
.edge:hover path {
  stroke-width: 3;
}
.edge.dimmed path {
  opacity: 0.2;
}
.edge.highlighted path {
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(var(--theme-primary-rgb), 0.5));
}
.edge.selected path {
  stroke-width: 4;
  stroke: var(--theme-primary);
  filter: drop-shadow(0 0 8px rgba(var(--theme-primary-rgb), 0.8));
}
.edge text {
  font-size: 11px;
  fill: var(--theme-text-sub);
  pointer-events: none;
  transition: opacity 0.2s ease;
  paint-order: stroke;
  stroke: var(--theme-background);
  stroke-width: 3px;
  stroke-linejoin: round;
}
.edge:hover .edge-label,
.edge.selected .edge-label {
  opacity: 1 !important;
}
.edge.dimmed text {
  opacity: 0.2;
}
.edge marker {
  fill: var(--theme-primary);
}
.edge.flow path {
  stroke-dasharray: 8 6;
  animation: flowDash 1.2s linear infinite;
}
@keyframes flowDash {
  from { stroke-dashoffset: 28; }
  to { stroke-dashoffset: 0; }
}
.edge.flow-reverse path {
  stroke-dasharray: 8 6;
  animation: flowDashReverse 1.2s linear infinite;
}
@keyframes flowDashReverse {
  from { stroke-dashoffset: 0; }
  to { stroke-dashoffset: 28; }
}

/* 仿真依赖边 */
.sim-edge {
  pointer-events: auto;
  cursor: move;
  opacity: 0.65;
  transition: opacity 0.2s;
}
.sim-edge:hover {
  opacity: 0.9;
}
.sim-edge-path {
  transition: stroke-width 0.2s, opacity 0.2s;
}
.sim-edge:hover .sim-edge-path {
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(155, 89, 182, 0.7));
}
.sim-edge-label {
  font-size: 10px;
  fill: #b39ddb;
  font-weight: 500;
  pointer-events: none;
  paint-order: stroke;
  stroke: var(--theme-background);
  stroke-width: 3px;
  stroke-linejoin: round;
  transition: opacity 0.2s;
}
.sim-edge.active .sim-edge-label {
  opacity: 1 !important;
}
.sim-edge-flow {
  opacity: 0;
  transition: opacity 0.3s;
}
.sim-edge.active .sim-edge-flow {
  opacity: 1;
  animation: simFlow 1.2s linear infinite;
}
@keyframes simFlow {
  from { stroke-dashoffset: 200; }
  to { stroke-dashoffset: 0; }
}
.sim-edge.active .sim-edge-path {
  stroke-width: 3.5;
  filter: drop-shadow(0 0 10px rgba(155, 89, 182, 0.9));
}
.sim-edge.active {
  opacity: 1 !important;
}

/* 消息气泡粒子 */
.msg-particle {
  pointer-events: auto;
  cursor: grab;
  opacity: 0;
  transition: opacity 0.2s;
}
.msg-particle.active {
  opacity: 1;
}
.msg-particle.grabbing {
  cursor: grabbing;
}
.msg-bubble {
  rx: 12;
  ry: 12;
  filter: drop-shadow(0 2px 8px rgba(var(--theme-accent-rgb), 0.4));
}
.msg-text {
  font-size: 10px;
  fill: #ffffff;
  font-weight: 500;
  paint-order: stroke;
  stroke: rgba(0,0,0,0.3);
  stroke-width: 2px;
}
.msg-container {
  cursor: grab;
}
.msg-container rect {
  rx: 12;
  ry: 12;
}
.msg-container text {
  font-size: 11px;
}

/* 消息流侧边栏 */
.msg-flow-panel {
  position: fixed;
  top: 60px;
  right: 10px;
  width: 300px;
  max-height: 500px;
  background: var(--theme-panel-bg);
  color: #fff;
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  z-index: 999;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  display: none;
}
.msg-flow-panel.visible {
  display: block;
}
.msg-flow-panel h3 {
  margin: 0 0 10px 0;
  font-size: 14px;
  color: var(--theme-accent);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--theme-border);
}
.msg-flow-item {
  padding: 8px;
  margin: 6px 0;
  background: rgba(255,255,255,0.05);
  border-radius: 6px;
  border-left: 3px solid var(--theme-accent);
}
.msg-flow-item .msg-time {
  font-size: 10px;
  color: var(--theme-text-dim);
  margin-bottom: 4px;
}
.msg-flow-item .msg-content {
  font-size: 12px;
  color: var(--theme-text);
}
.msg-flow-item .msg-rule {
  font-size: 10px;
  color: #ba68c8;
  margin-top: 4px;
}
.msg-flow-panel .close-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(var(--theme-primary-rgb), 0.2);
  border: none;
  color: var(--theme-primary);
  cursor: pointer;
  font-size: 14px;
  line-height: 24px;
  text-align: center;
}
.msg-flow-panel .clear-btn {
  width: 100%;
  margin-top: 8px;
  padding: 6px;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--theme-border);
  border-radius: 4px;
  color: var(--theme-text-dim);
  cursor: pointer;
  font-size: 11px;
}

/* Section 卡片动画 */
.section-card rect {
  transition: height 0.5s ease, y 0.5s ease, fill 0.3s ease;
}
.section-card text {
  transition: opacity 0.3s ease, y 0.5s ease;
}
.section-card.folded rect {
  fill: var(--theme-hover) !important;
}

.node.dimmed rect {
  opacity: 0.3;
  filter: saturate(0.3);
}
.node.dimmed text {
  opacity: 0.3;
}
.sidebar {
  background: var(--theme-secondary);
  border-left: 1px solid var(--theme-border);
  overflow-y: auto;
  padding: 16px;
}
.sidebar h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-sub);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--theme-border);
}
.card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
  transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
  cursor: pointer;
}
.card:hover {
  border-color: var(--theme-primary);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(var(--theme-primary-rgb), 0.15);
}
.card.active {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px rgba(var(--theme-primary-rgb), 0.2), 0 4px 12px rgba(var(--theme-primary-rgb), 0.2);
  transform: translateY(-1px);
}
.card .path {
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
  color: var(--theme-accent);
  margin-bottom: 6px;
  word-break: break-all;
}
.card .responsibility {
  font-size: 13px;
  color: var(--theme-text);
  margin-bottom: 8px;
  line-height: 1.5;
}
.card .apis {
  border-top: 1px dashed var(--theme-border);
  padding-top: 6px;
  margin-top: 6px;
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.card.expanded .apis {
  max-height: 200px;
}
.card .api-section {
  font-size: 11px;
  font-weight: 600;
  color: var(--theme-text-sub);
  margin: 8px 0 4px 0;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--theme-border);
}
.card .api-status {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 700;
  margin-right: 6px;
}
.card .api-status.status-done {
  background: rgba(76, 175, 80, 0.2);
  color: #4caf50;
}
.card .api-status.status-missing {
  background: rgba(244, 67, 54, 0.2);
  color: #f44336;
}
.card .api-status.status-extra {
  background: rgba(33, 150, 243, 0.2);
  color: #2196f3;
}
.card .api {
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  margin: 3px 0;
  word-break: break-all;
  padding-left: 22px;
}
.card .api-done {
  color: #4caf50;
}
.card .api-missing {
  color: #f44336;
  text-decoration: line-through;
  opacity: 0.7;
}
.card .api-extra {
  color: #2196f3;
}
.card .api .notes {
  color: var(--theme-text-sub);
  font-style: italic;
}
.card .deps {
  font-size: 11px;
  color: var(--theme-text-sub);
  margin-top: 6px;
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.3s ease;
}
.card.expanded .deps {
  max-height: 100px;
}
.card .deps span {
  font-family: "JetBrains Mono", Consolas, monospace;
  color: var(--theme-accent);
  margin-right: 6px;
}
.card .toggle-indicator {
  float: right;
  font-size: 10px;
  color: var(--theme-text-sub);
  margin-top: 2px;
  transition: transform 0.2s ease;
}
.card.expanded .toggle-indicator {
  transform: rotate(180deg);
}
.sidebar .invariants {
  margin-top: 16px;
}
.invariants h3 {
  font-size: 12px;
  color: var(--theme-text-sub);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}
.invariants ul {
  list-style: none;
}
.invariants li {
  font-size: 12px;
  color: var(--theme-text);
  padding: 6px 8px;
  background: rgba(var(--theme-primary-rgb), 0.08);
  border-left: 2px solid var(--theme-primary);
  margin-bottom: 4px;
  border-radius: 0 4px 4px 0;
  line-height: 1.5;
  transition: background 0.2s ease;
}
.invariants li:hover {
  background: rgba(var(--theme-primary-rgb), 0.15);
}
footer {
  background: var(--theme-secondary);
  border-top: 1px solid var(--theme-border);
  padding: 12px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
footer .info {
  font-size: 11px;
  color: var(--theme-text-sub);
}
footer button {
  background: linear-gradient(135deg, var(--theme-primary) 0%, var(--theme-primary-dark) 100%);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.1s, box-shadow 0.15s;
}
footer button:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(var(--theme-primary-rgb), 0.4);
}
footer button:active {
  transform: translateY(0);
}
#tooltip {
  position: fixed;
  background: var(--theme-panel-bg);
  border: 1px solid var(--theme-primary);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: #fff;
  max-width: 320px;
  pointer-events: none;
  z-index: 1000;
  display: none;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  line-height: 1.5;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
#tooltip.visible {
  opacity: 1;
  transform: translateY(0);
}
#tooltip .anno {
  padding: 4px 0;
  border-bottom: 1px dashed rgba(255,255,255,0.2);
}
#tooltip .anno:last-child { border-bottom: none; }
#tooltip .anno .author {
  font-size: 10px;
  color: var(--theme-accent);
  margin-right: 6px;
}
#tooltip .empty {
  color: var(--theme-text-sub);
  font-style: italic;
}
.node-enter {
  animation: nodeEnter 0.3s ease-out;
}
@keyframes nodeEnter {
  from { opacity: 0; transform: scale(0.9); }
  to { opacity: 1; transform: scale(1); }
}

.hidden {
  display: none !important;
}

.canvas-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: var(--theme-secondary);
  border-bottom: 1px solid var(--theme-border);
  gap: 12px;
  z-index: 10;
}
.search-input {
  flex: 1;
  max-width: 320px;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 6px 12px;
  font-size: 13px;
  font-family: inherit;
  transition: border-color 0.2s ease;
}
.search-input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.search-input::placeholder {
  color: var(--theme-text-dim);
}
.layout-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--theme-input-bg);
  border-radius: 6px;
  padding: 2px;
}
.layout-controls button {
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--theme-text);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: all 0.15s ease;
}
.layout-controls button:hover {
  background: var(--theme-hover);
}
.layout-controls button:active {
  background: var(--theme-primary);
}
.zoom-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}
.zoom-controls button {
  background: var(--theme-border);
  border: none;
  color: var(--theme-text);
  min-width: 28px;
  height: 28px;
  padding: 0 7px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: all 0.15s ease;
  font-family: inherit;
}
.zoom-controls button:hover {
  background: var(--theme-hover);
  color: var(--theme-primary);
}
.zoom-level {
  font-size: 12px;
  color: var(--theme-text-sub);
  min-width: 42px;
  text-align: center;
  font-family: "JetBrains Mono", Consolas, monospace;
}

.history-controls {
  display: flex;
  gap: 4px;
}
.history-controls button {
  min-width: 32px;
  height: 32px;
  padding: 0 9px;
  border: 1px solid var(--theme-border);
  background: var(--theme-card-bg);
  color: var(--theme-text);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  transition: all 0.15s ease;
}
.history-controls button:hover:not(:disabled) {
  background: var(--theme-primary);
  color: #fff;
  border-color: var(--theme-primary);
}
.history-controls button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
/* 职责分层：层开关按钮 */
.layer-controls {
  display: flex;
  gap: 4px;
}
.layer-controls button {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--theme-border);
  background: var(--theme-card-bg);
  color: var(--theme-text);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}
.layer-controls button:hover {
  border-color: var(--theme-primary);
}
.layer-controls button.active {
  background: var(--theme-primary);
  color: #fff;
  border-color: var(--theme-primary);
}
/* 架构分层图例（序号5/7）：🎨 图层开关显示，右上角悬浮 */
.layer-legend {
  position: absolute;
  top: 70px;
  right: 20px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 12px;
  z-index: 100;
  max-width: 320px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}
.layer-legend-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--theme-text);
}
.layer-legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--theme-text);
}
.layer-legend-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex-shrink: 0;
}
.layer-legend-name {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.layer-legend-desc {
  flex: 2;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.layer-legend-count {
  background: rgba(125, 211, 252, 0.15);
  color: #7dd3fc;
  border-radius: 10px;
  padding: 0 6px;
  font-size: 11px;
  flex-shrink: 0;
}
/* 筛选条（人端筛选：状态/孤岛/聚焦）——胶囊 chips，多选可叠加 */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
}
.filter-chip {
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--theme-border);
  background: var(--theme-card-bg);
  color: var(--theme-text);
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.filter-chip:hover {
  border-color: var(--theme-primary);
}
.filter-chip.active {
  background: var(--theme-primary);
  color: #fff;
  border-color: var(--theme-primary);
}
.filter-chip .chip-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.22);
  color: inherit;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  box-sizing: border-box;
}
.filter-chip.active .chip-count {
  background: rgba(255, 255, 255, 0.25);
}
.filter-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.filter-chip.filter-focus.active {
  background: #f0883e;
  border-color: #f0883e;
  color: #fff;
}
.filter-chip.filter-focus.active .chip-count {
  background: rgba(255, 255, 255, 0.25);
}
/* 筛选隐藏：CSS class 层控制（与折叠/分层的 inline display 正交，优先级最高） */
.filter-hidden {
  display: none !important;
}
/* 层角标（SVG 内，宿主节点左上角） */
.layer-badge {
  cursor: pointer;
}
.layer-badge .badge-bg {
  fill: var(--theme-panel-bg);
  stroke: var(--theme-primary);
  stroke-width: 1.5;
}
.layer-badge .badge-text {
  fill: var(--theme-primary);
  font-size: 10px;
  font-weight: bold;
  pointer-events: none;
}
.layer-badge.layer-error .badge-bg {
  stroke: #f0883e;
}
.layer-badge.layer-error .badge-text {
  fill: #f0883e;
}
.layer-badge.expanded .badge-bg {
  fill: var(--theme-primary);
}
.layer-badge.expanded .badge-text {
  fill: #fff;
}
.layer-badge.layer-error.expanded .badge-bg {
  fill: #f0883e;
  stroke: #f0883e;
}
.layer-badge.layer-error.expanded .badge-text {
  fill: #fff;
}

/* ==== 数据流追踪（L5a 静态推演：注入数据 → 沿调用链追踪处理/分流） ==== */
#dataflow-toggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
#dataflow-panel {
  position: fixed;
  top: 76px;
  right: 18px;
  z-index: 300;
  width: 340px;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  padding: 12px 14px;
  display: none;
}
.dataflow-title {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  color: var(--theme-text);
}
.dataflow-desc {
  font-size: 11px;
  color: var(--theme-text-dim);
  margin-bottom: 8px;
  line-height: 1.5;
}
#dataflow-input {
  width: 100%;
  box-sizing: border-box;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
  background: var(--theme-input-bg);
  color: var(--theme-text);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  padding: 8px;
  resize: vertical;
}
.dataflow-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  justify-content: flex-end;
}
.dataflow-actions button {
  padding: 5px 14px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--theme-border);
  background: var(--theme-input-bg);
  color: var(--theme-text);
}
.dataflow-actions #dataflow-start {
  background: var(--theme-primary);
  border-color: var(--theme-primary);
  color: #fff;
  font-weight: 600;
}
.node.trace-active {
  stroke-width: 2.5 !important;
  filter: drop-shadow(0 0 10px var(--theme-primary));
}
.edge.trace-branch {
  stroke: #f0a050 !important;
  stroke-width: 2.5 !important;
  opacity: 1 !important;
}
#trace-dot {
  fill: var(--theme-primary);
  stroke: #fff;
  stroke-width: 2;
  filter: drop-shadow(0 0 6px var(--theme-primary));
  pointer-events: none;
}
#trace-bubble {
  position: fixed;
  z-index: 320;
  background: rgba(16, 22, 38, 0.95);
  border: 1px solid var(--theme-primary);
  color: #e8eefb;
  border-radius: 8px;
  padding: 8px 10px;
  max-width: 300px;
  font-size: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.trace-bubble-title {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
  color: var(--theme-primary);
}
.trace-bubble-row {
  display: flex;
  gap: 6px;
  margin: 2px 0;
  font-family: "JetBrains Mono", Consolas, monospace;
  word-break: break-all;
}
.trace-dir {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 11px;
  background: rgba(76, 175, 80, 0.2);
  color: #7bd88f;
}
.trace-dir-out {
  background: rgba(79, 141, 247, 0.2);
  color: #8ab6ff;
}
.trace-bubble-note {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px dashed rgba(255, 255, 255, 0.25);
  color: #f0c27a;
  font-size: 11px;
}
.trace-status-unsupported {
  color: #f0a050;
}
.trace-status-error {
  color: #f4706a;
}
/* LLM 关键节点聚焦：关键点高亮，非关键压缩过渡 */
.node.trace-focus {
  stroke: var(--theme-primary);
  stroke-width: 2.5 !important;
  filter: drop-shadow(0 0 12px var(--theme-primary)) brightness(1.12);
  opacity: 1;
}
.node.trace-dim {
  opacity: 0.25;
  transition: opacity 0.5s ease;
}
#focus-panel {
  position: fixed;
  right: 16px;
  top: 76px;
  width: 300px;
  max-height: 62vh;
  overflow: auto;
  z-index: 330;
  background: rgba(16, 22, 38, 0.96);
  border: 1px solid var(--theme-primary);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  color: #e8eefb;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.focus-panel-title {
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--theme-primary);
}
.focus-close {
  float: right;
  cursor: pointer;
  color: #9fb0cc;
  font-size: 13px;
}
.focus-row {
  padding: 6px;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.focus-row:last-child {
  border-bottom: none;
}
.focus-row:hover {
  background: rgba(var(--theme-primary-rgb), 0.12);
}
.focus-row b {
  display: block;
  color: var(--theme-primary-light);
  font-size: 12px;
}
.focus-row span {
  color: #9fb0cc;
  font-size: 11px;
}
/* 变更影响（D2）：受影响节点/边标红，受影响清单面板 */
.node.impacted {
  stroke: #ff5252 !important;
  stroke-width: 2.5 !important;
  filter: drop-shadow(0 0 10px rgba(255, 82, 82, 0.6)) brightness(1.1);
}
.node.impacted-direct {
  stroke: #ff3d3d !important;
  stroke-width: 3 !important;
}
.edge.impacted path {
  stroke: #ff5252 !important;
  stroke-width: 3 !important;
  filter: drop-shadow(0 0 6px rgba(255, 82, 82, 0.6));
}
.diff-input-panel {
  position: fixed;
  left: 50%;
  top: 120px;
  transform: translateX(-50%);
  width: 380px;
  z-index: 340;
  background: rgba(16, 22, 38, 0.97);
  border: 1px solid var(--theme-primary);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12px;
  color: #e8eefb;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.diff-input-desc {
  color: #9fb0cc;
  margin-bottom: 8px;
  line-height: 1.5;
}
.diff-input-panel textarea {
  width: 100%;
  box-sizing: border-box;
  background: #0d1322;
  color: #e8eefb;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  padding: 6px;
  font-family: monospace;
  font-size: 11px;
}
.diff-input-opts {
  display: flex;
  gap: 12px;
  margin: 8px 0;
  align-items: center;
}
.diff-input-opts select,
.diff-input-opts input {
  background: #0d1322;
  color: #e8eefb;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  padding: 2px 4px;
}
.diff-input-actions {
  display: flex;
  gap: 8px;
}
.diff-input-actions button {
  background: var(--theme-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 5px 12px;
  cursor: pointer;
}
.diff-input-actions button#diff-input-gitdiff {
  background: rgba(24, 144, 255, 0.16);
  color: #7dd3fc;
  border: 1px solid rgba(125, 211, 252, 0.45);
}
.diff-input-actions button#diff-input-gitdiff:hover:not(:disabled) {
  background: rgba(24, 144, 255, 0.28);
}
/* Guided Tours（序号6）：▸ 当前导览节点（脉冲描边，与选中态区分）+ 导览控制面板 */
@keyframes tourPulse {
  0% { stroke-width: 3; filter: drop-shadow(0 0 4px rgba(125, 211, 252, 0.7)); }
  50% { stroke-width: 5; filter: drop-shadow(0 0 14px rgba(125, 211, 252, 0.95)); }
  100% { stroke-width: 3; filter: drop-shadow(0 0 4px rgba(125, 211, 252, 0.7)); }
}
.node.tour-step > [data-shape] {
  stroke: #7dd3fc !important;
  stroke-width: 3 !important;
  animation: tourPulse 1.2s ease-in-out infinite;
}
.guided-tour-panel {
  position: fixed;
  right: 20px;
  bottom: 70px;
  width: 300px;
  z-index: 340;
  background: rgba(16, 22, 38, 0.97);
  border: 1px solid var(--theme-primary);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12px;
  color: #e8eefb;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.gt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.gt-prog {
  font-weight: 700;
  color: #7dd3fc;
  font-size: 14px;
}
.gt-hint {
  color: #9fb0cc;
  font-size: 11px;
}
.gt-label {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
  word-break: break-all;
}
.gt-reason {
  color: #9fb0cc;
  line-height: 1.5;
  margin-bottom: 10px;
}
.gt-actions {
  display: flex;
  gap: 8px;
}
.gt-actions button {
  background: var(--theme-primary);
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
}
.gt-actions button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.gt-actions button#gt-play {
  background: rgba(24, 144, 255, 0.16);
  color: #7dd3fc;
  border: 1px solid rgba(125, 211, 252, 0.45);
}
.diff-input-actions button#diff-input-gitdiff:disabled {
  opacity: 0.6;
  cursor: wait;
}
.diff-input-status {
  margin-top: 8px;
  color: #f0a050;
  min-height: 14px;
}
.diff-sub {
  color: #9fb0cc;
  margin-bottom: 6px;
}
.diff-files-label {
  font-weight: 600;
  color: var(--theme-primary);
  margin: 6px 0 2px;
}
.diff-symbols {
  font-family: monospace;
  font-size: 10px;
  color: #9fb0cc;
  max-height: 120px;
  overflow: auto;
}
.diff-sym-depth {
  color: #f0a050;
}
.diff-warn {
  color: #f0a050;
}
.trace-judge {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed rgba(255, 255, 255, 0.25);
}
.trace-judge-cond {
  font-size: 11px;
  font-weight: 600;
  color: #ffd479;
  margin-bottom: 3px;
  word-break: break-all;
}
.trace-judge-row {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: #c9d4ea;
  margin: 1px 0;
}
.trace-via {
  flex: none;
  min-width: 26px;
  text-align: center;
  padding: 0 4px;
  border-radius: 3px;
  background: rgba(240, 136, 62, 0.25);
  color: #f0a050;
  font-size: 10px;
}
.trace-via.chosen {
  background: rgba(79, 141, 247, 0.5);
  color: #ffffff;
  box-shadow: 0 0 0 1px rgba(138, 182, 255, 0.7);
}
.trace-judge-hit {
  margin-left: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #8ab6ff;
  background: rgba(79, 141, 247, 0.18);
  border-radius: 3px;
  padding: 0 4px;
}
.trace-judge-note {
  margin-left: 4px;
  font-size: 10px;
  color: #8a96ab;
}
.history-indicator {
  font-size: 11px;
  color: var(--theme-text-dim);
  padding: 4px 10px;
  background: var(--theme-input-bg);
  border-radius: 4px;
  font-family: "JetBrains Mono", Consolas, monospace;
  min-width: 80px;
  text-align: center;
}

.node.search-match {
  animation: searchPulse 1.5s ease-in-out 3;
}
.node.search-dimmed {
  opacity: 0.2;
}
@keyframes searchPulse {
  0%, 100% { filter: drop-shadow(0 0 0 var(--theme-primary)); }
  50% { filter: drop-shadow(0 0 12px var(--theme-primary)); }
}

/* 语义搜索结果高亮（序号8 S2）：与本地搜索 pulse 区分，用主题强调色描边脉冲 */
.node.semantic-hit {
  animation: semanticPulse 1.6s ease-in-out 3;
}
.node.semantic-hit .node-label { color: var(--theme-accent); font-weight: 700; }
@keyframes semanticPulse {
  0%, 100% { filter: drop-shadow(0 0 0 var(--theme-accent)); }
  50% { filter: drop-shadow(0 0 14px var(--theme-accent)); }
}
/* 语义搜索结果面板 */
.sem-panel {
  position: fixed;
  top: 96px;
  right: 16px;
  width: 360px;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  z-index: 900;
  padding-bottom: 8px;
}
.sem-panel-title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 700;
  border-bottom: 1px solid var(--theme-border);
  position: sticky;
  top: 0;
  background: var(--theme-card-bg);
  border-radius: 10px 10px 0 0;
}
.sem-hint { font-size: 11px; color: var(--theme-text-dim); font-weight: 400; }
.sem-hit-row {
  padding: 8px 14px;
  cursor: pointer;
  border-bottom: 1px dashed var(--theme-border);
}
.sem-hit-row:hover { background: var(--theme-accent-bg); }
.sem-hit-row b { font-size: 12.5px; }
.sem-hit-row .sem-file { font-size: 11px; color: var(--theme-text-dim); font-family: "JetBrains Mono", Consolas, monospace; }
.sem-hit-row .sem-score { float: right; font-size: 11px; color: var(--theme-accent); }

.editor-mask {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.6);
  z-index: 2000;
  animation: maskFadeIn 0.2s ease;
}
@keyframes maskFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.prop-editor {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 420px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  z-index: 2001;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: editorSlideIn 0.25s ease;
}
@keyframes editorSlideIn {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}

.editor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--theme-border);
  background: linear-gradient(135deg, var(--theme-hover) 0%, var(--theme-card-bg) 100%);
}
.editor-header h3 {
  margin: 0;
  font-size: 16px;
  color: var(--theme-text);
  font-weight: 600;
}
.editor-close {
  background: none;
  border: none;
  color: var(--theme-text-sub);
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  transition: all 0.2s ease;
  line-height: 1;
}
.editor-close:hover {
  background: rgba(var(--theme-primary-rgb), 0.15);
  color: var(--theme-primary);
}

.editor-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.form-group {
  margin-bottom: 16px;
}
.form-group label {
  display: block;
  font-size: 12px;
  color: var(--theme-text-sub);
  margin-bottom: 6px;
  font-weight: 500;
}
.form-group input[type="text"],
.form-group select,
.form-group textarea {
  width: 100%;
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: inherit;
  box-sizing: border-box;
  transition: border-color 0.2s ease;
}
.form-group input[type="text"]:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.form-group input[readonly] {
  color: var(--theme-text-sub);
  cursor: not-allowed;
}
.form-group textarea {
  resize: vertical;
  min-height: 60px;
}
.color-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.color-row input[type="color"] {
  width: 36px;
  height: 36px;
  padding: 2px;
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  cursor: pointer;
}
.color-row input[type="text"] {
  flex: 1;
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 8px 12px;
  font-size: 13px;
  font-family: "JetBrains Mono", Consolas, monospace;
}
.color-row input[type="text"]:focus {
  outline: none;
  border-color: var(--theme-primary);
}

.editor-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--theme-border);
  background: var(--theme-secondary);
}

/* 进料口 · 注入回放面板（D3） */
.replay-panel {
  width: 520px;
}
.replay-open-btn {
  width: 100%;
}
.replay-panel textarea {
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 12px;
}
.replay-report {
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  padding: 10px 12px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
  font-family: "JetBrains Mono", Consolas, monospace;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.replay-line.replay-info { color: var(--theme-text-sub); }
.replay-line.replay-ok { color: #4caf50; }
.replay-line.replay-warn { color: #ff9800; }
.replay-line.replay-err { color: #e94560; }

.btn-primary,
.btn-secondary {
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s ease;
  font-family: inherit;
}
.btn-primary {
  background: linear-gradient(135deg, var(--theme-primary) 0%, var(--theme-primary-dark) 100%);
  color: white;
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(var(--theme-primary-rgb), 0.4);
}
.btn-secondary {
  background: var(--theme-border);
  color: var(--theme-text);
}
.btn-secondary:hover {
  background: var(--theme-hover);
}

/** ==== 动画播放器样式 ==== */
.anim-panel {
  background: var(--theme-secondary);
  border-bottom: 1px solid var(--theme-border);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.anim-panel.hidden {
  display: none !important;
}
.anim-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.anim-select {
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
  min-width: 160px;
}
.anim-panel button {
  background: var(--theme-border);
  border: none;
  color: var(--theme-text);
  width: 28px;
  height: 28px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  font-family: inherit;
}
.anim-panel button:hover {
  background: var(--theme-hover);
  color: var(--theme-primary);
}
.anim-stage-info {
  font-size: 12px;
  color: var(--theme-text-sub);
  font-family: "JetBrains Mono", Consolas, monospace;
  min-width: 50px;
  text-align: center;
}
.anim-speed-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}
.anim-speed-wrap label {
  font-size: 11px;
  color: var(--theme-text-sub);
}
.anim-speed-wrap input[type="range"] {
  width: 80px;
}
.anim-speed-wrap span {
  font-size: 12px;
  color: var(--theme-text-sub);
  font-family: "JetBrains Mono", Consolas, monospace;
  min-width: 28px;
}
.anim-progress-bar {
  flex: 1;
  height: 6px;
  background: var(--theme-border);
  border-radius: 3px;
  overflow: hidden;
  cursor: pointer;
}
.anim-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--theme-primary), var(--theme-primary-light));
  border-radius: 3px;
  transition: width 0.3s ease;
}
.anim-stage-name {
  font-size: 12px;
  color: var(--theme-accent);
  min-width: 120px;
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/** ==== 动画元素样式 ==== */
.node.anim-highlight rect,
.node.anim-highlight circle,
.node.anim-highlight polygon {
  stroke: #ffc107 !important;
  stroke-width: 3 !important;
  filter: drop-shadow(0 0 20px rgba(255, 193, 7, 0.9)) !important;
  animation: highlightPulse 0.8s ease-in-out infinite;
}
@keyframes highlightPulse {
  0%, 100% { filter: drop-shadow(0 0 12px rgba(255, 193, 7, 0.6)); }
  50% { filter: drop-shadow(0 0 24px rgba(255, 193, 7, 1)); }
}
.node.anim-highlight text {
  fill: #ffc107 !important;
}
.node.anim-transition rect,
.node.anim-transition circle,
.node.anim-transition polygon {
  transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.node.anim-transition {
  transition: opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.node.anim-transition text {
  transition: fill 0.5s cubic-bezier(0.4, 0, 0.2, 1);
}
.node.anim-hidden {
  opacity: 0.15 !important;
  pointer-events: none;
}
.node.anim-pulse rect,
.node.anim-pulse circle,
.node.anim-pulse polygon {
  animation: animPulse 1.2s ease-in-out infinite;
}
@keyframes animPulse {
  0%, 100% { filter: drop-shadow(0 0 4px rgba(var(--theme-primary-rgb), 0.4)); }
  50% { filter: drop-shadow(0 0 14px rgba(var(--theme-primary-rgb), 0.9)); }
}

/** 阈值触发闪烁效果 */
.node.anim-threshold rect,
.node.anim-threshold circle,
.node.anim-threshold polygon {
  animation: thresholdFlash 0.6s ease-in-out 3;
}
@keyframes thresholdFlash {
  0%, 100% { stroke: inherit; }
  50% { stroke: #f44336 !important; stroke-width: 3 !important; }
}

/** ==== 主题切换器样式 ==== */
.theme-switcher {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--theme-input-bg);
  border-radius: 6px;
  padding: 2px;
}
.theme-switcher button {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.theme-switcher button:hover {
  transform: scale(1.1);
}
.theme-switcher button.active {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.theme-blue { background: linear-gradient(135deg, #4f8df7, #111c36); }
.theme-sakura { background: linear-gradient(135deg, #ff7eb3, #2d1b36); }
.theme-forest { background: linear-gradient(135deg, #4caf50, #1a2f1a); }
.theme-ocean { background: linear-gradient(135deg, #2196f3, #0d2847); }
.theme-star { background: linear-gradient(135deg, #7dd3fc, #02040d); }

/* ==== 星图主题专区 ====
 * 星野：多层 radial-gradient 光点，不同平铺周期（240~420px）错开伪随机分布；
 * 星云：大面积低透明度紫/青光晕。全部挂在 svg 元素背景上——随画布内容一起平移缩放，
 * 星野即星图本身。规则置于文件尾部：与基础规则同特异性时靠源码顺序获胜。
 */
body[data-theme="star"] .canvas-wrap svg {
  background-color: var(--theme-secondary);
  background-image:
    radial-gradient(ellipse 42% 30% at 72% 18%, rgba(196, 181, 253, 0.055), transparent 70%),
    radial-gradient(ellipse 38% 26% at 18% 78%, rgba(125, 211, 252, 0.045), transparent 70%),
    radial-gradient(1.5px 1.5px at 25% 35%, rgba(255, 255, 255, 0.9) 50%, transparent 51%),
    radial-gradient(1px 1px at 75% 15%, rgba(190, 220, 255, 0.7) 50%, transparent 51%),
    radial-gradient(1px 1px at 45% 80%, rgba(255, 255, 255, 0.5) 50%, transparent 51%),
    radial-gradient(2px 2px at 85% 60%, rgba(196, 181, 253, 0.55) 50%, transparent 51%),
    radial-gradient(1px 1px at 10% 90%, rgba(125, 211, 252, 0.6) 50%, transparent 51%),
    radial-gradient(1.2px 1.2px at 60% 45%, rgba(255, 255, 255, 0.4) 50%, transparent 51%);
  background-size:
    100% 100%,
    100% 100%,
    340px 340px,
    260px 260px,
    420px 420px,
    300px 300px,
    380px 380px,
    240px 240px;
}
/* 节点常态微光（恒星感）；hover/selected 加强，规则在同特异性基础规则之后 */
body[data-theme="star"] .node rect,
body[data-theme="star"] .node circle,
body[data-theme="star"] .node polygon {
  filter: drop-shadow(0 0 6px rgba(var(--theme-primary-rgb), 0.30));
}
body[data-theme="star"] .node:hover rect,
body[data-theme="star"] .node:hover circle,
body[data-theme="star"] .node:hover polygon {
  filter: brightness(1.25) drop-shadow(0 0 14px rgba(var(--theme-primary-rgb), 0.65));
}
body[data-theme="star"] .node.selected rect,
body[data-theme="star"] .node.selected circle,
body[data-theme="star"] .node.selected polygon {
  filter: drop-shadow(0 0 18px rgba(var(--theme-primary-rgb), 0.8));
}
/* 星光轨迹边：常态柔光，高亮时拖尾增强 */
body[data-theme="star"] .edge path {
  filter: drop-shadow(0 0 3px rgba(var(--theme-primary-rgb), 0.35));
}
body[data-theme="star"] .edge:hover path,
body[data-theme="star"] .edge.highlighted path,
body[data-theme="star"] .edge.selected path {
  filter: drop-shadow(0 0 10px rgba(var(--theme-primary-rgb), 0.75));
}
/* 边标签压在星野上需要暗色描边保底可读 */
body[data-theme="star"] .edge text {
  text-shadow: 0 0 4px var(--theme-secondary), 0 0 8px var(--theme-secondary);
}

/** ==== 右键菜单 ==== */
.context-menu {
  position: absolute;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 4px;
  min-width: 160px;
  z-index: 1000;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  font-size: 13px;
}
.context-menu-item {
  padding: 8px 12px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--theme-text);
}
.context-menu-item:hover {
  background: var(--theme-primary);
  color: #fff;
}
.context-menu-item.danger {
  color: #f44336;
}
.context-menu-item.danger:hover {
  background: #f44336;
  color: #fff;
}
.context-sep {
  height: 1px;
  background: var(--theme-border);
  margin: 4px 0;
}

/** ==== 框选 ==== */
.selection-box {
  position: absolute;
  border: 2px solid var(--theme-primary);
  background: rgba(var(--theme-primary-rgb), 0.1);
  pointer-events: none;
  z-index: 999;
  border-radius: 3px;
}

/** ==== 多选工具栏 ==== */
.multi-select-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 8px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 1000;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  font-size: 13px;
  color: var(--theme-text);
}
.multi-select-bar button {
  background: var(--theme-primary);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.multi-select-bar button:hover {
  opacity: 0.9;
}
.multi-select-bar #select-clear {
  background: var(--theme-border);
  color: var(--theme-text);
}

/** ==== 选中节点样式 ==== */
.node.selected rect,
.node.selected ellipse,
.node.selected polygon {
  outline: 3px solid var(--theme-primary);
  outline-offset: 2px;
}
.node.selected text {
  font-weight: bold;
}

/** ==== 仿真器面板样式 ==== */
.sim-panel {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.sim-panel h2 {
  font-size: 13px;
  color: var(--theme-text);
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--theme-border);
}
.sim-options {
  margin-bottom: 10px;
  font-size: 12px;
}
.sim-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--theme-text-sub);
}
.sim-toggle input {
  cursor: pointer;
}
.sim-panel h3 {
  font-size: 11px;
  color: var(--theme-text-sub);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 10px 0 6px 0;
}
.sim-state {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
}
.sim-state-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: var(--theme-secondary);
  border-radius: 4px;
  font-size: 12px;
}
.sim-state-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sim-state-key {
  color: var(--theme-text-sub);
  font-family: "JetBrains Mono", Consolas, monospace;
}
.sim-state-type {
  font-size: 10px;
  color: var(--theme-text-dim);
  text-transform: uppercase;
}
.sim-state-value-wrap {
  display: flex;
  align-items: center;
}
.sim-state-val {
  color: var(--theme-accent);
  font-weight: 600;
  font-family: "JetBrains Mono", Consolas, monospace;
}
.sim-input-wrap {
  display: flex;
  gap: 6px;
  margin-bottom: 8px;
}
.sim-input {
  flex: 1;
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
}
.sim-input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.sim-triggers {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
/* 动画速度控制 */
.anim-speed {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--theme-text-sub);
}
.anim-speed input[type="range"] {
  flex: 1;
  height: 4px;
  accent-color: var(--theme-primary);
  cursor: pointer;
}
.anim-speed-val {
  min-width: 30px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--theme-text);
}
/* 动画图例 */
.anim-legend {
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--theme-text-sub);
}
.anim-legend summary {
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
  color: var(--theme-text-dim);
}
.anim-legend summary:hover { color: var(--theme-text); }
.anim-legend-body {
  padding: 6px 4px 2px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.anim-legend-body i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: -1px;
}
.lg-dot.lg-explicit { background: var(--theme-accent); box-shadow: 0 0 0 1px #fff inset; }
.lg-dot.lg-default { background: var(--theme-accent); opacity: 0.45; width: 7px; height: 7px; }
.anim-legend-body i.lg-flash { border-radius: 2px; }
.lg-flash.lg-yellow { background: #ffeb3b; }
.lg-flash.lg-green { background: #4CAF50; }
.lg-flash.lg-gray { background: #666; }
.lg-flash.lg-red { background: #ff1744; }
/* 视图切换（节点/动画） */
.view-switcher {
  display: flex;
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  overflow: hidden;
}
.view-switcher button {
  background: var(--theme-input-bg);
  border: none;
  color: var(--theme-text-dim);
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all 0.15s ease;
}
.view-switcher button.active {
  background: var(--theme-primary);
  color: #fff;
}
.view-switcher button:not(.active):hover {
  background: var(--theme-hover);
  color: var(--theme-text);
}
/* 步进控制条（动画视图浮层） */
.stepper-bar {
  position: absolute;
  top: 46px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--theme-panel-bg);
  border: 1px solid var(--theme-border);
  border-radius: 8px;
  padding: 6px 12px;
  z-index: 60;
  box-shadow: 0 4px 16px rgba(0,0,0,0.35);
  font-size: 12px;
}
.stepper-bar button {
  background: var(--theme-border);
  border: none;
  color: var(--theme-text);
  padding: 4px 12px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.stepper-bar button:hover { background: var(--theme-hover); color: var(--theme-primary); }
.stepper-bar button.primary { background: var(--theme-primary); color: #fff; }
.stepper-status {
  color: var(--theme-text-sub);
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 动画视图：节点面板内输入框 */
.stepper-input-wrap {
  display: flex;
  gap: 4px;
  width: 100%;
  height: 100%;
  align-items: center;
}
.stepper-input {
  flex: 1;
  min-width: 0;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 4px;
  color: var(--theme-text);
  font-size: 10px;
  padding: 2px 6px;
  font-family: inherit;
}
.stepper-input:focus { outline: none; border-color: var(--theme-primary); }
.stepper-inject-btn {
  background: var(--theme-primary);
  border: none;
  color: #fff;
  border-radius: 4px;
  font-size: 10px;
  padding: 3px 8px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.stepper-inject-btn:hover { background: var(--theme-primary-dark); }
/* 动画视图下隐藏粒子层（数据表达由步进器接管） */
body[data-view="anim"] .anim-layer-v2 .anim-particle-v2 { display: none; }
.sim-btn {
  background: var(--theme-border);
  border: none;
  color: var(--theme-text);
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}
.sim-btn:hover {
  background: var(--theme-hover);
  color: var(--theme-primary);
}
.sim-btn-primary {
  background: var(--theme-primary);
  color: #fff;
}
.sim-btn-primary:hover {
  background: var(--theme-primary-dark);
  color: #fff;
}
.sim-btn-secondary {
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
}
.sim-trace-wrap {
  max-height: 200px;
  overflow-y: auto;
}
.sim-trace {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}
.sim-trace-item {
  padding: 4px 6px;
  background: var(--theme-secondary);
  border-radius: 4px;
  border-left: 2px solid var(--theme-primary);
  line-height: 1.4;
}
.sim-trace-item .trace-event {
  color: var(--theme-accent);
  font-weight: 600;
}
.sim-trace-item .trace-rule {
  color: var(--theme-text-sub);
  font-size: 10px;
}
.sim-trace-item .trace-reason {
  color: #ffc107;
  font-size: 10px;
}
/* 异常日志（L4.5）：expected=黄 / unexpected=红 / critical=深红底 */
.anim-log-wrap {
  max-height: 160px;
  overflow-y: auto;
}
.sim-trace-item.anim-log-warn {
  border-left-color: #ffc107;
}
.sim-trace-item.anim-log-warn .trace-event {
  color: #ffc107;
}
.sim-trace-item.anim-log-error {
  border-left-color: #ff1744;
  background: rgba(255, 23, 68, 0.12);
}
.sim-trace-item.anim-log-error .trace-event {
  color: #ff5252;
}
.sim-trace-item.anim-log-critical {
  border-left-color: #ff1744;
  background: rgba(255, 23, 68, 0.25);
  animation: animLogCriticalPulse 1.2s ease-in-out 3;
}
.sim-trace-item.anim-log-critical .trace-event {
  color: #ff1744;
}
@keyframes animLogCriticalPulse {
  0%, 100% { box-shadow: none; }
  50% { box-shadow: 0 0 8px rgba(255, 23, 68, 0.7); }
}

/* ── 报告导读面板（renderHTML options.report 注入，打开即见的体检摘要卡） ── */
.report-overlay {
  position: absolute;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(5px);
}
.report-overlay.hidden { display: none !important; }
.report-card {
  position: relative;
  width: min(640px, 94%);
  max-height: 88%;
  overflow-y: auto;
  background: var(--theme-secondary);
  border: 1px solid var(--theme-border);
  border-radius: 14px;
  padding: 26px 28px 22px;
  color: var(--theme-text);
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5), 0 0 24px rgba(var(--theme-primary-rgb), 0.12);
}
.report-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: transparent;
  border: 1px solid var(--theme-border);
  color: var(--theme-text);
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s ease;
}
.report-close:hover { background: var(--theme-border); }
.report-kicker {
  font-size: 11px;
  letter-spacing: 2.5px;
  font-weight: 600;
  color: var(--theme-primary);
  opacity: 0.75;
}
.report-heading { margin: 6px 0 4px; font-size: 22px; }
.report-subline { font-size: 12px; opacity: 0.6; margin-bottom: 16px; }
.report-metrics {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.report-metric {
  flex: 1 1 90px;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 10px;
  padding: 10px 12px;
  text-align: center;
}
.report-metric-val { font-size: 20px; font-weight: 700; color: var(--theme-primary); }
.report-metric-label { font-size: 11px; opacity: 0.65; margin-top: 2px; }
.report-section-title {
  font-size: 13px;
  font-weight: 700;
  margin: 16px 0 8px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.report-hint { font-size: 11px; font-weight: 400; opacity: 0.5; }
.report-hotspots {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.report-hotspot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  cursor: pointer;
  transition: all 0.15s ease;
  font-size: 13px;
}
.report-hotspot[data-fly]:hover {
  border-color: var(--theme-primary);
  transform: translateX(3px);
  box-shadow: 0 0 10px rgba(var(--theme-primary-rgb), 0.25);
}
.report-hotspot-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.sev-crit .report-hotspot-dot { background: #ef5350; box-shadow: 0 0 6px #ef5350; }
.sev-warn .report-hotspot-dot { background: #ffb300; box-shadow: 0 0 6px #ffb300; }
.report-hotspot-label { font-family: 'Consolas', 'Courier New', monospace; }
.report-hotspot-detail { margin-left: auto; font-size: 11px; opacity: 0.6; white-space: nowrap; }
.report-empty { font-size: 13px; opacity: 0.75; padding: 6px 2px; }
.report-tour { margin: 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; }
.report-tour-item { font-size: 13px; line-height: 1.55; padding: 2px 6px; border-radius: 6px; }
.report-tour-item[data-fly] { cursor: pointer; }
.report-tour-item[data-fly]:hover { background: var(--theme-input-bg); color: var(--theme-primary); }
.report-tour-item[data-fly]::after { content: ' ✈'; opacity: 0.5; font-size: 11px; }
.report-legend { font-size: 12px; opacity: 0.9; }
.report-legend-row { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 6px; }
.lg-item { display: inline-flex; align-items: center; gap: 5px; }
.lg-swatch { width: 14px; height: 10px; border-radius: 3px; display: inline-block; }
.lg-file { background: #1565c0; }
.lg-dir { background: #152141; border: 1px solid #90caf9; }
.lg-shape { color: var(--theme-primary); font-size: 13px; }
.lg-ops { opacity: 0.65; }
.report-start {
  margin-top: 20px;
  width: 100%;
  padding: 11px;
  background: var(--theme-primary);
  color: #fff;
  border: none;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  transition: filter 0.15s ease;
}
.report-start:hover { filter: brightness(1.15); }
.report-open-btn {
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  padding: 6px 12px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.2s ease;
}
.report-open-btn:hover { border-color: var(--theme-primary); }

/* ── Hub 导航：返回主页链接（renderHTML options.nav 注入） ── */
.home-link {
  color: var(--theme-primary);
  text-decoration: none;
  font-size: 13px;
  margin-right: 6px;
  padding: 3px 9px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.home-link:hover {
  border-color: var(--theme-primary);
  background: rgba(var(--theme-primary-rgb), 0.12);
}

/* ── 紧凑工具栏：⋯ 收纳编辑类按钮（报告/浏览场景） ── */
.toolbar-advanced { display: contents; }
.toolbar-advanced.hidden { display: none !important; }
/* 紧凑模式展开时：编辑组独占第二行，避免把主栏挤换行 */
.toolbar-advanced--row {
  display: flex;
  flex-basis: 100%;
  order: 10;
  align-items: center;
  gap: 10px;
  padding: 6px 2px 2px;
  border-top: 1px dashed var(--theme-border);
}
.toolbar-advanced--row.hidden { display: none !important; }
.advanced-toggle {
  min-width: 28px;
  height: 28px;
  padding: 0 9px;
  background: var(--theme-input-bg);
  border: 1px solid var(--theme-border);
  border-radius: 6px;
  color: var(--theme-text);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  transition: all 0.15s ease;
}
.advanced-toggle:hover,
.advanced-toggle.active {
  border-color: var(--theme-primary);
  color: var(--theme-primary);
}

/* 工具栏分组文字标签（如"主题"） */
.toolbar-label {
  font-size: 11px;
  color: var(--theme-text-dim);
  padding: 0 4px 0 6px;
  user-select: none;
}

@media (max-width: 768px) {
  main { grid-template-columns: 1fr; }
  .sidebar { border-left: none; border-top: 1px solid var(--theme-border); }
  .prop-editor { width: 95vw; }
}
`;
}
