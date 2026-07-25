import { EDGE_GEOM_SOURCE } from './edge_geom_bundle.gen.js';

export function buildScript(dsl: unknown): string {
  const dslJson = JSON.stringify(dsl).replace(/</g, '\\u003c');
  return `
/* __DSL_START__ */
window.__DSL__ = ${dslJson};
/* __DSL_END__ */

(function() {
  // ---- 边几何纯逻辑（构建期从 edge_geom.ts 内联，单源双消费，勿手改）----
${EDGE_GEOM_SOURCE}

  const tooltip = document.getElementById('tooltip');
  const dsl = window.__DSL__;

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

      const svg = document.getElementById('canvas');
      if (!svg) return;

      const svgRect = svg.getBoundingClientRect();
      const viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
      const scaleX = viewBox[2] / svgRect.width;
      const scaleY = viewBox[3] / svgRect.height;

      const mouseX = (e.clientX - svgRect.left) * scaleX;
      const mouseY = (e.clientY - svgRect.top) * scaleY;

      var pos = getNodePos(nodeEl);
      if (!pos) return;

      const nodeX = pos.x;
      const nodeY = pos.y;

      state.dragging = nodeId;
      state.dragOffset = { x: mouseX - nodeX, y: mouseY - nodeY };
      nodeEl.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      pushUndo();
    });
    nodeEl.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.stopPropagation();
      state.dragging = nodeId;
      const transform = nodeEl.getAttribute('transform') || '';
      const match = transform.match(/translate\\(([^,]+),\\s*([^)]+)\\)/);
      const cx = match ? parseFloat(match[1]) : 0;
      const cy = match ? parseFloat(match[2]) : 0;
      state.dragOffset = { x: e.clientX - cx, y: e.clientY - cy };
      nodeEl.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
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
      fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(window.__DSL__),
      })
        .then(r => r.json())
        .then(data => {
          if (data.success) {
            console.log('DSL 已同步到服务器');
          } else {
            console.warn('服务器保存失败:', data.error);
          }
        })
        .catch(() => {
          console.log('服务器不可用，仅保存到 localStorage');
        });
    }, 500);
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

  // 应用 localStorage 中的坐标（如果存在）
  function applyLocalOverrides() {
    const local = loadLocal();
    if (!local || !local.geometry || !local.geometry.nodes) return;
    const localById = {};
    local.geometry.nodes.forEach(n => { localById[n.id] = n; });

    // 覆盖内存中的节点坐标
    (dsl.geometry.nodes || []).forEach(n => {
      const localNode = localById[n.id];
      if (localNode && localNode.x !== undefined && localNode.y !== undefined) {
        n.x = localNode.x;
        n.y = localNode.y;
      }
    });

    // 合并本地新增的边
    if (local.geometry.edges) {
      const existingIds = new Set((dsl.geometry.edges || []).map(e => e.id));
      local.geometry.edges.forEach(e => {
        if (!existingIds.has(e.id)) {
          if (!dsl.geometry.edges) dsl.geometry.edges = [];
          dsl.geometry.edges.push(e);
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
        }
      });
    }
  }

  applyLocalOverrides();

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

  // 平铺式布局：默认展开所有子节点（不折叠）。
  // 仅当 localStorage 中存有用户手动折叠状态时，才恢复折叠。
  function initCollapsedState() {
    var restored = null;
    try {
      var collapsedKey = 'design-canvas-collapsed:' + (dsl.feature || 'unknown');
      var versionKey = 'design-canvas-collapsed-ver:' + (dsl.feature || 'unknown');
      // v2 = 平铺布局默认展开；清除 v1（旧的全折叠默认）的持久化状态
      if (localStorage.getItem(versionKey) !== '2') {
        localStorage.removeItem(collapsedKey);
        localStorage.setItem(versionKey, '2');
      } else {
        var raw = localStorage.getItem(collapsedKey);
        if (raw) restored = JSON.parse(raw);
      }
    } catch (e) { /* ignore */ }

    if (restored && Array.isArray(restored)) {
      // 恢复用户上次的折叠状态
      restored.forEach(function(pid) {
        if (!childrenOf[pid]) return;
        state.collapsed.add(pid);
        var nodeEl = document.querySelector('.node[data-id="' + pid + '"]');
        if (nodeEl) nodeEl.classList.add('collapsed');
        var descendants = getAllDescendants(pid);
        descendants.forEach(function(did) {
          var descEl = document.querySelector('.node[data-id="' + did + '"]');
          if (descEl) descEl.style.display = 'none';
        });
        document.querySelectorAll('.edge').forEach(function(edgeEl) {
          var from = edgeEl.getAttribute('data-from');
          var to = edgeEl.getAttribute('data-to');
          if (descendants.includes(from) && descendants.includes(to)) {
            edgeEl.style.display = 'none';
          }
        });
      });
    }
    // 无持久化状态时默认全部展开（平铺布局）
  }

  // ==== Tooltip ====
  function showTooltip(e, targetId) {
    const annos = annoByTarget[targetId] || [];
    const label = e.currentTarget.getAttribute('data-label') || '';
    let html = '';
    html += '<div style="font-weight:600;margin-bottom:4px;">' + escapeHtml(label || targetId) + '</div>';

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

    if (!annos.length && !getSimInfoForNode(targetId)) {
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
  }

  function selectNode(nodeId) {
    clearSelection();
    state.selectedId = nodeId;

    // 选中节点
    const nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (nodeEl) nodeEl.classList.add('selected');

    // 高亮相关边：入边 + 出边
    const relatedEdges = new Set();
    (edgesByFrom[nodeId] || []).forEach(e => relatedEdges.add(e.id));
    (edgesByTo[nodeId] || []).forEach(e => relatedEdges.add(e.id));

    const allEdgeIds = Object.keys(edgeById);
    allEdgeIds.forEach(eid => {
      const edgeEl = document.querySelector('.edge[data-id="' + eid + '"]');
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
      const nEl = document.querySelector('.node[data-id="' + nid + '"]');
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

  // ==== 折叠/展开 ====
  function toggleCollapse(nodeId) {
    const hasChildren = (childrenOf[nodeId] || []).length > 0;
    if (!hasChildren) return;

    const nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!nodeEl) return;

    const descendants = getAllDescendants(nodeId);
    const isCollapsed = state.collapsed.has(nodeId);

    if (isCollapsed) {
      // 展开（跳过职责分层判定为不可见的深层节点）
      state.collapsed.delete(nodeId);
      nodeEl.classList.remove('collapsed');
      descendants.forEach(did => {
        if (!isNodeVisible(did)) return;
        const descEl = document.querySelector('.node[data-id="' + did + '"]');
        if (descEl) {
          descEl.style.display = '';
          descEl.classList.add('node-enter');
          setTimeout(() => descEl.classList.remove('node-enter'), 300);
        }
      });
      // 显示相关边（但 contains 边始终隐藏；深层边跟随层可见性）
      document.querySelectorAll('.edge').forEach(edgeEl => {
        const edgeId = edgeEl.getAttribute('data-id');
        const from = edgeEl.getAttribute('data-from');
        const to = edgeEl.getAttribute('data-to');
        if ((descendants.includes(from) || descendants.includes(to)) && !isContainsEdge(edgeId)) {
          if (!isNodeVisible(from) || !isNodeVisible(to)) return;
          const el = edgeEl.getAttribute('data-layer') || 'main';
          if (el !== 'main' && !isLayerExpanded(el, edgeHostOf(from, to))) return;
          edgeEl.style.display = '';
        }
      });
    } else {
      // 折叠
      state.collapsed.add(nodeId);
      nodeEl.classList.add('collapsed');
      descendants.forEach(did => {
        const descEl = document.querySelector('.node[data-id="' + did + '"]');
        if (descEl) descEl.style.display = 'none';
      });
      // 隐藏相关边（两端都在后代中的边）
      document.querySelectorAll('.edge').forEach(edgeEl => {
        const from = edgeEl.getAttribute('data-from');
        const to = edgeEl.getAttribute('data-to');
        if (descendants.includes(from) && descendants.includes(to)) {
          edgeEl.style.display = 'none';
        }
      });
    }
    updateCanvasViewBox();
  }

  // 更新 SVG viewBox（折叠后可能高度变化）
  function updateCanvasViewBox() {
    const svg = document.getElementById('canvas');
    if (!svg) return;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    let maxY = 0;
    document.querySelectorAll('.node').forEach(n => {
      if (n.style.display === 'none') return;
      const rect = n.querySelector('rect');
      if (rect) {
        const y = parseFloat(rect.getAttribute('y')) + parseFloat(rect.getAttribute('height'));
        maxY = Math.max(maxY, y);
      }
    });
    if (maxY > 0 && maxY + 50 > vb[3]) {
      vb[3] = maxY + 50;
      svg.setAttribute('viewBox', vb.join(' '));
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
      const from = edgeEl.getAttribute('data-from');
      const to = edgeEl.getAttribute('data-to');
      const edgeLayer = edgeEl.getAttribute('data-layer') || 'main';
      let vis = edgeLayer === 'main' || isLayerExpanded(edgeLayer, edgeHostOf(from, to));
      if (vis && from && to) vis = domVisible(from) && domVisible(to);
      edgeEl.style.display = vis ? '' : 'none';
    });
    updateCanvasViewBox();
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
    if (state.expandedLayers.has(key)) state.expandedLayers.delete(key);
    else state.expandedLayers.add(key);
    updateBadgeStates();
    applyLayerVisibility();
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
    });
    if (detBtn) detBtn.addEventListener('click', () => {
      state.globalLayers.detail = !state.globalLayers.detail;
      detBtn.classList.toggle('active', state.globalLayers.detail);
      applyLayerVisibility();
    });
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
  }

  // ==== 标注系统（人审） ====
  function renderAnnotationPanel() {
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
    showToast('已添加标注', 'success');
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

    document.querySelectorAll('.node').forEach(nodeEl => {
      const id = nodeEl.getAttribute('data-id');
      nodeEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openEditor(id);
      });
    });
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

  function collectObstacles(excludeMap) {
    var obs = [];
    var els = document.querySelectorAll('.node');
    for (var i = 0; i < els.length; i++) {
      var id = els[i].getAttribute('data-id');
      if (excludeMap[id]) continue;
      var pos = getNodePos(els[i]);
      if (pos) obs.push({ x: pos.x, y: pos.y, w: pos.w, h: pos.h });
    }
    return obs;
  }

  // 辅助：获取节点位置（通过 data-shape 标记识别形状元素，兼容 rect/circle/polygon）
  function getNodePos(nodeEl) {
    var shapeEl = nodeEl.querySelector('[data-shape="true"]');
    if (!shapeEl) return null;
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

    nodeEl.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    pushUndo();
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

    const nodeEl = document.querySelector('.node[data-id="' + state.dragging + '"]');
    if (!nodeEl) return;

    var pos = getNodePos(nodeEl);
    if (!pos) return;

    const oldX = pos.x;
    const oldY = pos.y;
    const dx = newX - oldX;
    const dy = newY - oldY;

    // 移动节点本身（支持 rect/circle/polygon）
    _applyNodeDelta(nodeEl, dx, dy);

    // 拖动父节点时，所有后代跟随移动（contains 关系）
    const descendants = getAllDescendants(state.dragging);
    descendants.forEach(function(childId) {
      const childEl = document.querySelector('.node[data-id="' + childId + '"]');
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
    affectedNodeIds.forEach(function(nid) {
      updateConnectedEdges(nid);
    });

    // 更新 DSL 中父节点坐标
    const node = nodeById[state.dragging];
    if (node) {
      node.x = newX;
      node.y = newY;
    }

    // 如果被拖动的是子节点，自动调整父节点大小以容纳所有子节点
    if (parentOf[state.dragging]) {
      resizeParentToFitChildren(parentOf[state.dragging]);
    }
  }

  function resizeParentToFitChildren(parentId) {
    var parentEl = document.querySelector('.node[data-id="' + parentId + '"]');
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
      var childEl = document.querySelector('.node[data-id="' + children[i] + '"]');
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

    updateConnectedEdges(parentId);

    if (parentOf[parentId]) {
      resizeParentToFitChildren(parentOf[parentId]);
    }
  }

  function endDrag() {
    if (!state.dragging) return;

    const nodeEl = document.querySelector('.node[data-id="' + state.dragging + '"]');
    if (nodeEl) nodeEl.style.cursor = 'pointer';

    // 碰撞退避：同层级节点重叠时自动推开
    resolveOverlaps();

    state.dragging = null;
    document.body.style.userSelect = '';
    saveLocal();
    saveToServer();
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

  function updateConnectedEdges(nodeId) {
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
      var edgeEl = document.querySelector('.edge[data-id="' + e.id + '"]');
      if (!edgeEl) return;

      var fromNode = document.querySelector('.node[data-id="' + e.from + '"]');
      var toNode = document.querySelector('.node[data-id="' + e.to + '"]');
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
        obstacles: isContains ? undefined : collectObstacles(obstacleExcludeMap(e.from, e.to)),
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

      var fromNodeEl = document.querySelector('.node[data-id="' + fromId + '"]');
      var toNodeEl = document.querySelector('.node[data-id="' + toId + '"]');
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
        obstacles: collectObstacles(obstacleExcludeMap(fromId, toId)),
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

  // ==== 碰撞退避：检测重叠节点并自动推开 ====
  function resolveOverlaps() {
    var moved = true;
    var iterations = 0;
    var maxIter = 8;
    var gap = 12;

    var allNodes = [];
    (dsl.geometry?.nodes || []).forEach(function(n) { allNodes.push(n); });
    if (nodeById['msg_flow_node']) {
      var mn = nodeById['msg_flow_node'];
      if (allNodes.every(function(n) { return n.id !== 'msg_flow_node'; })) {
        allNodes.push(mn);
      }
    }

    while (moved && iterations < maxIter) {
      moved = false;
      iterations++;

      for (var i = 0; i < allNodes.length; i++) {
        var a = allNodes[i];
        var aEl = document.querySelector('.node[data-id="' + a.id + '"]');
        if (!aEl) continue;
        var aPos = getNodePos(aEl);
        if (!aPos) continue;
        var ax = aPos.x, ay = aPos.y, aw = aPos.w, ah = aPos.h;

        for (var j = i + 1; j < allNodes.length; j++) {
          var b = allNodes[j];
          var aParent = parentOf[a.id];
          var bParent = parentOf[b.id];
          if (aParent !== bParent) continue;

          var bEl = document.querySelector('.node[data-id="' + b.id + '"]');
          if (!bEl) continue;
          var bPos = getNodePos(bEl);
          if (!bPos) continue;
          var bx = bPos.x, by = bPos.y, bw = bPos.w, bh = bPos.h;

          var overlapX = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
          var overlapY = Math.min(ay + ah, by + bh) - Math.max(ay, by);
          if (overlapX <= 0 || overlapY <= 0) continue;

          var pushX = 0, pushY = 0;
          if (overlapX < overlapY) {
            pushX = (overlapX + gap) / 2;
            if (ax < bx) pushX = -pushX;
          } else {
            pushY = (overlapY + gap) / 2;
            if (ay < by) pushY = -pushY;
          }

          moveNodeBy(a.id, pushX / 2, pushY / 2);
          moveNodeBy(b.id, -pushX / 2, -pushY / 2);
          ax += pushX / 2;
          ay += pushY / 2;
          moved = true;
        }
      }
    }

    Object.keys(nodeById).forEach(function(nid) {
      updateConnectedEdges(nid);
    });
  }

  // 按偏移量移动节点（支持所有形状）+ 后代跟随 + 更新相关边
  function moveNodeBy(nodeId, dx, dy) {
    if (dx === 0 && dy === 0) return;
    var nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
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
      var childEl = document.querySelector('.node[data-id="' + did + '"]');
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
    document.querySelectorAll('.node').forEach(nodeEl => {
      const id = nodeEl.getAttribute('data-id');

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
      if (label) label.textContent = Math.round(canvasState.scale * 100) + '%';
    }

    function setScale(newScale, centerX, centerY) {
      newScale = Math.max(0.2, Math.min(5, newScale));
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
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
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
    if (zoomReset) zoomReset.addEventListener('click', () => {
      canvasState.scale = 1;
      canvasState.panX = 0;
      canvasState.panY = 0;
      updateViewBox();
    });
    if (zoomFit) zoomFit.addEventListener('click', () => {
      const nodes = dsl.geometry?.nodes || [];
      if (nodes.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let visibleCount = 0;
      nodes.forEach(n => {
        // 跳过不可见节点（深层折叠 / collapse 折叠），避免幽灵占位撑大画布
        const el = document.querySelector('.node[data-id="' + n.id + '"]');
        if (el && el.style.display === 'none') return;
        visibleCount++;
        const x = n.x || 0, y = n.y || 0;
        const w = n.width || 120, h = n.height || 60;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      });
      if (visibleCount === 0) return;
      const padding = 50;
      const fw = maxX - minX + padding * 2;
      const fh = maxY - minY + padding * 2;
      const [ox, oy, ow, oh] = origViewBox;
      canvasState.scale = Math.min(ow / fw, oh / fh, 2);
      canvasState.panX = (minX - padding - ox) * canvasState.scale;
      canvasState.panY = (minY - padding - oy) * canvasState.scale;
      updateViewBox();
    });

    updateZoomLabel();
  }

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
            loadDSL();
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
    const themes = ['blue', 'sakura', 'forest', 'ocean'];
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

  // ==== 节点搜索 ====
  function setupNodeSearch() {
    const searchInput = document.getElementById('node-search');
    if (!searchInput) return;

    let searchTimeout = null;
    searchInput.addEventListener('input', (e) => {
      if (searchTimeout) clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => doSearch(e.target.value), 200);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doSearch(searchInput.value, true);
      } else if (e.key === 'Escape') {
        searchInput.value = '';
        doSearch('');
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
      });

      dsl.geometry.nodes = (dsl.geometry.nodes || []).filter(n => n.id !== id);
      dsl.geometry.edges = (dsl.geometry.edges || []).filter(e => e.from !== id && e.to !== id);
      delete nodeById[id];
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

    // 页面启动时：尝试 fetch 同目录的 design-canvas.json（如果通过 http serve）
    if (window.location.protocol !== 'file:') {
      fetch('design-canvas.json')
        .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
        .then(data => {
          if (data.feature && data.geometry && data._sync && data._sync.saved_at) {
            const inlineTime = window.__DSL__._sync && window.__DSL__._sync.saved_at;
            const fileTime = data._sync.saved_at;
            if (!inlineTime || fileTime > inlineTime) {
              window.__DSL__ = data;
              saveLocal();
              showToast('已同步最新 DSL（来自 design-canvas.json）', 'info');
            }
          }
        })
        .catch(() => {
          // 活态文件不存在，使用内联 DSL
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

  // ==== 动画播放器 ====
  const animState = {
    animations: dsl.animations || [],
    currentAnimIndex: -1,
    currentStageIndex: -1,
    isPlaying: false,
    speed: 1,
    timer: null,
  };

  function initAnimationPlayer() {
    if (animState.animations.length === 0) return;

    const panel = document.getElementById('anim-panel');
    if (panel) panel.classList.remove('hidden');

    const select = document.getElementById('anim-select');
    if (select) {
      select.innerHTML = '';
      animState.animations.forEach((anim, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = anim.name || anim.id;
        select.appendChild(opt);
      });
      select.addEventListener('change', (e) => {
        loadAnimation(parseInt(e.target.value));
      });
    }

    const playBtn = document.getElementById('anim-play');
    const prevBtn = document.getElementById('anim-prev');
    const nextBtn = document.getElementById('anim-next');
    const speedInput = document.getElementById('anim-speed');
    const progressBar = document.getElementById('anim-progress-bar');

    if (playBtn) playBtn.addEventListener('click', togglePlay);
    if (prevBtn) prevBtn.addEventListener('click', stepBackward);
    if (nextBtn) nextBtn.addEventListener('click', stepForward);
    if (speedInput) {
      speedInput.addEventListener('input', (e) => {
        animState.speed = parseFloat(e.target.value);
        const label = document.getElementById('anim-speed-label');
        if (label) label.textContent = animState.speed + '\u00d7';
      });
    }
    if (progressBar) {
      progressBar.addEventListener('click', (e) => {
        const anim = animState.animations[animState.currentAnimIndex];
        if (!anim || anim.stages.length === 0) return;
        const rect = progressBar.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const stageIdx = Math.min(anim.stages.length - 1, Math.max(0, Math.floor(ratio * anim.stages.length)));
        goToStage(stageIdx);
      });
    }

    // 记录节点初始位置，用于动画位移
    document.querySelectorAll('.node').forEach(el => {
      const rect = el.querySelector('rect');
      if (rect) {
        el.dataset.baseX = rect.getAttribute('x') || '0';
        el.dataset.baseY = rect.getAttribute('y') || '0';
      }
    });

    loadAnimation(0);
  }

  function loadAnimation(index) {
    if (index < 0 || index >= animState.animations.length) return;
    animState.currentAnimIndex = index;
    animState.currentStageIndex = -1;
    animState.isPlaying = false;
    resetAllAnimations();

    document.querySelectorAll('.node').forEach(el => el.classList.add('anim-transition'));
    updateAnimUI();
  }

  function resetAllAnimations() {
    document.querySelectorAll('.node').forEach(el => {
      el.classList.remove('anim-hidden', 'anim-highlight', 'anim-pulse', 'anim-threshold', 'anim-transition');
      el.style.opacity = '';
      el.style.transform = '';
    });
  }

  function applyElementState(nodeEl, s) {
    if (!nodeEl) return;

    // visible
    if (s.visible === false) {
      nodeEl.classList.add('anim-hidden');
    } else if (s.visible === true) {
      nodeEl.classList.remove('anim-hidden');
    }

    // highlight
    if (s.highlight === true) {
      nodeEl.classList.add('anim-highlight');
    } else if (s.highlight === false) {
      nodeEl.classList.remove('anim-highlight');
    }

    // opacity
    if (s.opacity !== undefined) {
      nodeEl.style.opacity = s.opacity;
    }

    // label
    if (s.label !== undefined) {
      const text = nodeEl.querySelector('text');
      if (text) text.textContent = s.label;
    }

    // status
    if (s.status !== undefined) {
      nodeEl.classList.remove('status-draft', 'status-in-progress', 'status-done', 'status-todo', 'status-doing', 'status-blocked');
      if (s.status) nodeEl.classList.add('status-' + s.status.replace(/_/g, '-'));
    }

    // position (absolute coordinates → translate offset)
    if (s.x !== undefined || s.y !== undefined) {
      const baseX = parseFloat(nodeEl.dataset.baseX || '0');
      const baseY = parseFloat(nodeEl.dataset.baseY || '0');
      const newX = s.x !== undefined ? s.x : baseX;
      const newY = s.y !== undefined ? s.y : baseY;
      nodeEl.style.transform = 'translate(' + (newX - baseX) + 'px, ' + (newY - baseY) + 'px)';
    }

    // size (optional: update rect width/height)
    if (s.width !== undefined || s.height !== undefined) {
      const rect = nodeEl.querySelector('rect');
      if (rect) {
        if (s.width !== undefined) rect.setAttribute('width', s.width);
        if (s.height !== undefined) rect.setAttribute('height', s.height);
      }
    }

    // style overrides (bg only for now)
    if (s.style) {
      const shapeEl = nodeEl.querySelector('rect, circle, polygon');
      if (shapeEl && s.style.bg) shapeEl.setAttribute('fill', s.style.bg);
    }
  }

  function applyStage(stageIndex) {
    const anim = animState.animations[animState.currentAnimIndex];
    if (!anim) return;
    const stage = anim.stages[stageIndex];
    if (!stage) return;

    stage.elements.forEach(s => {
      const nodeEl = document.querySelector('.node[data-id="' + s.id + '"]');
      if (!nodeEl) return;
      applyElementState(nodeEl, s);
    });

    // threshold / pulse effect
    if (stage.name && (/阈值|PulseEvict|触发|threshold|evict/i).test(stage.name)) {
      stage.elements.forEach(s => {
        const nodeEl = document.querySelector('.node[data-id="' + s.id + '"]');
        if (nodeEl) {
          nodeEl.classList.remove('anim-threshold');
          void nodeEl.offsetWidth;
          nodeEl.classList.add('anim-threshold');
        }
      });
    }
  }

  function goToStage(index) {
    const anim = animState.animations[animState.currentAnimIndex];
    if (!anim || index < 0 || index >= anim.stages.length) return;

    if (index < animState.currentStageIndex) {
      resetAllAnimations();
      document.querySelectorAll('.node').forEach(el => el.classList.add('anim-transition'));
      for (let i = 0; i <= index; i++) {
        applyStage(i);
      }
    } else {
      applyStage(index);
    }

    animState.currentStageIndex = index;
    updateAnimUI();
  }

  function stepForward() {
    const anim = animState.animations[animState.currentAnimIndex];
    if (!anim) return;
    if (animState.currentStageIndex < anim.stages.length - 1) {
      goToStage(animState.currentStageIndex + 1);
    } else {
      pause();
    }
  }

  function stepBackward() {
    if (animState.currentStageIndex > 0) {
      goToStage(animState.currentStageIndex - 1);
    }
  }

  function togglePlay() {
    if (animState.isPlaying) {
      pause();
    } else {
      play();
    }
  }

  function play() {
    animState.isPlaying = true;
    const btn = document.getElementById('anim-play');
    if (btn) btn.textContent = '\u23f8';

    const anim = animState.animations[animState.currentAnimIndex];
    if (!anim) return;

    if (animState.currentStageIndex >= anim.stages.length - 1) {
      resetAllAnimations();
      document.querySelectorAll('.node').forEach(el => el.classList.add('anim-transition'));
      animState.currentStageIndex = -1;
    }

    function tick() {
      if (!animState.isPlaying) return;
      stepForward();
      const stage = anim.stages[animState.currentStageIndex];
      const duration = (stage && stage.duration) ? stage.duration : 600;
      animState.timer = setTimeout(tick, duration / animState.speed);
    }
    tick();
  }

  function pause() {
    animState.isPlaying = false;
    if (animState.timer) {
      clearTimeout(animState.timer);
      animState.timer = null;
    }
    const btn = document.getElementById('anim-play');
    if (btn) btn.textContent = '\u25b6';
  }

  function updateAnimUI() {
    const anim = animState.animations[animState.currentAnimIndex];
    const stage = anim ? anim.stages[animState.currentStageIndex] : null;

    const info = document.getElementById('anim-stage-info');
    if (info) info.textContent = (animState.currentStageIndex + 1) + ' / ' + (anim ? anim.stages.length : 0);

    const nameEl = document.getElementById('anim-stage-name');
    if (nameEl) nameEl.textContent = stage ? stage.name : '-';

    const fill = document.getElementById('anim-progress-fill');
    if (fill) {
      const progress = anim && anim.stages.length > 0 ? ((animState.currentStageIndex + 1) / anim.stages.length * 100) : 0;
      fill.style.width = progress + '%';
    }
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
  setupSubDslButtons();
  hideContainsEdges();
  initCollapsedState();
  setupNodes();
  setupEdges();
  setupSimEdges();

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
  setupThemeSwitcher();
  setupNodeSearch();
  setupKeyboardShortcuts();
  setupExport();
  setupRerender();
  setupKeyboard();
  setupAnnotationTriggers();
  setupNodeEditor();
  setupSimulation();

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

  initAnimationPlayer();
})();
`;
}
