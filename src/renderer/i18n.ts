/**
 * 界面多语言（i18n）字典：中英双语。
 *
 * 设计原则：
 * - 只覆盖「界面静态文案」（按钮/标签/图例/提示/面板标题），不含内容数据
 *   （内容数据 = 模块名/API 说明，由 LLM 生成存于 DSL，属另一链路）。
 * - 字典不可翻译时回退 key 本身或中文，保证缺失不崩。
 * - 语言选择存 localStorage('dc-lang')，默认跟随浏览器 navigator.language。
 */
/// <reference lib="dom" />

export type Lang = 'zh' | 'en';

/** 从 localStorage / 浏览器优先语言解析当前语言 */
export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('dc-lang');
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* SSR / 禁用存储时忽略 */ }
  try {
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('zh')) return 'zh';
  } catch { /* ignore */ }
  return 'en';
}

/** 运行时语言字典：key → { zh, en } */
export const UI_DICT: Record<string, { zh: string; en: string }> = {
  // ── Header / 元数据 ──
  'home': { zh: '主页', en: 'Home' },
  'files': { zh: '文件', en: 'files' },
  'invariants': { zh: '不变式', en: 'invariants' },

  // ── 工具栏 ──
  'search_placeholder': { zh: '🔍 搜索节点 (label / id)...', en: '🔍 Search node (label / id)...' },
  'report_open': { zh: '📋 摘要', en: '📋 Summary' },
  'design_view': { zh: '🎭 设计', en: '🎭 Design' },
  'actual_view': { zh: '⚡ 实际', en: '⚡ Actual' },
  'nodes_view': { zh: '🗂 节点', en: '🗂 Nodes' },
  'anim_view': { zh: '🎬 动画', en: '🎬 Animation' },
  'tools_more': { zh: '⋯ 工具', en: '⋯ Tools' },
  'layer_error': { zh: '🛡 异常', en: '🛡 Errors' },
  'layer_detail': { zh: '🧩 细节', en: '🧩 Details' },
  'dataflow': { zh: '▶ 数据流', en: '▶ Dataflow' },
  'diff_impact': { zh: '🖍 影响', en: '🖍 Impact' },
  'layer_viz': { zh: '🎨 图层', en: '🎨 Layers' },
  'guided_tour': { zh: '▶ 导览', en: '▶ Tour' },
  'filter': { zh: '筛选', en: 'Filter' },
  'filter_draft': { zh: '⬜ 待实现', en: '⬜ Draft' },
  'filter_doing': { zh: '🟠 实现中', en: '🟠 Active' },
  'filter_done': { zh: '✅ 已完成', en: '✅ Done' },
  'filter_islands': { zh: '🗑 孤岛', en: '🗑 Islands' },
  'filter_focus': { zh: '🎯 聚焦', en: '🎯 Focus' },
  'undo': { zh: '↶ 撤销', en: '↶ Undo' },
  'redo': { zh: '↷ 重做', en: '↷ Redo' },
  'layout_topology': { zh: '🗺️ 拓扑', en: '🗺️ Topology' },
  'layout_force': { zh: '⚡ 力导', en: '⚡ Force' },
  'layout_grid': { zh: '📐 网格', en: '📐 Grid' },
  'dict_open': { zh: '📖 伪维基', en: '📖 Lexicon' },
  'theme': { zh: '主题', en: 'Theme' },
  'zoom_fit': { zh: '⤢ 适应', en: '⤢ Fit' },
  'zoom_reset': { zh: '⟲ 重置', en: '⟲ Reset' },
  'feature_overview': { zh: '🏷 功能概览', en: '🏷 Features' },
  'sidebar_toggle': { zh: '面板', en: 'Panel' },

  // ── 右键菜单 / 多选 ──
  'edit_label': { zh: '✏️ 编辑标签', en: '✏️ Edit label' },
  'add_annotation': { zh: '💬 添加标注', en: '💬 Add annotation' },
  'submit_approval': { zh: '📤 提交审批', en: '📤 Submit approval' },
  'delete_node': { zh: '🗑️ 删除节点', en: '🗑️ Delete node' },
  'selected_count': { zh: '已选 {n} 个节点', en: '{n} selected' },
  'batch_delete': { zh: '批量删除', en: 'Delete' },
  'clear_selection': { zh: '取消选择', en: 'Clear' },

  // ── 侧边栏 ──
  'anim_engine': { zh: '🎬 动画引擎', en: '🎬 Animation Engine' },
  'pause': { zh: '⏸ 暂停', en: '⏸ Pause' },
  'step': { zh: '⏭ 步进', en: '⏭ Step' },
  'resume': { zh: '▶ 继续', en: '▶ Resume' },
  'reset_anim': { zh: '↺ 重置动画', en: '↺ Reset' },
  'speed': { zh: '速度', en: 'Speed' },
  'slowmo': { zh: '🐢 慢动作', en: '🐢 Slow-mo' },
  'legend': { zh: '图例', en: 'Legend' },
  'legend_explicit': { zh: '显式数据流（带标签）', en: 'Explicit flow (labeled)' },
  'legend_default': { zh: 'L0 氛围流（无标签）', en: 'L0 ambient flow' },
  'legend_call': { zh: '黄闪：函数调用（ƒ）', en: 'Yellow: function call (ƒ)' },
  'legend_branch': { zh: '彩闪：分支命中（按分支着色）', en: 'Flash: branch hit' },
  'legend_branch_miss': { zh: '灰闪：分支全未命中', en: 'Gray: branch missed' },
  'legend_error': { zh: '红闪：异常（长闪=未声明）', en: 'Red: error (long=undeclared)' },
  'simulator': { zh: '🔬 仿真器', en: '🔬 Simulator' },
  'sim_show_edges': { zh: '显示事件流连线', en: 'Show event-flow edges' },
  'sim_send': { zh: '发送', en: 'Send' },
  'sim_reset': { zh: '重置', en: 'Reset' },
  'sim_trace_log': { zh: '触发日志', en: 'Trigger log' },
  'error_log': { zh: '异常日志（L4.5）', en: 'Error log (L4.5)' },
  'semantic_layer': { zh: 'Semantic 语义层', en: 'Semantic Layer' },
  'no_semantic': { zh: '无语义层信息', en: 'No semantic info' },
  'implemented': { zh: '已实现', en: 'Implemented' },
  'missing': { zh: '未实现', en: 'Missing' },
  'extra_api': { zh: '代码新增', en: 'Extra' },
  'lines': { zh: '行', en: 'lines' },

  // ── 功能卡片首屏 ──
  'features_kicker': { zh: 'PRODUCT FEATURES', en: 'PRODUCT FEATURES' },
  'features_title': { zh: '产品功能概览', en: 'Product Feature Overview' },
  'features_sub': { zh: '点击功能卡片，钻入其社区与文件；点击右上角进入星图', en: 'Click a feature to drill into its communities & files; click top-right to enter the star map' },
  'features_enter': { zh: '进入星图 →', en: 'Enter Star Map →' },
  'communities': { zh: '社区', en: 'communities' },
  'files_cap': { zh: '文件', en: 'files' },

  // ── 页脚 ──
  'footer_hint': { zh: '· 双击节点编辑属性 · 右键节点开始连线', en: '· double-click node to edit · right-click node to connect' },
  'rerender': { zh: '重新渲染', en: 'Re-render' },
  'export_json': { zh: '📥 导出 design-canvas.json', en: '📥 Export design-canvas.json' },
  'import_json': { zh: '📤 导入 DSL', en: '📤 Import DSL' },

  // ── 节点属性编辑器 ──
  'node_props': { zh: '节点属性', en: 'Node Properties' },
  'node_id': { zh: 'ID', en: 'ID' },
  'label_name': { zh: '名称 (label)', en: 'Name (label)' },
  'label_type': { zh: '类型 (type)', en: 'Type (type)' },
  'label_status': { zh: '状态 (status)', en: 'Status (status)' },
  'label_desc': { zh: '描述 (description)', en: 'Description (description)' },
  'label_shape': { zh: '形状 (shape)', en: 'Shape (shape)' },
  'label_bg': { zh: '背景色 (bg)', en: 'Background (bg)' },
  'label_radius': { zh: '圆角 (borderRadius)', en: 'Corner radius (borderRadius)' },
  'label_content_type': { zh: '内容类型 (content.type)', en: 'Content type (content.type)' },
  'label_content_blocks': { zh: '内容块 JSON (content.blocks)', en: 'Content blocks JSON (content.blocks)' },
  'editor_cancel': { zh: '取消', en: 'Cancel' },
  'editor_save': { zh: '保存', en: 'Save' },

  // ── 注入回放面板 ──
  'replay_title': { zh: '🧪 进料口 · 注入回放', en: '🧪 Injector · Replay' },
  'replay_flow': { zh: 'Flow', en: 'Flow' },
  'replay_preset': { zh: '预设异常场景（从 errors 声明自动构造注入值）', en: 'Preset error scenarios (auto-built from errors)' },
  'replay_preset_none': { zh: '（不预设，手动编辑下方 JSON）', en: '(none — edit JSON below)' },
  'replay_inject': { zh: '注入值 JSON（作为 handler 返回值 result）', en: 'Inject JSON (as handler result)' },
  'replay_value': { zh: '分支求值上下文 value（可选，JSON；缺省取 flow.mock_values[0]）', en: 'Branch eval context value (optional JSON)' },
  'replay_open_label': { zh: '注入回放（D3）', en: 'Inject replay (D3)' },
  'replay_open_btn': { zh: '🧪 打开进料口面板（{n} 条 flow）', en: '🧪 Open injector ({n} flows)' },

  // ── 页头徽标 / 计数 ──
  'files_count': { zh: '{n} 文件', en: '{n} files' },
  'invariants_count': { zh: '{n} 不变式', en: '{n} invariants' },

  // ── 图层图例 ──
  'layer_viz_title': { zh: '🎨 架构分层', en: '🎨 Architecture Layers' },

  // ── 摘要面板（report） ──
  'report_monolith_top': { zh: '⚠ 巨石文件 TOP', en: '⚠ Monolith files TOP' },
  'report_tour_title': { zh: '🧭 推荐探索路径', en: '🧭 Recommended tour' },
  'report_legend_title': { zh: '📖 图例与操作', en: '📖 Legend & actions' },
  'report_hint_fly': { zh: '点击条目直达节点', en: 'Click to fly to node' },
  'report_hint_tour': { zh: '带 ✈ 的步骤可点击定位', en: '✈ steps are clickable to locate' },
  'report_empty': { zh: '✅ 全部文件在阈值内，无巨石', en: '✅ All files within threshold, no monolith' },
  'report_start': { zh: '开始探索 →', en: 'Start exploring →' },
  'report_start_first': { zh: '开始探索：直达第一站 →', en: 'Start exploring: to first stop →' },
  'report_legend_file': { zh: '文件（颜色=语言）', en: 'file (color=language)' },
  'report_legend_dir': { zh: '目录容器', en: 'directory' },
  'report_legend_branch': { zh: '分支', en: 'branch' },
  'report_legend_loop': { zh: '循环', en: 'loop' },
  'report_legend_entry': { zh: '入口/返回', en: 'entry/return' },
  'report_ops_click': { zh: '单击节点=选中看详情', en: 'click node to select & inspect' },
  'report_ops_expand': { zh: '左上 ▸ 角标=展开内部', en: '▸ corner = expand' },
  'report_ops_zoom': { zh: '滚轮=缩放', en: 'scroll to zoom' },
  'report_ops_pan': { zh: '拖拽空白=平移', en: 'drag to pan' },

  // ── 功能卡片首屏（计数） ──
  'feature_count': { zh: '{n} 功能', en: '{n} features' },
  'community_count': { zh: '{n} 社区', en: '{n} communities' },
  'file_count_cap': { zh: '{n} 文件', en: '{n} files' },
  'feature_card_comm': { zh: '{n} 社区', en: '{n} communities' },
  'feature_card_file': { zh: '{n} 文件', en: '{n} files' },
  'feature_card_lines': { zh: '~{n} 行', en: '~{n} lines' },

  // ── 仿真器 / 侧栏补充 ──
  'sim_placeholder': { zh: '用户输入...', en: 'User input...' },
  'invariants_title': { zh: '不变式 ({n})', en: 'Invariants ({n})' },

  // ── 页脚 ──
  'footer_ops': { zh: '双击节点编辑属性 · 右键节点开始连线', en: 'double-click node to edit · right-click node to connect' },

  // ── 语义卡片 API 区块 ──
  'api_done': { zh: '✓ 已实现 ({n})', en: '✓ Implemented ({n})' },
  'api_missing': { zh: '✗ 未实现 ({n})', en: '✗ Not implemented ({n})' },
  'api_extra': { zh: '+ 代码新增 ({n})', en: '+ Extra in code ({n})' },
};

/** 取某 key 在指定语言下的文案；缺失时回退英文→中文→key */
export function t(key: string, lang: Lang): string {
  const entry = UI_DICT[key];
  if (!entry) return key;
  return entry[lang] ?? entry.zh ?? key;
}

/** 内容数据双语取值：优先所选语言，缺失回退 base（中文/默认） */
export function pick(base: string | undefined, en: string | undefined, lang: Lang): string {
  const b = base ?? '';
  if (lang === 'en' && en) return en;
  return b;
}

/** 为内容元素生成双语 data 属性（中英写入 data-zh/data-en，运行时按语言取值）。
 *  base 缺失时中英均回退为英文参数（en）或空串。返回含引导空格的属性串或空串。 */
export function contentAttrs(base: string | undefined, en: string | undefined): string {
  const b = base ?? '';
  const e = en || b;
  if (!b && !e) return '';
  return ` data-zh="${escapeAttr(b)}" data-en="${escapeAttr(e)}" data-i18n-content="1"`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 运行时翻译：把 root 下已标注的元素按 lang 更新。
 *  - [data-i18n]         → 文本（t() 取值，支持 data-i18n-args 模板 {n}）
 *  - [data-i18n-ph]      → placeholder 属性
 *  - [data-i18n-title]   → title 属性
 *  - [data-i18n-content] → 内容数据（data-zh/data-en 二选一）
 *  - [data-lang-btn]     → 语言切换按钮高亮
 */
export function applyStaticI18n(root: Document | HTMLElement, lang: Lang): void {
  const q = (sel: string, scope: Document | HTMLElement): NodeListOf<HTMLElement> =>
    (scope as HTMLElement).querySelectorAll(sel) as NodeListOf<HTMLElement>;

  q('[data-i18n]', root).forEach((el) => {
    const key = el.getAttribute('data-i18n') || '';
    let txt = t(key, lang);
    const argsAttr = el.getAttribute('data-i18n-args');
    if (argsAttr) {
      try {
        const args = JSON.parse(argsAttr);
        txt = txt.replace(/\{(\w+)\}/g, (_, k: string) => (args[k] != null ? String(args[k]) : `{${k}}`));
      } catch { /* 忽略非法 args */ }
    }
    el.textContent = txt;
  });
  q('[data-i18n-ph]', root).forEach((el) => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph') || '', lang));
  });
  q('[data-i18n-title]', root).forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title') || '', lang));
  });
  q('[data-i18n-content]', root).forEach((el) => {
    const zhV = el.getAttribute('data-zh');
    const enV = el.getAttribute('data-en');
    el.textContent = lang === 'en' && enV != null ? enV : (zhV != null ? zhV : el.textContent);
  });
  q('[data-lang-btn]', root).forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-lang-btn') === lang);
  });
}