import { EDGE_GEOM_SOURCE } from './edge_geom_bundle.gen.js';
import { DATAFLOW_SOURCE } from './dataflow_core_bundle.gen.js';
import { I18N_SOURCE } from './i18n_bundle.gen.js';

export function buildScript(dsl: unknown): string {
  const dslJson = JSON.stringify(dsl).replace(/</g, '\\u003c');
  return `
/* __DSL_START__ */
window.__DSL__ = ${dslJson};
/* __DSL_END__ */

(function() {
  // ---- 边几何纯逻辑（构建期从 edge_geom.ts 内联，单源双消费，勿手改）----
${EDGE_GEOM_SOURCE}

  // ---- 数据流追踪核心（构建期从 dataflow_core.ts 内联，单源双消费，勿手改）----
${DATAFLOW_SOURCE}

  // ---- 界面多语言字典 + 翻译函数（构建期从 i18n.ts 内联，单源双消费，勿手改）----
${I18N_SOURCE}

  const tooltip = document.getElementById('tooltip');
  const dsl = window.__DSL__;

  // ==== 数据源视图（实际/设计）====
  // 'design'=人编辑的布局/状态（默认静态）；'actual'=代码实时同步快照（只读，serve 模式）
  const dcView = (typeof localStorage !== 'undefined' && localStorage.getItem('dc-view')) || 'design';
  document.body.setAttribute('data-view', dcView);

  // ==== 数据预处理 ====
  const annoByTarget = {};
  (dsl.annotations || []).forEach(a => {
    if (!annoByTarget[a.target_id]) annoByTarget[a.target_id] = [];
    annoByTarget[a.target_id].push(a);
  });

  // 节点索引
  const nodeById = {};
  (dsl.geometry?.nodes || []).forEach(n => { nodeById[n.id] = n; });

  // 边索引：按 from/to 分组
  const edgesByFrom = {};
  const edgesByTo = {};
  const edgeById = {};
  (dsl.geometry?.edges || []).forEach(e => {
    edgeById[e.id] = e;
    if (!edgesByFrom[e.from]) edgesByFrom[e.from] = [];
    edgesByFrom[e.from].push(e);
    if (!edgesByTo[e.to]) edgesByTo[e.to] = [];
    edgesByTo[e.to].push(e);
  });

  // DOM 元素缓存：避免 selectNode 等高频路径反复 document.querySelector 全量扫描
  const nodeElById = {};
  const edgeElById = {};

  // 节点 shape 元素缓存：getNodePos 高频调用，避免重复 querySelector('[data-shape="true"]')
  const nodeShapeElCache = new WeakMap();

  // 通过 contains 边推断父子关系
  const childrenOf = {};
  const parentOf = {};
  (dsl.geometry?.edges || []).forEach(e => {
    const label = (e.label || '').toLowerCase();
    if (label === 'contains' || label === '包含') {
      if (!childrenOf[e.from]) childrenOf[e.from] = [];
      childrenOf[e.from].push(e.to);
      parentOf[e.to] = e.from;
    }
  });

  // ==== 职责分层：层索引 ====
  // layerOf: nodeId → 'main'|'error'|'detail'（缺省 main）
  // hostChildren: hostId → { error: [ids], detail: [ids] }（仅 host 指向已存在节点的才挂角标）
  const layerOf = {};
  const hostChildren = {};
  (dsl.geometry?.nodes || []).forEach(n => {
    const layer = n.layer || 'main';
    layerOf[n.id] = layer;
    if (layer !== 'main' && n.host && nodeById[n.host]) {
      if (!hostChildren[n.host]) hostChildren[n.host] = { error: [], detail: [] };
      hostChildren[n.host][layer].push(n.id);
    }
  });

  // 递归获取所有后代节点
  function getAllDescendants(nodeId) {
    const result = [];
    const stack = [...(childrenOf[nodeId] || [])];
    while (stack.length) {
      const id = stack.pop();
      result.push(id);
      (childrenOf[id] || []).forEach(c => stack.push(c));
    }
    return result;
  }

  // ==== 状态 ====
  const state = {
    selectedId: null,
    collapsed: new Set(),
    expandedLayers: new Set(),  // 'hostId:layer' 宿主角标展开的层
    globalLayers: { error: false, detail: false },  // 全局层开关
    dragging: null,
    dragOffset: { x: 0, y: 0 },
    dragStartPos: null,
    dragMoved: false,
    snapCandidates: null,   // 拖拽吸附候选节点框（startDrag 时构建一次）
    snapGuides: null,       // 拖拽吸附参考线（<g> 元素）
    connecting: null,
    tempLine: null,
    dirty: false,
    multiSelect: new Set(),
    multiDragging: false,
    multiDragStart: new Map(),
    selecting: false,
    selectionStart: { x: 0, y: 0 },
    contextMenuNodeId: null,
    edgeDragging: null,       // 当前拖拽的边 ID
    edgeDragStartMouse: null, // 拖拽起始鼠标坐标（画布坐标系）
    edgeCtrlOffset: {},       // 边控制点用户偏移 { edgeId: { dx, dy } }
    // 人端筛选：状态多选（空=全部）/ 孤岛隐藏 / 聚焦节点（null=关闭）
    filter: { statuses: new Set(), hideIslands: false, focusId: null },
  };

  // ==== 撤销/重做 ====
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 50;

  function pushUndo() {
    const snapshot = JSON.stringify(dsl);
    undoStack.push(snapshot);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
    updateHistoryIndicator();
  }

  function undo() {
    if (undoStack.length === 0) return false;
    const current = JSON.stringify(dsl);
    redoStack.push(current);
    const snapshot = undoStack.pop();
    try {
      const restored = JSON.parse(snapshot);
      Object.assign(dsl, restored);
      window.__DSL__ = dsl;
      saveLocal();
      // 全量刷新页面，确保所有新特性（仿真边、折叠、子图等）都正确渲染
      location.reload();
      return true;
    } catch (e) {
      console.error('Undo failed:', e);
      return false;
    }
  }

  function redo() {
    if (redoStack.length === 0) return false;
    const current = JSON.stringify(dsl);
    undoStack.push(current);
    const snapshot = redoStack.pop();
    try {
      const restored = JSON.parse(snapshot);
      Object.assign(dsl, restored);
      window.__DSL__ = dsl;
      saveLocal();
      // 全量刷新页面，确保所有新特性都正确渲染
      location.reload();
      return true;
    } catch (e) {
      console.error('Redo failed:', e);
      return false;
    }
  }

  function updateHistoryIndicator() {
    const el = document.getElementById('history-indicator');
    if (el) el.textContent = '撤销: ' + undoStack.length + ' | 重做: ' + redoStack.length;
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  function renderFromDSL() {
    const svg = document.getElementById('canvas');
    if (!svg) return;

    // 清除现有节点和边
    svg.querySelectorAll('.node, .edge').forEach(el => el.remove());
    // 清空 DOM 元素缓存
    Object.keys(nodeElById).forEach(k => delete nodeElById[k]);
    Object.keys(edgeElById).forEach(k => delete edgeElById[k]);

    // 重建节点
    (dsl.geometry?.nodes || []).forEach(n => {
      const ns = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'node' + (n.status ? ' status-' + n.status : ''));
      g.setAttribute('data-id', n.id);
      g.setAttribute('transform', 'translate(' + (n.x || 0) + ', ' + (n.y || 0) + ')');

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('width', n.width || 120);
      rect.setAttribute('height', n.height || 60);
      rect.setAttribute('rx', 8);
      rect.setAttribute('data-shape', 'true');
      g.appendChild(rect);

      const text = document.createElementNS(ns, 'text');
      text.setAttribute('class', 'node-label');
      text.setAttribute('x', (n.width || 120) / 2);
      text.setAttribute('y', (n.height || 60) / 2 + 5);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = n.label || n.id;
      g.appendChild(text);

      svg.appendChild(g);
      nodeElById[n.id] = g;

      // 重新绑定事件
      bindNodeEvents(g, n.id);
    });

    // 重建边
    (dsl.geometry?.edges || []).forEach(e => {
      const fromNode = nodeById[e.from];
      const toNode = nodeById[e.to];
      if (!fromNode || !toNode) return;

      const ns = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'edge');
      g.setAttribute('data-id', e.id);

      const path = document.createElementNS(ns, 'path');
      const fcx = (fromNode.x || 0) + (fromNode.width || 120) / 2;
      const fcy = (fromNode.y || 0) + (fromNode.height || 60) / 2;
      const tcx = (toNode.x || 0) + (toNode.width || 120) / 2;
      const tcy = (toNode.y || 0) + (toNode.height || 60) / 2;
      path.setAttribute('d', 'M ' + fcx + ' ' + fcy + ' L ' + tcx + ' ' + tcy);
      path.setAttribute('marker-end', 'url(#arrow)');
      g.appendChild(path);

      if (e.label) {
        const text = document.createElementNS(ns, 'text');
        text.setAttribute('x', (fcx + tcx) / 2);
        text.setAttribute('y', (fcy + tcy) / 2);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-label');
        text.textContent = e.label;
        g.appendChild(text);
      }

      svg.appendChild(g);
      edgeElById[e.id] = g;
      bindEdgeEvents(g, e.id);
    });

    // 重建索引
    nodeById = {};
    (dsl.geometry?.nodes || []).forEach(n => { nodeById[n.id] = n; });
    edgeById = {};
    edgesByFrom = {};
    edgesByTo = {};
    (dsl.geometry?.edges || []).forEach(e => {
      edgeById[e.id] = e;
      if (!edgesByFrom[e.from]) edgesByFrom[e.from] = [];
      edgesByFrom[e.from].push(e);
      if (!edgesByTo[e.to]) edgesByTo[e.to] = [];
      edgesByTo[e.to].push(e);
    });

    clearSelection();
  }

  function bindNodeEvents(nodeEl, nodeId) {
    nodeEl.addEventListener('mouseenter', e => showTooltip(e, nodeId));
    nodeEl.addEventListener('mousemove', moveTooltip);
    nodeEl.addEventListener('mouseleave', hideTooltip);
    nodeEl.addEventListener('contextmenu', e => { e.preventDefault(); startConnect(nodeEl, e); });
    nodeEl.addEventListener('click', e => {
      if (state.selectedId === nodeId) clearSelection();
      else selectNode(nodeId);
    });
    nodeEl.addEventListener('dblclick', e => {
      e.stopPropagation();
      e.preventDefault();
      // 双击节点 → 选中并打开该节点的留言面板（比拖拽更符合人机协作直觉）
      openAnnoPanel(nodeId);
    });
    nodeEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      // 与 setupNodes 的拖拽保持一致：统一走 startDrag（基于 getNodePos 计算 offset，
      // 兼容含 transform 与不含 transform 的节点）。此前这里用 transform 坐标重设 offset，
      // 会把容器节点（无 transform）的拖拽偏移算成屏幕坐标，导致拖不动 / 节点夹。
      startDrag(nodeEl, e);
    });
  }

  function bindEdgeEvents(edgeEl, edgeId) {
    edgeEl.addEventListener('click', e => {
      e.stopPropagation();
      selectEdge(edgeId);
    });
    edgeEl.addEventListener('dblclick', e => {
      e.stopPropagation();
      openEdgeEditor(edgeId);
    });
    edgeEl.addEventListener('mousedown', e => {
      startEdgeDrag(edgeId, e);
    });
  }

  // ==== 自动持久化到 localStorage ====
  function saveLocal() {
    try {
      localStorage.setItem('design-canvas:' + (dsl.feature || 'unknown'), JSON.stringify(dsl));
      // 同时保存 undo/redo 栈
      const historyKey = 'design-canvas-history:' + (dsl.feature || 'unknown');
      localStorage.setItem(historyKey, JSON.stringify({
        undo: undoStack,
        redo: redoStack,
      }));
      // 保存折叠状态
      const collapsedKey = 'design-canvas-collapsed:' + (dsl.feature || 'unknown');
      localStorage.setItem(collapsedKey, JSON.stringify(Array.from(state.collapsed)));
      // 保存边控制点偏移
      const edgeOffsetKey = 'design-canvas-edge-offsets:' + (dsl.feature || 'unknown');
      localStorage.setItem(edgeOffsetKey, JSON.stringify(state.edgeCtrlOffset));
    } catch (e) {
      console.warn('localStorage save failed', e);
    }
  }

  // 加载 undo/redo 历史
  function loadHistory() {
    try {
      const historyKey = 'design-canvas-history:' + (dsl.feature || 'unknown');
      const raw = localStorage.getItem(historyKey);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.undo && Array.isArray(data.undo)) {
        undoStack.length = 0;
        for (var i = 0; i < data.undo.length; i++) undoStack.push(data.undo[i]);
      }
      if (data.redo && Array.isArray(data.redo)) {
        redoStack.length = 0;
        for (var j = 0; j < data.redo.length; j++) redoStack.push(data.redo[j]);
      }
    } catch (e) {
      console.warn('load history failed', e);
    }
  }

  // ==== 自动同步到服务器 ====
  let saveTimeout = null;
  function saveToServer() {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      if (window.location.protocol === 'file:') return;
      // 提交携带当前基版本 _dsl_rev：若服务端已被人（MCP/其他会话）推进，
      // 返回 409+conflict，浏览器据此提示 rebase 而非静默覆盖，防「最后写者胜」
      var payload = JSON.parse(JSON.stringify(window.__DSL__ || {}));
      fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(r => {
          if (r.status === 409) {
            return r.json().then(data => {
              var cur = data && typeof data.current_rev === 'number' ? data.current_rev : null;
              // 有冲突：不覆盖服务器端他人的改动。
              // ①先把本地未同步改动落 localStorage（刷新后 applyLocalOverrides 会自动
              //   把本地几何/新增边/标注合并回服务器最新版 —— 即自动 rebase，本地不丢）
              // ②提示冲突，并提供「拉取最新」入口触发刷新引导 rebase。
              if (saveLocal) { try { saveLocal(); } catch (e) { console.warn('冲突暂存本地改动失败', e); } }
              var hint = '检测到 DSL 冲突：' + (data && data.message ? data.message : '设计已被其他会话更新');
              if (cur !== null && typeof window.__DSL__._dsl_rev === 'number' && window.__DSL__._dsl_rev <= cur) {
                hint += '（本地基于 ' + window.__DSL__._dsl_rev + '，服务器最新 ' + cur + '）';
              }
              hint += '。本地改动已保留，点击「拉取最新」自动合并并重存';
              showToast(hint.trim(), 'error');
              // 冲突介入点（悬浮窗）：让用户选择是拉取最新合并，还是保留本地强推
              ensureConflictBar(cur, window.__DSL__ && window.__DSL__._dsl_rev);
              console.warn('DSL 冲突，未覆盖服务器改动：', data);
            });
          }
          return r.json();
        })
        .then(data => {
          if (data && data.success) {
            var newRev = data.rev;
            // 成功后把服务端权威 rev 回写本地，保持乐观锁基准，避免下一次保存重复冲突
            if (typeof newRev === 'number' && window.__DSL__) window.__DSL__._dsl_rev = newRev;
            console.log('DSL 已同步到服务器 rev=' + newRev);
          } else if (data && !data.conflict) {
            console.warn('服务器保存失败:', data.error);
          }
        })
        .catch(() => {
          console.log('服务器不可用，仅保存到 localStorage');
        });
    }, 500);
  }

  // 冲突介入悬浮窗：乐观锁 409 时引导 rebase。
  // 「拉取最新并合并」→ 刷新页面，applyLocalOverrides 会把暂存的本地几何/新增边/标注
  //   合并回服务器最新 DSL（本地不丢），随后以新 rev 重存即完成 rebase。
  // 「关闭」→ 保持现状，本地改动仍在 localStorage，后续仍可手动刷新合并。
  function ensureConflictBar(currentRev, baseRev) {
    var existing = document.getElementById('conflict-bar');
    if (existing) existing.remove();
    var bar = document.createElement('div');
    bar.id = 'conflict-bar';
    bar.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2500;' +
      'display:flex;align-items:center;gap:12px;padding:10px 16px;border-radius:8px;' +
      'background:rgba(244,67,54,0.95);color:#fff;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,0.35);' +
      'max-width:80%;flex-wrap:wrap;';
    var msg = document.createElement('span');
    msg.textContent = 'DSL 冲突：' +
      (baseRev !== undefined ? '本地基于 rev ' + baseRev + '，' : '') +
      '服务器最新 rev ' + (currentRev !== undefined ? currentRev : '?') + '。拉取最新将保留并合并你的本地改动';
    bar.appendChild(msg);

    var btnPull = document.createElement('button');
    btnPull.textContent = '拉取最新并合并';
    btnPull.style.cssText = 'padding:4px 12px;border:none;border-radius:5px;background:#fff;color:#d32f2f;font-size:13px;cursor:pointer;font-weight:600;';
    btnPull.addEventListener('click', function () {
      // 先确保本地改动已暂存（前面 saveToServer 已调 saveLocal），再刷新触发自动合并
      if (saveLocal) { try { saveLocal(); } catch (e) {} }
      location.reload();
    });
    bar.appendChild(btnPull);

    var btnClose = document.createElement('button');
    btnClose.textContent = '关闭';
    btnClose.style.cssText = 'padding:4px 10px;border:none;border-radius:5px;background:rgba(255,255,255,0.2);color:#fff;font-size:13px;cursor:pointer;';
    btnClose.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(btnClose);

    document.body.appendChild(bar);
  }

  function loadLocal() {
    try {
      const key = 'design-canvas:' + (dsl.feature || 'unknown');
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // 应用 localStorage 中的坐标（如果存在）；返回是否发生了合并（供 rebase 后触发重存）
  function applyLocalOverrides() {
    const local = loadLocal();
    if (!local || !local.geometry || !local.geometry.nodes) return false;
    let merged = false;
    const localById = {};
    local.geometry.nodes.forEach(n => { localById[n.id] = n; });

    // 覆盖内存中的节点坐标（仅当与服务器值不同才视为改动，避免每次加载都触发无谓重存）
    (dsl.geometry.nodes || []).forEach(n => {
      const localNode = localById[n.id];
      if (localNode && localNode.x !== undefined && localNode.y !== undefined) {
        if (n.x !== localNode.x || n.y !== localNode.y) {
          n.x = localNode.x;
          n.y = localNode.y;
          merged = true;
        }
      }
    });

    // 合并本地新增的边
    if (local.geometry.edges) {
      const existingIds = new Set((dsl.geometry.edges || []).map(e => e.id));
      local.geometry.edges.forEach(e => {
        if (!existingIds.has(e.id)) {
          if (!dsl.geometry.edges) dsl.geometry.edges = [];
          dsl.geometry.edges.push(e);
          merged = true;
        }
      });
    }

    // 合并 annotations
    if (local.annotations) {
      const existingAnnoIds = new Set((dsl.annotations || []).map(a => a.id));
      local.annotations.forEach(a => {
        if (!existingAnnoIds.has(a.id)) {
          if (!dsl.annotations) dsl.annotations = [];
          dsl.annotations.push(a);
          merged = true;
        }
      });
    }
    return merged;
  }

  // 冲突后「拉取最新」刷新：applyLocalOverrides 把暂存的本地改动合并回服务器最新 DSL。
  // 合并成立后立即以服务器权威 rev 触发重存 —— 完成 rebase 闭环，后续编辑不再因旧 base 冲突。
  if (applyLocalOverrides()) {
    saveToServer();
  }
  // 若本无本地覆盖，上面的 applyLocalOverrides() 已返回 false；但页面首次加载也需应用覆盖，
  // 因此无论如何再调用一次以同步 DOM（无合并时 no-op，成本极低）
  applyLocalOverridesToDom();

  // 将 localStorage 覆盖的坐标应用到 DOM（applyLocalOverrides 只改了内存 dsl，
  // 但 DOM 节点是 HTML 内嵌 __DSL__ 渲染的，需要同步更新 rect/text/edge 位置）
  function applyLocalOverridesToDom() {
    (dsl.geometry?.nodes || []).forEach(function(n) {
      var nodeEl = document.querySelector('.node[data-id="' + n.id + '"]');
      if (!nodeEl) return;
      var rect = nodeEl.querySelector('rect, circle, polygon');
      if (!rect) return;
      var oldX = parseFloat(rect.getAttribute('x') || '0');
      var oldY = parseFloat(rect.getAttribute('y') || '0');
      var dx = (n.x || 0) - oldX;
      var dy = (n.y || 0) - oldY;
      if (dx === 0 && dy === 0) return;
      // 更新 shape 位置
      if (rect.tagName === 'rect') {
        rect.setAttribute('x', n.x || 0);
        rect.setAttribute('y', n.y || 0);
      } else if (rect.tagName === 'circle') {
        var r = parseFloat(rect.getAttribute('r') || '0');
        rect.setAttribute('cx', (n.x || 0) + (n.width || 120) / 2);
        rect.setAttribute('cy', (n.y || 0) + (n.height || 60) / 2);
      } else if (rect.tagName === 'polygon') {
        // 多边形需要重新计算所有点
        var pts = rect.getAttribute('points') || '';
        var newPts = pts.split(' ').map(function(pt) {
          var xy = pt.split(',').map(parseFloat);
          return (xy[0] + dx) + ',' + (xy[1] + dy);
        }).join(' ');
        rect.setAttribute('points', newPts);
      }
      // 更新文字位置
      var text = nodeEl.querySelector('text');
      if (text) {
        var tx = parseFloat(text.getAttribute('x') || '0');
        var ty = parseFloat(text.getAttribute('y') || '0');
        text.setAttribute('x', tx + dx);
        text.setAttribute('y', ty + dy);
      }
      // 更新状态圆点
      var circles = nodeEl.querySelectorAll('circle');
      circles.forEach(function(c) {
        if (c === rect) return;
        var cx = parseFloat(c.getAttribute('cx') || '0');
        var cy = parseFloat(c.getAttribute('cy') || '0');
        c.setAttribute('cx', cx + dx);
        c.setAttribute('cy', cy + dy);
      });
    });
    // 更新所有边的位置（基于最新节点坐标）
    (dsl.geometry?.edges || []).forEach(function(e) {
      var edgeEl = document.querySelector('.edge[data-id="' + e.id + '"]');
      if (!edgeEl) return;
      var fromNode = nodeById[e.from];
      var toNode = nodeById[e.to];
      if (!fromNode || !toNode) return;
      var fromEl = document.querySelector('.node[data-id="' + e.from + '"] rect, .node[data-id="' + e.from + '"] circle, .node[data-id="' + e.from + '"] polygon');
      var toEl = document.querySelector('.node[data-id="' + e.to + '"] rect, .node[data-id="' + e.to + '"] circle, .node[data-id="' + e.to + '"] polygon');
      if (!fromEl || !toEl) return;
      var fx = parseFloat(fromEl.getAttribute('x') || fromEl.getAttribute('cx') || '0');
      var fy = parseFloat(fromEl.getAttribute('y') || fromEl.getAttribute('cy') || '0');
      var fw = parseFloat(fromEl.getAttribute('width') || '120');
      var fh = parseFloat(fromEl.getAttribute('height') || '60');
      var tx = parseFloat(toEl.getAttribute('x') || toEl.getAttribute('cx') || '0');
      var ty = parseFloat(toEl.getAttribute('y') || toEl.getAttribute('cy') || '0');
      var tw = parseFloat(toEl.getAttribute('width') || '120');
      var th = parseFloat(toEl.getAttribute('height') || '60');
      var fcx = fx + fw / 2, fcy = fy + fh / 2;
      var tcx = tx + tw / 2, tcy = ty + th / 2;
      var path = edgeEl.querySelector('path');
      if (path) {
        path.setAttribute('d', 'M ' + fcx + ' ' + fcy + ' L ' + tcx + ' ' + tcy);
      }
      var label = edgeEl.querySelector('text');
      if (label) {
        label.setAttribute('x', (fcx + tcx) / 2);
        label.setAttribute('y', (fcy + tcy) / 2);
      }
    });
  }
  applyLocalOverridesToDom();

  // 加载边控制点偏移（从 localStorage）
  try {
    var _edgeOffsetKey = 'design-canvas-edge-offsets:' + (dsl.feature || 'unknown');
    var _savedOffsets = localStorage.getItem(_edgeOffsetKey);
    if (_savedOffsets) {
      state.edgeCtrlOffset = JSON.parse(_savedOffsets) || {};
    }
  } catch (e) { /* ignore */ }

  // ==== Toast 提示 ====
  function showToast(text, type) {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 16px;background:rgba(76,175,80,0.95);color:#fff;border-radius:6px;font-size:13px;z-index:2000;opacity:0;transition:opacity 0.2s;box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      document.body.appendChild(toast);
    }
    const colors = {
      success: 'rgba(76,175,80,0.95)',
      info: 'rgba(33,150,243,0.95)',
      warning: 'rgba(255,152,0,0.95)',
      error: 'rgba(244,67,54,0.95)',
    };
    toast.style.background = colors[type] || colors.success;
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
  }

  // 隐藏所有 contains 边（内部包含关系不显示连线，只保留流向边）
  function hideContainsEdges() {
    (dsl.geometry?.edges || []).forEach(e => {
      const label = (e.label || '').toLowerCase();
      if (label === 'contains' || label === '包含') {
        const edgeEl = document.querySelector('.edge[data-id="' + e.id + '"]');
        if (edgeEl) edgeEl.style.display = 'none';
      }
    });
  }

  // 折叠初始化：
  // 1. 有持久化状态 → 恢复用户上次的折叠
  // 2. 无持久化且巨型图（节点 > 100，如 import_project 产物）→ 默认折叠全部目录容器，
  //    初始只留顶层架构逐级披露，避免开局一团乱麻（v3）
  // 3. 其余 → 默认全部展开（v2 决策保留）
  function initCollapsedState() {
    // 功能树归类模式：只显示「项目根 + 各功能」，社区/文件/目录容器全部默认隐藏（折叠逐级下钻）
    if (dsl.feature_tree) {
      var isTop = function (id) { return id === '__project__' || id.indexOf('ft:') === 0; };
      (dsl.geometry?.nodes || []).forEach(function (n) {
        if (isTop(n.id)) return;
        var el = document.querySelector('.node[data-id="' + n.id + '"]');
        if (el) el.style.display = 'none';
      });
      // 标记折叠态：功能/社区容器呈角标，展开时才逐级披露后代
      (dsl.geometry?.nodes || []).forEach(function (n) {
        if (n.id.indexOf('ft:') !== 0 && n.id.indexOf('ct:') !== 0) return;
        if (!childrenOf[n.id]) return;
        state.collapsed.add(n.id);
        var nodeEl = document.querySelector('.node[data-id="' + n.id + '"]');
        if (nodeEl) nodeEl.classList.add('collapsed');
      });
      applyLayerVisibility();
      return;
    }
    var restored = null;
    try {
      var collapsedKey = 'design-canvas-collapsed:' + (dsl.feature || 'unknown');
      var versionKey = 'design-canvas-collapsed-ver:' + (dsl.feature || 'unknown');
      // v3 = 巨图默认折叠目录容器；清除旧版本持久化状态
      if (localStorage.getItem(versionKey) !== '3') {
        localStorage.removeItem(collapsedKey);
        localStorage.setItem(versionKey, '3');
      } else {
        var raw = localStorage.getItem(collapsedKey);
        if (raw) restored = JSON.parse(raw);
      }
    } catch (e) { /* ignore */ }

    var parentsToCollapse = [];
    if (restored && Array.isArray(restored)) {
      parentsToCollapse = restored;
    } else {
      // 巨图默认折叠目录容器：只数 main 层节点（深层默认隐藏，不该触发折叠），
      // 否则 116 个隐藏深层节点会把 56 节点的报告误判为巨图，首屏只剩几个折叠空壳
      var mainCount = (dsl.geometry?.nodes || []).filter(function(n) {
        return (n.layer || 'main') === 'main';
      }).length;
      if (mainCount > 100) parentsToCollapse = Object.keys(childrenOf);
    }

    parentsToCollapse.forEach(function(pid) {
      if (!childrenOf[pid]) return;
      state.collapsed.add(pid);
      var nodeEl = document.querySelector('.node[data-id="' + pid + '"]');
      if (nodeEl) nodeEl.classList.add('collapsed');
      getAllDescendants(pid).forEach(function(did) {
        var descEl = document.querySelector('.node[data-id="' + did + '"]');
        if (descEl) descEl.style.display = 'none';
      });
    });
    // 边可见性交由全局规则统一计算（隐藏端点的边一并隐藏）
    if (parentsToCollapse.length > 0) applyLayerVisibility();
  }

  // ==== Tooltip ====
  // 语言概念缓存（序号10）：<file_path → {concepts:[id], detail:{id→explanation}}>
  var lcByFile = null; // { filePath: { concepts: [id], explanations: {id: text} } }
  var lcConceptName = {}; // id → 展示名

  function loadLanguageConcepts() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (lcByFile) return;
    fetch('/api/language-concepts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 500 }),
    })
      .then(r => r.json())
      .then(data => {
        if (!data || !data.success) return;
        var map = {};
        (data.hits || []).forEach(h => {
          if (!map[h.file_path]) {
            map[h.file_path] = { concepts: [], explanations: {} };
          }
          var e = map[h.file_path];
          (h.concepts || []).forEach(id => {
            if (e.concepts.indexOf(id) === -1) e.concepts.push(id);
          });
        });
        // 概念展示名 + 解释（从后端概念统计取 name；explanation 由前端常量补，避免重复请求）
        var names = {};
        (data.concept_counts || []).forEach(c => { names[c.id] = c.name; });
        lcConceptName = names;
        lcByFile = map;
      })
      .catch(() => { /* 网络失败静默 */ });
  }

  // 概念 id → 解释文案（与后端 language_concepts.ts CONCEPTS 同步，前端展示用）
  var LC_EXPLAIN = {
    generic: '用类型参数（如 <T>）让函数/类/接口适配多种类型，调用时再指定具体类型，提升复用性与类型安全。',
    generator: '用 function* 或 yield 惰性产出序列值，每次 next() 时才计算，适合流式/大数据的按需生成。',
    closure: '函数捕获并记住其定义时的外部作用域变量，即使外层已返回仍可访问，常用于回调和状态封装。',
    decorator: '以 @ 语法附加到类/方法上，在运行时包装或增强原有行为，实现横切关注点（日志、鉴权、缓存）。',
    async: '通过 async/await、Promise 或回调处理非阻塞操作，避免阻塞主线程，协调并发与 I/O。',
    'dependency-injection': '把依赖从外部传入而非内部 new 出来，降低耦合、便于测试与替换实现。',
    factory: '将对象创建逻辑集中到一个方法/类，按参数返回不同类型实例，隐藏构造细节。',
    singleton: '保证一个类全局只有唯一实例，并提供一个全局访问点（如 getInstance / instance）。',
    observer: '通过订阅/发布机制让对象在事件发生时通知监听者，实现解耦的事件驱动通信。',
    strategy: '把可互换的算法封装为独立策略对象，运行时动态选择，避免大量条件分支。',
    'template-method': '在基类中固定算法骨架，把可变步骤留给子类覆写，复用餐具流程、定制细节。',
    'error-handling': '通过 try/catch、抛出异常或返回错误值，对流式失败做捕获、传播与恢复。',
    'state-machine': '用显式的状态集合与转移规则建模对象行为，避免用散乱的布尔/分支管理复杂状态。'
  };

  // ==== 伪维基词典（序号12）====
  // 词典聚合视图缓存：{ entries, links, aliasesIndex }
  var dictView = null;
  var dictLoaded = false;

  function loadDict() {
    if (dictLoaded) return;
    dictLoaded = true;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    fetch('/api/dict/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}), // 默认 cwd 项目
    })
      .then(r => r.json())
      .then(data => {
        if (!data || !data.success) return;
        // 只保留前端渲染需要的字段
        dictView = {
          entries: data.entries || [],
          links: data.links || {},
        };
      })
      .catch(() => { /* 静默 */ });
  }

  // 把一段文本按命中词典的词拆成高亮 HTML（命中词包成可点击词条）
  function dictHighlightHtml(text) {
    if (!text || !dictView || !dictView.entries || dictView.entries.length === 0) return escapeHtml(text);
    var lower = text.toLowerCase();
    // 收集命中区间
    var spans = [];
    for (var i = 0; i < dictView.entries.length; i++) {
      var e = dictView.entries[i];
      var cands = [e.term].concat(e.aliases || []).filter(function (t) { return t && t.length > 0; });
      for (var j = 0; j < cands.length; j++) {
        var c = cands[j].toLowerCase();
        var from = 0;
        var idx = lower.indexOf(c, from);
        while (idx !== -1) {
          spans.push({ start: idx, end: idx + c.length, term: e.term });
          from = idx + c.length;
          idx = lower.indexOf(c, from);
        }
      }
    }
    if (spans.length === 0) return escapeHtml(text);
    // 排序 + 合并重叠
    spans.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var merged = [];
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k];
      var last = merged[merged.length - 1];
      if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; }
      else merged.push(s);
    }
    // 拼接 HTML
    var out = '';
    var cursor = 0;
    for (var m = 0; m < merged.length; m++) {
      var sp = merged[m];
      if (sp.start > cursor) out += escapeHtml(text.slice(cursor, sp.start));
      out += '<span class="dict-term" data-dict="' + escapeAttr(sp.term) + '">' + escapeHtml(text.slice(sp.start, sp.end)) + '</span>';
      cursor = sp.end;
    }
    if (cursor < text.length) out += escapeHtml(text.slice(cursor));
    return out;
  }

  // ---- 伪维基词卡（点击高亮词弹出，三档切换 + 互链词展开）----
  var dictCardEl = null; // 当前词卡 DOM
  var dictCardState = { term: null, level: 'newbie' }; // 词卡当前词条 + 档位

  function dictEntryByTerm(term) {
    if (!dictView || !dictView.entries) return null;
    for (var i = 0; i < dictView.entries.length; i++) {
      if (dictView.entries[i].term === term) return dictView.entries[i];
    }
    return null;
  }
  function dictCardLinks(term) {
    return (dictView && dictView.links && dictView.links[term]) || [];
  }
  // 词卡正文：根据档位展示解释，并把正文里的已收录词也做成可跳转链接
  function dictCardBody(entry, level, srcTerm) {
    var text = entry[level] || '';
    var html = '<div class="dc-body">';
    if (!text) {
      html += '<div style="color:var(--theme-text-sub);">该档暂无解释。</div>';
    } else {
      // 复用高亮拆分，但链入词用 dict-link 样式（可继续跳转）
      var parts = splitHighlightsForHtml(text, level, srcTerm);
      html += parts;
    }
    var links = dictCardLinks(entry.term);
    if (links.length > 0) {
      html += '<div class="dc-links"><div class="dc-links-title">🔗 相关词条</div>';
      html += links.map(function (t) {
        var active = t === srcTerm ? ' dict-link--active' : '';
        return '<span class="dict-link' + active + '" data-dict="' + escapeAttr(t) + '">' + escapeHtml(t) + '</span>';
      }).join(' ');
      html += '</div>';
    }
    html += '</div>';
    return html;
  }
  // 把解释文本拆成 HTML，命中词典的词包成可点击 dict-link（跳转词卡）
  function splitHighlightsForHtml(text, level, srcTerm) {
    if (!dictView || !dictView.entries || dictView.entries.length === 0) return escapeHtml(text);
    var lower = text.toLowerCase();
    var spans = [];
    for (var i = 0; i < dictView.entries.length; i++) {
      var e = dictView.entries[i];
      var cands = [e.term].concat(e.aliases || []).filter(function (t) { return t && t.length > 0; });
      for (var j = 0; j < cands.length; j++) {
        var c = cands[j].toLowerCase();
        var from = 0;
        var idx = lower.indexOf(c, from);
        while (idx !== -1) {
          spans.push({ start: idx, end: idx + c.length, term: e.term });
          from = idx + c.length;
          idx = lower.indexOf(c, from);
        }
      }
    }
    if (spans.length === 0) return escapeHtml(text);
    spans.sort(function (a, b) { return a.start - b.start || b.end - a.end; });
    var merged = [];
    for (var k = 0; k < spans.length; k++) {
      var s = spans[k];
      var last = merged[merged.length - 1];
      if (last && s.start < last.end) { if (s.end > last.end) last.end = s.end; }
      else merged.push(s);
    }
    var out = '';
    var cursor = 0;
    for (var m = 0; m < merged.length; m++) {
      var sp = merged[m];
      if (sp.start > cursor) out += escapeHtml(text.slice(cursor, sp.start));
      var active = sp.term === srcTerm ? ' dict-link--active' : '';
      out += '<span class="dict-link' + active + '" data-dict="' + escapeAttr(sp.term) + '">' + escapeHtml(text.slice(sp.start, sp.end)) + '</span>';
      cursor = sp.end;
    }
    if (cursor < text.length) out += escapeHtml(text.slice(cursor));
    return out;
  }
  function renderDictCard(term) {
    var entry = dictEntryByTerm(term);
    if (!entry) return;
    dictCardState.term = term;
    var level = dictCardState.level;
    var kindLabel = entry.kind === 'project' ? '项目词' : '通用词';
    var html = '<div class="dc-head">' +
      '<span class="dc-term">' + escapeHtml(entry.term) + '</span>' +
      '<span style="display:flex;align-items:center;gap:6px;">' +
      '<span class="dc-badge">' + kindLabel + '</span>' +
      '<span class="dc-close" data-dictclose="1">✕</span>' +
      '</span></div>';
    html += '<div class="dc-tabs">' +
      '<button class="dc-tab' + (level === 'newbie' ? ' active' : '') + '" data-dictlevel="newbie">新人</button>' +
      '<button class="dc-tab' + (level === 'pm' ? ' active' : '') + '" data-dictlevel="pm">产品</button>' +
      '<button class="dc-tab' + (level === 'senior' ? ' active' : '') + '" data-dictlevel="senior">资深</button>' +
      '</div>';
    html += dictCardBody(entry, level, null);
    dictCardEl.innerHTML = html;
  }
  function showDictCard(term, clientX, clientY) {
    if (!dictView || !dictView.entries) return;
    if (!dictEntryByTerm(term)) return;
    if (!dictCardEl) {
      dictCardEl = document.createElement('div');
      dictCardEl.className = 'dict-card';
      document.body.appendChild(dictCardEl);
      // 词卡内点击：档位切换 / 跳转 / 关闭
      dictCardEl.addEventListener('click', function (ev) {
        var t = ev.target;
        var lvl = t.getAttribute && t.getAttribute('data-dictlevel');
        if (lvl) {
          dictCardState.level = lvl;
          renderDictCard(dictCardState.term);
          ev.stopPropagation();
          return;
        }
        var jump = t.getAttribute && t.getAttribute('data-dict');
        if (jump) {
          renderDictCard(jump); // 跳转到链入词条
          ev.stopPropagation();
          return;
        }
        if (t.getAttribute && t.getAttribute('data-dictclose')) {
          closeDictCard();
          ev.stopPropagation();
          return;
        }
      });
    }
    dictCardState.level = 'newbie';
    dictCardState.term = term;
    renderDictCard(term);
    dictCardEl.style.display = 'block';
    // 定位：优先放在点击点右侧，越界则左侧
    var w = dictCardEl.offsetWidth || 340;
    var h = dictCardEl.offsetHeight || 200;
    var x = clientX + 14;
    var y = clientY + 14;
    if (x + w > window.innerWidth) x = clientX - w - 14;
    if (y + h > window.innerHeight) y = clientY - h - 14;
    dictCardEl.style.left = x + 'px';
    dictCardEl.style.top = y + 'px';
  }
  function closeDictCard() {
    if (dictCardEl) dictCardEl.style.display = 'none';
  }

  // 点击 tooltip 内高亮词（dict-term）→ 弹出词卡；外部点击关闭词卡
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.getAttribute && t.getAttribute('data-dict')) {
      // 词卡内部点击由 dictCardEl 自己的监听处理，这里只处理 tooltip 内的高亮词
      if (t.className && t.className.indexOf && t.className.indexOf('dict-term') !== -1) {
        var term = t.getAttribute('data-dict');
        showDictCard(term, ev.clientX, ev.clientY);
        ev.stopPropagation();
        return;
      }
    }
    // 点击词卡外部 → 关闭词卡
    if (dictCardEl && dictCardEl.style.display !== 'none' && !(dictCardEl.contains(t))) {
      closeDictCard();
    }
  });

  // ---- 伪维基 收录面板（P3 动态学习：LLM 分类+生成 → 审批 → 注入 → 下次命中高亮）----
  var dictPanelEl = null;
  var dictPreview = null; // { term, kind, entry }
  var dictPanelSelLevel = 'newbie';

  function dictProjectHint() {
    // 从 DSL 取项目名做上下文提示，帮助 LLM 判断是否项目专有词
    return dsl.meta?.title || dsl.feature || '';
  }
  function dictOpenPanel() {
    if (!dictPanelEl) {
      dictPanelEl = document.createElement('div');
      dictPanelEl.className = 'dict-panel';
      dictPanelEl.innerHTML =
        '<div class="dp-head"><span class="dp-title">📖 伪维基词典</span>' +
        '<span class="dp-close" data-dpclose="1" title="关闭">✕</span></div>' +
        '<div class="dp-desc">收录通用概念或项目专有词，LLM 生成三档解释，并与已收录词自动互链。</div>' +
        '<div class="dp-form">' +
        '<input type="text" id="dp-term" class="dp-input" placeholder="输入要收录的词（如：依赖注入 / cache）">' +
        '<button id="dp-preview" type="button" class="dp-btn-primary" title="调用 LLM 分类并生成三档解释（不落库）">⚡ 生成预览</button>' +
        '</div>' +
        '<div id="dp-result" class="dp-result hidden"></div>' +
        '<div class="dp-confirm hidden" id="dp-confirm">' +
        '<button id="dp-save" type="button" class="dp-btn-save" title="确认收录到词典，下次解释文本命中即高亮">✅ 确认收录</button>' +
        '<button id="dp-cancel" type="button" class="dp-btn-ghost" title="仅预览，不收录">取消</button>' +
        '</div>' +
        '<div class="dp-list-title">已收录词条</div>' +
        '<div id="dp-list" class="dp-list"></div>';
      document.body.appendChild(dictPanelEl);
      dictPanelEl.addEventListener('click', function (ev) {
        var t = ev.target;
        if (t.getAttribute && t.getAttribute('data-dpclose')) { dictPanelEl.style.display = 'none'; return; }
        if (t.getAttribute && t.getAttribute('data-dplevel')) {
          dictPanelSelLevel = t.getAttribute('data-dplevel');
          renderDictPreview();
          return;
        }
        if (t.id === 'dp-preview') { dictRunPreview(); return; }
        if (t.id === 'dp-save') { dictRunSave(); return; }
        if (t.id === 'dp-cancel') { dictResetPreview(); return; }
      });
    }
    // 预填：若当前有选中文本（长按/拖选），自动带入
    var ss = (window.getSelection && window.getSelection().toString()) || '';
    var inp = document.getElementById('dp-term');
    if (ss && ss.trim().length > 0 && inp.value === '') inp.value = ss.trim().slice(0, 40);
    dictPanelEl.style.display = 'block';
    dictRenderList();
    setTimeout(function () { if (inp) inp.focus(); }, 50);
  }
  function dictClosePanel() { if (dictPanelEl) dictPanelEl.style.display = 'none'; }
  function dictRenderList() {
    var box = document.getElementById('dp-list');
    if (!box) return;
    var list = (dictView && dictView.entries) || [];
    if (list.length === 0) { box.innerHTML = '<div class="dp-empty">暂无词条，收录第一个吧。</div>'; return; }
    box.innerHTML = list.map(function (e) {
      var badge = e.kind === 'project' ? '项目' : '通用';
      return '<span class="dp-chip" data-dictterm="' + escapeAttr(e.term) + '">' +
        '<span class="dp-chip-badge">' + badge + '</span>' + escapeHtml(e.term) + '</span>';
    }).join('');
  }
  function dictResetPreview() {
    dictPreview = null;
    var r = document.getElementById('dp-result');
    var c = document.getElementById('dp-confirm');
    if (r) { r.classList.add('hidden'); r.innerHTML = ''; }
    if (c) c.classList.add('hidden');
  }
  function renderDictPreview() {
    var r = document.getElementById('dp-result');
    if (!r || !dictPreview) return;
    var entry = dictPreview.entry;
    var level = dictPanelSelLevel;
    var kindLabel = entry.kind === 'project' ? '项目词' : '通用词';
    var html = '<div class="dp-result-head">' +
      '<span class="dp-term">' + escapeHtml(entry.term) + '</span>' +
      '<span class="dp-badge">' + kindLabel + '</span>' +
      '<span class="dp-alias">别名：' + escapeHtml((entry.aliases || []).join('、') || '无') + '</span></div>' +
      '<div class="dp-tabs">' +
      '<button class="dp-tab' + (level === 'newbie' ? ' active' : '') + '" data-dplevel="newbie">新人</button>' +
      '<button class="dp-tab' + (level === 'pm' ? ' active' : '') + '" data-dplevel="pm">产品</button>' +
      '<button class="dp-tab' + (level === 'senior' ? ' active' : '') + '" data-dplevel="senior">资深</button>' +
      '</div>' +
      '<div class="dp-text">' + escapeHtml(entry[level] || '') + '</div>';
    r.innerHTML = html;
    r.classList.remove('hidden');
    var c = document.getElementById('dp-confirm');
    if (c) c.classList.remove('hidden');
  }
  function dictRunPreview() {
    var inp = document.getElementById('dp-term');
    var term = (inp && inp.value.trim()) || '';
    if (!term) { alert('请输入要收录的词'); return; }
    var r = document.getElementById('dp-result');
    if (r) { r.classList.remove('hidden'); r.innerHTML = '<div class="dp-loading">⏳ 正在调用 LLM 分类并生成三档解释…</div>'; }
    var c = document.getElementById('dp-confirm');
    if (c) c.classList.add('hidden');
    fetch('/api/dict/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: term, dry_run: true, project_hint: dictProjectHint(), feature: dsl.feature }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          if (r) r.innerHTML = '<div class="dp-error">生成失败：' + escapeHtml((data && data.message) || '未知错误') + '</div>';
          return;
        }
        dictPreview = { term: data.term, kind: data.kind, entry: data.entry };
        dictPanelSelLevel = 'newbie';
        renderDictPreview();
      })
      .catch(function () {
        if (r) r.innerHTML = '<div class="dp-error">网络错误，请确认 serve 已启动。</div>';
      });
  }
  function dictRunSave() {
    if (!dictPreview) return;
    var term = dictPreview.term;
    var saveBtn = document.getElementById('dp-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '⏳ 收录中…'; }
    fetch('/api/dict/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term: term, dry_run: false, project_hint: dictProjectHint(), feature: dsl.feature }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ 确认收录'; }
        if (!data || !data.success) {
          alert('收录失败：' + ((data && data.message) || '未知错误'));
          return;
        }
        // 收录成功：重新加载词典，词条下次即被高亮
        dictLoaded = false;
        dictView = null;
        loadDict();
        dictRenderList();
        dictResetPreview();
        dictClosePanel();
        showDictToast('✅ 已收录「' + term + '」，下次解释文本命中即高亮');
      })
      .catch(function () {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ 确认收录'; }
        alert('网络错误，请确认 serve 已启动。');
      });
  }
  function showDictToast(msg) {
    var t = document.createElement('div');
    t.className = 'dict-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 20);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300);
    }, 2600);
  }

  // 工具栏「📖 伪维基」按钮
  function setupDictPanel() {
    var btn = document.getElementById('dict-open');
    if (btn) btn.addEventListener('click', dictOpenPanel);
    // 面板打开状态下，点击列表里的词条 chip → 回填输入框
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t && t.getAttribute && t.getAttribute('data-dictterm')) {
        var inp = document.getElementById('dp-term');
        if (inp) inp.value = t.getAttribute('data-dictterm');
        dictResetPreview();
      }
    });
  }

  // 节点 id → file_path（复用 semantic 映射，与 diff_impact/semantic 对齐）
  function lcNodeToFile(nodeId) {
    const semanticFiles = (dsl.semantic && dsl.semantic.files) || [];
    for (const f of semanticFiles) {
      if (f.id === nodeId) return f.path;
    }
    // 回退：file_<rel> 字符串逆推
    if (nodeId && nodeId.indexOf('file_') === 0) {
      return nodeId.slice(5).replace(/_/g, '/') + '.ts';
    }
    return null;
  }

  // 生成 tooltip 里的语言概念徽章 + 解释片段（无命中返回 ''）
  function lcTooltipHtml(nodeId) {
    if (!lcByFile) return '';
    var filePath = lcNodeToFile(nodeId);
    if (!filePath) return '';
    var entry = lcByFile[filePath];
    if (!entry || !entry.concepts || entry.concepts.length === 0) return '';
    var chips = entry.concepts.map(id => {
      var name = lcConceptName[id] || id;
      return '<span class="lc-chip" data-id="' + id + '">' + escapeHtml(name) + '</span>';
    }).join('');
    var details = entry.concepts.map(id => {
      var name = lcConceptName[id] || id;
      var exp = LC_EXPLAIN[id] || '';
      return '<div class="lc-detail" data-id="' + id + '"><b>' + escapeHtml(name) + '</b>' +
        (exp ? '<div>' + dictHighlightHtml(exp) + '</div>' : '') + '</div>';
    }).join('');
    return '<div class="lc-block">' +
      '<div class="lc-title">💡 语言概念</div>' +
      '<div class="lc-chips">' + chips + '</div>' +
      '<div class="lc-details">' + details + '</div>' +
      '</div>';
  }

  function showTooltip(e, targetId) {
    const annos = annoByTarget[targetId] || [];
    const label = e.currentTarget.getAttribute('data-label') || '';
    const title = e.currentTarget.getAttribute('data-title') || '';
    let html = '';
    const headLine = title
      ? '<div style="font-weight:600;margin-bottom:2px;">' + escapeHtml(title) + '</div><div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">' + escapeHtml(label || targetId) + '</div>'
      : '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(label || targetId) + '</div>';
    html += headLine;

    // 语言概念徽章（序号10）
    html += lcTooltipHtml(targetId);

    // 仿真信息
    if (dsl.simulation) {
      const simInfo = getSimInfoForNode(targetId);
      if (simInfo) {
        html += '<div style="border-top:1px solid var(--theme-border);padding-top:6px;margin-top:4px;">';
        html += '<div style="font-size:11px;color:#9b59b6;margin-bottom:4px;">🔬 仿真关联</div>';
        if (simInfo.states.length > 0) {
          html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:2px;">状态:</div>';
          for (var i = 0; i < simInfo.states.length; i++) {
            var s = simInfo.states[i];
            html += '<div style="font-size:11px;margin-left:8px;">' + escapeHtml(s.key) + ' = <span style="color:var(--theme-primary);">' + escapeHtml(s.value) + '</span></div>';
          }
        }
        if (simInfo.rules.length > 0) {
          html += '<div style="font-size:11px;color:var(--theme-text-sub);margin:4px 0 2px 0;">规则:</div>';
          for (var j = 0; j < simInfo.rules.length; j++) {
            var r = simInfo.rules[j];
            html += '<div style="font-size:11px;margin-left:8px;">• ' + escapeHtml(r.name || r.event) + '</div>';
          }
        }
        html += '</div>';
      }
    }

    if (annos.length > 0) {
      html += annos.map(a => '<div class="anno"><span class="author">[' + (a.author || '?') + ']</span>' + escapeHtml(a.text) + '</div>').join('');
    }

    // 仅当无语言概念、无批注、无仿真信息时才回退到空占位
    if (!annos.length && !getSimInfoForNode(targetId) && html.indexOf('lc-block') === -1) {
      html = '<div class="empty">' + escapeHtml(label || targetId) + '</div>';
    }

    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    requestAnimationFrame(() => tooltip.classList.add('visible'));
    moveTooltip(e);
  }

  function getSimInfoForNode(nodeId) {
    if (!dsl.simulation) return null;
    const simDef = dsl.simulation;
    const states = [];
    const rules = [];

    // 查找映射的状态
    if (simDef.mappings) {
      for (var i = 0; i < simDef.mappings.length; i++) {
        if (simDef.mappings[i].nodeId === nodeId) {
          var stateKey = simDef.mappings[i].stateKey;
          var stateVal = null;
          // 从仿真引擎状态获取（如果有）
          var currentSimState = window.simState;
          if (currentSimState && currentSimState[stateKey] !== undefined) {
            stateVal = formatSimValue(currentSimState[stateKey]);
          } else {
            // 从初始状态获取
            for (var j = 0; j < simDef.initial_state.length; j++) {
              if (simDef.initial_state[j].key === stateKey) {
                stateVal = formatSimValue(simDef.initial_state[j].value);
                break;
              }
            }
          }
          states.push({ key: stateKey, value: stateVal });
        }
      }
    }

    // 查找关联的规则
    for (var k = 0; k < simDef.rules.length; k++) {
      var rule = simDef.rules[k];
      if (rule.from_node === nodeId || (rule.to_nodes && rule.to_nodes.indexOf(nodeId) !== -1)) {
        rules.push(rule);
      }
    }

    if (states.length === 0 && rules.length === 0) return null;
    return { states: states, rules: rules };
  }

  function formatSimValue(val) {
    if (Array.isArray(val)) return '[' + val.length + ' 项]';
    if (typeof val === 'object' && val !== null) return '{...}';
    return String(val);
  }
  function moveTooltip(e) {
    const pad = 14;
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    const rect = tooltip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = e.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = e.clientY - rect.height - pad;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  }
  function hideTooltip() {
    tooltip.classList.remove('visible');
    setTimeout(() => {
      if (!tooltip.classList.contains('visible')) tooltip.style.display = 'none';
    }, 150);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ==== 选中逻辑 ====
  function clearSelection() {
    if (!state.selectedId) return;
    state.selectedId = null;
    document.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
    document.querySelectorAll('.node.dimmed').forEach(n => n.classList.remove('dimmed'));
    document.querySelectorAll('.edge.highlighted').forEach(e => e.classList.remove('highlighted'));
    document.querySelectorAll('.edge.dimmed').forEach(e => e.classList.remove('dimmed'));
    document.querySelectorAll('.card.active').forEach(c => c.classList.remove('active'));
    updateFocusButton();
  }

  function selectNode(nodeId) {
    clearSelection();
    state.selectedId = nodeId;

    // 选中节点
    const nodeEl = nodeElById[nodeId];
    if (nodeEl) nodeEl.classList.add('selected');

    // 高亮相关边：入边 + 出边
    const relatedEdges = new Set();
    (edgesByFrom[nodeId] || []).forEach(e => relatedEdges.add(e.id));
    (edgesByTo[nodeId] || []).forEach(e => relatedEdges.add(e.id));

    const allEdgeIds = Object.keys(edgeById);
    allEdgeIds.forEach(eid => {
      const edgeEl = edgeElById[eid];
      if (!edgeEl) return;
      if (relatedEdges.has(eid)) {
        edgeEl.classList.add('highlighted');
      } else {
        edgeEl.classList.add('dimmed');
      }
    });

    // 非相关节点变暗
    const relatedNodes = new Set([nodeId]);
    relatedEdges.forEach(eid => {
      const e = edgeById[eid];
      relatedNodes.add(e.from);
      relatedNodes.add(e.to);
    });
    Object.keys(nodeById).forEach(nid => {
      const nEl = nodeElById[nid];
      if (!nEl) return;
      if (!relatedNodes.has(nid)) {
        nEl.classList.add('dimmed');
      }
    });

    // 侧边栏卡片联动
    const cardEl = document.querySelector('.card[data-id="' + nodeId + '"]');
    if (cardEl) {
      cardEl.classList.add('active');
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    updateFocusButton();
    updateDataflowButton();
  }

  function selectEdge(edgeId) {
    clearSelection();
    state.selectedId = edgeId;

    const edgeEl = document.querySelector('.edge[data-id="' + edgeId + '"]');
    if (edgeEl) edgeEl.classList.add('selected');
  }

  function openEdgeEditor(edgeId) {
    const edge = edgeById[edgeId];
    if (!edge) return;

    const editor = document.getElementById('prop-editor');
    if (!editor) return;

    // 构建边编辑表单
    const editorBody = editor.querySelector('.editor-body');
    if (!editorBody) return;

    editorBody.innerHTML = '<div class="form-group"><label>ID</label><input type="text" id="edge-id" readonly value="' + edge.id + '"></div>' +
      '<div class="form-group"><label>From → To</label><input type="text" readonly value="' + edge.from + ' → ' + edge.to + '"></div>' +
      '<div class="form-group"><label>标签 (label)</label><input type="text" id="edge-label" value="' + (edge.label || '') + '" placeholder="如: contains, flow, 调用..."></div>';

    editor.querySelector('.editor-header h3').textContent = '边属性';
    editor.classList.remove('hidden');
    document.getElementById('editor-mask').classList.remove('hidden');
    document.getElementById('edge-label').focus();

    // 保存按钮逻辑
    const saveBtn = document.getElementById('editor-save');
    const newSaveHandler = () => {
      pushUndo();

      edge.label = document.getElementById('edge-label').value;

      // 更新边显示
      const edgeEl = document.querySelector('.edge[data-id="' + edgeId + '"]');
      if (edgeEl) {
        let textEl = edgeEl.querySelector('.edge-label');
        if (edge.label) {
          if (!textEl) {
            const ns = 'http://www.w3.org/2000/svg';
            textEl = document.createElementNS(ns, 'text');
            textEl.setAttribute('class', 'edge-label');
            textEl.setAttribute('text-anchor', 'middle');
            edgeEl.appendChild(textEl);
          }
          const path = edgeEl.querySelector('path');
          if (path) {
            const d = path.getAttribute('d') || '';
            const nums = d.match(/[\\d.]+/g) || [];
            if (nums.length >= 4) {
              const fx = parseFloat(nums[0]);
              const fy = parseFloat(nums[1]);
              const tx = parseFloat(nums[2]);
              const ty = parseFloat(nums[3]);
              textEl.setAttribute('x', (fx + tx) / 2);
              textEl.setAttribute('y', (fy + ty) / 2);
            }
          }
          textEl.textContent = edge.label;
        } else if (textEl) {
          textEl.remove();
        }
      }

      saveLocal();
      saveToServer();
      closeEdgeEditor();
      showToast('边属性已更新', 'success');
    };

    // 替换保存按钮的事件处理器
    saveBtn.replaceWith(saveBtn.cloneNode(true));
    document.getElementById('editor-save').addEventListener('click', newSaveHandler);

    // 重置为节点编辑模式
    const resetEditor = () => {
      editorBody.innerHTML = '<div class="form-group"><label>ID</label><input type="text" id="editor-id" readonly></div>' +
        '<div class="form-group"><label>名称 (label)</label><input type="text" id="editor-label"></div>' +
        '<div class="form-group"><label>类型 (type)</label><select id="editor-type"><option value="service">service</option><option value="module">module</option><option value="database">database</option><option value="api">api</option><option value="queue">queue</option><option value="ui">ui</option><option value="other">other</option></select></div>' +
        '<div class="form-group"><label>状态 (status)</label><select id="editor-status"><option value="todo">todo</option><option value="doing">doing</option><option value="done">done</option><option value="blocked">blocked</option></select></div>' +
        '<div class="form-group"><label>描述 (description)</label><textarea id="editor-description" rows="3"></textarea></div>';
      editor.querySelector('.editor-header h3').textContent = '节点属性';
    };

    const cancelBtn = document.getElementById('editor-cancel');
    const closeBtn = document.getElementById('editor-close');
    const mask = document.getElementById('editor-mask');

    const resetAndClose = () => {
      resetEditor();
      editor.classList.add('hidden');
      mask.classList.add('hidden');
    };

    cancelBtn.onclick = resetAndClose;
    closeBtn.onclick = resetAndClose;
    mask.onclick = resetAndClose;
  }

  function closeEdgeEditor() {
    const editor = document.getElementById('prop-editor');
    const mask = document.getElementById('editor-mask');
    if (editor) editor.classList.add('hidden');
    if (mask) mask.classList.add('hidden');
  }

  // 判断边是否为 contains 边
  function isContainsEdge(edgeId) {
    const e = edgeById[edgeId];
    if (!e) return false;
    const label = (e.label || '').toLowerCase();
    return label === 'contains' || label === '包含';
  }

  // ==== 人端筛选：状态 / 孤岛 / 聚焦 ====
  // 孤岛：无几何数据边（非 contains）连接、且无 contains 子节点的节点
  const islandIds = new Set();
  (dsl.geometry?.nodes || []).forEach(n => {
    const hasDataEdge = (edgesByFrom[n.id] || []).some(e => !isContainsEdge(e.id)) ||
                        (edgesByTo[n.id] || []).some(e => !isContainsEdge(e.id));
    const hasChildren = (childrenOf[n.id] || []).length > 0;
    if (!hasDataEdge && !hasChildren) islandIds.add(n.id);
  });

  let focusScope = null;  // 当前聚焦范围（Set of ids），null=未聚焦

  // 聚焦范围 = 选中节点 ±1 跳（走数据边；contains 边只表达嵌套，不参与）
  function computeFocusScope(nodeId) {
    const set = new Set([nodeId]);
    (edgesByFrom[nodeId] || []).forEach(e => { if (!isContainsEdge(e.id)) set.add(e.to); });
    (edgesByTo[nodeId] || []).forEach(e => { if (!isContainsEdge(e.id)) set.add(e.from); });
    return set;
  }

  // 单节点筛选判定（与折叠/分层的 inline display 正交，最终可见 = 两者都可见）
  function filterVisible(n) {
    const f = state.filter;
    if (f.statuses.size && !f.statuses.has(n.status || 'draft')) return false;
    if (f.hideIslands && islandIds.has(n.id)) return false;
    if (f.focusId && !focusScope.has(n.id)) return false;
    return true;
  }

  // 全量应用筛选：节点/边用 .filter-hidden class（!important 压制 inline display）
  function applyFilters() {
    focusScope = state.filter.focusId ? computeFocusScope(state.filter.focusId) : null;
    let visibleCount = 0;
    (dsl.geometry?.nodes || []).forEach(n => {
      const el = document.querySelector('.node[data-id="' + n.id + '"]');
      if (!el) return;
      const vis = filterVisible(n);
      el.classList.toggle('filter-hidden', !vis);
      if (vis) visibleCount++;
    });
    document.querySelectorAll('.edge').forEach(edgeEl => {
      const eid = edgeEl.getAttribute('data-id');
      if (!eid || isContainsEdge(eid)) return;  // contains 边由嵌套系统管理
      const e = edgeById[eid];
      if (!e) return;
      const hidden = !!focusScope && (!focusScope.has(e.from) || !focusScope.has(e.to));
      edgeEl.classList.toggle('filter-hidden', hidden);
    });
    // 筛选生效但结果为空时提示，避免面对空白画布困惑
    const filterActive = state.filter.statuses.size > 0 || state.filter.hideIslands || !!state.filter.focusId;
    if (filterActive && visibleCount === 0) showToast('筛选结果为空：没有匹配的节点', 'info');
    updateFocusButton();
    if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.15, true);
  }

  // 聚焦按钮状态：无选中且未聚焦 → 禁用；聚焦中 → 显示目标名 + 可点退出
  function updateFocusButton() {
    const btn = document.getElementById('filter-focus');
    if (!btn) return;
    const fid = state.filter.focusId;
    btn.disabled = !fid && !state.selectedId;
    btn.classList.toggle('active', !!fid);
    if (fid) {
      const label = (nodeById[fid] && nodeById[fid].label) || fid;
      btn.title = '退出聚焦（Esc）';
      btn.textContent = '🎯 ' + label + ' ✕';
    } else {
      btn.title = '选中节点后点击：只看它 ±1 跳的上下游；再点退出';
      btn.textContent = '🎯 聚焦';
    }
  }

  // 绑定筛选条事件：状态 chips 多选 toggle；孤岛开关；聚焦开关
  function setupFilters() {
    document.querySelectorAll('.filter-chip[data-filter-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = btn.getAttribute('data-filter-status');
        const set = state.filter.statuses;
        if (set.has(s)) set.delete(s); else set.add(s);
        btn.classList.toggle('active', set.has(s));
        applyFilters();
      });
    });
    const islandBtn = document.getElementById('filter-islands');
    if (islandBtn) {
      const cnt = islandBtn.querySelector('.chip-count');
      if (cnt) cnt.textContent = islandIds.size;
      islandBtn.addEventListener('click', () => {
        state.filter.hideIslands = !state.filter.hideIslands;
        islandBtn.classList.toggle('active', state.filter.hideIslands);
        applyFilters();
      });
    }
    const focusBtn = document.getElementById('filter-focus');
    if (focusBtn) {
      focusBtn.addEventListener('click', () => {
        if (state.filter.focusId) {
          state.filter.focusId = null;
        } else {
          if (!state.selectedId) return;
          state.filter.focusId = state.selectedId;
        }
        applyFilters();
      });
    }
    updateFocusButton();
  }

  // ==== 数据源视图切换（实际/设计）====
  // 设计=人编辑的布局/状态（静态）；实际=代码实时快照（只读，serve 模式）。
  // 切换通过 localStorage 记录视图模式 + reload 重新渲染对应 DSL。
  function setDcView(view) {
    if (view === dcView) return;
    try { localStorage.setItem('dc-view', view); } catch (e) { /* 隐私模式下忽略 */ }
    location.reload();
  }

  function setupViewSwitcher() {
    const desBtn = document.getElementById('src-design');
    const actBtn = document.getElementById('src-actual');
    if (!desBtn || !actBtn) return;
    // 标记当前视图为 active
    const isActual = (dcView === 'actual');
    desBtn.classList.toggle('active', !isActual);
    actBtn.classList.toggle('active', isActual);
    desBtn.addEventListener('click', () => setDcView('design'));
    actBtn.addEventListener('click', () => setDcView('actual'));
  }

  // ==== 双视图 diff（最后一英里）：设计 vs 实际 图级高亮 ====
  // fetch /api/diff-views → 节点按 file_id 高亮（红=设计有实际无 / 绿=实际新增 / 黄=签名变），
  // 依赖边按 data-from/data-to 高亮（红=结构塌方 / 绿=新增依赖）
  function setupDiffHighlight() {
    if (window.location.protocol === 'file:') return;
    const feature = (window.__DSL__ && window.__DSL__.feature) || '';
    if (!feature) return;
    fetch('/api/diff-views', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature: feature }),
    })
      .then(function(r) { if (!r.ok) throw new Error('diff-views ' + r.status); return r.json(); })
      .then(function(data) {
        if (!data || !data.success || !data.data) return;
        var added = 0, removed = 0, modified = 0;
        var files = data.data.files;
        if (Array.isArray(files)) {
          files.forEach(function(f) {
            if (!f || !f.file_id) return;
            var el = document.querySelector('.node[data-id="' + f.file_id + '"]');
            if (!el) return;
            if (f.change === 'added') { el.classList.add('dc-diff-added'); added++; }
            else if (f.change === 'removed') { el.classList.add('dc-diff-removed'); removed++; }
            else if (f.change === 'modified') { el.classList.add('dc-diff-modified'); modified++; }
          });
        }
        // 边级高亮：结构塌方（红）/ 新增依赖（绿）
        var eAdded = 0, eRemoved = 0;
        var edges = data.data.edges;
        if (Array.isArray(edges) && edges.length > 0) {
          var diffNS = 'http://www.w3.org/2000/svg';
          var diffSvg = document.getElementById('canvas');
          var edgeElByKey = {};
          (dsl.geometry?.edges || []).forEach(function(e) {
            if (!e || !e.id || !e.from || !e.to) return;
            var el = document.querySelector('.edge[data-id="' + e.id + '"]');
            if (el) edgeElByKey[e.from + '\u0000' + e.to] = el;
          });
          var addedSeq = 0;
          edges.forEach(function(d) {
            if (!d || typeof d.from !== 'string' || typeof d.to !== 'string') return;
            var el = edgeElByKey[d.from + '\u0000' + d.to];
            if (d.change === 'added') {
              if (el) { el.classList.add('dc-diff-edge-added'); eAdded++; }
              else if (diffSvg) {
                // 新增依赖（live 有 / 设计无）：设计画布不存在这条边 → 补画绿色虚线
                var fEl = nodeElById[d.from];
                var tEl = nodeElById[d.to];
                var fPos = fEl && getNodePos(fEl);
                var tPos = tEl && getNodePos(tEl);
                if (fPos && tPos) {
                  var geom = computeEdgePath({
                    fromBox: fPos,
                    toBox: tPos,
                    selfLoop: d.from === d.to,
                    edgeType: 'curve',
                    offset: 0,
                    obstacles: collectObstacles(obstacleExcludeMap(d.from, d.to)),
                    manualCtrl: null,
                  });
                  var g = document.createElementNS(diffNS, 'g');
                  g.setAttribute('class', 'edge dc-diff-edge-added');
                  g.setAttribute('data-id', 'dc-diff-added-' + (addedSeq++));
                  var hit = document.createElementNS(diffNS, 'path');
                  hit.setAttribute('d', geom.d);
                  hit.setAttribute('stroke', 'transparent');
                  hit.setAttribute('stroke-width', '15');
                  hit.setAttribute('fill', 'none');
                  hit.setAttribute('pointer-events', 'stroke');
                  var vis = document.createElementNS(diffNS, 'path');
                  vis.setAttribute('d', geom.d);
                  vis.setAttribute('class', 'edge-themed');
                  vis.setAttribute('stroke', '#1dc981');
                  vis.setAttribute('stroke-width', '2.5');
                  vis.setAttribute('fill', 'none');
                  vis.setAttribute('stroke-dasharray', '6 4');
                  vis.setAttribute('marker-end', 'url(#arrow)');
                  g.appendChild(hit);
                  g.appendChild(vis);
                  diffSvg.appendChild(g);
                  eAdded++;
                }
              }
            } else if (d.change === 'removed') {
              if (el) { el.classList.add('dc-diff-edge-removed'); eRemoved++; }
            }
          });
        }
        if (added + removed + modified + eAdded + eRemoved === 0) return;
        renderDiffBar(added, removed, modified, eAdded, eRemoved);
      })
      .catch(function() { /* 设计/实际一侧缺失或未生成，静默忽略 */ });
  }

  function renderDiffBar(added, removed, modified, eAdded, eRemoved) {
    var existing = document.querySelector('.dc-diff-bar');
    if (existing) existing.remove();
    var bar = document.createElement('div');
    bar.className = 'dc-diff-bar';
    bar.innerHTML =
      '<span>设计 vs 实际 差异</span>' +
      (removed > 0 ? '<span class="dc-chip dc-c-red">红 ' + removed + ' 个设计有/实际无</span>' : '') +
      (added > 0 ? '<span class="dc-chip dc-c-green">绿 ' + added + ' 个实际新增</span>' : '') +
      (modified > 0 ? '<span class="dc-chip dc-c-yellow">黄 ' + modified + ' 个签名变化</span>' : '') +
      (eRemoved > 0 ? '<span class="dc-chip dc-c-red">✂ 红边 ' + eRemoved + ' 条断链</span>' : '') +
      (eAdded > 0 ? '<span class="dc-chip dc-c-green">＋绿边 ' + eAdded + ' 条新增依赖</span>' : '') +
      '<span class="dc-close" title="关闭">✕</span>';
    bar.querySelector('.dc-close').addEventListener('click', function() {
      bar.remove();
    });
    document.body.appendChild(bar);
  }

  // ==== 折叠/展开 ====
  function toggleCollapse(nodeId) {
    const hasChildren = (childrenOf[nodeId] || []).length > 0;
    if (!hasChildren) return;

    const nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!nodeEl) return;

    const descendants = getAllDescendants(nodeId);
    const isCollapsed = state.collapsed.has(nodeId);

    if (isCollapsed) {
      // 展开（跳过职责分层判定为不可见的深层节点；尊重嵌套折叠——
      // 后代路径上另有已折叠容器时不展开，实现逐级披露）
      state.collapsed.delete(nodeId);
      nodeEl.classList.remove('collapsed');
      descendants.forEach(did => {
        if (!isNodeVisible(did)) return;
        if (hasCollapsedAncestor(did, nodeId)) return;
        const descEl = document.querySelector('.node[data-id="' + did + '"]');
        if (descEl) {
          descEl.style.display = '';
          descEl.classList.add('node-enter');
          setTimeout(() => descEl.classList.remove('node-enter'), 300);
        }
      });
      // 边可见性交由全局规则统一计算（层可见 ∧ 两端点 DOM 可见），避免跨容器边悬空
      applyLayerVisibility();
      // 原地平滑展开：只记录相机检查点（供折叠回退），不缩放不跳变，
      // 子节点在各自原星图位置用 node-enter 淡入生长，画面保持稳定。
      cameraAnim.checkpoints[nodeId + ':collapse'] = { scale: canvasState.scale, panX: canvasState.panX, panY: canvasState.panY };
    } else {
      // 折叠
      state.collapsed.add(nodeId);
      nodeEl.classList.add('collapsed');
      descendants.forEach(did => {
        const descEl = document.querySelector('.node[data-id="' + did + '"]');
        if (descEl) descEl.style.display = 'none';
      });
      applyLayerVisibility();
      // 收起：退回展开前的相机检查点（无则按可见内容收束）
      if (!drillOutAfterCollapse(nodeId)) {
        if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.2, true);
      }
    }
    updateCanvasViewBox();
  }

  // 展开后取景：把宿主 + 刚披露的可见后代一起框入镜头（一步钻入该分支）
  function drillAfterExpand(nodeId) {
    // 记录展开前相机作为收起时的退路检查点
    cameraAnim.checkpoints[nodeId + ':collapse'] = { scale: canvasState.scale, panX: canvasState.panX, panY: canvasState.panY };
    const visible = [nodeId];
    getCollapsedDescendants(nodeId).forEach(did => {
      const el = document.querySelector('.node[data-id="' + did + '"]');
      if (isNodeVisible(did) && el && el.style.display !== 'none') visible.push(did);
    });
    const fit = cameraFitNodes(visible, 1.2);
    if (fit) animateCamera(fit, 420);
  }

  // 收起时退回展开前检查点；返回是否命中检查点（未命中则调用方自行收束镜头）
  function drillOutAfterCollapse(nodeId) {
    const key = nodeId + ':collapse';
    const cp = cameraAnim.checkpoints[key];
    if (!cp) return false;
    delete cameraAnim.checkpoints[key];
    animateCamera(cp, 380);
    return true;
  }

  // 宿主直接可见的后代（不含嵌套折叠容器内的深层后代）
  function getCollapsedDescendants(nodeId) {
    const out = [];
    (childrenOf[nodeId] || []).forEach(cid => {
      out.push(cid);
      if (state.collapsed.has(cid)) return;
      getCollapsedDescendants(cid).forEach(d => out.push(d));
    });
    return out;
  }

  // 后代 id 到 stopId（不含）的父链上是否存在已折叠容器
  function hasCollapsedAncestor(id, stopId) {
    let cur = parentOf[id];
    while (cur && cur !== stopId) {
      if (state.collapsed.has(cur)) return true;
      cur = parentOf[cur];
    }
    return false;
  }

  // ==== 功能卡片首屏：产品功能概览 → 点击卡片直接钻入对应功能 ====
  // 折叠所有功能/社区回首屏态：只留 项目根 + 各功能（同级 initCollapsedState 的 feature_tree 分支）
  function resetToTopLevel() {
    (dsl.geometry?.nodes || []).forEach(n => {
      if (n.id === '__project__' || n.id.indexOf('ft:') === 0) return;
      const el = document.querySelector('.node[data-id="' + n.id + '"]');
      if (el) el.style.display = 'none';
    });
    (dsl.geometry?.nodes || []).forEach(n => {
      if (n.id.indexOf('ft:') !== 0 && n.id.indexOf('ct:') !== 0) return;
      if (!childrenOf[n.id]) return;
      state.collapsed.add(n.id);
      const el = document.querySelector('.node[data-id="' + n.id + '"]');
      if (el) el.classList.add('collapsed');
    });
    // 清空下钻退路检查点，避免残留旧相机态
    Object.keys(cameraAnim.checkpoints).forEach(k => delete cameraAnim.checkpoints[k]);
    applyLayerVisibility();
  }

  // 点击功能卡片：折叠全部 → 仅展开目标功能（显示其社区）→ 相机钻入
  function drillIntoFeature(fid) {
    resetToTopLevel();
    if (!nodeById[fid]) return;
    state.collapsed.delete(fid);
    const fEl = document.querySelector('.node[data-id="' + fid + '"]');
    if (fEl) fEl.classList.remove('collapsed');
    (childrenOf[fid] || []).forEach(cid => {
      const cEl = document.querySelector('.node[data-id="' + cid + '"]');
      if (cEl) {
        cEl.style.display = '';
        cEl.classList.add('node-enter');
        setTimeout(() => cEl.classList.remove('node-enter'), 300);
      }
    });
    applyLayerVisibility();
    drillAfterExpand(fid);
  }

  // 返回概览：折叠全部分功能 → 相机收束 → 显示功能卡片层
  function showFeatureCards() {
    resetToTopLevel();
    const cards = document.getElementById('feature-cards');
    if (cards) cards.classList.remove('hidden');
    if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.6, true);
  }

  // 关闭卡片层（进入星图）：保持首屏折叠态，相机收束
  function closeFeatureCards() {
    const cards = document.getElementById('feature-cards');
    if (cards) cards.classList.add('hidden');
    if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.6, true);
  }

  function setupFeatureCards() {
    const cards = document.getElementById('feature-cards');
    if (!cards) return;
    cards.querySelectorAll('.feature-card').forEach(card => {
      card.addEventListener('click', () => {
        const fid = card.getAttribute('data-fid');
        if (!fid) return;
        cards.classList.add('hidden');
        drillIntoFeature(fid);
      });
    });
    const close = document.getElementById('feature-cards-close');
    if (close) close.addEventListener('click', closeFeatureCards);
    const open = document.getElementById('feature-cards-open');
    if (open) open.addEventListener('click', showFeatureCards);
  }

  // 更新 SVG viewBox（折叠后可能高度变化）
  // 展开深层后按需扩展画布（只增不减）：可见节点超出当前 viewBox 时同步扩展
  // svg viewBox 与缩放基准 origViewBox——二者同源，只改 svg 会在下次缩放时丢失扩展区
  function updateCanvasViewBox() {
    const svg = document.getElementById('canvas');
    if (!svg) return;
    let maxX = 0;
    let maxY = 0;
    (dsl.geometry?.nodes || []).forEach(n => {
      const el = document.querySelector('.node[data-id="' + n.id + '"]');
      if (el && el.style.display === 'none') return;
      maxX = Math.max(maxX, (n.x || 0) + (n.width || 0));
      maxY = Math.max(maxY, (n.y || 0) + (n.height || 0));
    });
    function grow(vb) {
      let changed = false;
      if (maxX > 0 && maxX + 50 > vb[2]) { vb[2] = maxX + 50; changed = true; }
      if (maxY > 0 && maxY + 50 > vb[3]) { vb[3] = maxY + 50; changed = true; }
      return changed;
    }
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    if (grow(vb)) svg.setAttribute('viewBox', vb.join(' '));
    if (canvasState.origViewBox && grow(canvasState.origViewBox) && canvasState.updateViewBox) {
      canvasState.updateViewBox();
    }
  }

  // ==== 职责分层：可见性判定与展开交互 ====
  // 层是否已展开（宿主角标 OR 全局开关）
  function isLayerExpanded(layer, host) {
    if (state.globalLayers[layer]) return true;
    if (host && state.expandedLayers.has(host + ':' + layer)) return true;
    return false;
  }

  // 节点层可见性：main 恒可见；深层看层展开；宿主本身深层时需递归可见（防环）
  function isNodeVisible(id, visited) {
    const layer = layerOf[id] || 'main';
    if (layer === 'main') return true;
    const n = nodeById[id];
    const host = n && n.host;
    if (!isLayerExpanded(layer, host)) return false;
    if (host && (layerOf[host] || 'main') !== 'main') {
      visited = visited || new Set();
      if (visited.has(id)) return false;
      visited.add(id);
      return isNodeVisible(host, visited);
    }
    return true;
  }

  // 边的宿主推导：取深层端点的 host（两端都深层时取 from 端）
  function edgeHostOf(from, to) {
    if ((layerOf[from] || 'main') !== 'main') return (nodeById[from] || {}).host;
    if ((layerOf[to] || 'main') !== 'main') return (nodeById[to] || {}).host;
    return undefined;
  }

  // 节点 DOM 实际可见（含 collapse 维度）
  function domVisible(id) {
    const el = document.querySelector('.node[data-id="' + id + '"]');
    return el ? el.style.display !== 'none' : true;
  }

  // 全量应用层可见性：深层节点按层判定（main 节点不动，归 collapse 系统管）；
  // 边可见 = 边层已展开 且 两端点 DOM 可见（尊重 collapse）
  function applyLayerVisibility() {
    (dsl.geometry?.nodes || []).forEach(n => {
      if ((layerOf[n.id] || 'main') === 'main') return;
      const vis = isNodeVisible(n.id);
      const el = document.querySelector('.node[data-id="' + n.id + '"]');
      if (!el) return;
      const cur = el.style.display !== 'none';
      if (vis === cur) return;
      el.style.display = vis ? '' : 'none';
      if (vis) {
        el.classList.add('node-enter');
        setTimeout(() => el.classList.remove('node-enter'), 300);
      }
    });
    document.querySelectorAll('.edge').forEach(edgeEl => {
      const edgeId = edgeEl.getAttribute('data-id');
      // contains 边始终隐藏（父子嵌套已可视表达），不参与可见性计算
      if (edgeId && isContainsEdge(edgeId)) return;
      const from = edgeEl.getAttribute('data-from');
      const to = edgeEl.getAttribute('data-to');
      const edgeLayer = edgeEl.getAttribute('data-layer') || 'main';
      let vis = edgeLayer === 'main' || isLayerExpanded(edgeLayer, edgeHostOf(from, to));
      if (vis && from && to) vis = domVisible(from) && domVisible(to);
      edgeEl.style.display = vis ? '' : 'none';
    });
    updateCanvasViewBox();
    // 功能树下钻/折叠后：重同步动画可见边，让新增文件调用边自动出粒子
    if (window.__animV2__ && window.__animV2__.resyncFlows) {
      try { window.__animV2__.resyncFlows(); } catch (e) { /* 动画未启动时静默 */ }
    }
  }

  // 生成层角标：error=⚠n（橙红）/ detail=▸n（主题色），宿主节点左上角
  function makeLayerBadge(hostId, layer, count, cx, cy) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'layer-badge layer-' + layer);
    g.setAttribute('data-host', hostId);
    g.setAttribute('data-layer', layer);
    const icon = layer === 'error' ? '⚠' : '▸';
    g.innerHTML = '<circle class="badge-bg" cx="' + cx + '" cy="' + cy + '" r="11"/>' +
      '<text class="badge-text" x="' + cx + '" y="' + cy + '" text-anchor="middle" dy="0.35em">' + icon + count + '</text>';
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      toggleHostLayer(hostId, layer);
    });
    return g;
  }

  function toggleHostLayer(hostId, layer) {
    const key = hostId + ':' + layer;
    if (state.expandedLayers.has(key)) {
      state.expandedLayers.delete(key);
      updateBadgeStates();
      applyLayerVisibility();
      drillOutOfHost(hostId, layer); // 退回展开前相机检查点
    } else {
      // 记录相机检查点（退路机制），展开后钻入宿主深层
      cameraAnim.checkpoints[key] = { scale: canvasState.scale, panX: canvasState.panX, panY: canvasState.panY };
      state.expandedLayers.add(key);
      updateBadgeStates();
      applyLayerVisibility();
      drillIntoHost(hostId, layer);
    }
  }

  function updateBadgeStates() {
    document.querySelectorAll('.layer-badge').forEach(b => {
      const key = b.getAttribute('data-host') + ':' + b.getAttribute('data-layer');
      b.classList.toggle('expanded', state.expandedLayers.has(key));
    });
  }

  // 给有深层孩子的宿主节点挂角标（左上，error 在前 detail 在后）
  function setupLayerBadges() {
    Object.keys(hostChildren).forEach(hostId => {
      const nodeEl = document.querySelector('.node[data-id="' + hostId + '"]');
      if (!nodeEl) return;
      const rect = nodeEl.querySelector('rect');
      if (!rect) return;
      const x = parseFloat(rect.getAttribute('x'));
      const y = parseFloat(rect.getAttribute('y'));
      const groups = hostChildren[hostId];
      let bx = x + 14;
      if (groups.error.length > 0) {
        nodeEl.appendChild(makeLayerBadge(hostId, 'error', groups.error.length, bx, y + 16));
        bx += 26;
      }
      if (groups.detail.length > 0) {
        nodeEl.appendChild(makeLayerBadge(hostId, 'detail', groups.detail.length, bx, y + 16));
        bx += 26;
      }
    });
  }

  // 全局层开关（工具栏按钮）
  function setupLayerControls() {
    const errBtn = document.getElementById('layer-error-toggle');
    const detBtn = document.getElementById('layer-detail-toggle');
    if (errBtn) errBtn.addEventListener('click', () => {
      state.globalLayers.error = !state.globalLayers.error;
      errBtn.classList.toggle('active', state.globalLayers.error);
      applyLayerVisibility();
      if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.2, true);
    });
    if (detBtn) detBtn.addEventListener('click', () => {
      state.globalLayers.detail = !state.globalLayers.detail;
      detBtn.classList.toggle('active', state.globalLayers.detail);
      applyLayerVisibility();
      if (canvasState.fitVisibleContent) canvasState.fitVisibleContent(1.2, true);
    });
  }

  // ==== 数据流追踪（L5a 静态推演：注入数据 → 沿调用链追踪处理/分流） ====

  // 数据流按钮可用性：选中 detail 层函数节点才启用
  function updateDataflowButton() {
    const btn = document.getElementById('dataflow-toggle');
    if (!btn) return;
    const n = state.selectedId ? nodeById[state.selectedId] : null;
    btn.disabled = !n || (!(n.layer === 'detail' || n.host) && !nodeById[n.host]);
  }

  function setupDataflow() {
    const btn = document.getElementById('dataflow-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const n = state.selectedId ? nodeById[state.selectedId] : null;
      if (!n) { showToast('请先选中一个 detail 层函数节点'); return; }
      const entry = n.layer === 'detail' ? n : nodeById[n.host];
      if (!entry) { showToast('请选中 detail 层函数节点（展开 ▸ 后链上的节点）'); return; }
      openDataflowPanel(entry);
    });
  }

  // ==== 变更影响分析（D2 渲染层）：填入已改文件 → /api/diff-impact → 标红 + 清单面板 ====

  // 绑定"影响"按钮 → 打开输入面板
  function setupDiffImpact() {
    const btn = document.getElementById('diff-impact-toggle');
    if (!btn) return;
    btn.addEventListener('click', openDiffImpactInput);
  }

  // ==== 架构分层着色（序号5/7 渲染层）：🎨 图层按钮 ↔ #canvas.layer-viz 类 + 图例显隐 ====
  function setupLayerViz() {
    const btn = document.getElementById('layer-viz-toggle');
    const canvas = document.getElementById('canvas');
    const legend = document.getElementById('layer-legend');
    if (!btn || !canvas) return;
    btn.addEventListener('click', () => {
      const on = !canvas.classList.contains('layer-viz');
      canvas.classList.toggle('layer-viz', on);
      btn.classList.toggle('active', on);
      if (legend) legend.classList.toggle('hidden', !on);
    });
  }

  // ==== Guided Tours（序号6）：▶ 导览 → /api/guided-tour → 按拓扑序逐个高亮 ====
  var __tour__ = { steps: [], index: -1, timer: null, playing: false };

  function setupGuidedTour() {
    const btn = document.getElementById('guided-tour-start');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (__tour__.steps.length > 0) { openTourPanel(); return; }
      fetch('/api/guided-tour', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: dsl.feature }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (!data || !data.success) throw new Error((data && data.message) || '生成导览失败');
          __tour__.steps = data.steps || [];
          if (__tour__.steps.length === 0) { showToast('该画布无可导览节点'); return; }
          openTourPanel();
        })
        .catch((e) => showToast('导览失败：' + (e && e.message ? e.message : e) + '（需 serve 模式）'));
    });
  }

  // 高亮单个节点（叠加 tour-step 类，底色描边脉冲）
  function tourHighlight(id) {
    document.querySelectorAll('.node.tour-step').forEach((el) => el.classList.remove('tour-step'));
    const el = document.querySelector('.node[data-id="' + id + '"]');
    if (el) el.classList.add('tour-step');
  }

  function tourGo(i) {
    const S = __tour__.steps;
    if (i < 0 || i >= S.length) return;
    __tour__.index = i;
    const s = S[i];
    tourHighlight(s.node_id);
    flyToNode(s.node_id);
    const panel = document.getElementById('guided-tour-panel');
    if (panel) {
      panel.querySelector('#gt-prog').textContent = (i + 1) + ' / ' + S.length;
      panel.querySelector('#gt-label').textContent = s.label || s.node_id;
      panel.querySelector('#gt-reason').textContent = s.reason || '';
      panel.querySelector('#gt-prev').disabled = i === 0;
      panel.querySelector('#gt-next').disabled = i === S.length - 1;
    }
  }

  function openTourPanel() {
    let panel = document.getElementById('guided-tour-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'guided-tour-panel';
      panel.className = 'guided-tour-panel';
      panel.innerHTML =
        '<div class="focus-panel-title">▶ 导览路径<span class="focus-close" id="gt-close">✕</span></div>' +
        '<div class="gt-head"><span id="gt-prog" class="gt-prog">-</span><span class="gt-hint">按依赖拓扑序，先依赖后依赖者</span></div>' +
        '<div class="gt-label" id="gt-label">-</div>' +
        '<div class="gt-reason" id="gt-reason">-</div>' +
        '<div class="gt-actions">' +
        '<button id="gt-prev" type="button">◀ 上一步</button>' +
        '<button id="gt-play" type="button">▶ 播放</button>' +
        '<button id="gt-next" type="button">下一步 ▶</button>' +
        '</div>';
      document.body.appendChild(panel);
      document.getElementById('gt-close').addEventListener('click', closeTour);
      document.getElementById('gt-prev').addEventListener('click', () => tourGo(__tour__.index - 1));
      document.getElementById('gt-next').addEventListener('click', () => { setTourPlaying(false); tourGo(__tour__.index + 1); });
      document.getElementById('gt-play').addEventListener('click', () => {
        if (__tour__.playing) { setTourPlaying(false); return; }
        if (__tour__.index < 0) tourGo(0);
        setTourPlaying(true);
      });
    }
    panel.style.display = 'block';
    if (__tour__.index < 0) tourGo(0);
  }

  function setTourPlaying(on) {
    __tour__.playing = on;
    const btn = document.getElementById('gt-play');
    if (btn) btn.textContent = on ? '⏸ 暂停' : '▶ 播放';
    if (on) {
      __tour__.timer = setInterval(() => {
        if (__tour__.index >= __tour__.steps.length - 1) { setTourPlaying(false); return; }
        tourGo(__tour__.index + 1);
      }, 1600);
    } else if (__tour__.timer) {
      clearInterval(__tour__.timer);
      __tour__.timer = null;
    }
  }

  function closeTour() {
    setTourPlaying(false);
    const p = document.getElementById('guided-tour-panel');
    if (p) p.remove();
    tourHighlight(null);
    __tour__.steps = [];
    __tour__.index = -1;
  }

  // 输入面板：填 changed 文件清单（相对项目根，每行一个）+ 方向/深度
  function openDiffImpactInput() {
    let panel = document.getElementById('diff-input-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'diff-input-panel';
      panel.className = 'diff-input-panel';
      panel.innerHTML =
        '<div class="focus-panel-title">🖍 变更影响分析<span class="focus-close" id="diff-input-close">✕</span></div>' +
        '<div class="diff-input-desc">填入已变更文件（相对项目根，每行一个，或逗号分隔），沿调用边追溯这次改动波及谁，并在图上标红。需 serve 模式（localhost 网页服务）+ 已建符号缓存。</div>' +
        '<textarea id="diff-input-files" rows="4" spellcheck="false" placeholder="例如：\\nsrc/db/db.ts\\nsrc/tools/serve.ts"></textarea>' +
        '<div class="diff-input-opts">' +
        '<label>方向 <select id="diff-input-dir"><option value="callers">谁调用受影响</option><option value="callees">受影响调用了谁</option><option value="both">双向</option></select></label>' +
        '<label>深度 <input id="diff-input-depth" type="number" min="1" max="10" value="3" style="width:52px"></label>' +
        '</div>' +
        '<div class="diff-input-actions">' +
        '<button id="diff-input-gitdiff" type="button" title="自动取 git 未提交/未跟踪的改动文件并分析">📡 从 git diff 取</button>' +
        '<button id="diff-input-run" type="button">▶ 分析并标红</button>' +
        '<button id="diff-input-clear" type="button">清除标记</button>' +
        '</div>' +
        '<div id="diff-input-status" class="diff-input-status"></div>';
      document.body.appendChild(panel);
      document.getElementById('diff-input-close').addEventListener('click', () => { panel.remove(); });
      document.getElementById('diff-input-gitdiff').addEventListener('click', gitDiffFetch);
      document.getElementById('diff-input-run').addEventListener('click', runDiffImpact);
      document.getElementById('diff-input-clear').addEventListener('click', clearDiffImpact);
    } else {
      panel.style.display = 'block';
    }
    document.getElementById('diff-input-files').focus();
  }

  // 清空受影响标红与面板
  function clearDiffImpact() {
    document.querySelectorAll('.node.impacted').forEach(el => el.classList.remove('impacted'));
    document.querySelectorAll('.edge.impacted').forEach(el => el.classList.remove('impacted'));
    const p = document.getElementById('diff-panel'); if (p) p.remove();
    const st = document.getElementById('diff-input-status'); if (st) st.textContent = '已清除受影响标记';
  }

  // 从 git 取改动文件 → 填充输入框并立即分析（D4 一键"本次未提交改动波及谁"）
  function gitDiffFetch() {
    const st = document.getElementById('diff-input-status');
    const filesInput = document.getElementById('diff-input-files');
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      st.textContent = '需在 serve 模式（localhost 网页服务）下使用';
      return;
    }
    st.textContent = '读取 git 改动…';
    const btn = document.getElementById('diff-input-gitdiff');
    if (btn) btn.disabled = true;
    fetch('/api/git-diff')
      .then(r => r.json())
      .then((data) => {
        if (!data || !Array.isArray(data.changed)) { st.textContent = '读取 git 改动失败'; return; }
        if (data.changed.length === 0) { st.textContent = data.message || 'git 未检出改动文件'; return; }
        filesInput.value = data.changed.join('\\n');
        st.textContent = '已填入 ' + data.changed.length + ' 个改动文件，开始分析…';
        runDiffImpact();
      })
      .catch(() => { st.textContent = '请求 git 改动失败（serve 模式才可用）'; })
      .finally(() => { if (btn) btn.disabled = false; });
  }

  // 调后端分析，结果交给 applyDiffImpact
  function runDiffImpact() {
    const st = document.getElementById('diff-input-status');
    const filesInput = document.getElementById('diff-input-files');
    const changed = (filesInput.value || '').split(/[\\n,，]/).map(s => s.trim()).filter(Boolean);
    if (changed.length === 0) { st.textContent = '请至少填一个变更文件'; return; }
    const direction = document.getElementById('diff-input-dir').value;
    const max_depth = parseInt(document.getElementById('diff-input-depth').value, 10) || 3;
    st.textContent = '分析中…';
    const body = { feature: dsl.feature, changed, direction, max_depth };
    const apply = (data) => {
      if (!data || !data.impacted_files) {
        st.textContent = '分析失败：' + ((data && data.detail) || (data && data.message) || '未知错误');
        return;
      }
      applyDiffImpact(data);
      const panel = document.getElementById('diff-input-panel');
      if (panel) panel.style.display = 'none';
    };
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      fetch('/api/diff-impact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(r => r.json())
        .then(apply)
        .catch(() => { st.textContent = '请求后端失败（serve 模式才可用）'; });
    } else {
      st.textContent = '需在 serve 模式（localhost 网页服务）下使用，并先对项目跑 import_project 建符号缓存';
    }
  }

  // 标红受影响节点/边 + 渲染受影响清单面板（内容与 D1 文本报告一致）
  function applyDiffImpact(data) {
    document.querySelectorAll('.node.impacted').forEach(el => el.classList.remove('impacted'));
    document.querySelectorAll('.edge.impacted').forEach(el => el.classList.remove('impacted'));
    let old = document.getElementById('diff-panel'); if (old) old.remove();

    const impactedNodes = new Map(); // dsl_node_id → direct?
    data.impacted_files.forEach((f) => { if (f.dsl_node_id) impactedNodes.set(f.dsl_node_id, f.direct); });
    impactedNodes.forEach((direct, id) => {
      const el = document.querySelector('.node[data-id="' + id + '"]');
      if (el) el.classList.add('impacted', direct ? 'impacted-direct' : 'impacted-indirect');
    });
    // 受影响节点之间的边标红
    (dsl.geometry?.edges || []).forEach(e => {
      if (impactedNodes.has(e.from) && impactedNodes.has(e.to)) {
        const el = document.querySelector('.edge[data-id="' + e.id + '"]');
        if (el) el.classList.add('impacted');
      }
    });

    // 受影响清单面板（样式复用 focus-panel）
    const panel = document.createElement('div');
    panel.id = 'diff-panel';
    const direct = data.impacted_files.filter(f => f.direct);
    const indirect = data.impacted_files.filter(f => !f.direct);
    const dirLabel = data.direction === 'callers' ? '谁调用受影响' : data.direction === 'callees' ? '受影响调用了谁' : '双向';
    const fileRow = (f, icon) => {
      const label = (f.dsl_node_id && nodeById[f.dsl_node_id]) ? (nodeById[f.dsl_node_id].label || f.dsl_node_id) : f.path;
      return '<div class="focus-row" data-node="' + escapeHtml(f.dsl_node_id || '') + '"><b>' + icon + ' ' + escapeHtml(label) + '</b><span>' + escapeHtml(f.path) + (f.symbol_count ? ' · ' + f.symbol_count + ' 符号' : '') + (f.direct ? '' : ' · 深度 ' + f.depth) + '</span></div>';
    };
    let html = '<div class="focus-panel-title">🖍 变更影响<span class="focus-close" id="diff-close">✕</span></div>' +
      '<div class="diff-sub">' + dirLabel + ' · 深度≤' + data.max_depth + '</div>' +
      '<div class="diff-files-label">直接受影响（' + direct.length + '）</div>' +
      direct.map(f => fileRow(f, '⬛')).join('') +
      '<div class="diff-files-label">间接波及（' + indirect.length + '）</div>' +
      indirect.map(f => fileRow(f, '🔴')).join('');
    if (data.impacted_symbols && data.impacted_symbols.length) {
      html += '<div class="diff-files-label">受影响符号明细</div><div class="diff-symbols">';
      data.impacted_symbols.forEach(s => {
        const icon = s.role === 'changed' ? '⬛' : s.role === 'caller' ? '⬆' : '⬇';
        html += '<div class="diff-sym">' + icon + ' ' + escapeHtml(s.file_path) + (s.start_line ? ':' + s.start_line : '') + ' · ' + escapeHtml(s.qualified_name) + ' <span class="diff-sym-depth">d' + s.depth + '</span></div>';
      });
      html += '</div>';
    }
    if (data.warnings && data.warnings.length) {
      html += '<div class="diff-files-label">警告</div>';
      data.warnings.forEach(w => { html += '<div class="diff-sym diff-warn">⚠ ' + escapeHtml(w) + '</div>'; });
    }
    html += '</div>';
    panel.innerHTML = html;
    document.body.appendChild(panel);
    document.getElementById('diff-close').addEventListener('click', () => panel.remove());
    panel.querySelectorAll('.focus-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-node');
        if (id && nodeById[id]) selectNode(id);
        const el = document.querySelector('.node[data-id="' + id + '"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    showToast('已标红 ' + impactedNodes.size + ' 个受影响节点');
    // D3 动画联动：受影响边上的粒子流重绘成红色
    if (window.__animV2__ && window.__animV2__.repaintImpacted) {
      try { window.__animV2__.repaintImpacted(); } catch (e) { /* 动画未启动时静默 */ }
    }
  }

  // 注入面板：预填入口节点 shapes.in 的 mock JSON，可手改
  function openDataflowPanel(entry) {
    let panel = document.getElementById('dataflow-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'dataflow-panel';
      panel.className = 'dataflow-panel';
      document.body.appendChild(panel);
    }
    const prefill = entry.shapes && entry.shapes.in
      ? JSON.stringify(mockValue(entry.shapes.in), null, 2)
      : '{"输入":"示例"}';
    panel.innerHTML =
      '<div class="dataflow-title">▶ 数据流推演：' + escapeHtml(entry.label || entry.id) + '</div>' +
      '<div class="dataflow-desc">注入数据（JSON），沿调用链推演每个函数的处理与分流。serve 模式真实执行代码，file:// 模式静态推演（mock 输出值）。</div>' +
      '<textarea id="dataflow-input" rows="6" spellcheck="false">' + escapeHtml(prefill) + '</textarea>' +
      '<div class="dataflow-actions">' +
      '<button id="dataflow-focus" type="button">✨ 聚焦关键节点</button>' +
      '<button id="dataflow-start" type="button">▶ 开始推演</button>' +
      '<button id="dataflow-cancel" type="button">取消</button>' +
      '</div>';
    panel.style.display = 'block';
    document.getElementById('dataflow-start').addEventListener('click', () => {
      let input;
      try {
        input = JSON.parse(document.getElementById('dataflow-input').value);
      } catch (e) {
        showToast('JSON 解析失败：' + e.message);
        return;
      }
      panel.style.display = 'none';
      runDataTrace(entry, input);
    });
    document.getElementById('dataflow-focus').addEventListener('click', () => {
      panel.style.display = 'none';
      focusKeyNodes(entry);
    });
    document.getElementById('dataflow-cancel').addEventListener('click', () => {
      panel.style.display = 'none';
    });
    document.getElementById('dataflow-input').focus();
  }

  // 清除上一轮推演的痕迹
  function clearTrace() {
    if (state.dataflowTimer) { clearInterval(state.dataflowTimer); state.dataflowTimer = null; }
    document.querySelectorAll('.trace-active').forEach(el => el.classList.remove('trace-active'));
    document.querySelectorAll('.trace-branch').forEach(el => el.classList.remove('trace-branch'));
    const bubble = document.getElementById('trace-bubble');
    if (bubble) bubble.remove();
    const dot = document.getElementById('trace-dot');
    if (dot) dot.remove();
  }

  // 本地启发式选点（无后端/后端失败时降级）：判定节点 → 跨文件 → 其余处理
  function localFocusNodes() {
    const all = dsl.geometry?.nodes || [];
    const judgeNodes = all.filter((n) => n.id.includes('__alg_') && /branch|loop/.test(n.description || ''));
    const judged = new Set(judgeNodes.map((n) => n.id));
    const chain = all.filter((n) => n.layer === 'detail' && !n.id.includes('__alg_'));
    const cross = chain.filter((n) => !judged.has(n.id) && n.id.includes('__sx'));
    const rest = chain.filter((n) => !judged.has(n.id) && !n.id.includes('__sx'));
    return [...judgeNodes, ...cross, ...rest].slice(0, 5).map((n) => ({
      node_id: n.id,
      reason: judged.has(n.id) ? '判定点：数据在此分流' : (n.id.includes('__sx') ? '跨文件调用：数据流出本文件' : '关键处理'),
    }));
  }

  // LLM 关键节点聚焦：关键点高亮展开、非关键压缩过渡；悬浮窗列理由，点击跳转
  function focusKeyNodes(entry) {
    const hostId = entry.host || entry.id;
    const applyFocus = (data) => {
      if (!data || !data.key_nodes || data.key_nodes.length === 0) { showToast('没有可聚焦的节点'); return; }
      document.querySelectorAll('.node.trace-focus').forEach(el => el.classList.remove('trace-focus'));
      document.querySelectorAll('.node.trace-dim').forEach(el => el.classList.remove('trace-dim'));
      const old = document.getElementById('focus-panel');
      if (old) old.remove();
      const keys = new Set(data.key_nodes.map((k) => k.node_id));
      document.querySelectorAll('.node[data-layer="detail"]').forEach((el) => {
        if (keys.has(el.getAttribute('data-id'))) el.classList.add('trace-focus');
        else el.classList.add('trace-dim');
      });
      const panel = document.createElement('div');
      panel.id = 'focus-panel';
      panel.innerHTML =
        '<div class="focus-panel-title">✨ 关键节点' + (data.llm ? '' : ' · 启发式') +
        '<span class="focus-close" id="focus-close">✕</span></div>' +
        data.key_nodes.map((k) => {
          const lbl = nodeById[k.node_id] ? (nodeById[k.node_id].label || k.node_id) : k.node_id;
          return '<div class="focus-row" data-node="' + escapeHtml(k.node_id) + '"><b>' + escapeHtml(lbl) + '</b><span>' + escapeHtml(k.reason || '') + '</span></div>';
        }).join('');
      document.body.appendChild(panel);
      document.getElementById('focus-close').addEventListener('click', () => {
        document.querySelectorAll('.node.trace-focus').forEach(el => el.classList.remove('trace-focus'));
        document.querySelectorAll('.node.trace-dim').forEach(el => el.classList.remove('trace-dim'));
        panel.remove();
      });
      panel.querySelectorAll('.focus-row').forEach((row) => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-node');
          if (id && nodeById[id]) selectNode(id);
          const el = document.querySelector('.node[data-id="' + id + '"]');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
      showToast('已聚焦 ' + data.key_nodes.length + ' 个关键节点' + (data.note ? '（' + data.note + '）' : ''));
    };
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      fetch('/api/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: dsl.feature, node_id: hostId }),
      })
        .then((r) => r.json())
        .then(applyFocus)
        .catch(() => applyFocus({ key_nodes: localFocusNodes(), llm: false, note: '后端不可用，本地启发式选点' }));
    } else {
      applyFocus({ key_nodes: localFocusNodes(), llm: false, note: '无后端，本地启发式选点' });
    }
  }

  // 节点中心（屏幕坐标，用于光点/浮层定位）
  function nodeScreenCenter(nodeId) {
    const el = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  // 当前步骤节点所属函数的 CFG 判定（真实条件 + 走向，来自 derive_algorithm 产物）
  // inValue：当前步骤注入值；rootInput：用户入口注入值。
  // scope 合并两者（当前步优先）：保证入口注入的参数名贯穿整条链参与判定求值。
  function judgementsOf(nodeId, inValue, rootInput) {
    const n = nodeById[nodeId];
    if (!n || !n.host) return [];
    const funcName = (n.label || '').replace(/^[①-⑫]|^\d+\.\s*/, '').replace(/·.*$/, '').trim();
    if (!funcName) return [];
    const nodes = (dsl.geometry?.nodes || []).map(x => ({ id: x.id, label: x.label, layer: x.layer, host: x.host, shapes: x.shapes || null, style: x.style || null, description: x.description }));
    const edges = (dsl.geometry?.edges || []).map(x => ({ id: x.id, from: x.from, to: x.to, type: x.type, label: x.label }));
    // 用户入口注入值优先（用户要看自己的输入走哪条路），当前步 in 值补充未注入字段
    const scope = Object.assign({}, flattenScope(inValue), flattenScope(rootInput));
    return applyJudgements(collectJudgements(nodes, edges, n.host, funcName), scope);
  }

  // 当前步骤浮层：进/出值 + 分流标注 + CFG 判定（rootInput 贯穿判定求值）
  function showTraceBubble(step, cx, cy, rootInput) {
    let bubble = document.getElementById('trace-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'trace-bubble';
      bubble.className = 'trace-bubble';
      document.body.appendChild(bubble);
    }
    const fmt = (v) => {
      const s = JSON.stringify(v);
      return s && s.length > 60 ? s.slice(0, 60) + '…' : s;
    };
    const js = judgementsOf(step.nodeId, step.inValue, rootInput);
    const jsHtml = js.length > 0
      ? '<div class="trace-judge">' + js.map((j) => {
          const hit = j.evaluable
            ? '<span class="trace-judge-hit">命中 → ' + escapeHtml(j.chosenVia || '?') + '</span>'
            : '<span class="trace-judge-note">无法求值' + (j.error ? '：' + escapeHtml(j.error) : '') + '</span>';
          const head = '<div class="trace-judge-cond">⚖ ' + escapeHtml(j.cond || '条件') + ' ' + hit + '</div>';
          const rows = j.branches.map((b) =>
            '<div class="trace-judge-row"><span class="trace-via' + (j.evaluable && j.chosenVia === b.via ? ' chosen' : '') + '">' + (j.evaluable && j.chosenVia === b.via ? '→ ' : '') + escapeHtml(b.via || '→') + '</span><span>' + escapeHtml(b.to) + '</span></div>'
          ).join('');
          return head + rows;
        }).join('') + '</div>'
      : '';
    const statusHtml = step.status && step.status !== 'ok'
      ? '<div class="trace-bubble-note trace-status-' + escapeHtml(step.status) + '">' + (step.status === 'unsupported' ? '⚠ 未真实执行：' : '✖ 执行出错：') + escapeHtml(step.note || '') + '</div>'
      : '';
    bubble.innerHTML =
      '<div class="trace-bubble-title">' + escapeHtml(step.label) + '</div>' +
      '<div class="trace-bubble-row"><span class="trace-dir">进</span>' + escapeHtml(fmt(step.inValue)) + '</div>' +
      '<div class="trace-bubble-row"><span class="trace-dir trace-dir-out">出</span>' + escapeHtml(fmt(step.outValue)) + '</div>' +
      (step.note && step.status === 'ok' ? '<div class="trace-bubble-note">' + escapeHtml(step.note) + '</div>' : '') +
      statusHtml +
      jsHtml;
    bubble.style.display = 'block';
    // 浮层放在节点上方居中
    bubble.style.left = Math.max(8, cx - bubble.offsetWidth / 2) + 'px';
    bubble.style.top = Math.max(8, cy - bubble.offsetHeight - 14) + 'px';
  }

  // 数据流播放调度：serve 模式（http）→ 真实执行（用户输入真实流过链路，可挖逻辑 bug）；
  // 无后端（file://）或请求失败 → 回退静态 mock 推演
  function runDataTrace(entry, inputValue) {
    clearTrace();
    const hostId = entry.host || entry.id;
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      fetch('/api/trace-exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: dsl.feature, node_id: hostId, input_value: inputValue }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.success && data.steps && data.steps.length > 0) {
            const steps = data.steps.map((s) => ({
              nodeId: s.node_id,
              label: nodeById[s.node_id] ? (nodeById[s.node_id].label || s.node_id) : s.node_id,
              inValue: s.in_value,
              outValue: s.out_value,
              note: s.note,
              status: s.status,
            }));
            playTrace(steps, entry, inputValue, []);
          } else {
            fallbackMockTrace(entry, inputValue);
          }
        })
        .catch(() => fallbackMockTrace(entry, inputValue));
    } else {
      fallbackMockTrace(entry, inputValue);
    }
  }

  // 回退：静态 mock 推演（无执行环境时看处理/判定/分流结构）
  function fallbackMockTrace(entry, inputValue) {
    const nodes = (dsl.geometry?.nodes || []).map(n => ({ id: n.id, label: n.label, layer: n.layer, host: n.host, shapes: n.shapes || null }));
    const edges = (dsl.geometry?.edges || []).map(e => ({ id: e.id, from: e.from, to: e.to, type: e.type }));
    const trace = buildDataTrace(nodes, edges, entry.id, inputValue);
    if (trace.steps.length === 0) { showToast('该节点没有可追踪的调用链'); return; }
    trace.steps.forEach((s) => { s.status = 'ok'; });
    playTrace(trace.steps, entry, inputValue, trace.branchEdgeIds);
  }

  // 通用播放器：800ms/步点亮节点 + 更新浮层；结束后保留路径
  function playTrace(steps, entry, rootInput, branchEdgeIds) {
    clearTrace();
    // 途经跳边提前高亮（分流标注在浮层 note 里）
    (branchEdgeIds || []).forEach(eid => {
      const el = document.querySelector('.edge[data-id="' + eid + '"]');
      if (el) el.classList.add('trace-branch');
    });

    // 光点（SVG 内部坐标系 = DSL 坐标，直接 append 到 #canvas）
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('id', 'trace-dot');
    dot.setAttribute('r', '8');
    dot.style.display = 'none';
    document.querySelector('svg#canvas')?.appendChild(dot);

    let idx = 0;
    const tick = () => {
      if (idx >= steps.length) {
        clearInterval(state.dataflowTimer);
        state.dataflowTimer = null;
        if (dot.parentNode) dot.parentNode.removeChild(dot);
        const bad = steps.filter((s) => s.status && s.status !== 'ok').length;
        showToast('✅ 推演完成 · ' + steps.length + ' 步' + (bad > 0 ? '（' + bad + ' 步未真实执行）' : ''));
        return;
      }
      const step = steps[idx];
      const el = document.querySelector('.node[data-id="' + step.nodeId + '"]');
      if (el) {
        el.classList.add('trace-active');
        const c = nodeScreenCenter(step.nodeId);
        const dn = nodeById[step.nodeId];
        if (dn) {
          // 光点用 DSL 坐标（SVG 内部系）
          dot.setAttribute('cx', (dn.x || 0) + (dn.width || 200) / 2);
          dot.setAttribute('cy', (dn.y || 0) + (dn.height || 60) / 2);
          dot.style.display = 'block';
        }
        if (c) showTraceBubble(step, c.x, c.y, rootInput);
      }
      idx++;
    };
    tick();
    state.dataflowTimer = setInterval(tick, 800);
  }

  // ==== 卡片交互 ====
  function setupCards() {
    document.querySelectorAll('.card').forEach(card => {
      const id = card.getAttribute('data-id');
      const nodeEl = document.querySelector('.node[data-id="' + id + '"]');

      // 点击卡片 → 选中节点
      card.addEventListener('click', () => {
        if (id) selectNode(id);
        card.classList.toggle('expanded');
      });

      // hover 卡片 → 节点发光
      if (nodeEl) {
        const rect = nodeEl.querySelector('rect');
        card.addEventListener('mouseenter', () => {
          if (rect && !state.selectedId) {
            rect.style.filter = 'brightness(1.3) drop-shadow(0 0 12px rgba(var(--theme-primary-rgb), 0.8))';
          }
        });
        card.addEventListener('mouseleave', () => {
          if (rect && !state.selectedId) {
            rect.style.filter = '';
          }
        });
      }

      // 添加展开指示器
      const hasApis = card.querySelector('.apis');
      const hasDeps = card.querySelector('.deps');
      if (hasApis || hasDeps) {
        const indicator = document.createElement('span');
        indicator.className = 'toggle-indicator';
        indicator.textContent = '▼';
        const pathEl = card.querySelector('.path');
        if (pathEl) pathEl.appendChild(indicator);
      }
    });

    // 分组卡片：点击路径行 → 定位并选中图上节点
    document.querySelectorAll('.card-group-item').forEach(item => {
      const id = item.getAttribute('data-id');
      item.addEventListener('click', () => {
        if (id) selectNode(id);
      });
    });
  }

  // ==== 标注系统（人审） ====
  function renderAnnotationPanel(focusNodeId) {
    let panel = document.getElementById('annotation-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'annotation-panel';
      panel.style.cssText = 'position:fixed;top:50px;right:10px;width:320px;max-height:70vh;background:var(--theme-panel-bg);color:#fff;border:1px solid var(--theme-border);border-radius:8px;padding:12px;font-size:13px;z-index:1000;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.4);display:none;';
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;border-bottom:1px solid var(--theme-border);padding-bottom:8px;';
      header.innerHTML = '<span style="font-weight:600;">📝 审查标注</span>';
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 6px;line-height:1;';
      closeBtn.onclick = () => { panel.style.display = 'none'; };
      header.appendChild(closeBtn);
      panel.appendChild(header);
      const list = document.createElement('div');
      list.id = 'annotation-list';
      panel.appendChild(list);
      document.body.appendChild(panel);
    }

    const list = document.getElementById('annotation-list');
    list.innerHTML = '';

    // 聚焦节点：顶部提供快速留言输入框
    if (focusNodeId) {
      const focusNode = nodeById[focusNodeId];
      const label = focusNode ? (focusNode.label || focusNode.id) : focusNodeId;
      const quickAdd = document.createElement('div');
      quickAdd.style.cssText = 'margin-bottom:10px;padding:8px;background:rgba(var(--theme-primary-rgb),0.1);border:1px solid var(--theme-border);border-radius:6px;';
      quickAdd.innerHTML = '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:6px;">📍 节点：<span style="color:var(--theme-accent);">' + escapeHtml(label) + '</span></div>';
      const input = document.createElement('input');
      input.placeholder = '写一句留言，Enter 提交…';
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--theme-border);border-radius:4px;color:#fff;font-size:12px;';
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && input.value.trim()) {
          addAnnotation(focusNodeId, input.value.trim(), 'comment', 'info');
          input.value = '';
        }
      });
      quickAdd.appendChild(input);
      list.appendChild(quickAdd);
    }

    const annotations = dsl.annotations || [];
    if (annotations.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--theme-text-sub);font-style:italic;padding:8px 0;';
      empty.textContent = '暂无标注。双击节点可添加标注。';
      list.appendChild(empty);
      return;
    }

    annotations.forEach((anno) => {
      const card = document.createElement('div');
      card.style.cssText = 'background:rgba(0,0,0,0.3);border-left:3px solid ' + (anno.severity === 'critical' ? '#F44336' : anno.severity === 'warning' ? '#FF9800' : '#2196F3') + ';padding:8px 10px;margin-bottom:8px;border-radius:4px;';

      const typeLabel = { question: '❓', issue: '⚠️', suggestion: '💡', approval: '✅' }[anno.type] || '📌';
      const titleRow = document.createElement('div');
      titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;';
      const title = document.createElement('span');
      title.style.cssText = 'font-weight:600;';
      title.textContent = typeLabel + ' ' + (anno.node_id || '通用');
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.style.cssText = 'background:transparent;border:none;color:var(--theme-text-sub);cursor:pointer;font-size:16px;padding:0 4px;';
      delBtn.onclick = () => {
        dsl.annotations = (dsl.annotations || []).filter(a => a.id !== anno.id);
        saveLocal();
        renderAnnotationPanel();
      };
      titleRow.appendChild(title);
      titleRow.appendChild(delBtn);
      card.appendChild(titleRow);

      const text = document.createElement('div');
      text.style.cssText = 'color:var(--theme-text);font-size:12px;line-height:1.5;white-space:pre-wrap;';
      text.textContent = anno.text;
      card.appendChild(text);

      if (anno.author) {
        const author = document.createElement('div');
        author.style.cssText = 'color:var(--theme-text-sub);font-size:11px;margin-top:4px;';
        author.textContent = '— ' + anno.author + ' · ' + (anno.timestamp || '');
        card.appendChild(author);
      }

      list.appendChild(card);
    });
  }

  function addAnnotation(nodeId, text, type, severity) {
    if (!dsl.annotations) dsl.annotations = [];
    dsl.annotations.push({
      id: 'anno_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      node_id: nodeId,
      text: text,
      type: type || 'comment',
      severity: severity || 'info',
      author: 'human',
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    saveLocal();
    renderAnnotationPanel();
    renderAnnoWall();
    showToast('已添加标注', 'success');
  }

  // ==== 侧边留言墙（按模块分组，点击定位到图上节点） ====
  function moduleNameOf(nodeId) {
    // 沿 contains 边向上找最近的 module 型父节点；找不到则用文件路径首段
    let cur = nodeId, guard = 0;
    while (cur && guard++ < 50) {
      const n = nodeById[cur];
      if (!n) break;
      if ((n.type === 'module' && !/^dir_/.test(n.id))) return n.label || n.id;
      cur = parentOf[cur];
    }
    const n = nodeById[nodeId];
    if (n && n.description) {
      const seg = String(n.description).split('/')[0];
      if (seg) return seg;
    }
    return '未分组';
  }

  function renderAnnoWall() {
    const wall = document.getElementById('anno-wall');
    if (!wall) return;
    const annos = (dsl.annotations || []).filter(a => !a.resolved);
    if (annos.length === 0) {
      wall.innerHTML = '<div class="anno-wall-head"><span class="anno-wall-title">💬 留言墙</span><span class="anno-wall-empty">暂无未解决留言</span></div>';
      return;
    }
    // 按模块分组
    const groups = {};
    annos.forEach(a => {
      const nid = a.node_id || a.target_id || '';
      const m = moduleNameOf(nid);
      if (!groups[m]) groups[m] = [];
      groups[m].push(a);
    });
    const sevLabel = { critical: '紧急', warning: '注意', info: '普通' };
    const typeIcon = { question: '❓', issue: '⚠️', suggestion: '💡', approval: '✅', comment: '📌' };
    const headers = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
    const maxOpen = 3; // 默认只展开留言最多的 3 个模块，其余折叠
    wall.innerHTML =
      '<div class="anno-wall-head"><span class="anno-wall-title">💬 留言墙</span>' +
      '<span class="anno-wall-count">' + annos.length + ' 未解决</span></div>' +
      headers.map((m, hi) => {
        const items = groups[m];
        const open = hi < maxOpen;
        return '<details class="anno-group" ' + (open ? 'open' : '') + ' data-module="' + escapeHtml(m) + '">' +
          '<summary><span class="anno-group-name">' + escapeHtml(m) + '</span>' +
          '<span class="anno-group-count">' + items.length + '</span></summary>' +
          items.map(a => {
            const nid = a.node_id || a.target_id || '';
            const sev = a.severity || 'info';
            return '<div class="anno-item" data-anno-id="' + escapeHtml(a.id) + '" data-node="' + escapeHtml(nid) + '">' +
              '<div class="anno-item-head"><span class="anno-sev sev-' + sev + '">' + (sevLabel[sev] || sev) + '</span>' +
              '<span class="anno-type">' + (typeIcon[a.type] || '📌') + '</span>' +
              '<span class="anno-node">' + escapeHtml(nid) + '</span></div>' +
              '<div class="anno-item-text">' + escapeHtml(a.text) + '</div>' +
              '<div class="anno-item-meta">— ' + escapeHtml(a.author || '?') + ' · ' + escapeHtml(a.timestamp || '') + '</div>' +
              '</div>';
          }).join('') +
          '</details>';
      }).join('');
    // 点击留言 → 定位并悬停到图上节点
    wall.querySelectorAll('.anno-item').forEach(item => {
      item.addEventListener('click', () => {
        const nid = item.getAttribute('data-node');
        if (nid && nodeById[nid]) {
          flyToNode(nid);
          // 临时高亮留言项
          wall.querySelectorAll('.anno-item').forEach(x => x.classList.remove('active'));
          item.classList.add('active');
        }
      });
    });
  }

  function setupAnnoWall() {
    const wall = document.getElementById('anno-wall');
    if (!wall) return;
    renderAnnoWall();
  }

  // ==== 图上留言角标：点击打开该节点留言 / 追加留言 ====
  function openAnnoPanel(nodeId) {
    if (!nodeId) return;
    // 选中节点并定位到画布
    selectNode(nodeId);
    if (nodeById[nodeId]) flyToNode(nodeId);
    const panel = document.getElementById('annotation-panel');
    if (panel) {
      panel.style.display = 'block';
      renderAnnotationPanel(nodeId);
    }
  }

  function setupAnnoBadgeClick() {
    document.querySelectorAll('.anno-badge').forEach(badge => {
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const nodeId = badge.getAttribute('data-node-id');
        openAnnoPanel(nodeId);
      });
    });
  }

  // ── 决策卡（2026-08-18 设计文档层）─────────────────────────
  // 点击「卡」角标弹出该节点的设计决策卡：参数表 + 决策记录。
  function esc2(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function setupDecisionBadgeClick() {
    document.querySelectorAll('.decision-badge').forEach(badge => {
      badge.addEventListener('click', (ev) => {
        ev.stopPropagation();
        let card = null;
        try { card = JSON.parse(badge.getAttribute('data-decision') || '{}'); } catch (e) { return; }
        closeDecisionPanel();
        const panel = document.createElement('div');
        panel.id = 'decision-panel';
        const parts = [];
        parts.push('<div class="decision-title">🗂 ' + esc2(card.label) + ' <span class="decision-id">#' + esc2(card.id) + '</span></div>');
        if (card.attributes && Object.keys(card.attributes).length) {
          parts.push('<div class="decision-sec">参数表</div><table class="decision-attrs">');
          for (const [k, v] of Object.entries(card.attributes)) parts.push('<tr><td>' + esc2(k) + '</td><td>' + esc2(v) + '</td></tr>');
          parts.push('</table>');
        }
        const d = card.decision;
        if (d) {
          parts.push('<div class="decision-sec">决策记录</div>');
          if (d.summary) parts.push('<div class="decision-row"><b>结论</b><span>' + esc2(d.summary) + '</span></div>');
          if (d.rationale) parts.push('<div class="decision-row"><b>理由</b><span>' + esc2(d.rationale) + '</span></div>');
          (d.alternatives || []).forEach(a => parts.push('<div class="decision-row alt"><b>否决</b><span>' + esc2(a.option) + '：' + esc2(a.rejected_because) + '</span></div>'));
          if (d.consequences) parts.push('<div class="decision-row"><b>后果</b><span>' + esc2(d.consequences) + '</span></div>');
          if (d.acceptance) parts.push('<div class="decision-row acc"><b>验收</b><span>' + esc2(d.acceptance) + '</span></div>');
        }
        panel.innerHTML = parts.join('') + '<div class="decision-close">点击空白处关闭</div>';
        document.body.appendChild(panel);
        panel.addEventListener('click', (e2) => e2.stopPropagation());
      });
    });
    document.addEventListener('click', () => closeDecisionPanel());
  }
  function closeDecisionPanel() {
    const old = document.getElementById('decision-panel');
    if (old) old.remove();
  }

  function setupAnnotationTriggers() {
    let toggleBtn = document.getElementById('anno-toggle-btn');
    if (!toggleBtn) {
      toggleBtn = document.createElement('button');
      toggleBtn.id = 'anno-toggle-btn';
      toggleBtn.textContent = '📝 标注';
      toggleBtn.style.cssText = 'position:fixed;top:10px;right:10px;padding:8px 14px;background:var(--theme-panel-bg);color:#fff;border:1px solid var(--theme-border);border-radius:6px;font-size:13px;cursor:pointer;z-index:999;';
      toggleBtn.onclick = () => {
        const panel = document.getElementById('annotation-panel');
        if (panel) {
          panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
          if (panel.style.display === 'block') renderAnnotationPanel();
        }
      };
      document.body.appendChild(toggleBtn);
    }

    renderAnnotationPanel();
  }

  // ==== 节点属性编辑器 ====
  function setupNodeEditor() {
    const editor = document.getElementById('prop-editor');
    const mask = document.getElementById('editor-mask');
    const closeBtn = document.getElementById('editor-close');
    const cancelBtn = document.getElementById('editor-cancel');
    const saveBtn = document.getElementById('editor-save');

    if (!editor || !mask) return;

    function closeEditor() {
      editor.classList.add('hidden');
      mask.classList.add('hidden');
    }

    function openEditor(nodeId) {
      const node = (dsl.geometry?.nodes || []).find(n => n.id === nodeId);
      if (!node) return;

      document.getElementById('editor-id').value = node.id;
      document.getElementById('editor-label').value = node.label || '';
      document.getElementById('editor-type').value = node.type || 'module';
      document.getElementById('editor-status').value = node.status || 'todo';
      document.getElementById('editor-description').value = node.description || '';

      // Style fields
      const style = node.style || {};
      document.getElementById('editor-shape').value = style.shape || 'rounded';
      const bg = style.bg || '#152141';
      document.getElementById('editor-bg-color').value = bg;
      document.getElementById('editor-bg-text').value = bg;
      document.getElementById('editor-radius').value = style.borderRadius ?? 8;

      // Content fields
      const content = node.content || { type: 'text' };
      document.getElementById('editor-content-type').value = content.type || 'text';
      document.getElementById('editor-content-blocks').value = content.blocks ? JSON.stringify(content.blocks, null, 2) : '';

      // 进料口入口（D3）：仅当节点有 flow 经过时显示（nodeFlows 函数声明提升，可前向调用）
      const replayRow = document.getElementById('editor-replay-row');
      if (replayRow) {
        const nFlows = nodeFlows(nodeId);
        replayRow.classList.toggle('hidden', nFlows.length === 0);
        const replayCnt = document.getElementById('editor-replay-count');
        if (replayCnt) replayCnt.textContent = String(nFlows.length);
      }

      // Sync color picker and text input
      const bgColorEl = document.getElementById('editor-bg-color');
      const bgTextEl = document.getElementById('editor-bg-text');
      bgColorEl.oninput = () => { bgTextEl.value = bgColorEl.value; };
      bgTextEl.oninput = () => {
        if (/^#[0-9a-fA-F]{6}$/.test(bgTextEl.value)) bgColorEl.value = bgTextEl.value;
      };

      editor.classList.remove('hidden');
      mask.classList.remove('hidden');
      document.getElementById('editor-label').focus();
    }

    function saveEditor() {
      const nodeId = document.getElementById('editor-id').value;
      const node = (dsl.geometry?.nodes || []).find(n => n.id === nodeId);
      if (!node) return;

      pushUndo();

      node.label = document.getElementById('editor-label').value;
      node.type = document.getElementById('editor-type').value;
      node.status = document.getElementById('editor-status').value;
      node.description = document.getElementById('editor-description').value;

      // Style fields
      const shape = document.getElementById('editor-shape').value;
      const bg = document.getElementById('editor-bg-text').value || document.getElementById('editor-bg-color').value;
      const borderRadius = parseInt(document.getElementById('editor-radius').value) || 8;
      if (!node.style) node.style = {};
      node.style.shape = shape;
      node.style.bg = bg;
      node.style.borderRadius = borderRadius;

      // Content fields
      const contentType = document.getElementById('editor-content-type').value;
      const blocksJson = document.getElementById('editor-content-blocks').value.trim();
      if (contentType === 'rich' && blocksJson) {
        try {
          const blocks = JSON.parse(blocksJson);
          node.content = { type: 'rich', blocks: blocks };
        } catch (e) {
          showToast('Content blocks JSON 格式错误，已跳过', 'error');
        }
      } else if (contentType === 'text') {
        node.content = { type: 'text' };
      }

      // Re-render this node
      const nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
      if (nodeEl) {
        nodeEl.classList.remove('status-todo', 'status-doing', 'status-done', 'status-blocked');
        if (node.status) nodeEl.classList.add('status-' + node.status);

        // If shape or content changed, need full re-render
        renderFromDSL();
      }

      const cardEl = document.querySelector('.card[data-id="' + nodeId + '"]');
      if (cardEl) {
        cardEl.classList.remove('status-todo', 'status-doing', 'status-done', 'status-blocked');
        if (node.status) cardEl.classList.add('status-' + node.status);
      }

      saveLocal();
      saveToServer();
      closeEditor();
      showToast('节点属性已更新', 'success');
    }

    closeBtn.addEventListener('click', closeEditor);
    cancelBtn.addEventListener('click', closeEditor);
    mask.addEventListener('click', closeEditor);
    saveBtn.addEventListener('click', saveEditor);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !editor.classList.contains('hidden')) {
        closeEditor();
      }
    });

    // ==== 进料口 · 注入回放面板（D3：静态报告 + 视觉回放，纯浏览器端） ====
    // 注意：本段是注入浏览器的纯 JS 文本（buildScript 模板字符串内），禁用 TS 语法与模板字面量
    const replayPanel = document.getElementById('replay-panel');
    const replayMask = document.getElementById('replay-mask');
    const flowSel = document.getElementById('replay-flow');
    const presetSel = document.getElementById('replay-preset');
    const injectTa = document.getElementById('replay-inject');
    const valueTa = document.getElementById('replay-value');
    const reportEl = document.getElementById('replay-report');
    let replayFlows = [];

    function nodeFlows(nodeId) {
      const flows = (dsl.animations_v2 && dsl.animations_v2.flows) || [];
      return flows.filter(f => (f.handler && f.handler.file_id === nodeId) || f.from === nodeId);
    }

    function currentFlow() {
      return replayFlows.find(f => flowSel && f.id === flowSel.value) || replayFlows[0] || null;
    }

    function closeReplay() {
      if (replayPanel) replayPanel.classList.add('hidden');
      if (replayMask) replayMask.classList.add('hidden');
    }

    function fillPresetAndInject() {
      const f = currentFlow();
      if (!f || !presetSel || !injectTa || !valueTa) return;
      const errors = (f.handler && f.handler.errors) || [];
      presetSel.innerHTML = '<option value="">（不预设，手动编辑下方 JSON）</option>';
      for (const e of errors) {
        const opt = document.createElement('option');
        opt.value = e.type;
        opt.textContent = e.type + '（' + e.severity + ' → ' + e.to + '）';
        presetSel.appendChild(opt);
      }
      const presetRow = document.getElementById('replay-preset-row');
      if (presetRow) presetRow.classList.toggle('hidden', errors.length === 0);
      // 缺省注入值：handler.mock_results[0] ?? handler.mock_result ?? {}
      const h = f.handler;
      let def = {};
      if (h) {
        if (Array.isArray(h.mock_results) && h.mock_results.length > 0) def = h.mock_results[0];
        else if (h.mock_result !== undefined) def = h.mock_result;
      }
      injectTa.value = JSON.stringify(def, null, 2);
      valueTa.value = (f.mock_values && f.mock_values.length > 0) ? JSON.stringify(f.mock_values[0], null, 2) : '';
      if (reportEl) reportEl.classList.add('hidden');
    }

    function openReplay(nodeId) {
      if (!replayPanel || !replayMask || !flowSel) return;
      replayFlows = nodeFlows(nodeId);
      if (replayFlows.length === 0) return;
      flowSel.innerHTML = '';
      for (const f of replayFlows) {
        const opt = document.createElement('option');
        opt.value = f.id;
        const dest = f.to || (f.branches ? f.branches.map(b => b.to).join('|') : '?');
        opt.textContent = f.id + '（' + f.from + ' → ' + dest + '）';
        flowSel.appendChild(opt);
      }
      fillPresetAndInject();
      closeEditor(); // 属性编辑器让位（回放只读 DSL，不产生编辑）
      replayPanel.classList.remove('hidden');
      replayMask.classList.remove('hidden');
    }

    const replayOpenBtn = document.getElementById('editor-replay-open');
    if (replayOpenBtn) replayOpenBtn.addEventListener('click', () => {
      const idInput = document.getElementById('editor-id');
      const nodeId = idInput && idInput.value;
      if (nodeId) openReplay(nodeId);
    });
    if (flowSel) flowSel.addEventListener('change', fillPresetAndInject);
    if (presetSel) presetSel.addEventListener('change', () => {
      const f = currentFlow();
      const errs = (f && f.handler && f.handler.errors) || [];
      const decl = errs.find(e => e.type === presetSel.value);
      const core = window.__animV2__ && window.__animV2__.core;
      if (!decl || !core || !injectTa) return;
      const built = core.buildPresetValue(decl);
      injectTa.value = JSON.stringify(built.value, null, 2);
      if (!built.hit) showToast('⚠ 声明条件非标准形态，自动构造值未命中 condition，建议手动调整', 'error');
    });
    const replayCloseBtn = document.getElementById('replay-close');
    if (replayCloseBtn) replayCloseBtn.addEventListener('click', closeReplay);
    const replayCancelBtn = document.getElementById('replay-cancel');
    if (replayCancelBtn) replayCancelBtn.addEventListener('click', closeReplay);
    if (replayMask) replayMask.addEventListener('click', closeReplay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && replayPanel && !replayPanel.classList.contains('hidden')) {
        closeReplay();
      }
    });

    const replayRunBtn = document.getElementById('replay-run');
    if (replayRunBtn) replayRunBtn.addEventListener('click', () => {
      const f = currentFlow();
      const core = window.__animV2__ && window.__animV2__.core;
      if (!f || !core || !injectTa || !valueTa || !reportEl) return;

      let inject;
      try {
        inject = JSON.parse(injectTa.value || 'null');
      } catch (err) {
        showToast('注入值 JSON 解析失败：' + err.message, 'error');
        return;
      }
      let valueCtx;
      const rawVal = valueTa.value.trim();
      if (rawVal) {
        try {
          valueCtx = JSON.parse(rawVal);
        } catch (err) {
          showToast('value 上下文 JSON 解析失败：' + err.message, 'error');
          return;
        }
      } else {
        valueCtx = (f.mock_values && f.mock_values.length > 0) ? f.mock_values[0] : {};
      }

      // ── 静态报告（与 MCP inject_replay 同源纯函数） ──
      const lines = [];
      const problems = [];
      const errors = (f.handler && f.handler.errors) || [];
      lines.push({ text: '注入值：' + core.formatValueShort(inject, 120), cls: 'info' });

      // 形状质检：handler.file_id 节点 shapes.out vs 注入值
      const fileId = f.handler && f.handler.file_id;
      const allNodes = (dsl.geometry && dsl.geometry.nodes) || [];
      const hostNode = fileId ? allNodes.find(n => n.id === fileId) : undefined;
      if (hostNode && hostNode.shapes && hostNode.shapes.out) {
        const violations = core.validateValueSchema(hostNode.shapes.out, inject);
        if (violations.length === 0) {
          lines.push({ text: '形状校验通过：' + fileId + '.shapes.out', cls: 'ok' });
        } else {
          lines.push({ text: '⚠ 形状校验违例（' + fileId + '.shapes.out）：', cls: 'warn' });
          for (const v of violations) lines.push({ text: '  ' + v, cls: 'warn' });
          problems.push('注入值与声明形状不匹配（DSL 漂移或数据非法）');
        }
      }

      // 异常分类 → 路由
      const cls = core.classifyError(errors, inject);
      if (cls.kind === 'declared' && cls.decl) {
        const d = cls.decl;
        lines.push({
          text: '已声明异常命中：' + d.type + '（' + d.severity + '）→ ' + d.to,
          cls: d.severity === 'unexpected' ? 'err' : 'warn',
        });
        if (d.log) lines.push({ text: '  日志：' + d.log, cls: 'info' });
      } else if (cls.kind === 'undeclared') {
        lines.push({ text: '⚠ 未声明异常：' + core.formatValueShort(inject, 80), cls: 'err' });
        lines.push({ text: '  结果像异常但未命中任何 errors 声明 → 疑似 bug，请补 errors 声明', cls: 'err' });
        problems.push('未声明异常（疑似 bug）');
      } else if (f.branches && f.branches.length > 0) {
        const picked = core.pickBranch(f.branches, valueCtx, inject);
        if (picked) {
          const cond = f.branches[picked.index].condition || 'else';
          lines.push({ text: '正常结果 → 命中分支 #' + (picked.index + 1) + '（' + cond + '）→ ' + picked.branch.to, cls: 'ok' });
        } else {
          lines.push({ text: '正常结果，但所有分支条件均未命中（无 else 兜底）→ 数据无处可去', cls: 'err' });
          problems.push('分支全部未命中（无 else 兜底）');
        }
      } else if (f.to) {
        lines.push({ text: '正常结果 → 直连流向：' + f.to, cls: 'ok' });
      } else {
        lines.push({ text: '正常结果，flow 无 branches 也无 to → 数据无处可去', cls: 'err' });
        problems.push('flow 无出口');
      }

      // ── 视觉回放：动画引擎实际跑一遍（粒子 / 闪烁 / anim-log） ──
      if (window.__animV2__ && window.__animV2__.replayFlow) {
        const r = window.__animV2__.replayFlow(f.id, inject, valueCtx);
        lines.push(r.ok
          ? { text: '视觉回放已执行（观察画布粒子与 anim-log）', cls: 'info' }
          : { text: '⚠ 视觉回放未执行：' + r.error, cls: 'warn' });
      } else {
        lines.push({ text: '⚠ 动画引擎未就绪，仅静态报告', cls: 'warn' });
      }

      lines.push({
        text: problems.length > 0 ? '结论：暴露 ' + problems.length + ' 个问题 —— ' + problems.join('；') : '结论：回放正常，未暴露问题',
        cls: problems.length > 0 ? 'err' : 'ok',
      });

      reportEl.innerHTML = '';
      for (const ln of lines) {
        const div = document.createElement('div');
        div.className = 'replay-line replay-' + ln.cls;
        div.textContent = ln.text;
        reportEl.appendChild(div);
      }
      reportEl.classList.remove('hidden');
    });

    // 双击已在 setupNodes 中统一绑定为「打开留言面板」，这里不再重复绑定 openEditor，避免冲突。
  }

  // ==== 边流动画 ====
  function setupFlowAnimation() {
    (dsl.geometry?.edges || []).forEach(e => {
      const label = (e.label || '').toLowerCase();
      const edgeEl = document.querySelector('.edge[data-id="' + e.id + '"]');
      if (!edgeEl) return;
      // 流向边：label 含 flow/流向/箭头 加流动画
      if (label.includes('flow') || label.includes('流向') || label.includes('→')) {
        edgeEl.classList.add('flow');
      }
    });
  }

  // ==== 给边加 data-from/data-to ====
  function setupEdgeData() {
    (dsl.geometry?.edges || []).forEach(e => {
      const edgeEl = document.querySelector('.edge[data-id="' + e.id + '"]');
      if (edgeEl) {
        edgeEl.setAttribute('data-from', e.from);
        edgeEl.setAttribute('data-to', e.to);
      }
    });
  }

  // ==== 给有子节点的节点加折叠按钮 ====
  function setupCollapseButtons() {
    Object.keys(childrenOf).forEach(parentId => {
      const nodeEl = document.querySelector('.node[data-id="' + parentId + '"]');
      if (!nodeEl) return;
      const rect = nodeEl.querySelector('rect');
      if (!rect) return;

      const x = parseFloat(rect.getAttribute('x'));
      const y = parseFloat(rect.getAttribute('y'));
      const w = parseFloat(rect.getAttribute('width'));
      const h = parseFloat(rect.getAttribute('height'));

      const btnX = x + w - 20;
      const btnY = y + h / 2;

      const btnGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      btnGroup.setAttribute('class', 'collapse-btn');
      btnGroup.setAttribute('data-parent', parentId);
      btnGroup.innerHTML = '<circle cx="' + btnX + '" cy="' + btnY + '" r="10" style="fill:var(--theme-panel-bg);stroke:var(--theme-primary)" stroke-width="1.5"/>' +
        '<path d="M ' + (btnX - 4) + ' ' + (btnY - 3) + ' L ' + (btnX + 4) + ' ' + btnY + ' L ' + (btnX - 4) + ' ' + (btnY + 3) + ' Z" style="fill:var(--theme-primary)"/>';

      btnGroup.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleCollapse(parentId);
      });

      nodeEl.appendChild(btnGroup);
    });
  }

  // ==== 给有子图的节点加"打开子图"按钮 ====
  function setupSubDslButtons() {
    (dsl.geometry?.nodes || []).forEach(n => {
      if (!n.sub_dsl) return;
      const nodeEl = document.querySelector('.node[data-id="' + n.id + '"]');
      if (!nodeEl) return;
      const rect = nodeEl.querySelector('rect');
      if (!rect) return;

      const x = parseFloat(rect.getAttribute('x'));
      const y = parseFloat(rect.getAttribute('y'));
      const w = parseFloat(rect.getAttribute('width'));

      const btnX = x + w - 20;
      const btnY = y + 16;

      const btnGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      btnGroup.setAttribute('class', 'sub-dsl-badge');
      btnGroup.setAttribute('data-node', n.id);
      btnGroup.innerHTML = '<circle cx="' + btnX + '" cy="' + btnY + '" r="10" fill="rgba(76,175,80,0.9)" stroke="#ffffff" stroke-width="1.5"/>' +
        '<path d="M ' + (btnX - 4) + ' ' + (btnY + 3) + ' L ' + (btnX + 4) + ' ' + (btnY + 3) + ' L ' + (btnX + 4) + ' ' + (btnY - 4) + ' L ' + (btnX + 1) + ' ' + (btnY - 4) + ' M ' + (btnX + 4) + ' ' + (btnY - 4) + ' L ' + (btnX - 2) + ' ' + (btnY + 2) + '" stroke="#ffffff" stroke-width="1.8" fill="none" stroke-linecap="round"/>';

      btnGroup.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openSubDsl(n.id);
      });

      nodeEl.appendChild(btnGroup);
    });
  }

  // 在新标签页打开子图
  function openSubDsl(nodeId) {
    const node = nodeById[nodeId];
    if (!node || !node.sub_dsl) return;

    const subDsl = node.sub_dsl;
    const subDslJson = JSON.stringify(subDsl).replace(/</g, '\\\\u003c');

    // 用当前页面的 HTML 结构 + 新 DSL 生成子图页面
    const currentHtml = document.documentElement.outerHTML;
    const startMark = '/* __DSL_START__ */';
    const endMark = '/* __DSL_END__ */';
    const startIdx = currentHtml.indexOf(startMark);
    const endIdx = currentHtml.indexOf(endMark, startIdx);
    if (startIdx === -1 || endIdx === -1) return;

    const newDslLine = 'window.__DSL__ = ' + subDslJson + ';';
    const subHtml = currentHtml.slice(0, startIdx + startMark.length) + '\\n' + newDslLine + '\\n' + currentHtml.slice(endIdx);

    // 在新标签页打开
    const newWin = window.open('', '_blank');
    if (newWin) {
      newWin.document.open();
      newWin.document.write(subHtml);
      newWin.document.close();
    }
  }

  // ==== 节点拖拽 ====
  // intersectRect / countQuadHits / countCubicHits / chooseAvoidCp / chooseAvoidCubic /
  // computeEdgePath 由顶部内联的 edge_geom.ts 提供（单源，勿在此重复定义）

  // ==== 边绕障：检测曲线与无关节点的碰撞，自动选择绕开的控制点 ====
  function getAncestors(nodeId) {
    var out = [];
    var cur = parentOf[nodeId];
    var guard = 0;
    while (cur && guard < 50) { out.push(cur); cur = parentOf[cur]; guard++; }
    return out;
  }

  // 障碍排除集：from/to 本身 + 双方祖先（容器）+ 双方后代
  function obstacleExcludeMap(fromId, toId) {
    var map = {};
    map[fromId] = true;
    map[toId] = true;
    getAncestors(fromId).forEach(function(id) { map[id] = true; });
    getAncestors(toId).forEach(function(id) { map[id] = true; });
    getAllDescendants(fromId).forEach(function(id) { map[id] = true; });
    getAllDescendants(toId).forEach(function(id) { map[id] = true; });
    return map;
  }

  function collectObstacles(excludeMap, precomputed) {
    var obs = [];
    if (precomputed) {
      // 拖动等高频路径：位置已预计算，仅按 excludeMap 过滤
      for (var p = 0; p < precomputed.length; p++) {
        var pc = precomputed[p];
        if (excludeMap[pc.id]) continue;
        obs.push({ x: pc.x, y: pc.y, w: pc.w, h: pc.h });
      }
      return obs;
    }
    var ids = Object.keys(nodeElById);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (excludeMap[id]) continue;
      var el = nodeElById[id];
      if (!el) continue;
      var pos = getNodePos(el);
      if (pos) obs.push({ x: pos.x, y: pos.y, w: pos.w, h: pos.h });
    }
    return obs;
  }

  // 预计算所有节点位置（含 id），供拖动等高频路径复用
  function precomputeNodePositions() {
    var ids = Object.keys(nodeElById);
    var arr = [];
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var el = nodeElById[id];
      if (!el) continue;
      var pos = getNodePos(el);
      if (pos) arr.push({ id: id, x: pos.x, y: pos.y, w: pos.w, h: pos.h });
    }
    return arr;
  }

  // 辅助：获取节点位置（通过 data-shape 标记识别形状元素，兼容 rect/circle/polygon）
  function getNodePos(nodeEl) {
    if (!nodeEl) return null;
    var shapeEl = nodeShapeElCache.get(nodeEl);
    if (!shapeEl || !shapeEl.isConnected) {
      shapeEl = nodeEl.querySelector('[data-shape="true"]');
      if (!shapeEl) return null;
      nodeShapeElCache.set(nodeEl, shapeEl);
    }
    var tag = shapeEl.tagName.toLowerCase();
    if (tag === 'rect') {
      return {
        x: parseFloat(shapeEl.getAttribute('x')),
        y: parseFloat(shapeEl.getAttribute('y')),
        w: parseFloat(shapeEl.getAttribute('width')),
        h: parseFloat(shapeEl.getAttribute('height')),
        shape: 'rect',
        shapeEl: shapeEl
      };
    }
    if (tag === 'circle') {
      var cx = parseFloat(shapeEl.getAttribute('cx'));
      var cy = parseFloat(shapeEl.getAttribute('cy'));
      var r = parseFloat(shapeEl.getAttribute('r'));
      return { x: cx - r, y: cy - r, w: r * 2, h: r * 2, shape: 'circle', cx: cx, cy: cy, r: r, shapeEl: shapeEl };
    }
    if (tag === 'polygon') {
      var pts = (shapeEl.getAttribute('points') || '').trim().split(/\s+/).map(function(p) {
        return p.split(',').map(parseFloat);
      });
      if (pts.length === 0) return null;
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      pts.forEach(function(p) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
      });
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, shape: 'polygon', points: pts, shapeEl: shapeEl };
    }
    return null;
  }

  // 辅助：对单个节点元素施加 delta 位移（移动形状 + 文字 + 圆点，不含后代）
  function _applyNodeDelta(nodeEl, dx, dy) {
    if (!nodeEl || (dx === 0 && dy === 0)) return;
    var pos = getNodePos(nodeEl);
    if (!pos) return;

    // 移动形状元素
    if (pos.shape === 'rect') {
      pos.shapeEl.setAttribute('x', pos.x + dx);
      pos.shapeEl.setAttribute('y', pos.y + dy);
    } else if (pos.shape === 'circle') {
      pos.shapeEl.setAttribute('cx', pos.cx + dx);
      pos.shapeEl.setAttribute('cy', pos.cy + dy);
    } else if (pos.shape === 'polygon') {
      var newPts = pos.points.map(function(p) {
        return (p[0] + dx) + ',' + (p[1] + dy);
      }).join(' ');
      pos.shapeEl.setAttribute('points', newPts);
    }

    // 移动所有 text 元素
    nodeEl.querySelectorAll('text').forEach(function(t) {
      var tx = parseFloat(t.getAttribute('x'));
      var ty = parseFloat(t.getAttribute('y'));
      if (!isNaN(tx)) t.setAttribute('x', tx + dx);
      if (!isNaN(ty)) t.setAttribute('y', ty + dy);
    });

    // 移动所有非主 shape 的 rect（如 section-card 内部的 rect）
    nodeEl.querySelectorAll('rect').forEach(function(r) {
      if (r.hasAttribute('data-shape')) return;
      var rx = parseFloat(r.getAttribute('x'));
      var ry = parseFloat(r.getAttribute('y'));
      if (!isNaN(rx)) r.setAttribute('x', rx + dx);
      if (!isNaN(ry)) r.setAttribute('y', ry + dy);
    });

    // 移动所有非形状的 circle（状态圆点等），跳过 data-shape 和 data-connect
    nodeEl.querySelectorAll('circle').forEach(function(c) {
      if (c.hasAttribute('data-shape')) return;
      if (c.hasAttribute('data-connect')) return;
      var ccx = parseFloat(c.getAttribute('cx'));
      var ccy = parseFloat(c.getAttribute('cy'));
      if (!isNaN(ccx)) c.setAttribute('cx', ccx + dx);
      if (!isNaN(ccy)) c.setAttribute('cy', ccy + dy);
    });

    // 移动 line 元素
    nodeEl.querySelectorAll('line').forEach(function(l) {
      var x1 = parseFloat(l.getAttribute('x1'));
      var y1 = parseFloat(l.getAttribute('y1'));
      var x2 = parseFloat(l.getAttribute('x2'));
      var y2 = parseFloat(l.getAttribute('y2'));
      if (!isNaN(x1)) l.setAttribute('x1', x1 + dx);
      if (!isNaN(y1)) l.setAttribute('y1', y1 + dy);
      if (!isNaN(x2)) l.setAttribute('x2', x2 + dx);
      if (!isNaN(y2)) l.setAttribute('y2', y2 + dy);
    });

    // 移动 foreignObject（富文本节点）
    var fo = nodeEl.querySelector('foreignObject');
    if (fo) {
      fo.setAttribute('x', parseFloat(fo.getAttribute('x')) + dx);
      fo.setAttribute('y', parseFloat(fo.getAttribute('y')) + dy);
    }

    // 移动节点内部直接子 <g>（如 section-layer、折叠按钮、子图徽章等）
    // 使用 transform 累加，保持内部坐标不变
    var directGs = [];
    for (var i = 0; i < nodeEl.children.length; i++) {
      var child = nodeEl.children[i];
      if (child.tagName && child.tagName.toLowerCase() === 'g') {
        directGs.push(child);
      }
    }
    directGs.forEach(function(g) {
      var transform = g.getAttribute('transform') || '';
      var match = transform.match(/translate\(([^,]+)[,\s]+([^)]+)\)/);
      var tx = match ? parseFloat(match[1]) : 0;
      var ty = match ? parseFloat(match[2]) : 0;
      g.setAttribute('transform', 'translate(' + (tx + dx) + ', ' + (ty + dy) + ')');
    });
  }

  // ==== 拖拽吸附对齐 ====
  var SNAP_THRESHOLD = 8; // viewBox 单位的吸附容差

  // 计算被拖节点 box 相对候选框的吸附偏移 {dx, dy, sx, sy}，sx/sy 为吸附的参考线坐标（无则 NaN）
  function computeSnapOffset(box, candidates, threshold) {
    var res = { dx: 0, dy: 0, sx: NaN, sy: NaN };
    if (!candidates || candidates.length === 0) return res;
    var edgesX = [box.x, box.x + box.w / 2, box.x + box.w];
    var edgesY = [box.y, box.y + box.h / 2, box.y + box.h];
    var bestX = null, bestY = null; // {dist, target, off}
    candidates.forEach(function(c) {
      var cEx = [c.x, c.x + c.w / 2, c.x + c.w];
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          var off = cEx[j] - edgesX[i];
          var d = Math.abs(off);
          if (d < threshold && (bestX === null || d < bestX.dist)) bestX = { dist: d, target: cEx[j], off: off };
        }
      }
      var cEy = [c.y, c.y + c.h / 2, c.y + c.h];
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          var offY = cEy[j] - edgesY[i];
          var dY = Math.abs(offY);
          if (dY < threshold && (bestY === null || dY < bestY.dist)) bestY = { dist: dY, target: cEy[j], off: offY };
        }
      }
    });
    if (bestX) { res.dx = bestX.off; res.sx = bestX.target; }
    if (bestY) { res.dy = bestY.off; res.sy = bestY.target; }
    return res;
  }

  // 更新吸附参考线（垂直 sx、水平 sy）
  function updateSnapGuides(sx, sy) {
    var svg = document.getElementById('canvas');
    if (!svg) return;
    if (!state.snapGuides || !state.snapGuides.isConnected) {
      var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'snap-guides');
      var vline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      var hline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      vline.setAttribute('class', 'snap-v');
      hline.setAttribute('class', 'snap-h');
      // 参考线内联样式（不依赖外部 CSS，保证可见）
      [vline, hline].forEach(function(l) {
        l.setAttribute('stroke', '#38bdf8');
        l.setAttribute('stroke-width', '1');
        l.setAttribute('stroke-dasharray', '4 3');
        l.setAttribute('fill', 'none');
        l.setAttribute('pointer-events', 'none');
      });
      g.appendChild(vline);
      g.appendChild(hline);
      svg.appendChild(g);
      state.snapGuides = g;
    }
    var vb = svg.getAttribute('viewBox').split(' ').map(Number);
    var vx0 = vb[0], vy0 = vb[1], vw = vb[2], vh = vb[3];
    var vline = state.snapGuides.querySelector('.snap-v');
    var hline = state.snapGuides.querySelector('.snap-h');
    if (isFinite(sx)) {
      vline.setAttribute('x1', sx); vline.setAttribute('x2', sx);
      vline.setAttribute('y1', vy0); vline.setAttribute('y2', vy0 + vh);
      vline.style.display = '';
    } else { vline.style.display = 'none'; }
    if (isFinite(sy)) {
      hline.setAttribute('x1', vx0); hline.setAttribute('x2', vx0 + vw);
      hline.setAttribute('y1', sy); hline.setAttribute('y2', sy);
      hline.style.display = '';
    } else { hline.style.display = 'none'; }
  }

  function clearSnapGuides() {
    if (state.snapGuides && state.snapGuides.isConnected) {
      state.snapGuides.remove();
    }
    state.snapGuides = null;
    state.snapCandidates = null;
  }

  function startDrag(nodeEl, e) {
    var pos = getNodePos(nodeEl);
    if (!pos) return;

    const svg = document.getElementById('canvas');
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scaleX = viewBox[2] / svgRect.width;
    const scaleY = viewBox[3] / svgRect.height;

    const nodeX = pos.x;
    const nodeY = pos.y;
    const mouseX = (e.clientX - svgRect.left) * scaleX;
    const mouseY = (e.clientY - svgRect.top) * scaleY;

    state.dragging = nodeEl.getAttribute('data-id');
    state.dragOffset = { x: mouseX - nodeX, y: mouseY - nodeY };
    state.dragStartPos = { x: nodeX, y: nodeY };
    state.dragMoved = false;
    // 构建吸附候选：拖拽节点及其后代之外的所有节点（拖拽期间静态，只需一次）
    var dragId = state.dragging;
    var exclude = new Set([dragId].concat(getAllDescendants(dragId)));
    state.snapCandidates = (dsl.geometry?.nodes || []).map(function(n) {
      var el = nodeElById[n.id];
      if (!el || exclude.has(n.id)) return null;
      var p = getNodePos(el);
      return p ? { x: p.x, y: p.y, w: p.w, h: p.h } : null;
    }).filter(Boolean);
    console.log('[dbg-drag] startDrag', state.dragging, 'nodeXY=', nodeX, nodeY, 'mouseXY=', mouseX, mouseY, 'offset=', JSON.stringify(state.dragOffset));

    nodeEl.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }

  function handleDrag(e) {
    if (!state.dragging) return;

    const svg = document.getElementById('canvas');
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scaleX = viewBox[2] / svgRect.width;
    const scaleY = viewBox[3] / svgRect.height;

    const mouseX = (e.clientX - svgRect.left) * scaleX;
    const mouseY = (e.clientY - svgRect.top) * scaleY;

    const newX = Math.max(0, mouseX - state.dragOffset.x);
    const newY = Math.max(0, mouseY - state.dragOffset.y);

    const nodeEl = nodeElById[state.dragging];
    if (!nodeEl) { console.log('[dbg-drag] handleDrag no nodeEl', state.dragging); return; }

    var pos = getNodePos(nodeEl);
    if (!pos) { console.log('[dbg-drag] handleDrag no pos'); return; }

    const oldX = pos.x;
    const oldY = pos.y;

    // 吸附对齐：在目标坐标上做吸附校正 + 画参考线
    const box = { x: newX, y: newY, w: pos.w, h: pos.h };
    var snap = computeSnapOffset(box, state.snapCandidates, SNAP_THRESHOLD);
    const snappedX = newX + snap.dx;
    const snappedY = newY + snap.dy;
    updateSnapGuides(snap.sx, snap.sy);

    const dx = snappedX - oldX;
    const dy = snappedY - oldY;
    console.log('[dbg-drag] handleDrag', state.dragging, 'oldX=', oldX, 'newX=', newX, 'snappedX=', snappedX, 'snapDX=', snap.dx, 'dx=', dx, 'mouseXY=', mouseX, mouseY);

    // 首次实际移动时才记录 undo 快照（避免单纯点击触发全量序列化）
    if (!state.dragMoved && (dx !== 0 || dy !== 0)) {
      state.dragMoved = true;
      pushUndo();
    }

    // 移动节点本身（支持 rect/circle/polygon）
    _applyNodeDelta(nodeEl, dx, dy);

    // 拖动父节点时，所有后代跟随移动（contains 关系）
    const descendants = getAllDescendants(state.dragging);
    descendants.forEach(function(childId) {
      const childEl = nodeElById[childId];
      if (!childEl) return;
      _applyNodeDelta(childEl, dx, dy);
      // 更新 DSL 中子节点坐标
      const childNode = nodeById[childId];
      if (childNode) {
        childNode.x = (childNode.x ?? 0) + dx;
        childNode.y = (childNode.y ?? 0) + dy;
      }
    });

    // 更新相关边的位置（包括子节点相关的边和仿真边）
    const affectedNodeIds = [state.dragging].concat(descendants);
    // 单帧内障碍位置只计算一次，供所有边复用，避免每条边重复全量遍历
    const precomputed = precomputeNodePositions();
    affectedNodeIds.forEach(function(nid) {
      updateConnectedEdges(nid, precomputed, true);
    });

    // 更新 DSL 中父节点坐标（用吸附后坐标，保证 DOM 与 DSL 一致）
    const node = nodeById[state.dragging];
    if (node) {
      node.x = snappedX;
      node.y = snappedY;
    }

    // 如果被拖动的是子节点，自动调整父节点大小以容纳所有子节点
    if (parentOf[state.dragging]) {
      resizeParentToFitChildren(parentOf[state.dragging]);
    }
  }

  function resizeParentToFitChildren(parentId) {
    var parentEl = nodeElById[parentId];
    if (!parentEl) return;
    var parentPos = getNodePos(parentEl);
    if (!parentPos) return;

    var children = childrenOf[parentId] || [];
    if (children.length === 0) return;

    var padding = 20;
    var titleBarHeight = 30;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    for (var i = 0; i < children.length; i++) {
      var childEl = nodeElById[children[i]];
      if (!childEl) continue;
      var childPos = getNodePos(childEl);
      if (!childPos) continue;
      if (childPos.x < minX) minX = childPos.x;
      if (childPos.y < minY) minY = childPos.y;
      if (childPos.x + childPos.w > maxX) maxX = childPos.x + childPos.w;
      if (childPos.y + childPos.h > maxY) maxY = childPos.y + childPos.h;
    }

    if (minX === Infinity) return;

    var newX = minX - padding;
    var newY = minY - padding - titleBarHeight;
    var newW = maxX - minX + padding * 2;
    var newH = maxY - minY + padding * 2 + titleBarHeight;

    var oldX = parentPos.x;
    var oldY = parentPos.y;
    var oldW = parentPos.w;
    var oldH = parentPos.h;

    if (newX === oldX && newY === oldY && newW === oldW && newH === oldH) return;

    var shapeEl = parentPos.shapeEl;
    var dx = newX - oldX;
    var dy = newY - oldY;
    if (parentPos.shape === 'rect') {
      shapeEl.setAttribute('x', newX);
      shapeEl.setAttribute('y', newY);
      shapeEl.setAttribute('width', newW);
      shapeEl.setAttribute('height', newH);
    }

    var text = parentEl.querySelector('text');
    if (text) {
      text.setAttribute('x', newX + newW / 2);
      text.setAttribute('y', newY + 20);
    }

    // 移动内部其他子 <g> 元素（如 section-layer）
    for (var gi = 0; gi < parentEl.children.length; gi++) {
      var child = parentEl.children[gi];
      if (child.tagName && child.tagName.toLowerCase() === 'g') {
        var gTransform = child.getAttribute('transform') || '';
        var gMatch = gTransform.match(/translate\(([^,]+)[,\s]+([^)]+)\)/);
        var gx = gMatch ? parseFloat(gMatch[1]) : 0;
        var gy = gMatch ? parseFloat(gMatch[2]) : 0;
        child.setAttribute('transform', 'translate(' + (gx + dx) + ', ' + (gy + dy) + ')');
      }
    }

    var parentNode = nodeById[parentId];
    if (parentNode) {
      parentNode.x = newX;
      parentNode.y = newY;
      parentNode.width = newW;
      parentNode.height = newH;
    }

    updateConnectedEdges(parentId, null, true);

    if (parentOf[parentId]) {
      resizeParentToFitChildren(parentOf[parentId]);
    }
  }

  function endDrag() {
    if (!state.dragging) return;

    const nodeEl = state.dragging ? nodeElById[state.dragging] : null;
    if (nodeEl) nodeEl.style.cursor = 'pointer';

    // 仅在节点确实发生移动时执行碰撞退避与保存，避免单纯点击触发 O(n²) 退避 + 全量序列化
    const moved = state.dragMoved || (state.dragStartPos &&
      (state.dragStartPos.x !== (nodeById[state.dragging]?.x ?? 0) ||
        state.dragStartPos.y !== (nodeById[state.dragging]?.y ?? 0)));
    if (moved) {
      // 拖动结束后用完整障碍避让重算一次相关边，恢复路径质量（fast 模式只用了廉价曲线）
      const descendants = getAllDescendants(state.dragging);
      const affectedNodeIds = [state.dragging].concat(descendants);
      const precomputed = precomputeNodePositions();
      affectedNodeIds.forEach(function(nid) {
        updateConnectedEdges(nid, precomputed, false);
      });
      // 手动编辑允许节点自由落位：不再自动互推重叠节点（resolveOverlaps 会让拖过去的节点被弹回=「拖不动」、邻居被挤开=「节点夹」）
      saveLocal();
      saveToServer();
    }

    state.dragging = null;
    state.dragStartPos = null;
    state.dragMoved = false;
    clearSnapGuides();
    document.body.style.userSelect = '';
    if (nodeEl) nodeEl.style.cursor = '';
  }

  // ==== 边拖拽：拖动曲线控制点 ====
  function startEdgeDrag(edgeId, e) {
    if (e.button !== 0) return;
    e.stopPropagation();
    state.edgeDragging = edgeId;
    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
    pushUndo();
  }

  function handleEdgeDrag(e) {
    if (!state.edgeDragging) return;
    var svg = document.getElementById('canvas');
    if (!svg) return;
    var svgRect = svg.getBoundingClientRect();
    var viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    var scaleX = viewBox[2] / svgRect.width;
    var scaleY = viewBox[3] / svgRect.height;
    var mouseX = (e.clientX - svgRect.left) * scaleX;
    var mouseY = (e.clientY - svgRect.top) * scaleY;

    var edgeId = state.edgeDragging;
    var isSim = edgeId.indexOf('sim-edge') === 0;
    var fromId, toId;
    if (isSim) {
      var simEl = document.querySelector('.sim-edge[data-id="' + edgeId + '"]');
      if (!simEl) return;
      fromId = simEl.getAttribute('data-from');
      toId = simEl.getAttribute('data-to');
    } else {
      var edge = edgeById[edgeId];
      if (!edge) return;
      fromId = edge.from;
      toId = edge.to;
    }
    if (fromId === toId) return; // 自环不可拖

    var fromEl = document.querySelector('.node[data-id="' + fromId + '"]');
    var toEl = document.querySelector('.node[data-id="' + toId + '"]');
    var fp = getNodePos(fromEl);
    var tp = getNodePos(toEl);
    if (!fp || !tp) return;

    var fx = fp.x + fp.w / 2, fy = fp.y + fp.h / 2;
    var tx = tp.x + tp.w / 2, ty = tp.y + tp.h / 2;
    var midX = (fx + tx) / 2, midY = (fy + ty) / 2;
    var dxe = tx - fx, dye = ty - fy;
    var len = Math.sqrt(dxe * dxe + dye * dye) || 1;
    var off = Math.min(len * 0.25, 80);
    var defCpX = midX + (-dye / len) * off;
    var defCpY = midY + (dxe / len) * off;

    state.edgeCtrlOffset[edgeId] = { dx: mouseX - defCpX, dy: mouseY - defCpY };
    updateConnectedEdges(fromId);
    updateConnectedEdges(toId);
  }

  function endEdgeDrag() {
    if (!state.edgeDragging) return;
    state.edgeDragging = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    saveLocal();
    saveToServer();
  }

  function updateConnectedEdges(nodeId, precomputed, fast) {
    function getCenter(nodeEl) {
      var pos = getNodePos(nodeEl);
      if (!pos) return null;
      return { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 };
    }

    var allEdges = [...(edgesByFrom[nodeId] || []), ...(edgesByTo[nodeId] || [])];
    var edgeMap = {};
    allEdges.forEach(function(e) { edgeMap[e.id] = e; });

    var pairGroups = {};
    allEdges.forEach(function(e) {
      var key = e.from + '->' + e.to;
      if (!pairGroups[key]) pairGroups[key] = [];
      pairGroups[key].push(e.id);
    });
    var edgeIndexMap = {};
    Object.keys(pairGroups).forEach(function(key) {
      var ids = pairGroups[key];
      ids.sort();
      ids.forEach(function(id, i) {
        edgeIndexMap[id] = { index: i, total: ids.length };
      });
    });

    allEdges.forEach(function(e) {
      var edgeEl = edgeElById[e.id];
      if (!edgeEl) return;

      var fromNode = nodeElById[e.from];
      var toNode = nodeElById[e.to];
      var fromPos = getNodePos(fromNode);
      var toPos = getNodePos(toNode);
      if (!fromPos || !toPos) return;

      // 路径计算全部委托 edge_geom.computeEdgePath（与服务端渲染同一实现）
      var ctrlOff = state.edgeCtrlOffset[e.id] || null;
      var isContains = isContainsEdge(e.id);
      var idxInfo = edgeIndexMap[e.id];
      var pathOffset = (idxInfo && idxInfo.total > 1) ? (idxInfo.index - (idxInfo.total - 1) / 2) * 18 : 0;
      var geom = computeEdgePath({
        fromBox: fromPos,
        toBox: toPos,
        selfLoop: e.from === e.to,
        edgeType: edgeEl.getAttribute('data-type') || 'curve',
        offset: pathOffset,
        // 拖动中的 fast 模式：跳过障碍避让（A* 太贵），用廉价二次曲线，拖完再全量重算
        obstacles: (fast || isContains) ? undefined : collectObstacles(obstacleExcludeMap(e.from, e.to), precomputed),
        manualCtrl: ctrlOff ? { dx: ctrlOff.dx, dy: ctrlOff.dy } : null,
      });

      edgeEl.querySelectorAll('path').forEach(function(p) {
        p.setAttribute('d', geom.d);
      });

      var text = edgeEl.querySelector('text');
      if (text) {
        text.setAttribute('x', geom.cpX);
        text.setAttribute('y', geom.cpY - 4);
      }
    });

    // 同步更新相关的仿真边（紫色虚线）：data-from 或 data-to 等于 nodeId
    var simEdges = document.querySelectorAll('.sim-edge[data-from="' + nodeId + '"], .sim-edge[data-to="' + nodeId + '"]');
    var simEdgesArr = Array.prototype.slice.call(simEdges);

    var simPairGroups = {};
    simEdgesArr.forEach(function(simEl) {
      var fId = simEl.getAttribute('data-from');
      var tId = simEl.getAttribute('data-to');
      var key = fId + '->' + tId;
      if (!simPairGroups[key]) simPairGroups[key] = [];
      simPairGroups[key].push(simEl.getAttribute('data-id'));
    });
    var simEdgeIndexMap = {};
    Object.keys(simPairGroups).forEach(function(key) {
      var ids = simPairGroups[key];
      ids.sort();
      ids.forEach(function(id, i) {
        simEdgeIndexMap[id] = { index: i, total: ids.length };
      });
    });

    simEdgesArr.forEach(function(simEl) {
      var fromId = simEl.getAttribute('data-from');
      var toId = simEl.getAttribute('data-to');
      var simId = simEl.getAttribute('data-id');

      var fromNodeEl = nodeElById[fromId];
      var toNodeEl = nodeElById[toId];
      var fromPos = getNodePos(fromNodeEl);
      var toPos = getNodePos(toNodeEl);
      if (!fromPos || !toPos) return;

      // 路径计算全部委托 edge_geom.computeEdgePath（与服务端渲染同一实现）
      var simCtrlOff = state.edgeCtrlOffset[simId] || null;
      var simIdxInfo = simEdgeIndexMap[simId];
      var simPathOffset = (simIdxInfo && simIdxInfo.total > 1) ? (simIdxInfo.index - (simIdxInfo.total - 1) / 2) * 18 : 0;
      var sGeom = computeEdgePath({
        fromBox: fromPos,
        toBox: toPos,
        selfLoop: fromId === toId,
        edgeType: 'curve',
        offset: simPathOffset,
        obstacles: fast ? undefined : collectObstacles(obstacleExcludeMap(fromId, toId), precomputed),
        manualCtrl: simCtrlOff ? { dx: simCtrlOff.dx, dy: simCtrlOff.dy } : null,
      });

      simEl.querySelectorAll('path').forEach(function(p) {
        p.setAttribute('d', sGeom.d);
      });
      var label = simEl.querySelector('.sim-edge-label');
      if (label) {
        label.setAttribute('x', sGeom.cpX);
        label.setAttribute('y', sGeom.cpY - 6);
      }
    });
  }

  // 按偏移量移动节点（支持所有形状）+ 后代跟随 + 更新相关边
  function moveNodeBy(nodeId, dx, dy) {
    if (dx === 0 && dy === 0) return;
    var nodeEl = nodeElById[nodeId];
    if (!nodeEl) return;
    var pos = getNodePos(nodeEl);
    if (!pos) return;

    // 移动节点本身
    _applyNodeDelta(nodeEl, dx, dy);
    var node = nodeById[nodeId];
    if (node) {
      node.x = (node.x ?? 0) + dx;
      node.y = (node.y ?? 0) + dy;
    }

    // 后代跟随移动（保持父子相对位置）
    var descendants = getAllDescendants(nodeId);
    descendants.forEach(function(did) {
      var childEl = nodeElById[did];
      if (!childEl) return;
      _applyNodeDelta(childEl, dx, dy);
      var childNode = nodeById[did];
      if (childNode) {
        childNode.x = (childNode.x ?? 0) + dx;
        childNode.y = (childNode.y ?? 0) + dy;
      }
    });

    // 更新相关边
    var affected = [nodeId].concat(descendants);
    affected.forEach(function(nid) {
      updateConnectedEdges(nid);
    });
  }

  // ==== 连线绘制 ====
  function startConnect(nodeEl, e) {
    const pos = getNodePos(nodeEl);
    if (!pos) return;

    const svg = document.getElementById('canvas');
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scaleX = viewBox[2] / svgRect.width;
    const scaleY = viewBox[3] / svgRect.height;

    const startX = pos.x + pos.w / 2;
    const startY = pos.y + pos.h / 2;

    state.connecting = nodeEl.getAttribute('data-id');

    // 创建临时连线
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', startX);
    line.setAttribute('y1', startY);
    line.setAttribute('x2', startX);
    line.setAttribute('y2', startY);
    line.style.stroke = 'var(--theme-primary)';
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '5,5');
    line.setAttribute('pointer-events', 'none');
    line.id = 'temp-connect-line';

    svg.appendChild(line);
    state.tempLine = line;

    document.body.style.cursor = 'crosshair';
  }

  function handleConnect(e) {
    if (!state.connecting || !state.tempLine) return;

    const svg = document.getElementById('canvas');
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scaleX = viewBox[2] / svgRect.width;
    const scaleY = viewBox[3] / svgRect.height;

    const mouseX = (e.clientX - svgRect.left) * scaleX;
    const mouseY = (e.clientY - svgRect.top) * scaleY;

    state.tempLine.setAttribute('x2', mouseX);
    state.tempLine.setAttribute('y2', mouseY);
  }

  function endConnect(e) {
    if (!state.connecting) return;

    document.body.style.cursor = '';

    if (state.tempLine) {
      state.tempLine.remove();
      state.tempLine = null;
    }

    // 找到目标节点
    const svg = document.getElementById('canvas');
    if (!svg) return;

    const svgRect = svg.getBoundingClientRect();
    const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    const scaleX = viewBox[2] / svgRect.width;
    const scaleY = viewBox[3] / svgRect.height;

    const mouseX = (e.clientX - svgRect.left) * scaleX;
    const mouseY = (e.clientY - svgRect.top) * scaleY;

    let targetId = null;
    document.querySelectorAll('.node').forEach(nodeEl => {
      const rect = nodeEl.querySelector('rect');
      if (!rect) return;

      const x = parseFloat(rect.getAttribute('x'));
      const y = parseFloat(rect.getAttribute('y'));
      const w = parseFloat(rect.getAttribute('width'));
      const h = parseFloat(rect.getAttribute('height'));

      if (mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h) {
        targetId = nodeEl.getAttribute('data-id');
      }
    });

    if (targetId && targetId !== state.connecting) {
      // 创建新边
      const newEdgeId = 'edge_' + Date.now();
      const newEdge = {
        id: newEdgeId,
        from: state.connecting,
        to: targetId,
        label: ''
      };

      // 添加到 DSL
      if (!dsl.geometry.edges) dsl.geometry.edges = [];
      dsl.geometry.edges.push(newEdge);
      pushUndo();

      // 渲染新边
      const fromNode = nodeById[newEdge.from];
      const toNode = nodeById[newEdge.to];
      if (fromNode && toNode) {
        const fromRect = document.querySelector('.node[data-id="' + newEdge.from + '"] rect');
        const toRect = document.querySelector('.node[data-id="' + newEdge.to + '"] rect');
        if (fromRect && toRect) {
          const fx = parseFloat(fromRect.getAttribute('x')) + parseFloat(fromRect.getAttribute('width')) / 2;
          const fy = parseFloat(fromRect.getAttribute('y')) + parseFloat(fromRect.getAttribute('height')) / 2;
          const tx = parseFloat(toRect.getAttribute('x')) + parseFloat(toRect.getAttribute('width')) / 2;
          const ty = parseFloat(toRect.getAttribute('y')) + parseFloat(toRect.getAttribute('height')) / 2;

          const edgeGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          edgeGroup.setAttribute('class', 'edge');
          edgeGroup.setAttribute('data-id', newEdgeId);
          edgeGroup.setAttribute('data-from', newEdge.from);
          edgeGroup.setAttribute('data-to', newEdge.to);

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'M ' + fx + ' ' + fy + ' L ' + tx + ' ' + ty);
          path.setAttribute('class', 'edge-themed');
          path.setAttribute('stroke-width', '2');
          path.setAttribute('fill', 'none');
          edgeGroup.appendChild(path);

          // 添加到 SVG（在所有节点之前）
          const firstNode = svg.querySelector('.node');
          if (firstNode) {
            svg.insertBefore(edgeGroup, firstNode);
          } else {
            svg.appendChild(edgeGroup);
          }

          // 更新索引
          edgeById[newEdgeId] = newEdge;
          edgeElById[newEdgeId] = edgeGroup;
          if (!edgesByFrom[newEdge.from]) edgesByFrom[newEdge.from] = [];
          edgesByFrom[newEdge.from].push(newEdge);
          if (!edgesByTo[newEdge.to]) edgesByTo[newEdge.to] = [];
          edgesByTo[newEdge.to].push(newEdge);

          showToast('已创建边: ' + newEdge.from + ' → ' + newEdge.to, 'success');
          saveLocal();
          saveToServer();
        }
      }
    } else if (state.connecting) {
      // 拖到空白处
      showToast('已取消连线', 'info');
    }

    state.connecting = null;
  }

  // ==== 节点事件绑定 ====
  function setupNodes() {
    // SVG 层级修复：边 path 有 pointer-events:stroke，若边在节点之上会盖住节点中心，
    // 导致"点节点却拖到边、连线全乱"。把所有节点重新 append 到 svg 末尾使其置顶，
    // 节点可点、边不挡节点。子节点（如外层容器）保持相对顺序，先置顶最深的叶子。
    const svgEl = document.getElementById('canvas');
    if (svgEl) {
      // 按在 DOM 中的深度排序，最深的节点最后 append（最上）
      const nodeEls = Array.prototype.slice.call(svgEl.querySelectorAll('.node'));
      nodeEls.sort(function(a, b) {
        var da = 0, db = 0, pa = a, pb = b;
        while (pa) { da++; pa = pa.parentNode; }
        while (pb) { db++; pb = pb.parentNode; }
        return da - db;
      });
      nodeEls.forEach(function(n) { svgEl.appendChild(n); });
    }
    document.querySelectorAll('.node').forEach(nodeEl => {
      const id = nodeEl.getAttribute('data-id');
      // 关键：主渲染路径（html_renderer SSR）不经过 renderFromDSL，
      // 若这里不填充 nodeElById，拖拽时 handleDrag 取 nodeElById[state.dragging]
      // 会得到 undefined 直接 return，表现为"节点拖不动"。
      nodeElById[id] = nodeEl;

      nodeEl.addEventListener('mouseenter', e => {
        showTooltip(e, id);
      });
      nodeEl.addEventListener('mousemove', moveTooltip);
      nodeEl.addEventListener('mouseleave', hideTooltip);

      // 右键菜单（Shift+右键开始连线）
      nodeEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (e.shiftKey) {
          startConnect(nodeEl, e);
        } else {
          showContextMenu(e, id);
        }
      });

      // 左键点击选中（Shift+点击多选）
      nodeEl.addEventListener('click', (e) => {
        if (e.shiftKey) {
          toggleMultiSelect(id);
        } else if (state.multiSelect.size > 0) {
          clearMultiSelect();
          selectNode(id);
        } else if (state.selectedId === id) {
          clearSelection();
        } else {
          selectNode(id);
        }
      });

      // 双击节点 → 打开该节点留言面板（人机协作：人留言 → LLM 代改）
      nodeEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        e.preventDefault();
        openAnnoPanel(id);
      });

      // 拖拽
      nodeEl.addEventListener('mousedown', (e) => {
        if (e.button === 0 && e.shiftKey) {
          startConnect(nodeEl, e);
        } else if (e.button === 0 && state.multiSelect.size > 0) {
          startMultiDrag(nodeEl, e);
        } else if (e.button === 0) {
          startDrag(nodeEl, e);
        }
      });
    });

    // 全局 mousemove 和 mouseup
    document.addEventListener('mousemove', (e) => {
      handleDrag(e);
      handleEdgeDrag(e);
      handleConnect(e);
      handleMultiDrag(e);
      handleSelectionBox(e);
    });

    document.addEventListener('mouseup', (e) => {
      if (state.edgeDragging) {
        endEdgeDrag();
      } else if (state.connecting) {
        endConnect(e);
      } else if (state.multiDragging) {
        endMultiDrag();
      } else if (state.selecting) {
        endSelectionBox(e);
      } else {
        endDrag();
      }
    });

    // 空白处点击隐藏菜单
    document.addEventListener('click', (e) => {
      const menu = document.getElementById('context-menu');
      if (menu && !menu.contains(e.target)) {
        menu.classList.add('hidden');
      }
    });
  }

  // ==== 右键菜单 ====
  function showContextMenu(e, nodeId) {
    const menu = document.getElementById('context-menu');
    if (!menu) return;
    menu.classList.remove('hidden');
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    state.contextMenuNodeId = nodeId;
    menu.querySelectorAll('.context-menu-item').forEach(item => {
      item.onclick = () => {
        const action = item.getAttribute('data-action');
        handleContextAction(action);
        menu.classList.add('hidden');
      };
    });
  }

  function handleContextAction(action) {
    const id = state.contextMenuNodeId;
    if (!id) return;
    if (action === 'edit-label') {
      const newLabel = prompt('输入新标签：', dsl.geometry.nodes.find(n => n.id === id)?.label ?? id);
      if (newLabel !== null) {
        const node = dsl.geometry.nodes.find(n => n.id === id);
        if (node) {
          pushUndo();
          node.label = newLabel;
          const textEl = document.querySelector('.node[data-id="' + id + '"] text');
          if (textEl) textEl.textContent = newLabel;
          saveLocal();
          markDirty();
        }
      }
    } else if (action === 'add-annotation') {
      const text = prompt('输入标注内容：');
      if (text) {
        pushUndo();
        if (!dsl.annotations) dsl.annotations = [];
        dsl.annotations.push({
          id: 'ann_' + Date.now().toString(36),
          node_id: id,
          text,
          type: 'comment',
          author: 'human',
          created: new Date().toISOString(),
          approval_status: 'draft',
          approval_history: [],
        });
        saveLocal();
        markDirty();
        alert('标注已添加');
      }
    } else if (action === 'submit-approval') {
      const annText = prompt('输入审批说明（可选）：', '请审批该设计');
      const annId = 'ann_' + Date.now().toString(36);
      pushUndo();
      if (!dsl.annotations) dsl.annotations = [];
      const ann = {
        id: annId,
        node_id: id,
        text: annText || '请审批',
        type: 'approval',
        author: 'human',
        created: new Date().toISOString(),
        approval_status: 'pending_review',
        approval_history: [{
          id: 'ah_' + Date.now().toString(36),
          action: 'submit',
          status: 'pending_review',
          actor: 'human',
          comment: annText || '',
          timestamp: new Date().toISOString(),
        }],
      };
      dsl.annotations.push(ann);
      saveLocal();
      markDirty();
      alert('已提交审批');
    } else if (action === 'delete') {
      if (confirm('确定删除该节点？')) {
        pushUndo();
        dsl.geometry.nodes = dsl.geometry.nodes.filter(n => n.id !== id);
        dsl.geometry.edges = (dsl.geometry.edges ?? []).filter(e => e.from !== id && e.to !== id);
        const nodeEl = document.querySelector('.node[data-id="' + id + '"]');
        if (nodeEl) nodeEl.remove();
        document.querySelectorAll('.edge').forEach(el => {
          if (el.getAttribute('data-from') === id || el.getAttribute('data-to') === id) {
            el.remove();
          }
        });
        saveLocal();
        markDirty();
      }
    }
  }

  // ==== 多选 ====
  function toggleMultiSelect(id) {
    if (state.multiSelect.has(id)) {
      state.multiSelect.delete(id);
    } else {
      state.multiSelect.add(id);
    }
    updateMultiSelectUI();
  }

  function clearMultiSelect() {
    state.multiSelect.clear();
    updateMultiSelectUI();
  }

  function updateMultiSelectUI() {
    document.querySelectorAll('.node').forEach(el => {
      el.classList.remove('selected');
    });
    state.multiSelect.forEach(id => {
      const el = document.querySelector('.node[data-id="' + id + '"]');
      if (el) el.classList.add('selected');
    });
    const bar = document.getElementById('multi-select-bar');
    const countEl = document.getElementById('select-count');
    if (bar && countEl) {
      if (state.multiSelect.size > 0) {
        bar.classList.remove('hidden');
        countEl.textContent = '已选 ' + state.multiSelect.size + ' 个节点';
      } else {
        bar.classList.add('hidden');
      }
    }
  }

  // ==== 框选 ====
  function startSelectionBox(e) {
    if (e.button !== 0 || e.shiftKey) return;
    const wrap = document.querySelector('.canvas-wrap');
    if (!wrap || e.target.closest('.node') || e.target.closest('.edge')) return;
    state.selecting = true;
    state.selectionStart = { x: e.clientX, y: e.clientY };
    const box = document.getElementById('selection-box');
    if (box) {
      box.classList.remove('hidden');
      box.style.left = e.clientX + 'px';
      box.style.top = e.clientY + 'px';
      box.style.width = '0px';
      box.style.height = '0px';
    }
  }

  function handleSelectionBox(e) {
    if (!state.selecting) return;
    const box = document.getElementById('selection-box');
    if (!box) return;
    const start = state.selectionStart;
    const left = Math.min(start.x, e.clientX);
    const top = Math.min(start.y, e.clientY);
    const width = Math.abs(e.clientX - start.x);
    const height = Math.abs(e.clientY - start.y);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = width + 'px';
    box.style.height = height + 'px';
  }

  function endSelectionBox(e) {
    if (!state.selecting) return;
    state.selecting = false;
    const box = document.getElementById('selection-box');
    if (box) box.classList.add('hidden');
    const start = state.selectionStart;
    const left = Math.min(start.x, e.clientX);
    const top = Math.min(start.y, e.clientY);
    const right = Math.max(start.x, e.clientX);
    const bottom = Math.max(start.y, e.clientY);
    document.querySelectorAll('.node').forEach(nodeEl => {
      const rect = nodeEl.getBoundingClientRect();
      if (rect.left >= left && rect.right <= right && rect.top >= top && rect.bottom <= bottom) {
        state.multiSelect.add(nodeEl.getAttribute('data-id') || '');
      }
    });
    updateMultiSelectUI();
  }

  // ==== 批量拖拽 ====
  function startMultiDrag(nodeEl, e) {
    const id = nodeEl.getAttribute('data-id');
    if (!id || !state.multiSelect.has(id)) return;
    state.multiDragging = true;
    state.dragStart = { x: e.clientX, y: e.clientY };
    state.multiDragStart = new Map();
    state.multiSelect.forEach(nid => {
      const node = dsl.geometry.nodes.find(n => n.id === nid);
      if (node) {
        state.multiDragStart.set(nid, { x: node.x ?? 0, y: node.y ?? 0 });
      }
    });
    pushUndo();
    e.preventDefault();
  }

  function handleMultiDrag(e) {
    if (!state.multiDragging) return;
    const dx = (e.clientX - state.dragStart.x) / state.scale;
    const dy = (e.clientY - state.dragStart.y) / state.scale;
    state.multiSelect.forEach(id => {
      const start = state.multiDragStart.get(id);
      const node = dsl.geometry.nodes.find(n => n.id === id);
      if (start && node) {
        node.x = start.x + dx;
        node.y = start.y + dy;
        const nodeEl = document.querySelector('.node[data-id="' + id + '"]');
        if (nodeEl) {
          nodeEl.setAttribute('transform', 'translate(' + node.x + ', ' + node.y + ')');
        }
      }
    });
  }

  function endMultiDrag() {
    state.multiDragging = false;
    saveLocal();
    markDirty();
  }

  // ==== 边事件绑定 ====
  function setupEdges() {
    document.querySelectorAll('.edge').forEach(edgeEl => {
      const id = edgeEl.getAttribute('data-id');
      // 关键：主渲染路径（html_renderer SSR）不经过 renderFromDSL，
      // 必须在此填充 edgeElById，否则 updateConnectedEdges 里 edgeElById[e.id] 为 undefined，
      // 拖动节点时边不会跟随（表现为"边像背景图留在原地"）。
      edgeElById[id] = edgeEl;
      edgeEl.addEventListener('mouseenter', e => {
        showTooltip(e, id);
      });
      edgeEl.addEventListener('mousemove', moveTooltip);
      edgeEl.addEventListener('mouseleave', hideTooltip);

      edgeEl.addEventListener('click', () => {
        const e = edgeById[id];
        if (e) selectNode(e.from);
      });
    });
  }

  // 紫色仿真边：hover 显示规则详情 tooltip，点击高亮相关节点
  function setupSimEdges() {
    document.querySelectorAll('.sim-edge').forEach(edgeEl => {
      edgeEl.addEventListener('mouseenter', e => {
        var detailRaw = edgeEl.getAttribute('data-detail');
        var detail = null;
        try { detail = JSON.parse(detailRaw); } catch (err) { /* ignore */ }
        var html = '';
        if (detail) {
          html += '<div style="font-weight:600;margin-bottom:6px;color:#b39ddb;">🔬 仿真规则: ' + escapeHtml(detail.name || detail.id) + '</div>';
          html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">规则ID: <code>' + escapeHtml(detail.id) + '</code></div>';
          html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">触发事件: <span style="color:#ffc107;">' + escapeHtml(detail.event) + '</span></div>';
          html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">来源 → 目标: <code>' + escapeHtml(detail.from) + ' → ' + escapeHtml(detail.to) + '</code></div>';
          if (detail.condition) {
            html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">条件:</div>';
            html += '<pre style="font-size:10px;color:var(--theme-accent);background:rgba(0,0,0,0.3);padding:6px;border-radius:4px;margin:4px 0;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(detail.condition) + '</pre>';
          }
          if (detail.emits && detail.emits.length > 0) {
            html += '<div style="font-size:11px;color:var(--theme-text-sub);margin-bottom:4px;">发射事件: <span style="color:#4caf50;">' + escapeHtml(detail.emits.join(', ')) + '</span></div>';
          }
        } else {
          var ruleId = edgeEl.getAttribute('data-rule') || '';
          var eventName = edgeEl.getAttribute('data-event') || '';
          html = '<div style="font-weight:600;color:#b39ddb;">🔬 ' + escapeHtml(ruleId) + '</div>' +
                 '<div style="font-size:11px;color:var(--theme-text-sub);">事件: ' + escapeHtml(eventName) + '</div>';
        }
        tooltip.innerHTML = html;
        tooltip.style.display = 'block';
        requestAnimationFrame(() => tooltip.classList.add('visible'));
        moveTooltip(e);
      });
      edgeEl.addEventListener('mousemove', moveTooltip);
      edgeEl.addEventListener('mouseleave', hideTooltip);
      edgeEl.addEventListener('mousedown', e => {
        var simEdgeId = edgeEl.getAttribute('data-id');
        startEdgeDrag(simEdgeId, e);
      });
      edgeEl.addEventListener('click', e => {
        e.stopPropagation();
        var ruleId = edgeEl.getAttribute('data-rule');
        // 高亮所有相关节点（from 和所有 to_nodes）
        document.querySelectorAll('.sim-edge[data-rule="' + ruleId + '"]').forEach(el => {
          el.classList.add('active');
          (function(elRef) { setTimeout(function() { elRef.classList.remove('active'); }, 2500); })(el);
        });
        showToast('已高亮规则: ' + ruleId, 'info');
      });
    });
  }

  // ==== 画布缩放与平移 ====
  const canvasState = {
    scale: 1,
    panX: 0,
    panY: 0,
    isPanning: false,
    panStart: { x: 0, y: 0 },
    origViewBox: null,
  };

  function setupCanvasZoomPan() {
    const svg = document.getElementById('canvas');
    const canvasWrap = document.querySelector('.canvas-wrap');
    if (!svg) return;

    const origViewBox = svg.getAttribute('viewBox').split(' ').map(Number);
    canvasState.origViewBox = origViewBox;

    // 屏幕感知缩放：fitScale = scale=1 时内容的实际显示比例（uniform，含 meet 约束）
    // 巨型画布（如 import_project 产物 8480×24746）fit 后实际显示可能只有 ~4%，
    // 固定 5 倍上限永远放不到可读尺寸 → 上限/步长/初始视图全部按 fitScale 自适应
    const rect0 = svg.getBoundingClientRect();
    const fitScale = (rect0.width > 0 && rect0.height > 0 && origViewBox[2] > 0 && origViewBox[3] > 0)
      ? Math.min(rect0.width / origViewBox[2], rect0.height / origViewBox[3])
      : 1;
    canvasState.fitScale = fitScale;
    // 上限：至少允许放大到实际 300%（巨图 maxScale 可远超 5）
    canvasState.maxScale = Math.max(5, 3 / fitScale);
    // 巨图滚轮大步长，普通图细调
    const wheelStep = fitScale < 0.25 ? 1.2 : 1.1;

    function updateViewBox() {
      const [ox, oy, ow, oh] = origViewBox;
      const nw = ow / canvasState.scale;
      const nh = oh / canvasState.scale;
      const nx = ox + (ow - nw) / 2 - canvasState.panX;
      const ny = oy + (oh - nh) / 2 - canvasState.panY;
      svg.setAttribute('viewBox', nx + ' ' + ny + ' ' + nw + ' ' + nh);
      updateZoomLabel();
    }

    function updateZoomLabel() {
      const label = document.getElementById('zoom-level');
      // 诚实标签：显示实际显示比例（scale × fitScale），而非相对 viewBox 的虚值
      if (label) label.textContent = Math.round(canvasState.scale * fitScale * 100) + '%';
    }

    function setScale(newScale, centerX, centerY) {
      newScale = Math.max(0.2, Math.min(canvasState.maxScale, newScale));
      if (centerX !== undefined && centerY !== undefined) {
        const rect = svg.getBoundingClientRect();
        const [ox, oy, ow, oh] = origViewBox;
        const svgCx = ox + (centerX / rect.width) * ow;
        const svgCy = oy + (centerY / rect.height) * oh;
        const oldScale = canvasState.scale;
        canvasState.panX += (svgCx - ox - ow / 2) * (1 / oldScale - 1 / newScale);
        canvasState.panY += (svgCy - oy - oh / 2) * (1 / oldScale - 1 / newScale);
      }
      canvasState.scale = newScale;
      updateViewBox();
    }

    // 滚轮缩放
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 / wheelStep : wheelStep;
      setScale(canvasState.scale * delta, e.offsetX, e.offsetY);
    }, { passive: false });

    // 拖拽背景平移
    if (canvasWrap) {
      canvasWrap.addEventListener('mousedown', (e) => {
        if (e.target === svg || e.target === canvasWrap || e.target.tagName === 'svg') {
          if (e.shiftKey) {
            // Shift + 空白拖拽：框选
            state.selecting = true;
            state.selectionStart = { x: e.clientX, y: e.clientY };
            const box = document.getElementById('selection-box');
            if (box) {
              box.classList.remove('hidden');
              box.style.left = e.clientX + 'px';
              box.style.top = e.clientY + 'px';
              box.style.width = '0px';
              box.style.height = '0px';
            }
            e.preventDefault();
          } else {
            canvasState.isPanning = true;
            canvasState.panStart = { x: e.clientX, y: e.clientY };
            canvasWrap.style.cursor = 'grabbing';
            e.preventDefault();
          }
        }
      });

      document.addEventListener('mousemove', (e) => {
        if (!canvasState.isPanning) return;
        const dx = e.clientX - canvasState.panStart.x;
        const dy = e.clientY - canvasState.panStart.y;
        const rect = svg.getBoundingClientRect();
        const [ox, oy, ow, oh] = origViewBox;
        canvasState.panX += (dx / rect.width) * ow / canvasState.scale;
        canvasState.panY += (dy / rect.height) * oh / canvasState.scale;
        canvasState.panStart = { x: e.clientX, y: e.clientY };
        updateViewBox();
      });

      document.addEventListener('mouseup', () => {
        if (canvasState.isPanning) {
          canvasState.isPanning = false;
          canvasWrap.style.cursor = '';
        }
      });
    }

    // 缩放按钮
    const zoomIn = document.getElementById('zoom-in');
    const zoomOut = document.getElementById('zoom-out');
    const zoomFit = document.getElementById('zoom-fit');
    const zoomReset = document.getElementById('zoom-reset');

    if (zoomIn) zoomIn.addEventListener('click', () => setScale(canvasState.scale * 1.2));
    if (zoomOut) zoomOut.addEventListener('click', () => setScale(canvasState.scale / 1.2));
    // 适配可见内容到屏幕：按屏幕尺寸直接反推 scale（s_d = scale × fitScale）。
    // 旧公式 min(ow/fw, oh/fh) 对超长画布（8480×24746）会被完整高度拖累，
    // meet 适配后实际显示仍只有 ~4%，等于没 fit —— 必须绕开 origViewBox 维度。
    // maxActual：实际显示比例上限（防小包围盒被过度放大）
    function fitVisibleContent(maxActual, animate) {
      const nodes = dsl.geometry?.nodes || [];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cnt = 0;
      nodes.forEach(n => {
        // 跳过不可见节点（深层折叠 / collapse 折叠 / 筛选隐藏），避免幽灵占位撑大画布
        const el = document.querySelector('.node[data-id="' + n.id + '"]');
        if (el && (el.style.display === 'none' || el.classList.contains('filter-hidden'))) return;
        cnt++;
        const x = n.x || 0, y = n.y || 0;
        const w = n.width || 120, h = n.height || 60;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      });
      if (cnt === 0) return;
      const padding = 50;
      const fw = maxX - minX + padding * 2;
      const fh = maxY - minY + padding * 2;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || fitScale <= 0) return;
      const sd = Math.min(rect.width / fw, rect.height / fh, maxActual || 1.5);
      const [ox, oy, ow, oh] = origViewBox;
      const target = {
        scale: Math.max(0.2, Math.min(canvasState.maxScale, sd / fitScale)),
        // 使视图中心对准可见包围盒中心（由 updateViewBox 公式反推）
        panX: ox + ow / 2 - (minX + maxX) / 2,
        panY: oy + oh / 2 - (minY + maxY) / 2,
      };
      // animate=true 走相机动效（层开关/钻入场景），默认瞬时（初始视图/重置）
      if (animate) { animateCamera(target, 420); return; }
      canvasState.scale = target.scale;
      canvasState.panX = target.panX;
      canvasState.panY = target.panY;
      updateViewBox();
    }

    // 初始视图（也是 zoom-reset 的目标）：巨图（fit 后实际显示 <50%）适配可见内容到屏幕
    // （折叠后只剩顶层容器时，开局即可读）；普通图保持 scale=1 全览
    function applyInitialView() {
      if (fitScale >= 0.5) {
        canvasState.scale = 1;
        canvasState.panX = 0;
        canvasState.panY = 0;
        updateViewBox();
        return;
      }
      // 巨图：适配可见内容，实际显示封顶 100%（1 单位 = 1 屏幕 px）
      fitVisibleContent(1.0);
    }
    if (zoomReset) zoomReset.addEventListener('click', applyInitialView);
    if (zoomFit) zoomFit.addEventListener('click', () => fitVisibleContent(1.5, true));

    applyInitialView();

    // 钻入动效句柄：闭包内相机函数挂到 canvasState，供层展开/收起调用
    canvasState.updateViewBox = updateViewBox;
    canvasState.fitVisibleContent = fitVisibleContent;
  }

  // ==== 缩放钻入动效 ====
  // 展开层级 = 钻入（相机平滑框住宿主+深层孩子，实际显示封顶 120% 防过曝）；
  // 收起 = 退回（恢复该层展开前的相机检查点）。检查点即退路机制。
  const cameraAnim = { raf: 0, checkpoints: {} };

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // 相机补间：scale/panX/panY 从当前值平滑到 target，新动画取消进行中的旧动画
  function animateCamera(target, duration) {
    if (!canvasState.updateViewBox) return;
    if (cameraAnim.raf) cancelAnimationFrame(cameraAnim.raf);
    const from = { scale: canvasState.scale, panX: canvasState.panX, panY: canvasState.panY };
    const dur = duration || 420;
    const start = performance.now();
    function step(now) {
      const t = Math.min(1, (now - start) / dur);
      const k = easeInOutCubic(t);
      canvasState.scale = from.scale + (target.scale - from.scale) * k;
      canvasState.panX = from.panX + (target.panX - from.panX) * k;
      canvasState.panY = from.panY + (target.panY - from.panY) * k;
      canvasState.updateViewBox();
      if (t < 1) cameraAnim.raf = requestAnimationFrame(step);
      else cameraAnim.raf = 0;
    }
    cameraAnim.raf = requestAnimationFrame(step);
  }

  // 框住一组节点的目标相机（与 fitVisibleContent 同公式，maxActual 封顶实际显示）
  // 返回 { scale, panX, panY, __sd }；__sd = 实际显示比例（钻入可读性判定用）
  function cameraFitNodes(ids, maxActual) {
    const svg = document.getElementById('canvas');
    if (!svg || !canvasState.origViewBox || !canvasState.fitScale) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cnt = 0;
    ids.forEach(id => {
      const n = nodeById[id];
      if (!n) return;
      cnt++;
      const x = n.x || 0, y = n.y || 0, w = n.width || 120, h = n.height || 60;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w);
      maxY = Math.max(maxY, y + h);
    });
    if (cnt === 0) return null;
    const padding = 60;
    const fw = maxX - minX + padding * 2;
    const fh = maxY - minY + padding * 2;
    const sd = Math.min(rect.width / fw, rect.height / fh, maxActual || 1.2);
    const vb = canvasState.origViewBox;
    return {
      scale: Math.max(0.2, Math.min(canvasState.maxScale || 5, sd / canvasState.fitScale)),
      panX: vb[0] + vb[2] / 2 - (minX + maxX) / 2,
      panY: vb[1] + vb[3] / 2 - (minY + maxY) / 2,
      __sd: sd,
    };
  }

  // 钻入宿主深层。两种取景：
  //   小层（全入镜实际显示 ≥70%）→ 宿主+全部该层孩子一起入镜
  //   长条/大片（全入镜不可读）→ 入口取景：宿主+按距离就近纳入孩子，直到跌破 70% 下限
  function drillIntoHost(hostId, layer) {
    const groups = hostChildren[hostId];
    if (!groups) return;
    const host = nodeById[hostId];
    if (!host) return;
    const kids = (groups[layer] || []).map(id => nodeById[id]).filter(Boolean);
    const full = cameraFitNodes([hostId].concat(kids.map(k => k.id)), 1.2);
    if (!full) return;
    if (kids.length === 0 || full.__sd >= 0.7) { animateCamera(full, 420); return; }
    const hx = (host.x || 0) + (host.width || 120) / 2;
    const hy = (host.y || 0) + (host.height || 60) / 2;
    kids.sort((a, b) => {
      const ax = (a.x || 0) + (a.width || 120) / 2, ay = (a.y || 0) + (a.height || 60) / 2;
      const bx = (b.x || 0) + (b.width || 120) / 2, by = (b.y || 0) + (b.height || 60) / 2;
      return ((ax - hx) * (ax - hx) + (ay - hy) * (ay - hy)) - ((bx - hx) * (bx - hx) + (by - hy) * (by - hy));
    });
    const ids = [hostId, kids[0].id];
    let best = cameraFitNodes(ids, 1.2);
    for (let i = 1; i < kids.length; i++) {
      const cand = cameraFitNodes(ids.concat([kids[i].id]), 1.2);
      if (!cand || cand.__sd < 0.7) break;
      ids.push(kids[i].id);
      best = cand;
    }
    if (best) animateCamera(best, 420);
  }

  // 退回：恢复该层展开前的相机检查点
  function drillOutOfHost(hostId, layer) {
    const key = hostId + ':' + layer;
    const cp = cameraAnim.checkpoints[key];
    if (!cp) return;
    delete cameraAnim.checkpoints[key];
    animateCamera(cp, 380);
  }

  // 报告面板/外部脚本用：相机飞到指定节点并选中（复用钻入的取景与补间曲线）
  function flyToNode(id) {
    if (!nodeById[id]) return;
    const fit = cameraFitNodes([id], 1.2);
    if (fit) animateCamera(fit, 520);
    selectNode(id);
  }

  // 调试/e2e 句柄（与 __DSL__ / __animV2__ 同级）：相机状态与钻入函数可编程访问
  window.__canvas__ = {
    canvasState: canvasState,
    cameraAnim: cameraAnim,
    state: state,
    animateCamera: animateCamera,
    drillIntoHost: drillIntoHost,
    drillOutOfHost: drillOutOfHost,
    flyToNode: flyToNode,
    openAnnoPanel: openAnnoPanel,
  };

  // 讲解导览外部控制：父页（/tour.html）通过 postMessage 让本画布定位高亮某节点。
  // 消息格式：{ source: 'dc-tour', action: 'fly', nodeId: '<id>' }
  window.addEventListener('message', function(ev) {
    const d = ev.data;
    if (!d || d.source !== 'dc-tour' || d.action !== 'fly') return;
    const id = d.nodeId;
    if (!id || !nodeById[id]) return;
    const overlay = document.getElementById('report-overlay');
    if (overlay) overlay.classList.add('hidden');
    flyToNode(id);
  });

  // ==== 多选工具栏 ====
  function setupMultiSelectBar() {
    const delBtn = document.getElementById('select-delete');
    const clearBtn = document.getElementById('select-clear');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (state.multiSelect.size === 0) return;
        if (!confirm('确定删除 ' + state.multiSelect.size + ' 个节点？')) return;
        pushUndo();
        state.multiSelect.forEach(id => {
          dsl.geometry.nodes = dsl.geometry.nodes.filter(n => n.id !== id);
          dsl.geometry.edges = (dsl.geometry.edges ?? []).filter(e => e.from !== id && e.to !== id);
          const el = document.querySelector('.node[data-id="' + id + '"]');
          if (el) el.remove();
        });
        state.multiSelect.clear();
        updateMultiSelectUI();
        saveLocal();
        markDirty();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearMultiSelect();
      });
    }
  }

  // ==== 报告导读面板（renderHTML options.report 注入时存在；无面板时静默跳过） ====
  function setupReportPanel() {
    const overlay = document.getElementById('report-overlay');
    if (!overlay) return;
    function closePanel() { overlay.classList.add('hidden'); }
    const closeBtn = document.getElementById('report-close');
    const startBtn = document.getElementById('report-start');
    const openBtn = document.getElementById('report-open');
    if (closeBtn) closeBtn.addEventListener('click', closePanel);
    if (startBtn) startBtn.addEventListener('click', closePanel);
    if (openBtn) openBtn.addEventListener('click', function() { overlay.classList.remove('hidden'); });
    // 点遮罩空白处关闭
    overlay.addEventListener('click', function(ev) { if (ev.target === overlay) closePanel(); });
    // 热点榜单 / 推荐路径：点击 → 关面板 + 相机飞到节点
    overlay.querySelectorAll('[data-fly]').forEach(function(el) {
      el.addEventListener('click', function() {
        const id = el.getAttribute('data-fly');
        closePanel();
        if (id) flyToNode(id);
      });
    });
  }

  // ==== 紧凑工具栏：⋯ 展开/收起编辑类按钮（撤销/布局等） ====
  function setupToolbarAdvanced() {
    const toggle = document.getElementById('advanced-toggle');
    const adv = document.getElementById('toolbar-advanced');
    if (!toggle || !adv) return;
    toggle.addEventListener('click', function() {
      adv.classList.toggle('hidden');
      toggle.classList.toggle('active');
    });
  }

  // ==== 布局按钮 ====
  function setupLayoutButtons() {
    const dagBtn = document.getElementById('layout-dag');
    const forceBtn = document.getElementById('layout-force');
    const gridBtn = document.getElementById('layout-grid');

    function applyLayout(type) {
      pushUndo();
      fetch('/api/layout/' + type, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: dsl.feature }),
      })
        .then(res => res.json())
        .then(data => {
          if (data.success) {
            // 与 undo/redo 同策略：全量刷新保证所有特性可靠重渲染
            location.reload();
          }
        })
        .catch(err => {
          console.error('Layout failed:', err);
        });
    }

    if (dagBtn) dagBtn.addEventListener('click', () => applyLayout('dag'));
    if (forceBtn) forceBtn.addEventListener('click', () => applyLayout('force'));
    if (gridBtn) gridBtn.addEventListener('click', () => applyLayout('grid'));
  }

  // ==== 主题切换 ====
  function setupThemeSwitcher() {
    const themes = ['dynamic', 'blue', 'sakura', 'forest', 'ocean', 'star'];
    themes.forEach(theme => {
      const btn = document.getElementById('theme-' + theme);
      if (btn) {
        btn.addEventListener('click', () => {
          document.body.setAttribute('data-theme', theme);
          dsl.theme = theme;
          themes.forEach(t => {
            const b = document.getElementById('theme-' + t);
            if (b) b.classList.toggle('active', t === theme);
          });
          saveLocal();
          saveToServer();
        });
      }
    });
  }

  // ==== 侧栏折叠抽屉：收起右侧面板让画布占满全宽（localStorage 记忆） ====
  function setupSidebarToggle() {
    const btn = document.getElementById('sidebar-toggle');
    const mainEl = document.querySelector('main');
    if (!btn || !mainEl) return;
    const icon = btn.querySelector('.sb-icon');
    const label = btn.querySelector('.sb-label');
    const KEY = 'dc-sidebar-hidden';
    let hidden = false;
    try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* ignore */ }
    const apply = (h) => {
      mainEl.classList.toggle('sidebar-hidden', h);
      if (icon) icon.textContent = h ? '▥' : '▤';
      if (label) {
        // 中性词：面板/展开，折叠状态用图标箭头区分，避免与 i18n 文案冲突
        label.textContent = h ? '展开' : '面板';
      }
      try { localStorage.setItem(KEY, h ? '1' : '0'); } catch { /* ignore */ }
    };
    btn.addEventListener('click', () => { hidden = !hidden; apply(hidden); });
    apply(hidden);
  }

  // ==== 多语言切换 ====
  function setupLanguage() {
    let lang = detectLang();
    const apply = () => applyStaticI18n(document, lang);
    // 首帧渲染完成后应用一次（HTML 静态标注为中文，需按 lingo 覆盖）
    requestAnimationFrame(apply);
    // 语言按钮：切换语言 → 存偏好 → 重译界面（绑定所有 [data-lang-btn]，含首屏悬浮与工具栏两处）
    const switchTo = (next) => {
      lang = next;
      try { localStorage.setItem('dc-lang', next); } catch { /* ignore */ }
      applyStaticI18n(document, next);
    };
    document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
      btn.addEventListener('click', () => switchTo(btn.getAttribute('data-lang-btn')));
    });
    // 暴露给 rerender 等外部逻辑复用
    window.__dcLang = { get: () => lang, apply };
  }

  // ==== 节点搜索 ====
  function setupNodeSearch() {
    const searchInput = document.getElementById('node-search');
    if (!searchInput) return;

    let searchTimeout = null;
    let semTimeout = null;
    searchInput.addEventListener('input', (e) => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => doSearch(e.target.value), 200);
      // 语义搜索 debounce 稍长：本地子串匹配即时，语义走网络等结果
      if (semTimeout) clearTimeout(semTimeout);
      semTimeout = setTimeout(() => runSemanticSearch(e.target.value), 350);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch(searchInput.value, true);
        runSemanticSearch(searchInput.value);
      } else if (e.key === 'Escape') {
        searchInput.value = '';
        doSearch('');
        clearSemanticResults();
        searchInput.blur();
      }
    });

    function doSearch(query, focusFirst) {
      const nodes = document.querySelectorAll('.node');
      query = (query || '').toLowerCase().trim();

      if (!query) {
        nodes.forEach(n => {
          n.classList.remove('search-match', 'search-dimmed');
        });
        return;
      }

      let firstMatch = null;
      nodes.forEach(n => {
        const id = n.getAttribute('data-id') || '';
        const labelEl = n.querySelector('.node-label');
        const label = (labelEl ? labelEl.textContent : '') || '';
        const labelText = label.toLowerCase();
        const idText = id.toLowerCase();

        if (labelText.includes(query) || idText.includes(query)) {
          n.classList.add('search-match');
          n.classList.remove('search-dimmed');
          if (!firstMatch) firstMatch = n;
        } else {
          n.classList.remove('search-match');
          n.classList.add('search-dimmed');
        }
      });

      if (firstMatch && focusFirst) {
        const id = firstMatch.getAttribute('data-id');
        const node = (dsl.geometry?.nodes || []).find(n => n.id === id);
        if (node) {
          const cx = (node.x || 0) + (node.width || 120) / 2;
          const cy = (node.y || 0) + (node.height || 60) / 2;
          const [ox, oy, ow, oh] = canvasState.origViewBox || [0, 0, 1200, 800];
          canvasState.panX = (cx - ox - ow / 2) * canvasState.scale;
          canvasState.panY = (cy - oy - oh / 2) * canvasState.scale;

          const svg = document.getElementById('canvas');
          if (svg) {
            const nw = ow / canvasState.scale;
            const nh = oh / canvasState.scale;
            const nx = ox + (ow - nw) / 2 - canvasState.panX;
            const ny = oy + (oh - nh) / 2 - canvasState.panY;
            svg.setAttribute('viewBox', nx + ' ' + ny + ' ' + nw + ' ' + nh);
          }
          selectNode(id);
        }
      }

      const count = firstMatch ? document.querySelectorAll('.node.search-match').length : 0;
      if (count === 0 && query) {
        showToast('未找到匹配的节点', 'info');
      }
    }

    // ---- 语义搜索结果 (序号8 S2)：调后端 → 映射 file_path → 画布节点 → 高亮 + 结果面板 ----
    // file_path → 节点 id 映射：优先 feature 的 semantic.files（authoritative），
    // 与 diff_impact 对齐；无 semantic 时回退 file_<rel> 字符串拼接。
    function semanticNodeId(filePath) {
      const semanticFiles = (dsl.semantic && dsl.semantic.files) || [];
      for (const f of semanticFiles) {
        if (f.path && (f.path === filePath)) return f.id;
      }
      // 去 src/ 前缀再比一次（feature 可能以 src/ 为根）
      const stripped = filePath.startsWith('src/') ? filePath.slice(4) : null;
      if (stripped) {
        for (const f of semanticFiles) {
          if (f.path && f.path === stripped) return f.id;
        }
      }
      // 无 semantic 匹配：回退 import_project 的 fileNodeId 规则
      return 'file_' + filePath.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function clearSemanticResults() {
      document.querySelectorAll('.node.semantic-hit').forEach(n => n.classList.remove('semantic-hit'));
      const old = document.getElementById('sem-panel');
      if (old) old.remove();
    }

    function runSemanticSearch(query) {
      clearSemanticResults();
      query = (query || '').trim();
      if (!query) return;
      // 非 serve 模式（file://）无法调后端，静默跳过（本地子串搜索已兜底）
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

      fetch('/api/semantic-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, limit: 8 }),
      })
        .then(r => r.json())
        .then((data) => {
          if (!data || !data.success || !data.hits || data.hits.length === 0) {
            if (data && data.hits && data.hits.length === 0) showToast('语义搜索无结果', 'info');
            return;
          }
          applySemanticResults(data);
        })
        .catch(() => { /* 网络失败静默，本地搜索已兜底 */ });
    }

    function applySemanticResults(data) {
      const hits = data.hits || [];
      const hitIds = [];
      hits.forEach(h => {
        const id = semanticNodeId(h.file_path);
        if (!id) return;
        hitIds.push({ id, score: h.score, name: h.qualified_name || h.name, file: h.file_path, line: h.start_line });
        const el = document.querySelector('.node[data-id="' + id + '"]');
        if (el) el.classList.add('semantic-hit');
      });

      // 结果面板
      let panel = document.getElementById('sem-panel');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'sem-panel';
        panel.className = 'sem-panel';
        document.body.appendChild(panel);
      }
      const rows = hitIds.map(h =>
        '<div class="sem-hit-row" data-id="' + h.id + '">' +
          '<span class="sem-score">' + h.score.toFixed(3) + '</span>' +
          '<b>' + escapeHtml(h.name) + '</b>' +
          '<div class="sem-file">' + escapeHtml(h.file) + (h.line ? ':' + h.line : '') + '</div>' +
        '</div>'
      ).join('');
      panel.innerHTML =
        '<div class="sem-panel-title">🔎 语义结果 (' + hits.length + ')<span class="sem-hint">' + escapeHtml(data.provider === 'semantic' ? '向量检索' : '降级全文') + '</span><span class="focus-close" id="sem-close">✕</span></div>' +
        rows;
      document.getElementById('sem-close').addEventListener('click', () => { clearSemanticResults(); });
      panel.querySelectorAll('.sem-hit-row').forEach(row => {
        row.addEventListener('click', () => {
          const id = row.getAttribute('data-id');
          if (id && nodeById[id]) flyToNode(id);
          else {
            const el = document.querySelector('.node[data-id="' + id + '"]');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      });
      if (hitIds.length > 0) showToast('语义搜索命中 ' + hitIds.length + ' 个节点');
    }
  }

  // ==== 键盘快捷键 ====
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // 在输入框中不触发快捷键
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      // Ctrl+Z → 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Ctrl+Y / Ctrl+Shift+Z → 重做
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      // Delete / Backspace → 删除选中的节点或边
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selectedId) {
          e.preventDefault();
          pushUndo();
          deleteSelected();
        }
      }

      // Ctrl+D → 复制选中节点
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        if (state.selectedId) {
          e.preventDefault();
          pushUndo();
          duplicateNode(state.selectedId);
        }
      }

      // Ctrl+0 → 重置缩放
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        const resetBtn = document.getElementById('zoom-reset');
        if (resetBtn) resetBtn.click();
      }

      // Ctrl+= / Ctrl++ → 放大
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        const zoomIn = document.getElementById('zoom-in');
        if (zoomIn) zoomIn.click();
      }

      // Ctrl+- → 缩小
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        const zoomOut = document.getElementById('zoom-out');
        if (zoomOut) zoomOut.click();
      }

      // Esc → 退出聚焦（筛选模式）
      if (e.key === 'Escape' && state.filter.focusId) {
        state.filter.focusId = null;
        applyFilters();
      }
    });
  }

  function deleteSelected() {
    const id = state.selectedId;
    if (!id) return;

    // 判断是节点还是边
    if (edgeById[id]) {
      // 删除边
      const edge = edgeById[id];
      const edgeEl = document.querySelector('.edge[data-id="' + id + '"]');
      if (edgeEl) edgeEl.remove();

      dsl.geometry.edges = (dsl.geometry.edges || []).filter(e => e.id !== id);
      delete edgeById[id];
      delete edgeElById[id];
      if (edgesByFrom[edge.from]) {
        edgesByFrom[edge.from] = edgesByFrom[edge.from].filter(e => e.id !== id);
        if (edgesByFrom[edge.from].length === 0) delete edgesByFrom[edge.from];
      }
      if (edgesByTo[edge.to]) {
        edgesByTo[edge.to] = edgesByTo[edge.to].filter(e => e.id !== id);
        if (edgesByTo[edge.to].length === 0) delete edgesByTo[edge.to];
      }

      showToast('已删除边: ' + edge.from + ' → ' + edge.to, 'success');
    } else if (nodeById[id]) {
      // 删除节点及其关联边
      const nodeEl = document.querySelector('.node[data-id="' + id + '"]');
      if (nodeEl) nodeEl.remove();

      const relatedEdges = [...(edgesByFrom[id] || []), ...(edgesByTo[id] || [])];
      relatedEdges.forEach(e => {
        const el = document.querySelector('.edge[data-id="' + e.id + '"]');
        if (el) el.remove();
        delete edgeById[e.id];
        delete edgeElById[e.id];
      });

      dsl.geometry.nodes = (dsl.geometry.nodes || []).filter(n => n.id !== id);
      dsl.geometry.edges = (dsl.geometry.edges || []).filter(e => e.from !== id && e.to !== id);
      delete nodeById[id];
      delete nodeElById[id];
      delete edgesByFrom[id];
      delete edgesByTo[id];

      const cardEl = document.querySelector('.card[data-id="' + id + '"]');
      if (cardEl) cardEl.remove();

      showToast('已删除节点: ' + id, 'success');
    }

    clearSelection();
    saveLocal();
    saveToServer();
  }

  function duplicateNode(nodeId) {
    const node = nodeById[nodeId];
    if (!node) return;

    const newId = nodeId + '_copy_' + Date.now().toString(36);
    const newNode = {
      ...node,
      id: newId,
      x: (node.x || 0) + 40,
      y: (node.y || 0) + 40,
      label: (node.label || node.id) + ' (copy)',
    };

    dsl.geometry.nodes = dsl.geometry.nodes || [];
    dsl.geometry.nodes.push(newNode);
    nodeById[newId] = newNode;

    const svg = document.getElementById('canvas');
    if (svg) {
      const ns = 'http://www.w3.org/2000/svg';
      const g = document.createElementNS(ns, 'g');
      g.setAttribute('class', 'node' + (newNode.status ? ' status-' + newNode.status : ''));
      g.setAttribute('data-id', newId);
      g.setAttribute('transform', 'translate(' + (newNode.x || 0) + ', ' + (newNode.y || 0) + ')');

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('width', newNode.width || 120);
      rect.setAttribute('height', newNode.height || 60);
      rect.setAttribute('rx', 8);
      g.appendChild(rect);

      const text = document.createElementNS(ns, 'text');
      text.setAttribute('class', 'node-label');
      text.setAttribute('x', (newNode.width || 120) / 2);
      text.setAttribute('y', (newNode.height || 60) / 2 + 5);
      text.setAttribute('text-anchor', 'middle');
      text.textContent = newNode.label || newId;
      g.appendChild(text);

      svg.appendChild(g);
      nodeElById[newId] = g;

      g.addEventListener('mouseenter', e => showTooltip(e, newId));
      g.addEventListener('mousemove', moveTooltip);
      g.addEventListener('mouseleave', hideTooltip);
      g.addEventListener('contextmenu', (e) => { e.preventDefault(); startConnect(g, e); });
      g.addEventListener('click', (e) => {
        if (state.selectedId === newId) clearSelection();
        else selectNode(newId);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const editor = document.getElementById('prop-editor');
        if (editor) {
          const idField = document.getElementById('editor-id');
          if (idField) {
            idField.value = newId;
            document.getElementById('editor-label').value = newNode.label || '';
            document.getElementById('editor-type').value = newNode.type || 'module';
            document.getElementById('editor-status').value = newNode.status || 'todo';
            document.getElementById('editor-description').value = newNode.description || '';
            editor.classList.remove('hidden');
            document.getElementById('editor-mask').classList.remove('hidden');
            document.getElementById('editor-label').focus();
          }
        }
      });

      // 拖拽
      g.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const rect = g.querySelector('rect');
        if (!rect) return;
        state.dragging = newId;
        state.dragOffset = {
          x: e.clientX - (parseFloat(g.getAttribute('transform').match(/translate\\(([^,]+)/)[1]) || 0),
          y: e.clientY - (parseFloat(g.getAttribute('transform').match(/,\\s*([^)]+)/)[1]) || 0),
        };
        g.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      });
    }

    selectNode(newId);
    showToast('已复制节点: ' + newId, 'success');
    saveLocal();
    saveToServer();
  }

  // ==== 点击空白取消选中 ====
  function setupCanvasClick() {
    const svg = document.getElementById('canvas');
    if (!svg) return;
    svg.addEventListener('click', (e) => {
      if (e.target === svg || e.target.tagName === 'svg') {
        clearSelection();
      }
    });
  }

  // ==== 导出按钮 ====
  function setupExport() {
    // 导出按钮 → design-canvas.json（固定文件名，LLM 可读取）
    const exportBtn = document.getElementById('export-json');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const json = JSON.stringify(window.__DSL__, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'design-canvas.json';  // 固定文件名
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('已导出 design-canvas.json', 'success');
      });
    }

    // 导入按钮
    const importBtn = document.getElementById('import-json');
    if (importBtn) {
      importBtn.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = (e) => {
          const file = (e.target).files[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = (ev) => {
            try {
              const data = JSON.parse(ev.target.result);
              // 验证基本结构
              if (!data.feature || !data.geometry) {
                showToast('无效的 DSL 文件', 'error');
                return;
              }
              window.__DSL__ = data;
              saveLocal();
              showToast('已导入 "' + data.feature + '"，刷新页面生效', 'success');
              setTimeout(() => location.reload(), 800);
            } catch (err) {
              showToast('解析失败: ' + err.message, 'error');
            }
          };
          reader.readAsText(file);
        };
        input.click();
      });
    }

    // 页面启动时：尝试 fetch 最新数据（如果通过 http serve）
    // 实际视图 → 拉取实际 DSL（/api/live，代码实时快照）；设计视图 → 拉取活态 design-canvas.json
    if (window.location.protocol !== 'file:') {
      const feature = (window.__DSL__ && window.__DSL__.feature) || '';
      const url = dcView === 'actual'
        ? '/api/live?feature=' + encodeURIComponent(feature)
        : 'design-canvas.json';
      fetch(url)
        .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
        .then(data => {
          if (data.feature && data.geometry && data._sync && data._sync.saved_at) {
            const inlineTime = window.__DSL__._sync && window.__DSL__._sync.saved_at;
            const fileTime = data._sync.saved_at;
            if (!inlineTime || fileTime > inlineTime) {
              window.__DSL__ = data;
              saveLocal();
              showToast(dcView === 'actual' ? '已加载实际 DSL（代码实时快照）' : '已同步最新 DSL（来自 design-canvas.json）', 'info');
            }
          }
        })
        .catch(() => {
          // 活态/实际文件不存在，使用内联 DSL
        });
    }
  }

  // ==== 重新渲染按钮 ====
  function setupRerender() {
    const rerender = document.getElementById('rerender');
    if (rerender) rerender.addEventListener('click', () => location.reload());
  }

  // ==== 键盘快捷键 ====
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clearSelection();
    });
  }

  // ==== 仿真器 ====
  function setupSimulation() {
    if (!dsl.simulation) return;
    const simDef = dsl.simulation;
    let state = {};
    for (const def of simDef.initial_state) {
      state[def.key] = JSON.parse(JSON.stringify(def.value));
    }
    // 暴露给外部 tooltip 与动画引擎（card_sync 等 state_change watcher）使用
    window.simState = state;
    let trace = [];
    let step = 0;

    function evalCond(condition, payload) {
      if (!condition) return true;
      try {
        var fn = new Function('state', 'payload', 'with(state) { return !!(' + condition + '); }');
        return fn(state, payload || {});
      } catch (e) { return false; }
    }

    function interpolate(template) {
      return template.replace(/\\$\\{(\\w+)\\}/g, function(_, key) {
        return state[key] !== undefined ? String(state[key]) : '';
      });
    }

    function mapStateToNodes() {
      var updates = [];
      if (!simDef.mappings) return updates;
      for (var i = 0; i < simDef.mappings.length; i++) {
        var m = simDef.mappings[i];
        var up = { id: m.nodeId };
        if (m.labelTemplate) up.label = interpolate(m.labelTemplate);
        if (m.styleMap) {
          for (var j = 0; j < m.styleMap.length; j++) {
            var c = m.styleMap[j];
            if (evalCond(c.when)) {
              up.style = up.style || {};
              Object.assign(up.style, c.style);
            }
          }
        }
        updates.push(up);
      }
      return updates;
    }

    function applyUpdates(updates) {
      for (var i = 0; i < updates.length; i++) {
        var up = updates[i];
        var node = document.querySelector('.node[data-id="' + up.id + '"]');
        if (!node) continue;
        if (up.label !== undefined) {
          var text = node.querySelector('text');
          if (text) text.textContent = up.label;
        }
        if (up.style) {
          var shape = node.querySelector('rect, circle, polygon');
          if (shape) {
            if (up.style.bg) { shape.setAttribute('fill', up.style.bg); shape.style.fill = ''; }
            if (up.style.color) node.querySelector('text').setAttribute('fill', up.style.color);
            if (up.style.border) { shape.setAttribute('stroke', up.style.border); shape.style.stroke = ''; }
            if (up.style.opacity !== undefined) shape.setAttribute('opacity', up.style.opacity);
          }
        }
        if (up.highlight) {
          // 如果节点被折叠隐藏，高亮传递到最近可见的祖先节点
          var targetNode = node;
          if (node.style.display === 'none') {
            for (var pid in parentOf) {
              var descendants = getAllDescendants(pid);
              if (descendants.indexOf(up.id) !== -1) {
                var parentEl = document.querySelector('.node[data-id="' + pid + '"]');
                if (parentEl && parentEl.style.display !== 'none') {
                  targetNode = parentEl;
                  break;
                }
              }
            }
          }
          targetNode.classList.add('anim-highlight');
          (function(n) { setTimeout(function() { n.classList.remove('anim-highlight'); }, 3000); })(targetNode);
        }
      }
    }

    function interpolateObj(obj) {
      var result = {};
      var dollarSign = '$';
      for (var k in obj) {
        var v = obj[k];
        if (typeof v === 'string') {
          var processed = v;
          if (v.indexOf(dollarSign + '{') !== -1) {
            var parts = v.split(dollarSign + '{');
            var rebuilt = parts[0];
            for (var i = 1; i < parts.length; i++) {
              var endBrace = parts[i].indexOf('}');
              if (endBrace === -1) {
                rebuilt += parts[i];
                continue;
              }
              var expr = parts[i].substring(0, endBrace);
              var value = '';
              try {
                value = String((new Function('state', 'with(state) { return ' + expr + '; }'))(state));
              } catch (e2) {
                value = state[expr] !== undefined ? String(state[expr]) : '';
              }
              rebuilt += value + parts[i].substring(endBrace + 1);
            }
            processed = rebuilt;
          }
          var hasMathFunc = processed.indexOf('Math.') !== -1;
          var hasPlus = processed.indexOf('+') !== -1;
          var hasMinus = processed.indexOf('-') !== -1;
          var hasStar = processed.indexOf('*') !== -1;
          var hasSlash = processed.indexOf('/') !== -1;
          if (hasMathFunc || hasPlus || hasMinus || hasStar || hasSlash) {
            try {
              result[k] = (new Function('state', 'with(state) { return ' + processed + '; }'))(state);
            } catch (e) {
              result[k] = processed;
            }
          } else {
            var numMatch = processed.match(/^(\\d+\\.?\\d*)$/);
            result[k] = numMatch ? Number(numMatch[1]) : processed;
          }
        } else {
          result[k] = v;
        }
      }
      return result;
    }

    function executeAction(action) {
      var updates = [];
      switch (action.type) {
        case 'set_state':
          if (action.target) {
            var dollarSign = '$';
            var hasTemplate = typeof action.value === 'string' && action.value.indexOf(dollarSign + '{') !== -1;
            var val;
            if (hasTemplate) {
              var expr = action.value.replace(new RegExp(dollarSign + '\\{(\\w+)\\}', 'g'), '$1');
              val = (new Function('state', 'with(state) { return ' + expr + '; }'))(state);
            } else {
              val = action.value;
            }
            state[action.target] = JSON.parse(JSON.stringify(val));
          }
          break;
        case 'increment':
          if (action.target) state[action.target] = (state[action.target] || 0) + (action.amount || 1);
          break;
        case 'decrement':
          if (action.target) state[action.target] = (state[action.target] || 0) - (action.amount || 1);
          break;
        case 'push':
          if (action.target) {
            var arr = state[action.target] || [];
            var val = typeof action.value === 'object' ? interpolateObj(action.value) : action.value;
            arr.push(JSON.parse(JSON.stringify(val)));
            state[action.target] = arr;
          }
          break;
        case 'pop':
          if (action.target) {
            var arr = state[action.target] || [];
            arr.pop();
            state[action.target] = arr;
          }
          break;
        case 'move':
          if (action.from && action.to && action.amount !== undefined) {
            state[action.from] = (state[action.from] || 0) - action.amount;
            state[action.to] = (state[action.to] || 0) + action.amount;
          }
          break;
        case 'highlight':
          if (action.target) updates.push({ id: action.target, highlight: true });
          break;
        case 'call':
          if (action.target === 'foldOldestSections') {
            var count = action.value || 4;
            var sections = state['sections'] || [];
            var folded = 0;
            for (var i = 0; i < sections.length; i++) {
              if (sections[i].status === 'active' && folded < count) {
                sections[i].status = 'folded';
                folded++;
              }
            }
          } else if (action.target === 'evictOldestSection') {
            var sections = state['sections'] || [];
            var toEvict = [];
            for (var i = 0; i < sections.length; i++) {
              if (sections[i].status === 'folded') {
                toEvict.push(i);
                break;
              }
            }
            for (var j = toEvict.length - 1; j >= 0; j--) {
              sections.splice(toEvict[j], 1);
            }
          }
          break;
      }
      updates.push.apply(updates, mapStateToNodes());
      return updates;
    }

    function recordTrace(event, rule, conditionMet, actions, emitted) {
      step++;
      trace.push({
        step: step,
        event: event,
        ruleId: rule.id,
        conditionMet: conditionMet,
        actions: actions.slice(),
        emittedEvents: emitted,
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
        stateSnapshot: JSON.parse(JSON.stringify(state))
      });
    }

    function processEvent(event, payload, depth) {
      depth = depth || 0;
      var allUpdates = [];
      // 通知动画 V2 事件触发器（根事件与级联事件统一在此通知一次）
      if (typeof window.__simEventListener__ === 'function') {
        try { window.__simEventListener__(event, payload); } catch(e) {}
      }
      for (var i = 0; i < simDef.rules.length; i++) {
        var rule = simDef.rules[i];
        if (rule.event !== event) continue;
        var met = evalCond(rule.condition, payload);
        if (!met) {
          recordTrace(event, rule, false, [], []);
          continue;
        }
        var ruleUpdates = [];
        for (var j = 0; j < rule.actions.length; j++) {
          var ups = executeAction(rule.actions[j]);
          ruleUpdates.push.apply(ruleUpdates, ups);
        }
        allUpdates.push.apply(allUpdates, ruleUpdates);
        var emitted = rule.emits || [];
        recordTrace(event, rule, true, rule.actions, emitted);
        // 通知动画引擎：规则触发 → sim-edge 粒子流
        if (typeof window.__simRuleFired__ === 'function') {
          try { window.__simRuleFired__(rule.id, event, depth); } catch(e) {}
        }
        for (var k = 0; k < emitted.length; k++) {
          var cascade = processEvent(emitted[k], payload, depth + 1);
          allUpdates.push.apply(allUpdates, cascade);
        }
      }
      return allUpdates;
    }

    function updateStateDisplay() {
      for (var key in state) {
        var el = document.getElementById('sim-val-' + key);
        if (el) {
          var val = state[key];
          var display;
          if (Array.isArray(val)) {
            var activeCount = val.filter ? val.filter(function(s) { return s.status === 'active'; }).length : 0;
            var tokenSum = val.reduce ? val.reduce(function(sum, s) { return sum + (s.tokens || 0); }, 0) : 0;
            display = '[' + val.length + ']';
            if (activeCount > 0 || tokenSum > 0) {
              display += ' active:' + activeCount;
              if (tokenSum > 0) display += ' tokens:' + tokenSum.toLocaleString();
            }
          } else if (typeof val === 'object') {
            display = '{...}';
          } else {
            display = String(val);
          }
          el.textContent = display;
        }
      }
    }

    function renderTrace() {
      var container = document.getElementById('sim-trace');
      if (!container) return;
      var html = '';
      var count = 0;
      for (var i = trace.length - 1; i >= 0; i--) {
        var t = trace[i];
        if (!t.conditionMet) continue;
        count++;
        var reason = '';
        if (t.event === 'threshold_check' && t.conditionMet) reason = ' 条件满足 → 触发';
        else if (t.emittedEvents.length > 0) reason = ' → 发射: ' + t.emittedEvents.join(', ');
        html += '<div class="sim-trace-item">' +
          '<span class="trace-event">#' + t.step + ' ' + t.event + '</span>' +
          '<span class="trace-rule"> [' + t.ruleId + ']</span>' +
          (reason ? '<span class="trace-reason">' + reason + '</span>' : '') +
          '</div>';
      }
      container.innerHTML = html || '<div style="color:var(--theme-text-dim);font-size:11px;">暂无触发记录</div>';
      if (count > 0) {
        container.scrollTop = 0;
      }
    }

    function handleEvent(event, payload) {
      var updates = processEvent(event, payload);
      applyUpdates(updates);
      updateStateDisplay();
      renderTrace();
      animateSimEdges(trace.slice().reverse());
      showToast('事件触发: ' + event + ' (' + updates.length + ' 更新)', 'success');
      saveLocal();
      saveToServer();
    }

    function animateSimEdges(traceList) {
      var activeRules = {};
      for (var i = 0; i < traceList.length; i++) {
        var t = traceList[i];
        if (t.conditionMet) {
          activeRules[t.ruleId] = true;
        }
      }
      var simEdges = document.querySelectorAll('.sim-edge');
      for (var j = 0; j < simEdges.length; j++) {
        var edge = simEdges[j];
        var ruleId = edge.getAttribute('data-rule');
        if (ruleId && activeRules[ruleId]) {
          edge.classList.add('active');
          (function(edgeEl) {
            setTimeout(function() { edgeEl.classList.remove('active'); }, 2500);
          })(edge);
        }
      }
    }

    // ==== 消息气泡粒子与卡片动画已由通用动画引擎接管（animation_engine.ts） ====
    // - sim-edge 粒子流：processEvent 通过 window.__simRuleFired__ 通知引擎
    // - 卡片同步：引擎 card_sync effect 轮询 window.simState.sections 快照对比

    // 绑定 UI 事件
    var sendBtn = document.getElementById('sim-send');
    var input = document.getElementById('sim-input');
    if (sendBtn && input) {
      sendBtn.addEventListener('click', function() {
        var text = input.value.trim();
        if (!text) return;
        handleEvent('user_input', { text: text });
        input.value = '';
      });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') sendBtn.click();
      });
    }

    var turnDoneBtn = document.getElementById('sim-turn-done');
    if (turnDoneBtn) {
      turnDoneBtn.addEventListener('click', function() {
        handleEvent('turn_done', {});
      });
    }

    var advanceBtn = document.getElementById('sim-advance');
    if (advanceBtn) {
      advanceBtn.addEventListener('click', function() {
        handleEvent('advance_conveyor', {});
      });
    }

    var resetBtn = document.getElementById('sim-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        state = {};
        for (var i = 0; i < simDef.initial_state.length; i++) {
          var def = simDef.initial_state[i];
          state[def.key] = JSON.parse(JSON.stringify(def.value));
        }
        trace = [];
        step = 0;
        var ups = mapStateToNodes();
        applyUpdates(ups);
        updateStateDisplay();
        renderTrace();
        // 清除高亮
        document.querySelectorAll('.anim-highlight').forEach(function(el) {
          el.classList.remove('anim-highlight');
        });
      });
    }

    var showEdgesCheckbox = document.getElementById('sim-show-edges');
    if (showEdgesCheckbox) {
      showEdgesCheckbox.addEventListener('change', function() {
        var simEdges = document.querySelectorAll('.sim-edge');
        for (var i = 0; i < simEdges.length; i++) {
          simEdges[i].style.display = this.checked ? '' : 'none';
        }
      });
    }

    // 初始映射
    var initUpdates = mapStateToNodes();
    applyUpdates(initUpdates);
    updateStateDisplay();
  }

  // ==== 初始化 ====
  setupEdgeData();
  setupCollapseButtons();
  setupLayerBadges();
  setupLayerControls();
  setupDataflow();
  setupDiffImpact();
  setupLayerViz();
  setupGuidedTour();
  setupSubDslButtons();
  hideContainsEdges();
  initCollapsedState();
  setupNodes();
  setupEdges();
  setupSimEdges();
  loadLanguageConcepts();
  loadDict();
  setupDictPanel();

  // 应用边控制点偏移：对所有节点触发一次边更新
  Object.keys(nodeById).forEach(function(nid) {
    updateConnectedEdges(nid);
  });

  setupCards();
  setupFlowAnimation();
  setupCanvasClick();
  setupCanvasZoomPan();
  setupLayoutButtons();
  setupMultiSelectBar();
  setupReportPanel();
  setupToolbarAdvanced();
  setupThemeSwitcher();
  setupSidebarToggle();
  setupLanguage();
  setupNodeSearch();
  setupFilters();
  setupViewSwitcher();
  setupDiffHighlight();
  setupFeatureCards();
  setupKeyboardShortcuts();
  setupExport();
  setupRerender();
  setupKeyboard();
  setupAnnotationTriggers();
  setupAnnoWall();
  setupAnnoBadgeClick();
  setupDecisionBadgeClick();
  setupNodeEditor();
  setupSimulation();

  // URL hash 直达：#fly=<node_id>（Hub 子页"在星图中定位"跳转；命中时跳过导读面板直接飞）
  (function() {
    const m = /[#&]fly=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    if (!nodeById[id]) return;
    const overlay = document.getElementById('report-overlay');
    if (overlay) overlay.classList.add('hidden');
    // 延迟到首帧布局后：初始化时 svg 像素尺寸未就绪，相机取景会算错 scale
    setTimeout(function() { flyToNode(id); }, 120);
  })();

  // 撤销/重做按钮
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.addEventListener('click', () => undo());
  if (redoBtn) redoBtn.addEventListener('click', () => redo());

  // 恢复 undo/redo 历史
  loadHistory();
  updateHistoryIndicator();

  // SSE 实时同步：监听 DSL 变更，自动刷新
  if (window.location.protocol !== 'file:') {
    try {
      var evtSource = new EventSource('/api/events');
      evtSource.addEventListener('dsl-changed', function(event) {
        try {
          var data = JSON.parse(event.data);
          // 只在来源不是自己（browser）时刷新，避免循环
          if (data.source !== 'browser') {
            // 延迟 300ms 避免频繁刷新
            clearTimeout(window.__sseReloadTimer);
            window.__sseReloadTimer = setTimeout(function() {
              // 保存当前 undo/redo 历史到 localStorage
              saveLocal();
              location.reload();
            }, 300);
          }
        } catch (e) {
          console.warn('SSE event parse failed', e);
        }
      });
      evtSource.onerror = function() {
        // 静默重连，EventSource 会自动重试
      };
    } catch (e) {
      console.warn('SSE not supported, real-time sync disabled');
    }
  }

  })();
`;
}
