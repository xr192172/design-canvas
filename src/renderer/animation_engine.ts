/**
 * AnimationEngine V2 — 通用动画执行器（分层精度 L0-L5）
 *
 * 设计原则（详见 docs/animation-design.md）：
 * - L0-L1 零成本：无 animations_v2 字段时，从 geometry/semantic 自动推导默认动画
 * - L2+ 显式声明：有 animations_v2.flows 时，显式 flow 覆盖同路径默认粒子流
 * - 不硬编码项目特定 ID：通过 effect 注册表扩展
 * - 与 simulation 联动：监听仿真器事件触发对应 flow
 *
 * 本模块导出 buildAnimationScript(dsl) → 浏览器端 JS 字符串
 * 由 html_renderer.ts 拼接为独立 <script> 块注入
 */

import type { DesignDSL, Edge, Node } from '../dsl/types.js';

/**
 * 生成浏览器端动画执行器 JS 代码
 * 作为独立 <script> 注入，通过 window.__animV2__ 暴露接口
 */
export function buildAnimationScript(dsl: DesignDSL): string {
  const hasAnimationsV2 = !!dsl.animations_v2;
  const flowsJson = JSON.stringify(dsl.animations_v2?.flows ?? []);
  const runtimeJson = JSON.stringify(dsl.animations_v2?.runtime ?? null) || 'null';

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

  // L1 默认状态高亮：提取所有有 status 的节点
  const statusNodes = nodes
    .filter(n => n.status)
    .map(n => ({ id: n.id, status: n.status as string }));

  const defaultFlowsJson = JSON.stringify(defaultFlows);
  const statusNodesJson = JSON.stringify(statusNodes);

  return `
// ========== Animation Engine V2 (L0-L5) ==========
(function() {
  'use strict';

  var ANIM_VERSION = 1;
  var HAS_EXPLICIT_FLOWS = ${hasAnimationsV2};
  var EXPLICIT_FLOWS = ${flowsJson};
  var RUNTIME_CONFIG = ${runtimeJson};
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

  // ---- 内置 Effect：card_create / card_fold / card_evict ----
  // 卡片通用样式常量（与 scripts.ts 中的 Section 卡片保持视觉一致）
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

  // 获取/创建卡片容器（flow.to 指向的节点内的 <g data-card-container>)
  // 若节点内没有显式容器，则在节点下创建一个并返回
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

  // 计算容器内所有卡片的目标布局（按 DOM 顺序）
  function layoutCards(container, nodeRect) {
    var cards = container.querySelectorAll('g.card-v2:not(.evicting)');
    var yCursor = nodeRect.y + CARD_STYLE.padY;
    var cardX = nodeRect.x + CARD_STYLE.padX;
    var cardW = nodeRect.w - CARD_STYLE.padX * 2;
    cards.forEach(function(card) {
      var folded = card.classList.contains('folded');
      var h = folded ? CARD_STYLE.foldedH : CARD_STYLE.activeH;
      card.setAttribute('transform', 'translate(0,0)');
      var rect = card.querySelector('rect');
      if (rect) {
        rect.setAttribute('x', cardX);
        rect.setAttribute('y', yCursor);
        rect.setAttribute('width', cardW);
        rect.setAttribute('height', h);
      }
      // 同步文字 y
      var title = card.querySelector('.card-title');
      if (title) title.setAttribute('y', yCursor + 17);
      var body = card.querySelector('.body-text');
      if (body) body.setAttribute('y', yCursor + 34);
      var badge = card.querySelector('.fold-badge');
      if (badge) badge.setAttribute('y', yCursor + 17);
      yCursor += h + CARD_STYLE.gap;
    });
    return yCursor;
  }

  // 创建一张卡片 SVG 元素（不附加到 DOM）
  function buildCardElement(value) {
    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'g');
    var folded = (value && value.status === 'folded');
    g.setAttribute('class', 'card-v2' + (folded ? ' folded' : ''));
    g.setAttribute('data-card-id', value && value.id ? value.id : ('card_' + Date.now()));
    g.setAttribute('opacity', '0');

    var rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('rx', '4');
    rect.setAttribute('fill', folded ? CARD_STYLE.foldedFill : CARD_STYLE.activeFill);
    rect.setAttribute('stroke', folded ? CARD_STYLE.foldedStroke : CARD_STYLE.activeStroke);
    rect.setAttribute('stroke-width', '1');
    g.appendChild(rect);

    var title = document.createElementNS(ns, 'text');
    title.setAttribute('class', 'card-title');
    title.setAttribute('x', '0');
    title.setAttribute('y', '17');
    title.setAttribute('fill', folded ? CARD_STYLE.foldedTitleColor : CARD_STYLE.titleColor);
    title.setAttribute('font-size', '11');
    title.setAttribute('font-weight', folded ? '600' : '500');
    var titleStr = (value && (value.summary || value.id)) || 'Untitled';
    if (titleStr.length > 42) titleStr = titleStr.substring(0, 40) + '...';
    title.textContent = (folded ? '📦 ' : '📝 ') + titleStr;
    g.appendChild(title);

    if (!folded) {
      var body = document.createElementNS(ns, 'text');
      body.setAttribute('class', 'body-text');
      body.setAttribute('x', '0');
      body.setAttribute('y', '34');
      body.setAttribute('fill', CARD_STYLE.bodyColor);
      body.setAttribute('font-size', '10');
      var msg = (value && value.messages) || 0;
      var tok = (value && value.tokens) || 0;
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
    return g;
  }

  // effect: card_create —— 在 flow.to 节点内创建一张新卡片（淡入）
  EffectRegistry.register('card_create', function(ctx) {
    var flow = ctx.flow;
    var value = ctx.value || (flow && flow.rawFlow && flow.rawFlow.value) || {};
    var container = ensureCardContainer(flow.to);
    if (!container) return false;

    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;

    var card = buildCardElement(value);
    container.appendChild(card);

    // 重排所有卡片位置
    layoutCards(container, nodeRect);

    // 设置 badge 的 x（依赖 width，需要在 layout 之后）
    var cardW = nodeRect.w - CARD_STYLE.padX * 2;
    var badge = card.querySelector('.fold-badge');
    if (badge) badge.setAttribute('x', nodeRect.x + CARD_STYLE.padX + cardW - 8);
    // 设置 title/body 的 x
    var title = card.querySelector('.card-title');
    if (title) title.setAttribute('x', nodeRect.x + CARD_STYLE.padX + 10);
    var body = card.querySelector('.body-text');
    if (body) body.setAttribute('x', nodeRect.x + CARD_STYLE.padX + 10);

    // 淡入动画（从下方上移）
    var startTime = performance.now();
    var duration = 300;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      card.setAttribute('opacity', String(ease));
      card.setAttribute('transform', 'translate(0,' + ((1 - ease) * 12) + ')');
      if (progress < 1) requestAnimationFrame(tick);
      else { card.setAttribute('opacity', '1'); card.removeAttribute('transform'); }
    }
    requestAnimationFrame(tick);
    return true;
  });

  // effect: card_fold —— 折叠指定卡片（cardId 通过 value.cardId 或 value.id 传入）
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

    var rect = card.querySelector('rect');
    if (!rect) return false;
    var fromH = CARD_STYLE.activeH;
    var toH = CARD_STYLE.foldedH;

    // 切换样式
    card.classList.add('folded');
    rect.setAttribute('fill', CARD_STYLE.foldedFill);
    rect.setAttribute('stroke', CARD_STYLE.foldedStroke);

    // 切换 title 颜色/前缀，移除 body，添加 badge
    var title = card.querySelector('.card-title');
    if (title) {
      title.setAttribute('fill', CARD_STYLE.foldedTitleColor);
      title.setAttribute('font-weight', '600');
      var titleStr = title.textContent.replace(/^[📝📦] /, '');
      title.textContent = '📦 ' + titleStr;
    }
    var body = card.querySelector('.body-text');
    if (body) body.remove();

    var existingBadge = card.querySelector('.fold-badge');
    if (!existingBadge) {
      var ns = 'http://www.w3.org/2000/svg';
      var badge = document.createElementNS(ns, 'text');
      badge.setAttribute('class', 'fold-badge');
      badge.setAttribute('text-anchor', 'end');
      badge.setAttribute('fill', CARD_STYLE.bodyColor);
      badge.setAttribute('font-size', '10');
      badge.textContent = '✂ folded';
      card.appendChild(badge);
    }

    // 高度过渡动画
    var startTime = performance.now();
    var duration = 300;
    var baseY = parseFloat(rect.getAttribute('y')) || 0;
    var cardW = nodeRect.w - CARD_STYLE.padX * 2;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      rect.setAttribute('height', String(fromH + (toH - fromH) * ease));
      if (title) title.setAttribute('y', baseY + 17);
      var badge2 = card.querySelector('.fold-badge');
      if (badge2) {
        badge2.setAttribute('y', baseY + 17);
        badge2.setAttribute('x', nodeRect.x + CARD_STYLE.padX + cardW - 8);
      }
      if (progress < 1) requestAnimationFrame(tick);
      else {
        // 动画结束后重排所有卡片位置
        layoutCards(container, nodeRect);
      }
    }
    requestAnimationFrame(tick);
    return true;
  });

  // effect: card_evict —— 淘汰容器内最旧（DOM 顺序第一张）的卡片（左滑+淡出）
  EffectRegistry.register('card_evict', function(ctx) {
    var flow = ctx.flow;
    var container = ensureCardContainer(flow.to);
    if (!container) return false;

    var nodeRect = getNodeRect(flow.to);
    if (!nodeRect) return false;

    var cards = container.querySelectorAll('g.card-v2:not(.evicting)');
    if (cards.length === 0) return false;

    var card = cards[0];
    card.classList.add('evicting');
    var cardW = nodeRect.w - CARD_STYLE.padX * 2;

    var startTime = performance.now();
    var duration = 400;
    function tick(now) {
      var progress = Math.min((now - startTime) / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      card.setAttribute('transform', 'translate(' + (-ease * (cardW + 30)) + ',0)');
      card.setAttribute('opacity', String(1 - ease));
      if (progress < 1) requestAnimationFrame(tick);
      else {
        if (card.parentNode) card.parentNode.removeChild(card);
        // 淘汰后重排剩余卡片
        layoutCards(container, nodeRect);
      }
    }
    requestAnimationFrame(tick);
    return true;
  });

  // ---- 状态管理 ----
  var state = {
    activeParticles: [],
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

  // ---- L0/L2 默认行为与显式流 ----
  function startDefaultFlows() {
    var periodicFlows = [];
    var eventFlows = [];

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
          effect: f.effect || 'particle_flow',
          explicit: true,
          rawFlow: f
        };

        if (f.trigger.type === 'periodic') {
          periodicFlows.push(flowConfig);
        } else if (f.trigger.type === 'event') {
          eventFlows.push({ config: flowConfig, eventName: f.trigger.event });
        }
        // state_change 和 manual 暂不在启动时注册，由其他机制触发
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
  }

  // ---- L2 事件触发：监听仿真器事件 ----
  function setupEventTriggers(eventFlows) {
    // 监听 window.__sim__ 的事件触发
    // 仿真器在触发事件时会调用 window.__simEventListener__(eventName, payload)
    var listeners = {};

    eventFlows.forEach(function(ef) {
      var eventName = ef.eventName;
      if (!listeners[eventName]) listeners[eventName] = [];
      listeners[eventName].push(ef.config);
    });

    window.__simEventListener__ = function(eventName, payload) {
      var configs = listeners[eventName];
      if (!configs) return;
      for (var i = 0; i < configs.length; i++) {
        spawnDefaultParticle(configs[i]);
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

  function spawnDefaultParticle(flow) {
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

    var fromCenter = getNodeCenter(flow.from);
    var toCenter = getNodeCenter(flow.to);
    if (!fromCenter || !toCenter) {
      return;
    }

    var fromRect = getNodeRect(flow.from);
    var toRect = getNodeRect(flow.to);
    if (!fromRect || !toRect) return;

    var start = intersectRect(fromCenter, toCenter, fromRect);
    var end = intersectRect(toCenter, fromCenter, toRect);

    var layer = ensureAnimLayer();
    if (!layer) return;

    var ns = 'http://www.w3.org/2000/svg';
    var g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'anim-particle-v2');
    g.style.opacity = '0';
    g.style.transition = 'opacity 0.3s';

    // 粒子主体：带值类型标签的圆形
    var circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('r', '6');
    circle.setAttribute('fill', flow.color || '#4fc3f7');
    circle.setAttribute('opacity', '0.9');
    circle.setAttribute('stroke', '#ffffff');
    circle.setAttribute('stroke-width', '1');
    g.appendChild(circle);

    // L2 值类型标签（显示在粒子上方）
    if (flow.valueLabel) {
      var labelBg = document.createElementNS(ns, 'rect');
      var labelText = flow.valueLabel;
      var labelWidth = Math.max(labelText.length * 6 + 8, 30);
      labelBg.setAttribute('x', -labelWidth / 2);
      labelBg.setAttribute('y', -22);
      labelBg.setAttribute('width', labelWidth);
      labelBg.setAttribute('height', '14');
      labelBg.setAttribute('rx', '3');
      labelBg.setAttribute('fill', flow.color || '#4fc3f7');
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
    } else if (flow.label) {
      // L0 默认标签（较简朴）
      var text0 = document.createElementNS(ns, 'text');
      text0.setAttribute('x', '0');
      text0.setAttribute('y', '-10');
      text0.setAttribute('text-anchor', 'middle');
      text0.setAttribute('fill', '#ffffff');
      text0.setAttribute('style', 'font-size:10px;pointer-events:none;');
      text0.textContent = flow.label;
      g.appendChild(text0);
    }

    layer.appendChild(g);

    var particle = {
      el: g,
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      t: 0,
      speed: 0.012,
      color: flow.color,
      label: flow.valueLabel || flow.label,
      valueType: flow.valueType,
      flowId: flow.id,
      targetNodeId: flow.to,
      branches: flow.branches,
      onComplete: null
    };

    // L2: 粒子到达终点时显示输入/输出提示
    if (flow.explicit && flow.valueType) {
      particle.onComplete = function(p) {
        showNodeIOPrompt(p.targetNodeId, p.valueType, p.label);
      };
    }

    state.activeParticles.push(particle);

    // 淡入
    requestAnimationFrame(function() { g.style.opacity = '1'; });

    if (!state.animFrame) {
      tickParticles();
    }
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

    // 定位在节点右侧上方
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

    // 淡入 → 停留 1.5s → 淡出
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

      if (p.t >= 1) {
        // 到达终点
        p.t = 1;
        var x = p.endX;
        var y = p.endY;
        p.el.setAttribute('transform', 'translate(' + x + ',' + y + ')');

        // 触发完成回调（L4 handler 处理）
        if (p.onComplete) {
          p.onComplete(p);
        } else {
          // 默认：淡出移除
          fadeOutParticle(p);
        }
      } else {
        // 沿直线插值
        var x = p.startX + (p.endX - p.startX) * p.t;
        var y = p.startY + (p.endY - p.startY) * p.t;
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

  function fadeOutParticle(p) {
    p.el.style.transition = 'opacity 0.3s';
    p.el.style.opacity = '0';
    setTimeout(function() {
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    }, 300);
  }

  // ---- L1 默认行为：状态变化高亮 ----
  function startStatusWatch() {
    // 初始化快照
    for (var i = 0; i < STATUS_NODES.length; i++) {
      var sn = STATUS_NODES[i];
      state.prevStatusSnapshot[sn.id] = sn.status;
    }

    // 定期检查节点 status 变化（DOM 上的 data-status 属性）
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

        // in_progress 呼吸效果
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

    // 闪烁动画
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
    if (el.dataset.breathingApplied) return; // 避免重复应用
    el.dataset.breathingApplied = 'true';

    var shape = el.querySelector('rect[data-shape="true"], circle[data-shape="true"], polygon[data-shape="true"]');
    if (!shape) return;

    // 用 CSS animation 实现呼吸
    shape.style.animation = 'anim-v2-breathing 2s ease-in-out infinite';

    // 注入 keyframes（只注入一次）
    if (!document.getElementById('anim-v2-breathing-style')) {
      var style = document.createElement('style');
      style.id = 'anim-v2-breathing-style';
      style.textContent = '@keyframes anim-v2-breathing { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }';
      document.head.appendChild(style);
    }

    // 监听 status 变化，移除呼吸效果
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

  // ---- 暂停/步进控制 ----
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

  // ---- 启动 ----
  function start() {
    if (state.started) return;
    state.started = true;

    // 等待 DOM 渲染完成（scripts.ts 可能在动画脚本之后才渲染节点）
    setTimeout(function() {
      try {
        startDefaultFlows();
        startStatusWatch();
        console.log('[animV2] started, flows:', Object.keys(state.flowTimers).length, 'statusNodes:', STATUS_NODES.length);
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
