/**
 * HTML 渲染器：DSL → 自包含 HTML 字符串
 *
 * 渲染原则：
 * - 单 HTML 文件，内联所有 CSS+JS，零外部依赖
 * - SVG 画布：节点矩形 + 边连线
 * - 右侧 sidebar：semantic 卡片 + 不变式
 * - hover 节点/边 → 显示 annotations tooltip
 * - 底部导出按钮：序列化 window.__DSL__ → 下载 <feature>.json
 */

import type { DesignDSL, Node, Edge, SemanticFile } from '../dsl/types.js';
import { buildStyles } from './styles.js';
import { buildScript } from './scripts.js';
import { buildAnimationScript } from './animation_engine.js';
import { computeEdgePath } from './edge_geom.js';
import type { GRect } from './edge_geom.js';
import { schemaToHuman } from './shape_card.js';

/** 障碍矩形（edge_geom.GRect 的本地别名，保持调用处可读性） */
type RectBox = GRect;

/** 计算节点矩形边界（带默认尺寸；形状卡节点默认更宽更高） */
function nodeBox(n: Node): GRect {
  const rows = (n.shapes?.in ? 1 : 0) + (n.shapes?.out ? 1 : 0);
  const hasShapes = rows > 0;
  return {
    x: n.x ?? 0,
    y: n.y ?? 0,
    w: n.width ?? (hasShapes ? 240 : 120),
    h: n.height ?? (hasShapes ? 34 + rows * 24 + 10 : 60),
  };
}

/** 计算边 path：委托 edge_geom.computeEdgePath（单源，浏览器运行时共用同一实现） */
function computeEdgeGeom(from: Node, to: Node, edgeType?: string, offset: number = 0, obstacles?: RectBox[]) {
  return computeEdgePath({
    fromBox: nodeBox(from),
    toBox: nodeBox(to),
    selfLoop: from.id === to.id,
    edgeType,
    offset,
    obstacles,
  });
}

/** HTML 转义 */
function esc(s: string | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c] as string);
}

/** 计算画布尺寸：优先用 geometry.width/height，缺失时根据节点推导 */
function computeCanvasSize(dsl: DesignDSL): { width: number; height: number } {
  const explicitW = dsl.geometry.width;
  const explicitH = dsl.geometry.height;
  if (explicitW != null && explicitH != null) {
    return { width: explicitW, height: explicitH };
  }

  let maxX = 0;
  let maxY = 0;
  for (const n of dsl.geometry.nodes) {
    // 深层节点默认隐藏（层角标展开才可见），不参与初始画布尺寸，
    // 否则隐藏节点把画布撑出大片空白（展开后由前端 updateCanvasViewBox 按需扩展）
    if ((n.layer ?? 'main') !== 'main') continue;
    const b = nodeBox(n);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return {
    width: explicitW ?? maxX + 50,
    height: explicitH ?? maxY + 50,
  };
}

/** 渲染单个 SVG 节点 */
/** 渲染内容块为 HTML */
function renderContentBlocks(blocks: import('../dsl/types.js').ContentBlock[]): string {
  return blocks
    .filter((b) => b.visible !== false)
    .map((block) => {
      switch (block.type) {
        case 'text': {
          const s = block.style ?? {};
          const css = [
            s.fontSize ? `font-size:${s.fontSize}px` : '',
            s.bold ? 'font-weight:bold' : '',
            s.italic ? 'font-style:italic' : '',
            s.color ? `color:${s.color}` : '',
            s.align ? `text-align:${s.align}` : '',
          ]
            .filter(Boolean)
            .join(';');
          return `<div class="cb-text" style="${css}">${esc(block.value ?? '')}</div>`;
        }
        case 'image':
          return `<div class="cb-image"><img src="${esc(block.src ?? '')}" style="width:${block.width ?? '100%'}px;height:${block.height ?? 'auto'}px;object-fit:cover;border-radius:4px;" loading="lazy"/></div>`;
        case 'color_block': {
          const css = [
            block.bg ? `background:${block.bg}` : '',
            block.border ? `border:${block.border}` : '',
            block.borderRadius ? `border-radius:${block.borderRadius}px` : '',
            block.padding ? `padding:${block.padding}px` : '',
          ]
            .filter(Boolean)
            .join(';');
          const children = block.children ? renderContentBlocks(block.children) : '';
          return `<div class="cb-color-block" style="${css}">${children}</div>`;
        }
        case 'spacer':
          return `<div class="cb-spacer" style="height:${block.spacerHeight ?? 8}px"></div>`;
        case 'code':
          return `<div class="cb-code" data-lang="${esc(block.language ?? '')}">${esc(block.value ?? '')}</div>`;
        case 'list': {
          const tag = block.listType === 'ol' ? 'ol' : 'ul';
          const items = (block.items ?? []).map((item) => `<li>${esc(item)}</li>`).join('');
          return `<${tag} class="cb-list">${items}</${tag}>`;
        }
        case 'divider':
          return `<div class="cb-divider"></div>`;
        case 'badge':
          return `<div class="cb-badge" style="background:${block.badgeColor ?? 'var(--theme-primary)'}">${esc(block.value ?? '')}</div>`;
        default:
          return '';
      }
    })
    .join('');
}

function renderNode(n: Node, parentIds?: Set<string>): string {
  const b = nodeBox(n);
  const style = n.style ?? {};
  // tone 语义色优先于显式 bg；均无时走主题变量
  const toneFill = style.tone ? `var(--theme-${style.tone})` : '';
  const fill = style.bg ?? toneFill;
  const stroke = (style.border ?? '').split(' ').pop() ?? '';
  // 未显式指定配色的节点跟随主题：走 inline style（支持 var()），
  // 选中/状态/动画等 CSS 规则带 !important 或更高优先级，可正常覆盖
  const themedCss: string[] = [];
  if (!fill) themedCss.push('fill:var(--theme-card-bg)');
  if (!stroke) themedCss.push('stroke:var(--theme-border)');
  const themedAttr = themedCss.length ? ` style="${themedCss.join(';')}"` : '';
  const fillAttr = fill ? ` fill="${esc(fill)}"` : '';
  const strokeAttr = ` stroke-width="1"${stroke ? ` stroke="${esc(stroke)}"` : ''}`;
  const rx = style.borderRadius ?? 8;
  const shape = style.shape ?? 'rounded';

  const textColor = style.color ?? '#ffffff';
  const label = n.label ?? n.id;

  // 是否为父节点（含子组件）：平铺布局下文字上移到顶部，避免与子节点重叠
  const isParent = parentIds ? parentIds.has(n.id) : false;

  const hasSubDsl = !!n.sub_dsl;
  const status = n.status ?? 'draft';

  // 状态 CSS class：status-draft / status-in-progress / status-done
  const statusClass = `status-${status.replace('_', '-')}`;

  const classes = ['node'];
  if (hasSubDsl) classes.push('has-sub-dsl');
  classes.push(statusClass);
  if (n.content && n.content.type !== 'text') classes.push('rich-node');
  const nodeClass = classes.join(' ');

  // 职责分层：深层节点初始隐藏，运行时由角标/全局开关展开
  const layer = n.layer ?? 'main';
  const layerAttr = layer !== 'main' ? ` data-layer="${layer}"` : '';
  const hostAttr = n.host ? ` data-host="${esc(n.host)}"` : '';
  const hiddenAttr = layer !== 'main' ? ' style="display:none"' : '';

  // 状态指示器：右上角小圆点
  const statusColors: Record<string, string> = {
    draft: '#666',
    in_progress: '#FF9800',
    done: '#4CAF50',
  };
  const dotColor = statusColors[status] ?? '#666';
  const dotX = b.x + b.w - 8;
  const dotY = b.y + 8;

  // 形状 SVG 元素
  let shapeSvg = '';
  const shadowAttr = style.shadow ? `filter="url(#nodeShadow)"` : '';
  if (shape === 'circle') {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = Math.min(b.w, b.h) / 2;
    shapeSvg = `<circle data-shape="true" cx="${cx}" cy="${cy}" r="${r}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  } else if (shape === 'diamond') {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    shapeSvg = `<polygon data-shape="true" points="${cx},${b.y} ${b.x + b.w},${cy} ${cx},${b.y + b.h} ${b.x},${cy}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  } else if (shape === 'parallelogram') {
    const skew = 30;
    shapeSvg = `<polygon data-shape="true" points="${b.x + skew},${b.y} ${b.x + b.w + skew},${b.y} ${b.x + b.w},${b.y + b.h} ${b.x},${b.y + b.h}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  } else if (shape === 'hexagon') {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const rx = b.w / 2;
    const ry = b.h / 2;
    shapeSvg = `<polygon data-shape="true" points="${cx},${b.y} ${cx + rx},${b.y + ry * 0.4} ${cx + rx},${b.y + ry * 1.6} ${cx},${b.y + b.h} ${cx - rx},${b.y + ry * 1.6} ${cx - rx},${b.y + ry * 0.4}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  } else if (shape === 'triangle') {
    shapeSvg = `<polygon data-shape="true" points="${b.x + b.w / 2},${b.y} ${b.x + b.w},${b.y + b.h} ${b.x},${b.y + b.h}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  } else {
    // rect / rounded / freeform
    shapeSvg = `<rect data-shape="true" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${rx}" ${fillAttr}${strokeAttr}${themedAttr} ${shadowAttr}/>`;
  }

  // 内容渲染
  const shapeRows: Array<{ dir: 'in' | 'out'; text: string }> = [];
  if (n.shapes?.in) shapeRows.push({ dir: 'in', text: schemaToHuman(n.shapes.in) });
  if (n.shapes?.out) shapeRows.push({ dir: 'out', text: schemaToHuman(n.shapes.out) });
  const hasShapes = shapeRows.length > 0;
  let contentSvg = '';
  if (n.content && n.content.type === 'rich' && n.content.blocks && n.content.blocks.length > 0) {
    // 富文本节点：用 foreignObject 内嵌 HTML
    const html = renderContentBlocks(n.content.blocks);
    contentSvg = `<foreignObject x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"><div xmlns="http://www.w3.org/1999/xhtml" class="rich-content" style="width:${b.w}px;height:${b.h}px;padding:8px;overflow:hidden;color:${esc(textColor)};">${html}</div></foreignObject>`;
  } else {
    // 纯文字节点：SVG text，根据节点宽度自适应字体大小
    const textX = b.x + b.w / 2;
    // 平铺布局：父节点文字上移到顶部（y+18），子节点保持居中；形状卡节点标签同样置顶
    const textY = isParent || hasShapes ? b.y + 18 : b.y + b.h / 2;
    // 根据节点宽度和标签长度估算合适的字体大小
    const labelLen = label.length;
    const maxByWidth = Math.floor((b.w - 16) / Math.max(labelLen * 0.6, 1));
    const maxByHeight = Math.floor((b.h - 8) / 1.4);
    const fontSize = Math.max(11, Math.min(18, maxByWidth, maxByHeight));
    const dy = isParent || hasShapes ? '0' : '0.35em';
    contentSvg = `<text x="${textX}" y="${textY}" text-anchor="middle" dy="${dy}" fill="${esc(textColor)}" style="font-size:${fontSize}px" ${isParent ? 'class="label-top"' : ''}>${esc(label)}</text>`;
    // D1 数据形状卡：进/出料口人话形状（纯展示，pointer-events=none 不抢拖拽）
    if (hasShapes) {
      const rowsHtml = shapeRows
        .map(
          (r) =>
            `<div class="shape-row ${r.dir}"><span class="shape-dir">${r.dir === 'in' ? '进' : '出'}</span><span class="shape-body">${esc(r.text)}</span></div>`,
        )
        .join('');
      contentSvg += `<foreignObject x="${b.x + 6}" y="${b.y + 28}" width="${b.w - 12}" height="${b.h - 34}" pointer-events="none"><div xmlns="http://www.w3.org/1999/xhtml" class="shape-card">${rowsHtml}</div></foreignObject>`;
    }
  }

  return `    <g class="${nodeClass}" data-id="${esc(n.id)}" data-label="${esc(label)}" data-has-sub-dsl="${hasSubDsl}" data-status="${status}"${layerAttr}${hostAttr}${hiddenAttr}>
      ${shapeSvg}
      ${contentSvg}
      <circle cx="${dotX}" cy="${dotY}" r="4" fill="${dotColor}" stroke="#ffffff" stroke-width="0.5"/>
    </g>`;
}

/** 渲染单条 SVG 边 */
function renderEdge(
  e: Edge,
  nodeMap: Map<string, Node>,
  offsetInfo?: { index: number; total: number },
  obstaclesFor?: (fromId: string, toId: string) => RectBox[],
): string {
  const from = nodeMap.get(e.from);
  const to = nodeMap.get(e.to);
  if (!from || !to) return '';
  const edgeType = e.type ?? 'curve';

  // 边重叠退避：同对 (from→to) 的多条边按索引分配垂直偏移
  let pathOffset = 0;
  if (offsetInfo && offsetInfo.total > 1) {
    // 居中分配：index=0 最负，index=total-1 最正
    pathOffset = (offsetInfo.index - (offsetInfo.total - 1) / 2) * 18;
  }
  // contains 边（隐藏）不做绕障；其余边自动绕开障碍节点
  const label0 = (e.label ?? '').toLowerCase();
  const isContains = label0 === 'contains' || label0 === '包含';
  const obstacles = !isContains && obstaclesFor ? obstaclesFor(e.from, e.to) : undefined;
  const geom = computeEdgeGeom(from, to, edgeType, pathOffset, obstacles);
  const d = geom.d;
  // 未显式指定颜色的边跟随主题边色（edge-themed class 优先级低于 .edge.selected 规则）
  const strokeAttr = e.style?.stroke ? `stroke="${esc(e.style.stroke)}"` : 'class="edge-themed"';
  const strokeWidth = e.style?.strokeWidth ?? 2;
  const arrowDir = e.arrow ?? 'forward';
  const isDashed = edgeType === 'dashed';

  // 箭头 marker
  const markerStart = (arrowDir === 'reverse' || arrowDir === 'both') ? 'marker-start="url(#arrow-reverse)"' : '';
  const markerEnd = (arrowDir === 'forward' || arrowDir === 'both') ? 'marker-end="url(#arrow)"' : '';
  const dashAttr = isDashed ? 'stroke-dasharray="6 4"' : '';

  // 标签位置：曲线控制点（与运行时 updateConnectedEdges 行为一致）
  const labelX = geom.cpX;
  const labelY = geom.cpY;

  const labelText = e.label ?? '';
  // 流向边（↓ 流向）标签默认显示；其他边标签 hover 显示
  const isFlowLabel = labelText.includes('流向') || labelText.includes('flow');
  const labelOpacity = isFlowLabel ? '0.85' : '0';
  const labelXml = labelText
    ? `<text class="edge-label" x="${labelX}" y="${labelY}" text-anchor="middle" dy="-4" opacity="${labelOpacity}">${esc(labelText)}</text>`
    : '';

  // 职责分层：显式 layer 优先，否则跟随端点较深层（detail > error > main）
  const layerRank = (l?: string): number => (l === 'detail' ? 2 : l === 'error' ? 1 : 0);
  const fromLayer = from.layer ?? 'main';
  const toLayer = to.layer ?? 'main';
  const derived = layerRank(fromLayer) >= layerRank(toLayer) ? fromLayer : toLayer;
  const edgeLayer = e.layer ?? derived;
  const layerAttr = edgeLayer !== 'main' ? ` data-layer="${edgeLayer}"` : '';
  const hiddenAttr = edgeLayer !== 'main' ? ' style="display:none"' : '';

  return `    <g class="edge" data-id="${esc(e.id)}" data-label="${esc(labelText)}" data-type="${esc(edgeType)}"${layerAttr}${hiddenAttr}>
      <path d="${d}" stroke="transparent" stroke-width="15" fill="none" pointer-events="stroke"/>
      <path d="${d}" ${strokeAttr} stroke-width="${strokeWidth}" ${markerStart} ${markerEnd} ${dashAttr} fill="none" pointer-events="none"/>
      ${labelXml}
    </g>`;
}

/** 渲染仿真依赖边：从规则的 from_node -> to_nodes 生成可视化连线 */
function renderSimEdges(
  dsl: DesignDSL,
  nodeMap: Map<string, Node>,
  obstaclesFor?: (fromId: string, toId: string) => RectBox[],
): string {
  if (!dsl.simulation?.rules) return '';
  const rules = dsl.simulation.rules;
  const edges: string[] = [];
  let idx = 0;
  for (const rule of rules) {
    if (!rule.from_node || !rule.to_nodes || rule.to_nodes.length === 0) continue;
    const from = nodeMap.get(rule.from_node);
    if (!from) continue;
    for (const toId of rule.to_nodes) {
      const to = nodeMap.get(toId);
      if (!to) continue;
      idx++;
      const edgeId = 'sim-edge-' + idx;
      const geom = computeEdgeGeom(from, to, 'curve', 0, obstaclesFor ? obstaclesFor(rule.from_node, toId) : undefined);
      const d = geom.d;
      const label = rule.name || rule.event;
      // 标签定位到控制点（与运行时行为一致）
      const midX = geom.cpX;
      const midY = geom.cpY;
      // 编码规则详情供 tooltip 使用（HTML 转义 + base64 避免 quote 冲突）
      const detail = {
        id: rule.id,
        name: rule.name,
        event: rule.event,
        condition: rule.condition ?? '',
        from: rule.from_node,
        to: toId,
        emits: rule.emits ?? [],
      };
      const detailJson = esc(JSON.stringify(detail));
      edges.push(
        '    <g class="sim-edge" data-id="' + esc(edgeId) + '" data-rule="' + esc(rule.id) + '" data-event="' + esc(rule.event) + '" data-detail="' + detailJson + '" data-from="' + esc(rule.from_node) + '" data-to="' + esc(toId) + '">' +
        '      <path class="sim-edge-hit" d="' + d + '" stroke="transparent" stroke-width="15" fill="none" pointer-events="stroke"/>' +
        '      <path class="sim-edge-path" d="' + d + '" stroke="#9b59b6" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#sim-arrow)" fill="none" pointer-events="none"/>' +
        '      <path class="sim-edge-flow" d="' + d + '" stroke="#e74c3c" stroke-width="2.5" stroke-dasharray="8 200" stroke-linecap="round" fill="none" style="stroke-dashoffset:200" pointer-events="none"/>' +
        '      <text class="sim-edge-label" x="' + midX + '" y="' + midY + '" text-anchor="middle" dy="-6" opacity="0.7">' + esc(label) + '</text>' +
        '    </g>'
      );
    }
  }
  return edges.join('\n');
}

function extractFuncName(signature: string): string {
  const match = signature.match(/(?:\w+\.)?(\w+)\s*\(/);
  return match ? match[1] : signature;
}

function renderCard(file: SemanticFile): string {
  const expected = file.expected_apis ?? [];
  const actual = file.actual_apis ?? [];

  const actualNames = new Set(actual.map((a) => extractFuncName(a.signature)));
  const expectedNames = new Set(expected.map((a) => extractFuncName(a.signature)));

  const matchedApis = expected.filter((a) => actualNames.has(extractFuncName(a.signature)));
  const missingApis = expected.filter((a) => !actualNames.has(extractFuncName(a.signature)));
  const extraApis = actual.filter((a) => !expectedNames.has(extractFuncName(a.signature)));

  const apiHtml = [];

  if (matchedApis.length > 0) {
    apiHtml.push(`<div class="api-section"><span class="api-status status-done">✓</span> 已实现 (${matchedApis.length})</div>`);
    apiHtml.push(...matchedApis.map((a) => `<div class="api api-done">${esc(a.signature)}${a.notes ? ` <span class="notes">// ${esc(a.notes)}</span>` : ''}</div>`));
  }

  if (missingApis.length > 0) {
    apiHtml.push(`<div class="api-section"><span class="api-status status-missing">✗</span> 未实现 (${missingApis.length})</div>`);
    apiHtml.push(...missingApis.map((a) => `<div class="api api-missing">${esc(a.signature)}${a.notes ? ` <span class="notes">// ${esc(a.notes)}</span>` : ''}</div>`));
  }

  if (extraApis.length > 0) {
    apiHtml.push(`<div class="api-section"><span class="api-status status-extra">+</span> 代码新增 (${extraApis.length})</div>`);
    apiHtml.push(...extraApis.map((a) => `<div class="api api-extra">${esc(a.signature)}${a.notes ? ` <span class="notes">// ${esc(a.notes)}</span>` : ''}</div>`));
  }

  const apis = apiHtml.join('');
  const deps = (file.expected_deps ?? [])
    .map((d) => `<span>${esc(d)}</span>`)
    .join('');

  return `      <article class="card" data-id="${esc(file.id)}">
        <div class="path">${esc(file.path)}</div>
        <div class="responsibility">${esc(file.responsibility)}</div>
        ${apis ? `<div class="apis">${apis}</div>` : ''}
        ${deps ? `<div class="deps">deps: ${deps}</div>` : ''}
      </article>`;
}

/** 渲染泳道背景 */
function renderSwimlanes(dsl: DesignDSL): string {
  if (!dsl.geometry.swimlanes || dsl.geometry.swimlanes.length === 0) return '';

  const swimlanes = dsl.geometry.swimlanes;
  const width = dsl.geometry.width ?? 800;

  // 按节点 y 坐标分配泳道高度
  const swimlaneNodes = new Map<string, Node[]>();
  dsl.geometry.nodes.forEach(n => {
    const laneId = n.swimlane || 'default';
    if (!swimlaneNodes.has(laneId)) swimlaneNodes.set(laneId, []);
    swimlaneNodes.get(laneId)!.push(n);
  });

  const defaultColors = ['#152141', '#1a1f3c', '#141f38', '#1c2747'];
  const xml: string[] = [];

  swimlanes.forEach((lane, i) => {
    const nodes = swimlaneNodes.get(lane.id) || [];
    if (nodes.length === 0) return;

    // 计算泳道范围
    const minY = Math.min(...nodes.map(n => n.y ?? 0));
    const maxY = Math.max(...nodes.map(n => (n.y ?? 0) + (n.height ?? 50)));
    const laneY = lane.y ?? minY - 20;
    const laneHeight = lane.height ?? (maxY - minY + 60);

    const bg = lane.bg || defaultColors[i % defaultColors.length];
    const color = lane.color || '#8b9bb4';
    const label = lane.label || lane.id;

    xml.push(`    <g class="swimlane" data-id="${esc(lane.id)}">
      <rect x="0" y="${laneY}" width="${width}" height="${laneHeight}" fill="${esc(bg)}" opacity="0.4"/>
      <text x="10" y="${laneY + 24}" fill="${esc(color)}" font-size="13" font-weight="600">${esc(label)}</text>
    </g>`);
  });

  return xml.join('\n');
}

/**
 * 职责分层自动推导（F2）：无显式 layer 的节点按规则推导。
 * 规则：animations_v2 flows[].handler.errors[].to → error 层，host=flow.from（异常从哪来挂哪）。
 * 豁免：该节点若同时承担主干流转职责（任一 flow 的 from/to/branches.to），不折叠——
 *   异常出口只是它的职责之一（如 conveyor 的草稿区），折叠会隐藏主干组件。
 * 显式 layer 优先，不覆盖；host 指向不存在的节点时丢弃（跟随全局开关）。
 * 名字模式推导有意不做——import_project 产物中 errors.go 等文件名会误伤。
 * 返回加工副本（存储文件不动），浏览器端 window.__DSL__ 单源消费推导结果。
 */
function deriveLayers(dsl: DesignDSL): DesignDSL {
  const nodeIds = new Set(dsl.geometry.nodes.map((n) => n.id));
  const flows = dsl.animations_v2?.flows ?? [];

  // 主干职责节点：任一 flow 的正常流转端点
  const mainDuty = new Set<string>();
  for (const f of flows) {
    if (nodeIds.has(f.from)) mainDuty.add(f.from);
    if (f.to && nodeIds.has(f.to)) mainDuty.add(f.to);
    for (const b of f.branches ?? []) {
      if (nodeIds.has(b.to)) mainDuty.add(b.to);
    }
  }

  const derived = new Map<string, { host?: string }>();
  for (const f of flows) {
    for (const err of f.handler?.errors ?? []) {
      if (!nodeIds.has(err.to) || mainDuty.has(err.to) || derived.has(err.to)) continue;
      derived.set(err.to, { host: nodeIds.has(f.from) ? f.from : undefined });
    }
  }
  if (derived.size === 0) return dsl;

  let touched = false;
  const nodes = dsl.geometry.nodes.map((n) => {
    if (n.layer) return n;
    const d = derived.get(n.id);
    if (!d) return n;
    touched = true;
    return { ...n, layer: 'error' as const, ...(d.host && !n.host ? { host: d.host } : {}) };
  });
  if (!touched) return dsl;
  return { ...dsl, geometry: { ...dsl.geometry, nodes } };
}

/** 报告导读摘要：renderHTML 第二参数传入，生成打开即见的导读面板 */
export interface ReportSummary {
  /** 面板大标题（默认 dsl.title ?? dsl.feature） */
  heading?: string;
  /** 副标题一行（生成时间、数据源等） */
  subline?: string;
  /** 概况指标条 */
  metrics?: Array<{ label: string; value: string }>;
  /** 热点榜单：点击条目飞到对应节点并选中 */
  hotspots?: Array<{ node_id?: string; label: string; detail?: string; severity?: 'crit' | 'warn' }>;
  /** 推荐探索路径（有序），带 node_id 的项可点击飞行 */
  tour?: Array<{ node_id?: string; text: string }>;
}

export interface RenderOptions {
  report?: ReportSummary;
  /** 页面导航：注入"返回主页"链接（Hub 模式下子页面用） */
  nav?: { home_href?: string; home_label?: string };
  /** 紧凑工具栏：编辑类按钮（撤销/布局/导入导出/标注）收纳进 ⋯ 菜单（报告/浏览场景） */
  compact_toolbar?: boolean;
}

/** 报告导读面板：打开即见的摘要卡（指标/热点/推荐路径/图例），仅 options.report 存在时注入 */
function buildReportPanel(dsl: DesignDSL, report: ReportSummary): string {
  const heading = report.heading ?? dsl.title ?? dsl.feature;
  const metrics = report.metrics ?? [];
  const hotspots = report.hotspots ?? [];
  const tour = report.tour ?? [];
  const metricsHtml = metrics.length > 0
    ? `<div class="report-metrics">${metrics.map((m) => `<div class="report-metric"><div class="report-metric-val">${esc(m.value)}</div><div class="report-metric-label">${esc(m.label)}</div></div>`).join('')}</div>`
    : '';
  const hotspotsHtml = hotspots.length > 0
    ? `<ul class="report-hotspots">${hotspots.map((h) => `<li class="report-hotspot sev-${h.severity === 'crit' ? 'crit' : 'warn'}"${h.node_id ? ` data-fly="${esc(h.node_id)}"` : ''}><span class="report-hotspot-dot"></span><span class="report-hotspot-label">${esc(h.label)}</span><span class="report-hotspot-detail">${esc(h.detail ?? '')}</span></li>`).join('')}</ul>`
    : '<div class="report-empty">✅ 全部文件在阈值内，无巨石</div>';
  const tourHtml = tour.length > 0
    ? `<div class="report-section-title">🧭 推荐探索路径<span class="report-hint">带 ✈ 的步骤可点击定位</span></div><ol class="report-tour">${tour.map((t) => `<li class="report-tour-item"${t.node_id ? ` data-fly="${esc(t.node_id)}"` : ''}>${esc(t.text)}</li>`).join('')}</ol>`
    : '';
  return `      <div id="report-overlay" class="report-overlay">
        <div class="report-card">
          <button id="report-close" class="report-close" type="button" title="关闭，开始探索">✕</button>
          <div class="report-kicker">SELF-ANALYSIS REPORT</div>
          <h2 class="report-heading">${esc(heading)}</h2>
          ${report.subline ? `<div class="report-subline">${esc(report.subline)}</div>` : ''}
          ${metricsHtml}
          <div class="report-section-title">⚠ 巨石文件 TOP<span class="report-hint">点击条目直达节点</span></div>
          ${hotspotsHtml}
          ${tourHtml}
          <div class="report-section-title">📖 图例与操作</div>
          <div class="report-legend">
            <div class="report-legend-row">
              <span class="lg-item"><span class="lg-swatch lg-file"></span>文件（颜色=语言）</span>
              <span class="lg-item"><span class="lg-swatch lg-dir"></span>目录容器</span>
              <span class="lg-item"><span class="lg-shape">◆</span>分支</span>
              <span class="lg-item"><span class="lg-shape">⬡</span>循环</span>
              <span class="lg-item"><span class="lg-shape">●</span>入口/返回</span>
            </div>
            <div class="report-legend-row lg-ops">
              <span>单击节点=选中看详情</span><span>左上 ▸ 角标=展开内部</span><span>滚轮=缩放</span><span>拖拽空白=平移</span>
            </div>
          </div>
          <button id="report-start" class="report-start" type="button"${tour.length > 0 && tour[0].node_id ? ` data-fly="${esc(tour[0].node_id)}"` : ''}>${tour.length > 0 && tour[0].node_id ? '开始探索：直达第一站 →' : '开始探索 →'}</button>
        </div>
      </div>
`;
}

/** 主渲染入口：DSL → 完整 HTML 字符串 */
export function renderHTML(dsl: DesignDSL, options?: RenderOptions): string {
  // 职责分层自动推导（F2）：L4.5 handler.errors 声明的流向节点 → error 层（host=flow.from）
  // 烘焙进注入副本，存储文件不动；显式 layer 优先不覆盖
  dsl = deriveLayers(dsl);
  const canvas = computeCanvasSize(dsl);
  const nodeMap = new Map<string, Node>();
  for (const n of dsl.geometry.nodes) nodeMap.set(n.id, n);

  // 计算"父节点"集合（通过 contains 边推断）：平铺布局下父节点文字上移到顶部
  const parentIds = new Set<string>();
  const parentOfMap = new Map<string, string>();
  const childrenOfMap = new Map<string, string[]>();
  for (const e of (dsl.geometry.edges ?? [])) {
    const label = (e.label ?? '').toLowerCase();
    if (label === 'contains' || label === '包含') {
      parentIds.add(e.from);
      parentOfMap.set(e.to, e.from);
      const arr = childrenOfMap.get(e.from) ?? [];
      arr.push(e.to);
      childrenOfMap.set(e.from, arr);
    }
  }

  // 边绕障：收集除 from/to 及其祖先/后代外的所有节点矩形作为障碍
  const ancestorsOf = (id: string): string[] => {
    const out: string[] = [];
    let cur = parentOfMap.get(id);
    let guard = 0;
    while (cur && guard++ < 50) {
      out.push(cur);
      cur = parentOfMap.get(cur);
    }
    return out;
  };
  const descendantsOf = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(childrenOfMap.get(id) ?? [])];
    while (stack.length) {
      const x = stack.pop()!;
      out.push(x);
      stack.push(...(childrenOfMap.get(x) ?? []));
    }
    return out;
  };
  const obstaclesFor = (fromId: string, toId: string): RectBox[] => {
    const excluded = new Set<string>([
      fromId, toId,
      ...ancestorsOf(fromId), ...ancestorsOf(toId),
      ...descendantsOf(fromId), ...descendantsOf(toId),
    ]);
    const obs: RectBox[] = [];
    for (const n of dsl.geometry.nodes) {
      if (excluded.has(n.id)) continue;
      // 深层节点初始隐藏，不作为障碍（避免 main 层边绕开"幽灵障碍"）
      if (n.layer && n.layer !== 'main') continue;
      obs.push(nodeBox(n));
    }
    return obs;
  };

  const nodesXml = dsl.geometry.nodes.map((n) => renderNode(n, parentIds)).join('\n');

  // 边重叠退避：统计每对 (from→to) 的边数，为同对边分配索引
  const edgeGroupCount = new Map<string, number>();
  const edgeGroupIndex = new Map<string, number>();
  const edgeGroupCurrent = new Map<string, number>();
  for (const e of (dsl.geometry.edges ?? [])) {
    const key = e.from + '→' + e.to;
    edgeGroupCount.set(key, (edgeGroupCount.get(key) ?? 0) + 1);
  }
  const edgesXml = (dsl.geometry.edges ?? []).map((e) => {
    const key = e.from + '→' + e.to;
    const total = edgeGroupCount.get(key) ?? 1;
    const index = edgeGroupCurrent.get(key) ?? 0;
    edgeGroupCurrent.set(key, index + 1);
    return renderEdge(e, nodeMap, { index, total }, obstaclesFor);
  }).join('\n');
  const simEdgesXml = renderSimEdges(dsl, nodeMap, obstaclesFor);
  const swimlanesXml = renderSwimlanes(dsl);
  const cardsXml = (dsl.semantic?.files ?? []).map(renderCard).join('\n');
  const invariantsXml = (dsl.semantic?.multi_file_invariants ?? [])
    .map((inv) => `<li>${esc(inv)}</li>`)
    .join('');

  const fileCount = dsl.semantic?.files?.length ?? 0;
  const invariantCount = dsl.semantic?.multi_file_invariants?.length ?? 0;
  const status = dsl.status ?? 'draft';
  const title = dsl.title ?? '';
  const theme = dsl.theme ?? 'blue';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(dsl.feature)} - design-canvas</title>
  <style>${buildStyles()}</style>
</head>
<body data-theme="${esc(theme)}">
  <header>
    ${options?.nav?.home_href ? `<a href="${esc(options.nav.home_href)}" class="home-link" title="返回主页">🏠 ${esc(options.nav.home_label ?? '主页')}</a>` : ''}
    <h1>${esc(dsl.feature)}</h1>
    ${title ? `<span class="title">${esc(title)}</span>` : ''}
    <div class="meta">
      <span class="badge status-${esc(status)}">${esc(status)}</span>
      <span class="badge">${fileCount} 文件</span>
      <span class="badge">${invariantCount} 不变式</span>
      ${dsl.version ? `<span class="badge">v${esc(dsl.version)}</span>` : ''}
    </div>
  </header>
  <main>
    <div class="canvas-wrap">
      <div class="canvas-toolbar">
        <input type="text" id="node-search" class="search-input" placeholder="🔍 搜索节点 (label / id)..." autocomplete="off">
        ${options?.report ? `<button id="report-open" class="report-open-btn" type="button" title="查看分析摘要">📋 摘要</button>` : ''}
        ${(dsl.animations_v2?.flows?.length ?? 0) > 0 ? `<div class="view-switcher" title="切换视图：节点=静态结构 / 动画=交互式数据步进">
          <button id="view-nodes" class="active" type="button">🗂 节点</button>
          <button id="view-anim" type="button">🎬 动画</button>
        </div>` : ''}
        ${options?.compact_toolbar ? `<button id="advanced-toggle" class="advanced-toggle" type="button" title="更多工具（撤销/重做、重新布局）">⋯ 工具</button>` : ''}
        ${(() => {
          // 职责分层：统计深层节点，有才显示层开关
          const errCount = dsl.geometry.nodes.filter((n) => n.layer === 'error').length;
          const detCount = dsl.geometry.nodes.filter((n) => n.layer === 'detail').length;
          if (errCount === 0 && detCount === 0) return '';
          const errBtn = errCount > 0
            ? `<button id="layer-error-toggle" type="button" title="异常层：显示/隐藏全部异常处理节点 (${errCount})">🛡 异常 ${errCount}</button>`
            : '';
          const detBtn = detCount > 0
            ? `<button id="layer-detail-toggle" type="button" title="细节层：显示/隐藏全部实现细节节点 (${detCount})">🧩 细节 ${detCount}</button>`
            : '';
          return `<div class="layer-controls">${errBtn}${detBtn}</div>`;
        })()}
        <div id="toolbar-advanced" class="${options?.compact_toolbar ? 'toolbar-advanced toolbar-advanced--row hidden' : 'toolbar-advanced'}">
        <div class="history-controls">
          <button id="btn-undo" type="button" title="撤销 (Ctrl+Z)" disabled>↶ 撤销</button>
          <button id="btn-redo" type="button" title="重做 (Ctrl+Y)" disabled>↷ 重做</button>
        </div>
        <span id="history-indicator" class="history-indicator" title="历史记录"></span>
        <div class="layout-controls">
          <button id="layout-dag" type="button" title="拓扑排序布局">🗺️ 拓扑</button>
          <button id="layout-force" type="button" title="力导向布局">⚡ 力导</button>
          <button id="layout-grid" type="button" title="网格对齐">📐 网格</button>
        </div>
        </div><!-- /toolbar-advanced -->
        <div class="theme-switcher" title="切换主题">
          <span class="toolbar-label">主题</span>
          <button id="theme-blue" class="theme-blue ${theme === 'blue' ? 'active' : ''}" title="蓝色"></button>
          <button id="theme-sakura" class="theme-sakura ${theme === 'sakura' ? 'active' : ''}" title="樱花"></button>
          <button id="theme-forest" class="theme-forest ${theme === 'forest' ? 'active' : ''}" title="森林"></button>
          <button id="theme-ocean" class="theme-ocean ${theme === 'ocean' ? 'active' : ''}" title="海洋"></button>
          <button id="theme-star" class="theme-star ${theme === 'star' ? 'active' : ''}" title="星图"></button>
        </div>
        <div class="zoom-controls">
          <button id="zoom-out" type="button" title="缩小">−</button>
          <span id="zoom-level" class="zoom-level">100%</span>
          <button id="zoom-in" type="button" title="放大">+</button>
          <button id="zoom-fit" type="button" title="适应画布">⤢ 适应</button>
          <button id="zoom-reset" type="button" title="重置">⟲ 重置</button>
        </div>
      </div>
      ${options?.report ? buildReportPanel(dsl, options.report) : ''}
      <div id="context-menu" class="context-menu hidden">
        <div class="context-menu-item" data-action="edit-label">✏️ 编辑标签</div>
        <div class="context-menu-item" data-action="add-annotation">💬 添加标注</div>
        <div class="context-menu-item" data-action="submit-approval">📤 提交审批</div>
        <div class="context-sep"></div>
        <div class="context-menu-item danger" data-action="delete">🗑️ 删除节点</div>
      </div>
      <div id="selection-box" class="selection-box hidden"></div>
      <div id="multi-select-bar" class="multi-select-bar hidden">
        <span id="select-count">已选 0 个节点</span>
        <button id="select-delete" type="button">批量删除</button>
        <button id="select-clear" type="button">取消选择</button>
      </div>
      <div id="anim-panel" class="anim-panel hidden">
        <div class="anim-row">
          <select id="anim-select" class="anim-select" title="选择动画"></select>
          <button id="anim-prev" type="button" title="上一阶段">◀</button>
          <button id="anim-play" type="button" title="播放/暂停">▶</button>
          <button id="anim-next" type="button" title="下一阶段">▶▶</button>
          <span id="anim-stage-info" class="anim-stage-info">0 / 0</span>
          <div class="anim-speed-wrap">
            <label>速度</label>
            <input type="range" id="anim-speed" min="0.5" max="3" step="0.5" value="1" title="播放速度">
            <span id="anim-speed-label">1×</span>
          </div>
        </div>
        <div class="anim-row">
          <div id="anim-progress-bar" class="anim-progress-bar">
            <div id="anim-progress-fill" class="anim-progress-fill" style="width:0%"></div>
          </div>
          <span id="anim-stage-name" class="anim-stage-name">-</span>
        </div>
      </div>
      <svg id="canvas" viewBox="0 0 ${canvas.width} ${canvas.height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <filter id="nodeShadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="rgba(0,0,0,0.3)"/>
          </filter>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" style="fill:var(--theme-primary)"/>
          </marker>
          <marker id="arrow-reverse" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 10 0 L 0 5 L 10 10 z" style="fill:var(--theme-primary)"/>
          </marker>
          <marker id="sim-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#9b59b6"/>
          </marker>
        </defs>
${swimlanesXml}
${nodesXml}
${edgesXml}
${simEdgesXml}
      </svg>
    </div>
    <aside class="sidebar">
${
  dsl.simulation
    ? `      <div class="sim-panel">
        <h2>🔬 仿真器</h2>
        <div class="sim-options">
          <label class="sim-toggle">
            <input type="checkbox" id="sim-show-edges" checked>
            <span>显示事件流连线</span>
          </label>
        </div>
        <div class="sim-state" id="sim-state-container">
${dsl.simulation.initial_state.map(s => `          <div class="sim-state-row" data-key="${esc(s.key)}">
            <div class="sim-state-info">
              <span class="sim-state-key">${esc(s.key)}</span>
              <span class="sim-state-type">${esc(s.type ?? '?')}</span>
            </div>
            <div class="sim-state-value-wrap">
              <span id="sim-val-${esc(s.key)}" class="sim-state-val" title="${esc(s.description ?? '')}">${esc(String(s.value))}</span>
            </div>
          </div>`).join('\n')}
        </div>
        <div class="sim-input-wrap">
          <input type="text" id="sim-input" class="sim-input" placeholder="用户输入..." autocomplete="off">
          <button id="sim-send" class="sim-btn sim-btn-primary">发送</button>
        </div>
        <div class="sim-triggers">
          <button id="sim-turn-done" class="sim-btn">TurnDone</button>
          <button id="sim-advance" class="sim-btn">Advance</button>
          <button id="sim-reset" class="sim-btn sim-btn-secondary">重置</button>
        </div>
        <div class="sim-triggers anim-controls" title="动画引擎控制">
          <button id="anim-pause" class="sim-btn">⏸ 暂停</button>
          <button id="anim-step" class="sim-btn">⏭ 步进</button>
          <button id="anim-resume" class="sim-btn">▶ 继续</button>
          <button id="anim-reset" class="sim-btn sim-btn-secondary">↺ 重置动画</button>
        </div>
        <div class="anim-speed" title="动画速度（0.25x - 2x）">
          <span class="anim-speed-label">速度</span>
          <input type="range" id="anim-speed" min="0.25" max="2" step="0.25" value="1">
          <span id="anim-speed-val" class="anim-speed-val">1x</span>
        </div>
        <details class="anim-legend">
          <summary>图例</summary>
          <div class="anim-legend-body">
            <div><i class="lg-dot lg-explicit"></i>显式数据流（带标签）</div>
            <div><i class="lg-dot lg-default"></i>L0 氛围流（无标签）</div>
            <div><i class="lg-flash lg-yellow"></i>黄闪：函数调用（ƒ）</div>
            <div><i class="lg-flash lg-green"></i>彩闪：分支命中（按分支着色）</div>
            <div><i class="lg-flash lg-gray"></i>灰闪：分支全未命中</div>
            <div><i class="lg-flash lg-red"></i>红闪：异常（长闪=未声明）</div>
          </div>
        </details>
        <div class="sim-trace-wrap">
          <h3>触发日志</h3>
          <div id="sim-trace" class="sim-trace"></div>
        </div>
        <div class="sim-trace-wrap anim-log-wrap">
          <h3>异常日志（L4.5）</h3>
          <div id="anim-log" class="sim-trace"></div>
        </div>
      </div>`
    : ''
}
      <h2>Semantic 语义层</h2>
${cardsXml || '      <div class="empty">无语义层信息</div>'}
${
  invariantsXml
    ? `      <div class="invariants">
        <h3>不变式 (${invariantCount})</h3>
        <ul>${invariantsXml}</ul>
      </div>`
    : ''
}
    </aside>
  </main>
  <footer>
    <span class="info">design-canvas · id=${esc(dsl.id)} · 双击节点编辑属性 · 右键节点开始连线</span>
    <div>
      <button id="rerender" type="button">重新渲染</button>
      <button id="export-json" type="button">📥 导出 design-canvas.json</button>
      <button id="import-json" type="button">📤 导入 DSL</button>
    </div>
  </footer>
  <div id="tooltip"></div>
  <div id="prop-editor" class="prop-editor hidden">
    <div class="editor-header">
      <h3>节点属性</h3>
      <button id="editor-close" class="editor-close">×</button>
    </div>
    <div class="editor-body">
      <div class="form-group">
        <label>ID</label>
        <input type="text" id="editor-id" readonly>
      </div>
      <div class="form-group">
        <label>名称 (label)</label>
        <input type="text" id="editor-label">
      </div>
      <div class="form-group">
        <label>类型 (type)</label>
        <select id="editor-type">
          <option value="service">service</option>
          <option value="module">module</option>
          <option value="database">database</option>
          <option value="api">api</option>
          <option value="queue">queue</option>
          <option value="ui">ui</option>
          <option value="other">other</option>
        </select>
      </div>
      <div class="form-group">
        <label>状态 (status)</label>
        <select id="editor-status">
          <option value="todo">todo</option>
          <option value="doing">doing</option>
          <option value="done">done</option>
          <option value="blocked">blocked</option>
        </select>
      </div>
      <div class="form-group">
        <label>描述 (description)</label>
        <textarea id="editor-description" rows="3"></textarea>
      </div>
      <div class="form-group">
        <label>形状 (shape)</label>
        <select id="editor-shape">
          <option value="rounded">rounded</option>
          <option value="rect">rect</option>
          <option value="circle">circle</option>
          <option value="diamond">diamond</option>
          <option value="freeform">freeform</option>
        </select>
      </div>
      <div class="form-group">
        <label>背景色 (bg)</label>
        <div class="color-row">
          <input type="color" id="editor-bg-color" value="#152141">
          <input type="text" id="editor-bg-text" placeholder="#152141">
        </div>
      </div>
      <div class="form-group">
        <label>圆角 (borderRadius)</label>
        <input type="number" id="editor-radius" min="0" max="100" value="8">
      </div>
      <div class="form-group">
        <label>内容类型 (content.type)</label>
        <select id="editor-content-type">
          <option value="text">text (纯文字)</option>
          <option value="rich">rich (富文本块)</option>
        </select>
      </div>
      <div class="form-group">
        <label>内容块 JSON (content.blocks)</label>
        <textarea id="editor-content-blocks" rows="6" placeholder='[{"type":"text","value":"标题","style":{"fontSize":18,"bold":true}},{"type":"color_block","bg":"#0f3460","children":[{"type":"text","value":"内容"}]}]'></textarea>
      </div>
      <div class="form-group hidden" id="editor-replay-row">
        <label>注入回放（D3）</label>
        <button type="button" id="editor-replay-open" class="btn-secondary replay-open-btn">🧪 打开进料口面板（<span id="editor-replay-count">0</span> 条 flow）</button>
      </div>
    </div>
    <div class="editor-footer">
      <button id="editor-cancel" class="btn-secondary">取消</button>
      <button id="editor-save" class="btn-primary">保存</button>
    </div>
  </div>
  <div id="editor-mask" class="editor-mask hidden"></div>
  <div id="replay-panel" class="prop-editor replay-panel hidden">
    <div class="editor-header">
      <h3>🧪 进料口 · 注入回放</h3>
      <button id="replay-close" class="editor-close">×</button>
    </div>
    <div class="editor-body">
      <div class="form-group">
        <label>Flow</label>
        <select id="replay-flow"></select>
      </div>
      <div class="form-group" id="replay-preset-row">
        <label>预设异常场景（从 errors 声明自动构造注入值）</label>
        <select id="replay-preset">
          <option value="">（不预设，手动编辑下方 JSON）</option>
        </select>
      </div>
      <div class="form-group">
        <label>注入值 JSON（作为 handler 返回值 result）</label>
        <textarea id="replay-inject" rows="6" spellcheck="false"></textarea>
      </div>
      <div class="form-group">
        <label>分支求值上下文 value（可选，JSON；缺省取 flow.mock_values[0]）</label>
        <textarea id="replay-value" rows="3" spellcheck="false"></textarea>
      </div>
      <div id="replay-report" class="replay-report hidden"></div>
    </div>
    <div class="editor-footer">
      <button id="replay-cancel" class="btn-secondary">关闭</button>
      <button id="replay-run" class="btn-primary">▶ 回放</button>
    </div>
  </div>
  <div id="replay-mask" class="editor-mask hidden"></div>
  <script>${buildScript(dsl)}</script>
  <script>${buildAnimationScript(dsl)}</script>
</body>
</html>`;
}
