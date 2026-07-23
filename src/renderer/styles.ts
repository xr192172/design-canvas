export function buildStyles(): string {
  return `
:root {
  --theme-primary: #e94560;
  --theme-secondary: #16213e;
  --theme-background: #0a0e27;
  --theme-card-bg: #16213e;
  --theme-border: #1f2a4d;
  --theme-text: #e6e6e6;
  --theme-text-sub: #8b9bb4;
  --theme-accent: #4fc3f7;
  --theme-success: #4caf50;
  --theme-warning: #ff9800;
  --theme-error: #f44336;
}

[data-theme="blue"] {
  --theme-primary: #e94560;
  --theme-secondary: #16213e;
  --theme-background: #0a0e27;
  --theme-card-bg: #16213e;
  --theme-border: #1f2a4d;
  --theme-text: #e6e6e6;
  --theme-text-sub: #8b9bb4;
  --theme-accent: #4fc3f7;
}

[data-theme="sakura"] {
  --theme-primary: #ff7eb3;
  --theme-secondary: #2d1b36;
  --theme-background: #1a0f1f;
  --theme-card-bg: #2d1b36;
  --theme-border: #4a2c50;
  --theme-text: #ffe6f2;
  --theme-text-sub: #c495b8;
  --theme-accent: #ffb6c1;
}

[data-theme="forest"] {
  --theme-primary: #4caf50;
  --theme-secondary: #1a2f1a;
  --theme-background: #0a140a;
  --theme-card-bg: #1a2f1a;
  --theme-border: #2d4d2d;
  --theme-text: #e8f5e9;
  --theme-text-sub: #81c784;
  --theme-accent: #81c784;
}

[data-theme="ocean"] {
  --theme-primary: #2196f3;
  --theme-secondary: #0d2847;
  --theme-background: #051828;
  --theme-card-bg: #0d2847;
  --theme-border: #1a3f6b;
  --theme-text: #e3f2fd;
  --theme-text-sub: #64b5f6;
  --theme-accent: #64b5f6;
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
  background: linear-gradient(135deg, var(--theme-secondary) 0%, #16213e 100%);
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
  background: rgba(233, 69, 96, 0.15);
  color: var(--theme-primary);
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid rgba(233, 69, 96, 0.3);
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
  filter: brightness(1.2) drop-shadow(0 0 10px rgba(233, 69, 96, 0.6));
  transform: scale(1.01);
}
.node.selected rect {
  stroke: var(--theme-primary) !important;
  stroke-width: 2 !important;
  filter: drop-shadow(0 0 14px rgba(233, 69, 96, 0.7));
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
  filter: brightness(1.2) drop-shadow(0 0 10px rgba(233, 69, 96, 0.6));
  transform: scale(1.01);
}
.node.selected circle,
.node.selected polygon {
  stroke: var(--theme-primary) !important;
  stroke-width: 2 !important;
  filter: drop-shadow(0 0 14px rgba(233, 69, 96, 0.7));
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
  background: #0d1330;
  border: 1px solid #1f2a4d;
  border-radius: 4px;
  padding: 6px 10px;
  font-family: "JetBrains Mono", Consolas, monospace;
  font-size: 11px;
  color: #4fc3f7;
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
.edge:hover path {
  stroke-width: 3;
}
.edge.dimmed path {
  opacity: 0.2;
}
.edge.highlighted path {
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(233, 69, 96, 0.5));
}
.edge.selected path {
  stroke-width: 4;
  stroke: var(--theme-primary);
  filter: drop-shadow(0 0 8px rgba(233, 69, 96, 0.8));
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
  filter: drop-shadow(0 2px 8px rgba(79, 195, 247, 0.4));
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
  background: rgba(22, 33, 62, 0.96);
  color: #fff;
  border: 1px solid #1f2a4d;
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
  color: #4fc3f7;
  padding-bottom: 6px;
  border-bottom: 1px solid #1f2a4d;
}
.msg-flow-item {
  padding: 8px;
  margin: 6px 0;
  background: rgba(255,255,255,0.05);
  border-radius: 6px;
  border-left: 3px solid #4fc3f7;
}
.msg-flow-item .msg-time {
  font-size: 10px;
  color: #5a6a88;
  margin-bottom: 4px;
}
.msg-flow-item .msg-content {
  font-size: 12px;
  color: #e0e0e0;
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
  background: rgba(233,69,96,0.2);
  border: none;
  color: #e94560;
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
  border: 1px solid #1f2a4d;
  border-radius: 4px;
  color: #5a6a88;
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
  fill: #2d2d5a !important;
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
  box-shadow: 0 4px 12px rgba(233, 69, 96, 0.15);
}
.card.active {
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px rgba(233, 69, 96, 0.2), 0 4px 12px rgba(233, 69, 96, 0.2);
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
  border-bottom: 1px solid rgba(31, 42, 77, 0.5);
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
  background: rgba(233, 69, 96, 0.08);
  border-left: 2px solid var(--theme-primary);
  margin-bottom: 4px;
  border-radius: 0 4px 4px 0;
  line-height: 1.5;
  transition: background 0.2s ease;
}
.invariants li:hover {
  background: rgba(233, 69, 96, 0.15);
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
  background: linear-gradient(135deg, var(--theme-primary) 0%, #c73652 100%);
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
  box-shadow: 0 4px 12px rgba(233, 69, 96, 0.4);
}
footer button:active {
  transform: translateY(0);
}
#tooltip {
  position: fixed;
  background: rgba(15, 52, 96, 0.97);
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
  padding: 8px 12px;
  background: var(--theme-secondary);
  border-bottom: 1px solid var(--theme-border);
  gap: 12px;
  z-index: 10;
}
.search-input {
  flex: 1;
  max-width: 320px;
  background: #162042;
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
  color: #5a6a88;
}
.layout-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  background: #162042;
  border-radius: 6px;
  padding: 2px;
}
.layout-controls button {
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}
.layout-controls button:hover {
  background: #2a3860;
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
  width: 28px;
  height: 28px;
  border-radius: 5px;
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
  font-family: inherit;
}
.zoom-controls button:hover {
  background: #2a3860;
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
  width: 32px;
  height: 32px;
  border: 1px solid var(--theme-border);
  background: var(--theme-card-bg);
  color: var(--theme-text);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
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
.history-indicator {
  font-size: 11px;
  color: #5a6a88;
  padding: 4px 10px;
  background: rgba(22, 33, 62, 0.5);
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
  background: linear-gradient(135deg, #1a2350 0%, var(--theme-card-bg) 100%);
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
  background: rgba(233, 69, 96, 0.15);
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
  background: linear-gradient(135deg, var(--theme-primary) 0%, #c73652 100%);
  color: white;
}
.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(233, 69, 96, 0.4);
}
.btn-secondary {
  background: var(--theme-border);
  color: var(--theme-text);
}
.btn-secondary:hover {
  background: #2a3860;
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
  background: #162042;
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
  background: #2a3860;
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
  background: linear-gradient(90deg, var(--theme-primary), #ff758f);
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
  0%, 100% { filter: drop-shadow(0 0 4px rgba(233, 69, 96, 0.4)); }
  50% { filter: drop-shadow(0 0 14px rgba(233, 69, 96, 0.9)); }
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
  background: #162042;
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
.theme-blue { background: linear-gradient(135deg, #e94560, #16213e); }
.theme-sakura { background: linear-gradient(135deg, #ff7eb3, #2d1b36); }
.theme-forest { background: linear-gradient(135deg, #4caf50, #1a2f1a); }
.theme-ocean { background: linear-gradient(135deg, #2196f3, #0d2847); }

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
  background: rgba(233, 69, 96, 0.1);
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
  color: #5a6a88;
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
  background: #2a3860;
  color: var(--theme-primary);
}
.sim-btn-primary {
  background: var(--theme-primary);
  color: #fff;
}
.sim-btn-primary:hover {
  background: #d13a54;
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

@media (max-width: 768px) {
  main { grid-template-columns: 1fr; }
  .sidebar { border-left: none; border-top: 1px solid var(--theme-border); }
  .prop-editor { width: 95vw; }
}
`;
}
