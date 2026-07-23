/**
 * AnimationEngine V2 — 通用动画执行器（分层精度 L0-L5）
 *
 * 设计原则（详见 docs/animation-design.md）：
 * - L0-L1 零成本：无 animations_v2 字段时，从 geometry/semantic 自动推导默认动画
 * - L2+ 显式声明：有 animations_v2.flows 时，显式 flow 覆盖同路径默认粒子流
 * - 不硬编码项目特定 ID：通过 effect 注册表扩展
 * - 与 simulation 联动：监听仿真器规则触发（__simRuleFired__）→ sim-edge 粒子流
 * - 内置 effect：card_create / card_fold / card_evict / card_sync（状态数组全量同步）
 * - 粒子到达终点可转为可拖拽 chip 容器（on_arrive: 'chip'）
 *
 * 本模块导出 buildAnimationScript(dsl) → 浏览器端 JS 字符串
 * 由 html_renderer.ts 拼接为独立 <script> 块注入
 */

import type { DesignDSL } from '../dsl/types.js';
import { ANIM_CORE_SOURCE } from './anim_core_bundle.gen.js';

/**
 * 生成浏览器端动画执行器 JS 代码
 * 作为独立 <script> 注入，通过 window.__animV2__ 暴露接口
 */
export function buildAnimationScript(dsl: DesignDSL): string {
  const hasAnimationsV2 = !!dsl.animations_v2;
  const flowsJson = JSON.stringify(dsl.animations_v2?.flows ?? []);
  const runtimeRaw = (dsl.animations_v2?.runtime ?? {}) as Record<string, unknown>;
  const simParticlesRaw = (runtimeRaw.sim_particles ?? {}) as Record<string, unknown>;
  const simParticleCfg = {
    on_arrive: simParticlesRaw.on_arrive === 'chip' ? 'chip' : 'fade',
    label: simParticlesRaw.label === 'rule' ? 'rule' : 'event',
  };

  // 提取 geometry 中的 edges 用于 L0 默认粒子流推导
  const edges = dsl.geometry.edges ?? [];
  const nodes = dsl.geometry.nodes;

  // L0 默认流：为每条非 sim-edge 的普通 edge 生成默认粒子流配置
  const defaultFlows: DefaultFlowConfig[] = [];
  for (const edge of edges) {
    // sim-edge 由仿真器触发，不在此处生成默认流
    if (edge.id.startsWith('sim-edge')) continue;
    // contains 边通常不表示数据流，跳过
    if (edge.label === 'contains') continue;
    defaultFlows.push({
      id: `default_flow_${edge.id}`,
      from: edge.from,
      to: edge.to,
      interval: 4000,
      color: edge.style?.stroke ?? '#4fc3f7',
      edgeId: edge.id,
    });
  }

  // 仿真规则（用于 sim-edge 粒子流：规则触发时沿对应 sim-edge 发送粒子）
  const simRules = (dsl.simulation?.rules ?? [])
    .filter((r) => r.from_node && r.to_nodes && r.to_nodes.length > 0)
    .map((r) => ({ id: r.id, name: r.name ?? r.event, event: r.event }));

  // L1 默认状态高亮：提取所有有 status 的节点
  const statusNodes = nodes
    .filter((n) => n.status)
    .map((n) => ({ id: n.id, status: n.status as string }));

  const defaultFlowsJson = JSON.stringify(defaultFlows);
  const statusNodesJson = JSON.stringify(statusNodes);
  const simRulesJson = JSON.stringify(simRules);
  const simParticleCfgJson = JSON.stringify(simParticleCfg);

  return `
// ========== Animation Engine V2 (L0-L5) ==========
(function() {
  'use strict';

  // ---- AnimCore 纯逻辑（构建期从 anim_core.ts 内联，单源双消费，勿手改）----
${ANIM_CORE_SOURCE}

  var ANIM_VERSION = 2;
  var HAS_EXPLICIT_FLOWS = ${hasAnimationsV2};
  var EXPLICIT_FLOWS = ${flowsJson};
  var SIM_RULES = ${simRulesJson};
  var SIM_PARTICLE_CFG = ${simParticleCfgJson};
  var DEFAULT_FLOWS = ${defaultFlowsJson};
  var STATUS_NODES = ${statusNodesJson};

  // ---- Effect 注册表 ----
  // 约定 effect 函数签名：function(ctx) {}
  // ctx 包含：flow（流配置）、value（数据值对象）、targetNodeId（flow.to）
  // effect 返回 true 表示已处理（不再触发默认粒子），返回 false/undefined 走默认
  var EffectRegistry = {
    _effects: {},
    register: function(name, fn) { this._effects[name] = fn; },
    get: function(name) { return this._effects[name]; },
    has: function(name) { return !!this._effects[name]; }
  };

  // ---- 卡片通用样式常量 ----
  var CARD_STYLE = {
    activeH: 50,
    foldedH: 26,
    padX: 8,
    padY: 6,
    gap: 4,
    activeFill: '#1e3a5f',
    foldedFill: '#2d2d5a',
    activeStroke: '#3a5a8a',
    foldedStroke: '#5a4a8a',
    titleColor: '#ffffff',
    foldedTitleColor: '#b39ddb',
    bodyColor: '#8b9bb4'
  };

  // flow.layout 覆盖默认卡片布局
  function getCardLayout(flow) {
    var o = (flow && flow.rawFlow && flow.rawFlow.layout) || {};
    return {
      padX: o.padX != null ? o.padX : CARD_STYLE.padX,
      padY: o.padY != null ? o.padY : CARD_STYLE.padY,
      gap: o.gap != null ? o.gap : CARD_STYLE.gap,
      activeH: o.activeH != null ? o.activeH : CARD_STYLE.activeH,
      foldedH: o.foldedH != null ? o.foldedH : CARD_STYLE.foldedH
    };
  }

  // ---- 状态管理 ----
  var state = {
    activeParticles: [],
    chips: [],
    animFrame: null,
    paused: false,
    stepMode: false,
    flowTimers: {},
    prevStatusSnapshot: {},
    started: false
  };

  // ---- 工具函数 ----
  function getSvgCanvas() {
    return document.getElementById('canvas');
  }

  function ensureAnimLayer() {
    var svg = getSvgCanvas();
    if (!svg) return null;
    var layer = svg.querySelector('#anim-layer-v2');
    if (!layer) {
      layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      layer.setAttribute('id', 'anim-layer-v2');
      layer.setAttribute('class', 'anim-layer-v2');
      layer.style.pointerEvents = 'none';
      svg.appendChild(layer);
    }
    return layer;
  }

  function getNodeRect(nodeId) {
    var el = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!el) return null;
    var r = el.querySelector('rect[data-shape="true"], circle[data-shape="true"], polygon[data-shape="true"]');
    if (!r) return null;
    if (r.tagName === 'rect') {
      return {
        x: parseFloat(r.getAttribute('x')) || 0,
        y: parseFloat(r.getAttribute('y')) || 0,
        w: parseFloat(r.getAttribute('width')) || 120,
        h: parseFloat(r.getAttribute('height')) || 60
      };
    } else if (r.tagName === 'circle') {
      var cx = parseFloat(r.getAttribute('cx')) || 0;
      var cy = parseFloat(r.getAttribute('cy')) || 0;
      var rad = parseFloat(r.getAttribute('r')) || 30;
      return { x: cx - rad, y: cy - rad, w: rad * 2, h: rad * 2 };
    } else {
      var bb = r.getBBox();
      return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
    }
  }

  function getNodeCenter(nodeId) {
    var r = getNodeRect(nodeId);
    if (!r) return null;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  function intersectRect(from, to, rect) {
    var cx = rect.x + rect.w / 2;
    var cy = rect.y + rect.h / 2;
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    var halfW = rect.w / 2;
    var halfH = rect.h / 2;
    var tX = dx === 0 ? Infinity : halfW / Math.abs(dx);
    var tY = dy === 0 ? Infinity : halfH / Math.abs(dy);
    var t = Math.min(tX, tY);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function fadeOutEl(el) {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 300);
  }

  // ---- 通用节点高亮（L3 判断处闪烁 / L4.5 异常警报共用） ----
  // 直接操作 shape 属性，不依赖 CSS 类；连续调用时清除旧定时器避免状态残留
  function flashNode(nodeId, color, duration) {
    var el = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!el) return;
    var shape = el.querySelector('[data-shape="true"]');
    if (!shape) return;
    if (el.__flashTimer) {
      clearTimeout(el.__flashTimer);
      el.__flashTimer = null;
    }
    if (el.__flashOrig == null) {
      el.__flashOrig = {
        stroke: shape.getAttribute('stroke'),
        width: shape.getAttribute('stroke-width')
      };
    }
    shape.setAttribute('stroke', color || '#ffeb3b');
    shape.setAttribute('stroke-width', '3');
    el.__flashTimer = setTimeout(function() {
      var orig = el.__flashOrig || {};
      shape.setAttribute('stroke', orig.stroke || '#1f2a4d');
      shape.setAttribute('stroke-width', orig.width || '1');
      el.__flashTimer = null;
      el.__flashOrig = null;
    }, duration || 600);
  }

  // L3 分支调色板：按命中分支索引取色（branch.effect 显式指定时优先）
  var BRANCH_PALETTE = ['#4CAF50', '#e94560', '#FF9800', '#9b59b6', '#4fc3f7', '#ffeb3b'];

  function branchColor(branch, index) {
    if (branch && branch.effect === 'particle_red') return '#e94560';
    if (branch && branch.effect === 'particle_green') return '#4CAF50';
    return BRANCH_PALETTE[(index || 0) % BRANCH_PALETTE.length];
  }

  // ========== 卡片系统（card_* effects 共用） ==========

  // 为容器节点创建/更新 clipPath（防止卡片滑出节点边界）
  function ensureCardClip(nodeId) {
    var clipId = 'card-clip-' + nodeId;
    var nodeRect = getNodeRect(nodeId);
    if (!nodeRect) return clipId;
    var svg = getSvgCanvas();
    if (!svg) return clipId;
    var ns = 'http://www.w3.org/2000/svg';
    var defs = svg.querySelector('defs');
    if (!defs) {
      defs = document.createElementNS(ns, 'defs');
      svg.insertBefore(defs, svg.firstChild);
    }
    var old = document.getElementById(clipId);
    if (old) old.remove();
    var clip = document.createElementNS(ns, 'clipPath');
    clip.setAttribute('id', clipId);
    var clipRect = document.createElementNS(ns, 'rect');
    clipRect.setAttribute('x', nodeRect.x);
    clipRect.setAttribute('y', nodeRect.y);
    clipRect.setAttribute('width', nodeRect.w);
    clipRect.setAttribute('height', nodeRect.h);
    clip.appendChild(clipRect);
    defs.appendChild(clip);
    return clipId;
  }

  // 获取/创建卡片容器（flow.to 指向的节点内的 <g data-card-container>）
  function ensureCardContainer(nodeId) {
    var nodeEl = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!nodeEl) return null;
    var container = nodeEl.querySelector('[data-card-container="true"]');
    if (!container) {
      var ns = 'http://www.w3.org/2000/svg';
      container = document.createElementNS(ns, 'g');
      container.setAttribute('data-card-container', 'true');
      container.setAttribute('class', 'card-container-v2');
      nodeEl.appendChild(container);
    }
    return container;
  }

  // 容器标题（可选，flow.title_template 驱动）
  function ensureContainerTitle(container, nodeRect) {
    var title = container.querySelector('.container-title');
    if (!title) {
      var ns = 'http://www.w3.org/2000/svg';
      title = document.createElementNS(ns, 'text');
      title.setAttribute('class', 'container-title');
      title.setAttribute('fill', '#7aa0c4');
      title.setAttribute('font-size', '10');
      title.setAttribute('font-weight', '600');
      container.appendChild(title);
    }
    title.setAttribute('x', nodeRect.x + 10);
    title.setAttribute('y', nodeRect.y + 16);
    return title;
  }

  function renderTitleTemplate(template, data) {
    var active = 0, folded = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i] && data[i].status === 'folded') folded++;
      else active++;
    }
    return template
      .replace(/\\$\\{active\\}/g, String(active))
      .replace(/\\$\\{folded\\}/g, String(folded))
      .replace(/\\$\\{total\\}/g, String(data.length));
  }

  // 定位单张卡片（rect + 内部文字）
  function positionCard(g, nodeRect, layout, y, h) {
    var cardX = nodeRect.x + layout.padX;
    var cardW = nodeRect.w - layout.padX * 2;
    var rect = g.querySelector('rect');
    if (rect) {
      rect.setAttribute('x', cardX);
      rect.setAttribute('y', y);
      rect.setAttribute('width', cardW);
      rect.setAttribute('height', h);
    }
    var title = g.querySelector('.card-title');
    if (title) {
      title.setAttribute('x', cardX + 10);
      title.setAttribute('y', y + 17);
    }
    var body = g.querySelector('.body-text');
    if (body) {
      body.setAttribute('x', cardX + 10);
      body.setAttribute('y', y + 34);
    }
    var badge = g.querySelector('.fold-badge');
    if (badge) {
      badge.setAttribute('x', cardX + cardW - 8);
      badge.setAttribute('y', y + 17);
    }
  }

  // 重排容器内所有卡片（按 DOM 顺序）
  function layoutCards(container, nodeRect, layout) {
    var cards = container.querySelectorAll('g.card-v2:not(.evicting)');
    var yCursor = nodeRect.y + layout.padY;
    cards.forEach(function(card) {
      var folded = card.classList.contains('folded');
      var h = folded ? layout.foldedH : layout.activeH;
      card.setAttribute('transform', 'translate(0,0)');
      positionCard(card, nodeRect, layout, yCursor, h);
      yCursor += h + layout.gap;
    });
    return yCursor;
  }

  // 生成卡片内部文字元素（title + body/badge），不定位
  function appendCardContent(g, sec, folded) {
    var ns = 'http://www.w3.org/2000/svg';
    var title = document.createElementNS(ns, 'text');
    title.setAttribute('class', 'card-title');
    title.setAttribute('fill', folded ? CARD_STYLE.foldedTitleColor : CARD_STYLE.titleColor);
    title.setAttribute('font-size', '11');
    title.setAttribute('font-weight', folded ? '600' : '500');
    var titleStr = (sec && (sec.summary || sec.id)) || 'Untitled';
    if (titleStr.length > 42) titleStr = titleStr.substring(0, 40) + '...';
    title.textContent = (folded ? '📦 ' : '📝 ') + titleStr;
    g.appendChild(title);

    if (!folded) {
      var body = document.createElementNS(ns, 'text');
      body.setAttribute('class', 'body-text');
      body.setAttribute('fill', CARD_STYLE.bodyColor);
      body.setAttribute('font-size', '10');
      var msg = (sec && sec.messages) || 0;
      var tok = (sec && sec.tokens) || 0;
      body.textContent = '... ' + msg + ' msg · ' + tok + ' tok ...';
      g.appendChild(body);
    } else {
      var badge = document.createElementNS(ns, 'text');
      badge.setAttribute('class', 'fold-badge');
      badge.setAttribute('text-anchor', 'end');
      badge.setAttribute('fill', CARD_STYLE.bodyColor);
      badge.setAttribute('font-size', '10');
      badge.textContent = '✂ folded';
      g.appendChild(badge);
    }
  }

  // 创建一张卡片 SVG 元素（不附加到 DOM，不定位）
  function buildCardElement(sec, folded, clipId) {
    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'card-v2' + (folded ? ' folded' : ''));
    g.setAttribute('data-card-id', sec && sec.id ? sec.id : ('card_' + Date.now()));
    g.setAttribute('opacity', '0');
    if (clipId) g.setAttribute('clip-path', 'url(#' + clipId + ')');

    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', folded ? CARD_STYLE.foldedFill : CARD_STYLE.activeFill);
    rect.setAttribute('stroke', folded ? CARD_STYLE.foldedStroke : CARD_STYLE.activeStroke);
    rect.setAttribute('stroke-width', '1');
    g.appendChild(rect);

    appendCardContent(g, sec, folded);
    return g;
  }

  // 状态切换（折叠↔展开）时重建卡片内容与样式
  function rebuildCardContent(g, sec, folded) {
    var texts = g.querySelectorAll('text');
    for (var i = 0; i < texts.length; i++) texts[i].remove();
    var rect = g.querySelector('rect');
    if (rect) {
      rect.setAttribute('fill', folded ? CARD_STYLE.foldedFill : CARD_STYLE.activeFill);
      rect.setAttribute('stroke', folded ? CARD_STYLE.foldedStroke : CARD_STYLE.activeStroke);
    }
    appendCardContent(g, sec, folded);
  }

  // 更新卡片文字内容（无状态变化时）
  function updateCardContent(g, sec, folded) {
    var title = g.querySelector('.card-title');
    if (title) {
      var titleStr = (sec && (sec.summary || sec.id)) || 'Untitled';
      if (titleStr.length > 42) titleStr = titleStr.substring(0, 40) + '...';
      title.textContent = (folded ? '📦 ' : '📝 ') + titleStr;
    }
    var body = g.querySelector('.body-text');
    if (body && !folded) {
      var msg = (sec && sec.messages) || 0;
      var tok = (sec && sec.tokens) || 0;
      body.textContent = '... ' + msg + ' msg · ' + tok + ' tok ...';
    }
  }

  // 新卡片淡入（从下方上移）
  function animateCardFadeIn(g) {
    var startTime = performance.now();
    var duration = 300;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      g.setAttribute('opacity', String(ease));
      g.setAttribute('transform', 'translate(0,' + ((1 - ease) * 12) + ')');
      if (progress < 1) requestAnimationFrame(tick);
      else { g.setAttribute('opacity', '1'); g.removeAttribute('transform'); }
    }
    requestAnimationFrame(tick);
  }

  // 折叠/展开过渡：rect height + text y 同步
  function animateFoldTransition(g, fromH, toH, baseY, done) {
    var rect = g.querySelector('rect');
    if (!rect) { if (done) done(); return; }
    var startTime = performance.now();
    var duration = 300;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      rect.setAttribute('height', String(fromH + (toH - fromH) * ease));
      var title = g.querySelector('.card-title');
      if (title) title.setAttribute('y', baseY + 17);
      var body = g.querySelector('.body-text');
      if (body) body.setAttribute('y', baseY + 34);
      var badge = g.querySelector('.fold-badge');
      if (badge) badge.setAttribute('y', baseY + 17);
      if (progress < 1) requestAnimationFrame(tick);
      else if (done) done();
    }
    requestAnimationFrame(tick);
  }

  // 淘汰卡片左滑+淡出
  function animateCardSlideOut(g, cardW, done) {
    g.classList.add('evicting');
    var startTime = performance.now();
    var duration = 400;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      g.setAttribute('transform', 'translate(' + (-ease * (cardW + 30)) + ',0)');
      g.setAttribute('opacity', String(1 - ease));
      if (progress < 1) requestAnimationFrame(tick);
      else {
        if (g.parentNode) g.parentNode.removeChild(g);
        if (done) done();
      }
    }
    requestAnimationFrame(tick);
  }

  // ---- effect: card_create —— 在 flow.to 节点内创建一张新卡片（淡入） ----
  EffectRegistry.register('card_create', function(ctx) {
    var flow = ctx.flow;
    var value = ctx.value || (flow && flow.rawFlow && flow.rawFlow.value) || {};
    var container = ensureCardContainer(flow.to);
    if (!container) return false;
    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;
    var layout = getCardLayout(flow);
    var clipId = ensureCardClip(flow.to);
    var card = buildCardElement(value, value.status === 'folded', clipId);
    container.appendChild(card);
    layoutCards(container, nodeRect, layout);
    animateCardFadeIn(card);
    return true;
  });

  // ---- effect: card_fold —— 折叠指定卡片（cardId 通过 value.cardId 或 value.id 传入） ----
  EffectRegistry.register('card_fold', function(ctx) {
    var flow = ctx.flow;
    var value = ctx.value || (flow && flow.rawFlow && flow.rawFlow.value) || {};
    var cardId = value.cardId || value.id;
    if (!cardId) return false;
    var container = ensureCardContainer(flow.to);
    if (!container) return false;
    var card = container.querySelector('g.card-v2[data-card-id="' + cardId + '"]');
    if (!card || card.classList.contains('folded')) return false;
    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;
    var layout = getCardLayout(flow);
    card.classList.add('folded');
    rebuildCardContent(card, value, true);
    var rect = card.querySelector('rect');
    var baseY = rect ? parseFloat(rect.getAttribute('y')) || 0 : 0;
    animateFoldTransition(card, layout.activeH, layout.foldedH, baseY, function() {
      layoutCards(container, nodeRect, layout);
    });
    return true;
  });

  // ---- effect: card_evict —— 淘汰容器内最旧（DOM 顺序第一张）的卡片（左滑+淡出） ----
  EffectRegistry.register('card_evict', function(ctx) {
    var flow = ctx.flow;
    var container = ensureCardContainer(flow.to);
    if (!container) return false;
    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;
    var layout = getCardLayout(flow);
    var cards = container.querySelectorAll('g.card-v2:not(.evicting)');
    if (cards.length === 0) return false;
    animateCardSlideOut(cards[0], nodeRect.w - layout.padX * 2, function() {
      layoutCards(container, nodeRect, layout);
    });
    return true;
  });

  // ---- effect: card_sync —— 全量同步状态数组到卡片（快照对比 → 创建/折叠/淘汰） ----
  // 数据源：window.simState[flow.source_key || 'sections']
  EffectRegistry.register('card_sync', function(ctx) {
    var flow = ctx.flow;
    var raw = (flow && flow.rawFlow) || {};
    var sourceKey = raw.source_key || 'sections';
    var data = (window.simState && window.simState[sourceKey]) || [];
    if (!Array.isArray(data)) return false;
    var container = ensureCardContainer(flow.to);
    if (!container) return false;
    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;
    var layout = getCardLayout(flow);
    var clipId = ensureCardClip(flow.to);

    // 容器标题（可选）
    if (raw.title_template) {
      var titleEl = ensureContainerTitle(container, nodeRect);
      titleEl.textContent = renderTitleTemplate(raw.title_template, data);
    }

    // 第一遍：计算目标布局
    var yCursor = nodeRect.y + layout.padY;
    var layouts = {};
    for (var i = 0; i < data.length; i++) {
      var sec = data[i];
      if (!sec || sec.id == null) continue;
      var folded = sec.status === 'folded';
      var h = folded ? layout.foldedH : layout.activeH;
      layouts[sec.id] = { y: yCursor, h: h, folded: folded };
      yCursor += h + layout.gap;
    }

    // 收集现有卡片
    var existingMap = {};
    container.querySelectorAll('g.card-v2').forEach(function(card) {
      existingMap[card.getAttribute('data-card-id')] = card;
    });

    // 第二遍：创建/更新卡片
    var keptIds = {};
    for (var j = 0; j < data.length; j++) {
      var sec2 = data[j];
      if (!sec2 || sec2.id == null) continue;
      var sid = sec2.id;
      keptIds[sid] = true;
      var lo = layouts[sid];
      var existing = existingMap[sid];
      if (existing) {
        var wasFolded = existing.classList.contains('folded');
        if (wasFolded !== lo.folded) {
          // 状态变化：折叠 ↔ 展开
          existing.classList.toggle('folded', lo.folded);
          rebuildCardContent(existing, sec2, lo.folded);
          var oldH = wasFolded ? layout.foldedH : layout.activeH;
          animateFoldTransition(existing, oldH, lo.h, lo.y, null);
        } else {
          updateCardContent(existing, sec2, lo.folded);
          positionCard(existing, nodeRect, layout, lo.y, lo.h);
        }
      } else {
        var g = buildCardElement(sec2, lo.folded, clipId);
        positionCard(g, nodeRect, layout, lo.y, lo.h);
        container.appendChild(g);
        animateCardFadeIn(g);
      }
    }

    // 第三遍：淘汰不再存在的卡片（左滑+淡出）
    var cardW = nodeRect.w - layout.padX * 2;
    Object.keys(existingMap).forEach(function(id) {
      if (keptIds[id]) return;
      animateCardSlideOut(existingMap[id], cardW, null);
    });
    return true;
  });

  // 对所有声明了 card_sync 的 flow 执行一次同步（启动与 reset 时调用）
  function runCardSyncFlows() {
    if (!HAS_EXPLICIT_FLOWS) return;
    for (var i = 0; i < EXPLICIT_FLOWS.length; i++) {
      var f = EXPLICIT_FLOWS[i];
      if (f.effect === 'card_sync' && f.to) {
        try {
          EffectRegistry.get('card_sync')({
            flow: { to: f.to, effect: 'card_sync', rawFlow: f },
            value: null,
            targetNodeId: f.to
          });
        } catch (e) {
          console.error('[animV2] card_sync run failed:', e);
        }
      }
    }
  }

  // ========== 粒子系统 ==========

  // 查找 flow 对应的 SVG path 元素（优先 edgeId，其次 from/to 匹配）
  function findFlowPathEl(flow) {
    if (flow.edgeId) {
      var g = document.querySelector('.edge[data-id="' + flow.edgeId + '"]');
      if (g) {
        var p = g.querySelector('path');
        if (p) return p;
      }
    }
    if (flow.from && flow.to) {
      var g2 = document.querySelector('.edge[data-from="' + flow.from + '"][data-to="' + flow.to + '"]');
      if (g2) {
        var p2 = g2.querySelector('path');
        if (p2) return p2;
      }
    }
    return null;
  }

  // 统一粒子发射：可沿 SVG path（getPointAtLength）或直线插值
  function spawnParticleAlongPath(opts) {
    var layer = ensureAnimLayer();
    if (!layer) return;

    var pathEl = opts.pathEl || null;
    var pathLen = 0;
    if (pathEl) {
      try { pathLen = pathEl.getTotalLength(); } catch (e) { pathEl = null; }
    }

    var start = null, end = null;
    if (!pathEl) {
      var fromCenter = getNodeCenter(opts.from);
      var toCenter = getNodeCenter(opts.to);
      if (!fromCenter || !toCenter) return;
      var fromRect = getNodeRect(opts.from);
      var toRect = getNodeRect(opts.to);
      if (!fromRect || !toRect) return;
      start = intersectRect(fromCenter, toCenter, fromRect);
      end = intersectRect(toCenter, fromCenter, toRect);
    }

    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'anim-particle-v2');
    g.style.opacity = '0';
    g.style.transition = 'opacity 0.3s';

    var circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', '6');
    circle.setAttribute('fill', opts.color || '#4fc3f7');
    circle.setAttribute('opacity', '0.9');
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '1');
    g.appendChild(circle);

    if (opts.valueLabel) {
      var labelBg = document.createElementNS(ns, 'rect');
      var labelText = opts.valueLabel;
      var labelWidth = Math.max(labelText.length * 6 + 8, 30);
      labelBg.setAttribute('x', -labelWidth / 2);
      labelBg.setAttribute('y', -22);
      labelBg.setAttribute('width', labelWidth);
      labelBg.setAttribute('height', '14');
      labelBg.setAttribute('rx', '3');
      labelBg.setAttribute('fill', opts.color || '#4fc3f7');
      labelBg.setAttribute('opacity', '0.85');
      g.appendChild(labelBg);

      var text = document.createElementNS(ns, 'text');
      text.setAttribute('x', '0');
      text.setAttribute('y', '-12');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#ffffff');
      text.setAttribute('style', 'font-size:9px;font-weight:500;pointer-events:none;');
      text.textContent = labelText;
      g.appendChild(text);
    } else if (opts.label) {
      var text0 = document.createElementNS(ns, 'text');
      text0.setAttribute('x', '0');
      text0.setAttribute('y', '-10');
      text0.setAttribute('text-anchor', 'middle');
      text0.setAttribute('fill', '#ffffff');
      text0.setAttribute('style', 'font-size:10px;pointer-events:none;');
      text0.textContent = opts.label;
      g.appendChild(text0);
    }

    layer.appendChild(g);

    var particle = {
      el: g,
      pathEl: pathEl,
      pathLen: pathLen,
      startX: start ? start.x : 0,
      startY: start ? start.y : 0,
      endX: end ? end.x : 0,
      endY: end ? end.y : 0,
      t: 0,
      speed: opts.speed || 0.012,
      color: opts.color,
      label: opts.valueLabel || opts.label,
      valueType: opts.valueType,
      flowId: opts.flowId,
      targetNodeId: opts.to,
      branches: opts.branches,
      onArrive: opts.onArrive || 'fade',
      onComplete: null
    };

    if (opts.explicit && opts.valueType) {
      particle.onComplete = function(p) {
        showNodeIOPrompt(p.targetNodeId, p.valueType, p.label);
      };
    }

    state.activeParticles.push(particle);
    requestAnimationFrame(function() { g.style.opacity = '1'; });
    if (!state.animFrame) {
      tickParticles();
    }
  }

  function spawnDefaultParticle(flow, payloadData) {
    // ---- L3 条件分支：branches 非空时先求值选路 ----
    // 求值上下文 value 按触发器类型自动构造：
    //   event → payload；state_change → simState 全量；periodic → mock_values 轮换
    if (flow.branches && flow.branches.length > 0) {
      var evalValue = payloadData !== undefined ? payloadData
        : (flow.mockRotator ? flow.mockRotator()
        : (flow.rawFlow ? flow.rawFlow.value : undefined));
      var picked = pickBranch(flow.branches, evalValue, undefined);
      if (!picked) {
        // 全部未命中：判断处灰闪提示，不发粒子
        flashNode(flow.from, '#666', 400);
        return;
      }
      var bColor = branchColor(picked.branch, picked.index);
      flashNode(flow.from, bColor, 600);
      var bVal = picked.branch.value;
      spawnParticleAlongPath({
        pathEl: findFlowPathEl({ from: flow.from, to: picked.branch.to }),
        from: flow.from,
        to: picked.branch.to,
        color: bColor,
        label: flow.label,
        valueLabel: bVal ? (bVal.label || bVal.type) : flow.valueLabel,
        valueType: bVal ? bVal.type : flow.valueType,
        flowId: flow.id + '::' + picked.branch.to,
        onArrive: flow.onArrive,
        explicit: flow.explicit
      });
      return;
    }

    // 优先检查注册的 effect（L2+ 显式 flow 可指定 effect）
    // effect 返回 true 表示已处理，不再触发默认粒子流
    var effectName = flow.effect || 'particle_flow';
    if (effectName !== 'particle_flow' && EffectRegistry.has(effectName)) {
      try {
        var handled = EffectRegistry.get(effectName)({
          flow: flow,
          value: flow.rawFlow ? flow.rawFlow.value : null,
          targetNodeId: flow.to
        });
        if (handled) return;
      } catch (e) {
        console.error('[animV2] effect "' + effectName + '" failed:', e);
        // 失败时回退到默认粒子流
      }
    }

    spawnParticleAlongPath({
      pathEl: findFlowPathEl(flow),
      from: flow.from,
      to: flow.to,
      color: flow.color || '#4fc3f7',
      label: flow.label,
      valueLabel: flow.valueLabel,
      valueType: flow.valueType,
      flowId: flow.id,
      branches: flow.branches,
      onArrive: flow.onArrive,
      explicit: flow.explicit
    });
  }

  // ---- sim-edge 粒子流：仿真规则触发时沿对应 sim-edge 发送粒子 ----
  function spawnSimRuleParticles(ruleId, eventName, depth) {
    var rule = null;
    for (var i = 0; i < SIM_RULES.length; i++) {
      if (SIM_RULES[i].id === ruleId) { rule = SIM_RULES[i]; break; }
    }
    if (!rule) return;
    var edges = document.querySelectorAll('.sim-edge[data-rule="' + ruleId + '"]');
    var delayBase = (depth || 0) * 450;
    for (var j = 0; j < edges.length; j++) {
      (function(edgeEl, idx) {
        var pathEl = edgeEl.querySelector('.sim-edge-path');
        if (!pathEl) return;
        var toId = edgeEl.getAttribute('data-to');
        setTimeout(function() {
          var stroke = pathEl.getAttribute('stroke') || '#9b59b6';
          var label = SIM_PARTICLE_CFG.label === 'rule' ? rule.name : eventName;
          spawnParticleAlongPath({
            pathEl: pathEl,
            from: edgeEl.getAttribute('data-from'),
            to: toId,
            color: stroke,
            label: label,
            flowId: 'sim_' + ruleId,
            onArrive: SIM_PARTICLE_CFG.on_arrive,
            speed: 0.02
          });
        }, delayBase + idx * 150);
      })(edges[j], j);
    }
  }

  // 仿真器规则触发钩子（scripts.ts 的 processEvent 调用）
  window.__simRuleFired__ = function(ruleId, eventName, depth) {
    try {
      spawnSimRuleParticles(ruleId, eventName, depth);
    } catch (e) {
      console.error('[animV2] sim rule particle failed:', e);
    }
  };

  // ---- 粒子到达终点 → 转为可拖拽 chip 容器 ----
  var chipSeq = 0;
  var CHIP_MAX = 18;

  function convertParticleToChip(p) {
    var layer = ensureAnimLayer();
    if (!layer) { fadeOutEl(p.el); return; }
    var svg = getSvgCanvas();
    var vb = svg ? svg.getAttribute('viewBox') : null;
    var canvasW = vb ? parseFloat(vb.split(' ')[2]) : 1200;

    var ns = 'http://www.w3.org/2000/svg';
    chipSeq++;
    var label = p.label || 'msg';
    if (label.length > 24) label = label.substring(0, 22) + '..';
    var w = Math.max(label.length * 6.5 + 18, 50);
    var h = 20;

    // 停靠区：画布右侧竖排（不遮挡节点内容）
    var dockX = canvasW - w - 14;
    var slot = (chipSeq - 1) % CHIP_MAX;
    var dockY = 40 + slot * 26;

    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'anim-chip');
    g.setAttribute('transform', 'translate(' + dockX + ',' + dockY + ')');
    g.style.pointerEvents = 'auto';
    g.style.cursor = 'grab';
    g.style.opacity = '0';
    g.style.transition = 'opacity 0.3s';

    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('data-shape', 'true');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', String(w));
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', p.color || '#4fc3f7');
    rect.setAttribute('opacity', '0.85');
    g.appendChild(rect);

    var text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(w / 2));
    text.setAttribute('y', '14');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('style', 'font-size:10px;font-weight:500;pointer-events:none;');
    text.textContent = label;
    g.appendChild(text);

    layer.appendChild(g);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    requestAnimationFrame(function() { g.style.opacity = '1'; });

    state.chips.push({ el: g, born: Date.now() });
    while (state.chips.length > CHIP_MAX) {
      var oldest = state.chips.shift();
      fadeOutEl(oldest.el);
    }

    bindChipDrag(g);
  }

  // chip 拖拽（独立于节点拖拽，避免与主交互耦合）
  function bindChipDrag(g) {
    g.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      var svg = getSvgCanvas();
      if (!svg) return;
      g.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      var moveHandler = function(ev) {
        var svgRect = svg.getBoundingClientRect();
        var viewBox = svg.getAttribute('viewBox').split(' ').map(Number);
        var scaleX = viewBox[2] / svgRect.width;
        var scaleY = viewBox[3] / svgRect.height;
        var mouseX = (ev.clientX - svgRect.left) * scaleX + viewBox[0];
        var mouseY = (ev.clientY - svgRect.top) * scaleY + viewBox[1];
        var rect = g.querySelector('rect');
        var w = rect ? parseFloat(rect.getAttribute('width')) || 0 : 0;
        var h = rect ? parseFloat(rect.getAttribute('height')) || 0 : 0;
        g.setAttribute('transform', 'translate(' + (mouseX - w / 2) + ',' + (mouseY - h / 2) + ')');
      };
      var upHandler = function() {
        g.style.cursor = 'grab';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', moveHandler);
        document.removeEventListener('mouseup', upHandler);
      };
      document.addEventListener('mousemove', moveHandler);
      document.addEventListener('mouseup', upHandler);
    });
  }

  // ---- L2 节点处输入/输出提示 ----
  function showNodeIOPrompt(nodeId, inputType, inputLabel) {
    var rect = getNodeRect(nodeId);
    if (!rect) return;

    var layer = ensureAnimLayer();
    if (!layer) return;

    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'anim-io-prompt');
    g.style.opacity = '0';
    g.style.transition = 'opacity 0.3s';

    var promptX = rect.x + rect.w + 8;
    var promptY = rect.y - 4;

    var bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', promptX);
    bg.setAttribute('y', promptY);
    bg.setAttribute('width', '160');
    bg.setAttribute('height', '32');
    bg.setAttribute('rx', '4');
    bg.setAttribute('fill', '#1a1a2e');
    bg.setAttribute('stroke', '#4fc3f7');
    bg.setAttribute('stroke-width', '1');
    bg.setAttribute('opacity', '0.95');
    g.appendChild(bg);

    var text1 = document.createElementNS(ns, 'text');
    text1.setAttribute('x', promptX + 8);
    text1.setAttribute('y', promptY + 13);
    text1.setAttribute('fill', '#4fc3f7');
    text1.setAttribute('style', 'font-size:10px;font-weight:600;');
    text1.textContent = '输入: ' + (inputLabel || inputType);
    g.appendChild(text1);

    var text2 = document.createElementNS(ns, 'text');
    text2.setAttribute('x', promptX + 8);
    text2.setAttribute('y', promptY + 26);
    text2.setAttribute('fill', '#888');
    text2.setAttribute('style', 'font-size:10px;');
    text2.textContent = '输出: ???';
    g.appendChild(text2);

    layer.appendChild(g);

    requestAnimationFrame(function() { g.style.opacity = '1'; });
    setTimeout(function() {
      g.style.opacity = '0';
      setTimeout(function() {
        if (g.parentNode) g.parentNode.removeChild(g);
      }, 300);
    }, 1500);
  }

  function tickParticles() {
    if (state.paused && !state.stepMode) {
      state.animFrame = null;
      return;
    }

    var remaining = [];
    for (var i = 0; i < state.activeParticles.length; i++) {
      var p = state.activeParticles[i];
      p.t += p.speed * (state.stepMode ? 0.1 : 1);

      var x, y;
      if (p.t >= 1) {
        p.t = 1;
        if (p.pathEl) {
          try {
            var endPt = p.pathEl.getPointAtLength(p.pathLen);
            x = endPt.x; y = endPt.y;
          } catch (e) { x = p.endX; y = p.endY; }
        } else {
          x = p.endX; y = p.endY;
        }
        p.el.setAttribute('transform', 'translate(' + x + ',' + y + ')');

        if (p.onComplete) {
          p.onComplete(p);
        } else if (p.onArrive === 'chip') {
          convertParticleToChip(p);
        } else {
          fadeOutEl(p.el);
        }
      } else {
        if (p.pathEl) {
          try {
            var pt = p.pathEl.getPointAtLength(p.t * p.pathLen);
            x = pt.x; y = pt.y;
          } catch (e) {
            x = p.startX + (p.endX - p.startX) * p.t;
            y = p.startY + (p.endY - p.startY) * p.t;
          }
        } else {
          x = p.startX + (p.endX - p.startX) * p.t;
          y = p.startY + (p.endY - p.startY) * p.t;
        }
        p.el.setAttribute('transform', 'translate(' + x + ',' + y + ')');
        remaining.push(p);
      }
    }
    state.activeParticles = remaining;

    if (state.activeParticles.length > 0) {
      state.animFrame = requestAnimationFrame(tickParticles);
    } else {
      state.animFrame = null;
    }
  }

  // ---- L0/L2 默认行为与显式流 ----
  function startDefaultFlows() {
    var periodicFlows = [];
    var eventFlows = [];
    var stateChangeFlows = [];

    // 处理显式 flows（L2+）
    if (HAS_EXPLICIT_FLOWS && EXPLICIT_FLOWS.length > 0) {
      for (var i = 0; i < EXPLICIT_FLOWS.length; i++) {
        var f = EXPLICIT_FLOWS[i];
        if (!f.trigger) continue;

        var flowConfig = {
          id: f.id,
          from: f.from,
          to: f.to,
          interval: f.trigger.interval || 4000,
          color: '#4fc3f7',
          label: f.value ? (f.value.label || f.value.type) : '',
          valueType: f.value ? f.value.type : '',
          valueLabel: f.value ? (f.value.label || f.value.type) : '',
          branches: f.branches || null,
          mockRotator: (f.mock_values && f.mock_values.length > 0) ? createMockRotator(f.mock_values) : null,
          effect: f.effect || 'particle_flow',
          onArrive: f.on_arrive || 'fade',
          explicit: true,
          rawFlow: f
        };

        if (f.trigger.type === 'periodic') {
          periodicFlows.push(flowConfig);
        } else if (f.trigger.type === 'event') {
          eventFlows.push({ config: flowConfig, eventName: f.trigger.event });
        } else if (f.trigger.type === 'state_change') {
          stateChangeFlows.push({ config: flowConfig, watchKey: f.trigger.watch || f.source_key || 'sections' });
        }
        // manual 暂不在启动时注册，由其他机制触发
      }
    }

    // 补充默认流（未被显式覆盖的 edge）
    var explicitPaths = {};
    periodicFlows.forEach(function(f) {
      explicitPaths[f.from + '->' + f.to] = true;
    });
    eventFlows.forEach(function(e) {
      explicitPaths[e.config.from + '->' + e.config.to] = true;
    });

    for (var j = 0; j < DEFAULT_FLOWS.length; j++) {
      var df = DEFAULT_FLOWS[j];
      var key = df.from + '->' + df.to;
      if (!explicitPaths[key]) {
        periodicFlows.push(df);
      }
    }

    // 启动 periodic 流
    periodicFlows.forEach(function(flow) {
      startFlowTimer(flow);
    });

    // 注册 event 触发流
    if (eventFlows.length > 0) {
      setupEventTriggers(eventFlows);
    }

    // 注册 state_change 触发流（轮询 window.simState 快照对比）
    if (stateChangeFlows.length > 0) {
      setupStateWatchers(stateChangeFlows);
    }
  }

  // ---- L2 状态变化触发：监听仿真器状态键 ----
  // 通用机制：任何 trigger.type=state_change 的 flow 都可声明 watch 状态键
  // 引擎每 300ms 对比 JSON 快照，变化时触发 flow（如 card_sync 全量同步卡片）
  function setupStateWatchers(scFlows) {
    var watchers = {};
    scFlows.forEach(function(sf) {
      var key = sf.watchKey;
      if (!watchers[key]) watchers[key] = [];
      watchers[key].push(sf.config);
    });
    var prevSnapshots = {};
    setInterval(function() {
      if (state.paused) return;
      if (!window.simState) return;
      for (var key in watchers) {
        var data = window.simState[key];
        if (data === undefined) continue;
        // AnimCore 统一快照逻辑：序列化失败（循环引用等）本轮跳过
        var snap = makeSnapshot(data);
        if (snap === null) continue;
        if (prevSnapshots[key] === snap) continue;
        prevSnapshots[key] = snap;
        var configs = watchers[key];
        for (var i = 0; i < configs.length; i++) {
          try {
            // L3 求值上下文：state_change 触发时传入 simState 全量（只读）
            spawnDefaultParticle(configs[i], window.simState);
          } catch (e) {
            console.error('[animV2] state watcher flow failed:', e);
          }
        }
      }
    }, 300);
    console.log('[animV2] state watchers registered:', Object.keys(watchers));
  }

  // ---- L2 事件触发：监听仿真器事件 ----
  function setupEventTriggers(eventFlows) {
    var listeners = {};

    eventFlows.forEach(function(ef) {
      var eventName = ef.eventName;
      if (!listeners[eventName]) listeners[eventName] = [];
      listeners[eventName].push(ef.config);
    });

    var prevListener = window.__simEventListener__;
    window.__simEventListener__ = function(eventName, payload) {
      if (typeof prevListener === 'function') {
        try { prevListener(eventName, payload); } catch (e) {}
      }
      var configs = listeners[eventName];
      if (!configs) return;
      for (var i = 0; i < configs.length; i++) {
        // L3 求值上下文：event 触发时传入仿真器事件载荷
        spawnDefaultParticle(configs[i], payload);
      }
    };

    console.log('[animV2] event triggers registered:', Object.keys(listeners));
  }

  function startFlowTimer(flow) {
    // 立即跑一次
    spawnDefaultParticle(flow);

    // 周期触发
    state.flowTimers[flow.id] = setInterval(function() {
      if (state.paused && !state.stepMode) return;
      spawnDefaultParticle(flow);
    }, flow.interval);
  }

  // ---- L1 默认行为：状态变化高亮 ----
  function startStatusWatch() {
    for (var i = 0; i < STATUS_NODES.length; i++) {
      var sn = STATUS_NODES[i];
      state.prevStatusSnapshot[sn.id] = sn.status;
    }

    setInterval(function() {
      if (state.paused) return;
      for (var j = 0; j < STATUS_NODES.length; j++) {
        var node = STATUS_NODES[j];
        var el = document.querySelector('.node[data-id="' + node.id + '"]');
        if (!el) continue;
        var currentStatus = el.getAttribute('data-status') || node.status;
        var prevStatus = state.prevStatusSnapshot[node.id];
        if (currentStatus !== prevStatus) {
          state.prevStatusSnapshot[node.id] = currentStatus;
          triggerStatusChangeEffect(node.id, prevStatus, currentStatus);
        }

        if (currentStatus === 'in_progress') {
          applyBreathingEffect(node.id);
        }
      }
    }, 500);
  }

  function triggerStatusChangeEffect(nodeId, oldStatus, newStatus) {
    var el = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!el) return;
    var shape = el.querySelector('rect[data-shape="true"], circle[data-shape="true"], polygon[data-shape="true"]');
    if (!shape) return;

    var flashColor = '#4CAF50';
    if (newStatus === 'in_progress') flashColor = '#FF9800';
    else if (newStatus === 'done') flashColor = '#4CAF50';
    else if (newStatus === 'draft') flashColor = '#666';

    var originalStroke = shape.getAttribute('stroke');
    var originalWidth = shape.getAttribute('stroke-width');

    shape.setAttribute('stroke', flashColor);
    shape.setAttribute('stroke-width', '4');

    setTimeout(function() {
      shape.setAttribute('stroke', originalStroke || '#1f2a4d');
      shape.setAttribute('stroke-width', originalWidth || '1');
    }, 300);
  }

  function applyBreathingEffect(nodeId) {
    var el = document.querySelector('.node[data-id="' + nodeId + '"]');
    if (!el) return;
    if (el.dataset.breathingApplied) return;
    el.dataset.breathingApplied = 'true';

    var shape = el.querySelector('rect[data-shape="true"], circle[data-shape="true"], polygon[data-shape="true"]');
    if (!shape) return;

    shape.style.animation = 'anim-v2-breathing 2s ease-in-out infinite';

    if (!document.getElementById('anim-v2-breathing-style')) {
      var style = document.createElement('style');
      style.id = 'anim-v2-breathing-style';
      style.textContent = '@keyframes anim-v2-breathing { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }';
      document.head.appendChild(style);
    }

    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        if (m.attributeName === 'data-status') {
          var newStatus = el.getAttribute('data-status');
          if (newStatus !== 'in_progress') {
            shape.style.animation = '';
            delete el.dataset.breathingApplied;
            observer.disconnect();
          }
        }
      });
    });
    observer.observe(el, { attributes: true });
  }

  // ---- 暂停/步进/重置控制 ----
  function pause() {
    state.paused = true;
    state.stepMode = false;
  }

  function resume() {
    state.paused = false;
    state.stepMode = false;
    if (!state.animFrame && state.activeParticles.length > 0) {
      tickParticles();
    }
  }

  function step() {
    state.paused = true;
    state.stepMode = true;
    if (!state.animFrame && state.activeParticles.length > 0) {
      tickParticles();
    }
  }

  // 重置：清除粒子/chip/卡片，重新同步 card_sync flows
  function reset() {
    for (var i = 0; i < state.activeParticles.length; i++) {
      var p = state.activeParticles[i];
      if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }
    state.activeParticles = [];
    for (var j = 0; j < state.chips.length; j++) {
      var c = state.chips[j];
      if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
    }
    state.chips = [];
    var containers = document.querySelectorAll('[data-card-container="true"]');
    for (var k = 0; k < containers.length; k++) {
      var cards = containers[k].querySelectorAll('g.card-v2');
      for (var m = 0; m < cards.length; m++) cards[m].remove();
    }
    runCardSyncFlows();
  }

  // ---- 控制按钮接线（sim-panel 中的动画控制按钮） ----
  function setupControlButtons() {
    function bind(id, fn) {
      var btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', function() { try { fn(); } catch (e) { console.error('[animV2] control "' + id + '" failed:', e); } });
    }
    bind('anim-pause', pause);
    bind('anim-step', step);
    bind('anim-resume', resume);
    bind('anim-reset', reset);
  }

  // ---- 启动 ----
  function start() {
    if (state.started) return;
    state.started = true;
    setupControlButtons();

    // 等待 DOM 渲染完成（scripts.ts 可能在动画脚本之后才渲染节点）
    setTimeout(function() {
      try {
        startDefaultFlows();
        startStatusWatch();
        runCardSyncFlows();
        console.log('[animV2] started, flows:', Object.keys(state.flowTimers).length, 'statusNodes:', STATUS_NODES.length, 'simRules:', SIM_RULES.length);
      } catch (e) {
        console.error('[animV2] start failed:', e);
      }
    }, 1500);
  }

  // ---- 暴露接口 ----
  window.__animV2__ = {
    version: ANIM_VERSION,
    start: start,
    pause: pause,
    resume: resume,
    step: step,
    reset: reset,
    spawnParticle: spawnDefaultParticle,
    // 手动触发 effect（调试 / L5 运行时调用）
    // 用法：__animV2__.triggerEffect('card_create', { to: 'node_section_queue', value: { id, summary, ... } })
    triggerEffect: function(effectName, options) {
      if (!EffectRegistry.has(effectName)) {
        console.warn('[animV2] effect not registered:', effectName);
        return false;
      }
      var flow = {
        to: options.to,
        from: options.from,
        effect: effectName,
        rawFlow: { value: options.value }
      };
      try {
        return !!EffectRegistry.get(effectName)({
          flow: flow,
          value: options.value,
          targetNodeId: options.to
        });
      } catch (e) {
        console.error('[animV2] triggerEffect "' + effectName + '" failed:', e);
        return false;
      }
    },
    EffectRegistry: EffectRegistry,
    state: state
  };

  // 自动启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;
}

/** L0 默认流配置（内部类型，用于生成 JS 配置） */
interface DefaultFlowConfig {
  id: string;
  from: string;
  to: string;
  interval: number;
  color: string;
  edgeId: string;
}
