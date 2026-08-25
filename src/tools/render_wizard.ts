/**
 * render_wizard —— 新功能向导前端（mock「DSL 协作工作台」壳上的第一个真页面）
 *
 * 用户定调（2026-08-25）：先冲进前端，在 mock 模板的基础上改，而不是继续在
 * tools_map 上改。向导 = 用户三层模型的可执行化：积木→契约→胶水→采集→登记→闭环。
 *
 * 形态（壳照抄 mock，数据是真实工具清单）：
 *   - 顶部 stepper：七步 chip（mock 的流程条视觉）
 *   - 画布：七节点横排 + 贝塞尔连线 + 虚线流动动画（mock 的连线语言）
 *   - 「模拟运行」：步骤依次点亮（running→done），连线流动——
 *     从上往下搭建的体感；真实调用后续接 daemon/hub
 *   - 点节点 → 右侧悬窗：步骤详情 + 背后工具（真实功能名+入口徽章）+
 *     输入/输出/完成标志——功能(人话)→工具(真实)→实现的桥
 *   - 缩放/拖拽同 sandbox 画布（围绕鼠标点缩放、空白平移、自动 fit）
 */

import fs from 'node:fs';
import path from 'node:path';
import { wizardSteps, ROLE_LABEL, type WizardStep } from './wizard_steps.js';

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function jsonForScript(o: unknown): string {
  return JSON.stringify(o).replace(/<\//g, '<\\/');
}

const ROLE_BADGE: Record<string, string> = {
  brick: 'wz-badge-brick',
  contract: 'wz-badge-contract',
  glue: 'wz-badge-glue',
  flow: 'wz-badge-flow',
  store: 'wz-badge-store',
  review: 'wz-badge-review',
};
const KIND_BADGE: Record<string, string> = { mcp: 'wz-kind-mcp', cli: 'wz-kind-cli', human: 'wz-kind-human' };
const KIND_TXT: Record<string, string> = { mcp: 'MCP', cli: 'CLI', human: '人' };

const NODE_W = 190;
const NODE_H = 128;
const GAP_X = 88;
const PAD = 46;

export function renderWizardHtml(projectName: string): string {
  const steps = wizardSteps();

  // 画布布局：七节点一行
  const nodes = steps.map((s, i) => ({
    step: s,
    x: PAD + i * (NODE_W + GAP_X),
    y: PAD,
    w: NODE_W,
    h: NODE_H,
  }));
  const width = PAD * 2 + steps.length * (NODE_W + GAP_X) - GAP_X;
  const height = PAD * 2 + NODE_H;

  const stepperHtml = steps
    .map(
      (s) =>
        `<button class="wz-step" data-step="${s.id}" title="${esc(s.desc)}"><span class="wz-step-no">${s.no}</span><span class="wz-step-label">${esc(s.label)}</span></button>`,
    )
    .join('<span class="wz-step-arrow">→</span>');

  const nodesHtml = nodes
    .map(
      (n) => `<div class="wz-node" data-step="${n.step.id}" style="top:${n.y}px;left:${n.x}px;">
  <div class="wz-node-status">
    <span class="wz-dot ${n.step.role}"></span>
    <span class="wz-badge ${ROLE_BADGE[n.step.role]}">${ROLE_LABEL[n.step.role]}</span>
    <span class="wz-node-no">第${n.step.no}步</span>
  </div>
  <div class="wz-node-title">${esc(n.step.label)}</div>
  <div class="wz-node-desc">${esc(n.step.desc.slice(0, 40))}${n.step.desc.length > 40 ? '…' : ''}</div>
  <div class="wz-node-tools">${n.step.tools.map((t) => `<span class="wz-kind ${KIND_BADGE[t.kind]}">${KIND_TXT[t.kind]}</span>`).join('')}</div>
</div>`,
    )
    .join('\n');

  // 连线：右缘中点→左缘中点贝塞尔（mock 连线语言），最后一条指向"闭环完成"
  const pathsHtml = nodes
    .slice(0, -1)
    .map((n, i) => {
      const a = n;
      const b = nodes[i + 1];
      const x1 = a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = b.x;
      const y2 = b.y + b.h / 2;
      const bend = Math.max(40, (x2 - x1) * 0.4);
      return `<path class="wz-flow" data-flow="${i + 1}" d="M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}" marker-end="url(#wz-arrow)"></path>`;
    })
    .join('\n');

  const detail = steps.map((s) => ({
    id: s.id,
    no: s.no,
    label: s.label,
    role: ROLE_LABEL[s.role],
    desc: s.desc,
    tools: s.tools.map((t) => ({
      name: t.name,
      kind: KIND_TXT[t.kind] ?? t.kind,
      note: t.note,
    })),
    input: s.input,
    output: s.output,
    doneWhen: s.doneWhen,
  }));

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>新功能向导 · ${esc(projectName)}</title>
<style>
:root{--bg:#fafafa;--card:#fff;--border:#e4e4e7;--border-strong:#d4d4d8;--text:#0a0a0a;--muted:#71717a;--brand:#7c3aed;--ok:#16a34a;--info:#2563eb;--warn:#d97706;--radius:.625rem;--radius-sm:.375rem;--shadow-sm:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 6px -1px rgba(0,0,0,.06),0 2px 4px -2px rgba(0,0,0,.04);--canvas-bg:#f8f8f8;--canvas-grid:#ececee;--node-bg:#fff;--node-border:#d4d4d8;--conn:#a1a1aa;--conn-active:#111827}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text);background:var(--bg);height:100vh;display:flex;flex-direction:column;overflow:hidden}
header{display:flex;align-items:center;gap:14px;padding:10px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap}
header h1{font-size:14px;margin:0;font-weight:650}
header .meta{font-size:11.5px;color:var(--muted)}
.wz-run{margin-left:auto;padding:7px 18px;border-radius:18px;border:none;background:#111827;color:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:background .15s}
.wz-run:hover{background:#374151}
.wz-run:disabled{background:#d4d4d8;cursor:default}
.stepper{display:flex;align-items:center;gap:4px;padding:10px 18px;background:var(--card);border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto}
.wz-step{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:18px;border:1px solid var(--border);background:#fff;font-size:12px;font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;color:var(--text)}
.wz-step:hover{border-color:var(--border-strong)}
.wz-step.active{border-color:#111827;background:#111827;color:#fff}
.wz-step.done .wz-step-no{background:#16a34a}
.wz-step-no{width:18px;height:18px;border-radius:50%;background:#f4f4f5;color:var(--muted);font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:700}
.wz-step.active .wz-step-no{background:#fff;color:#111827}
.wz-step-arrow{color:#a1a1aa;font-size:11px}
main{flex:1;position:relative;overflow:hidden;background:var(--canvas-bg);background-image:radial-gradient(var(--canvas-grid) 1px,transparent 1px);background-size:22px 22px;cursor:grab}
main.panning{cursor:grabbing}
.wz-inner{position:absolute;top:0;left:0;transform-origin:0 0;width:${width}px;height:${height}px}
.wz-conns{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1;overflow:visible}
.wz-conns path{fill:none;stroke:var(--conn);stroke-width:2;stroke-linecap:round;stroke-dasharray:6 8;animation:wz-flow 3s linear infinite}
.wz-conns path.on{stroke:var(--conn-active);stroke-width:2.5;animation-duration:1.2s}
@keyframes wz-flow{to{stroke-dashoffset:-28}}
.wz-node{position:absolute;width:${NODE_W}px;height:${NODE_H}px;background:var(--node-bg);border:1.5px solid var(--node-border);border-radius:var(--radius);padding:12px 14px;box-shadow:var(--shadow-sm);z-index:2;transition:all .2s;cursor:pointer}
.wz-node:hover{box-shadow:var(--shadow)}
.wz-node.sel{border-color:var(--brand);box-shadow:0 0 0 3px #7c3aed33}
.wz-node.running{border-color:var(--warn);box-shadow:0 0 0 3px #fde68a66}
.wz-node.done{border-color:var(--ok)}
.wz-node.done .wz-node-no{color:var(--ok)}
.wz-node-status{display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:7px}
.wz-dot{width:7px;height:7px;border-radius:50%}
.wz-dot.brick{background:#16a34a}.wz-dot.contract{background:#2563eb}.wz-dot.glue{background:#71717a}.wz-dot.flow{background:#7c3aed}.wz-dot.store{background:#0891b2}.wz-dot.review{background:#d97706}
.wz-node-no{margin-left:auto;color:var(--muted);font-size:10px}
.wz-node-title{font-size:13.5px;font-weight:650;margin-bottom:5px}
.wz-node-desc{font-size:10.5px;color:var(--muted);line-height:1.5;height:32px;overflow:hidden}
.wz-node-tools{display:flex;gap:4px;margin-top:6px}
.wz-badge{font-size:9.5px;padding:2px 7px;border-radius:9px;font-weight:600;line-height:1.2}
.wz-badge-brick{background:#f0fdf4;color:#15803d}
.wz-badge-contract{background:#eff6ff;color:#1d4ed8}
.wz-badge-glue{background:#f5f5f5;color:#71717a}
.wz-badge-flow{background:#f5f3ff;color:#6d28d9}
.wz-badge-store{background:#ecfeff;color:#0e7490}
.wz-badge-review{background:#fffbeb;color:#b45309}
.wz-kind{font-size:9px;padding:2px 6px;border-radius:8px;font-weight:600}
.wz-kind-mcp{background:#eff6ff;color:#1d4ed8}
.wz-kind-cli{background:#fef2f2;color:#b91c1c}
.wz-kind-human{background:#fff7ed;color:#c2410c}
.wz-ctrls{position:absolute;bottom:16px;right:16px;z-index:10;display:flex;flex-direction:column;gap:6px}
.wz-ctrl{width:32px;height:32px;background:#fff;border:1px solid var(--border);border-radius:var(--radius-sm);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow-sm);font-size:13px;font-weight:600;color:var(--text)}
.wz-ctrl:hover{background:var(--bg)}
.wz-zval{font-size:10px;color:var(--muted);text-align:center;background:#fff;border:1px solid var(--border);border-radius:4px;padding:1px 0;box-shadow:var(--shadow-sm)}
.wz-done-toast{position:absolute;top:18px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:9px 22px;border-radius:22px;font-size:12.5px;font-weight:600;z-index:20;display:none;box-shadow:var(--shadow)}
.wz-done-toast.show{display:block;animation:wz-pop .3s ease}
@keyframes wz-pop{from{opacity:0;transform:translateX(-50%) translateY(-8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.panel{position:fixed;top:0;right:-440px;width:420px;height:100vh;background:#fff;border-left:1px solid var(--border);box-shadow:-8px 0 24px rgba(0,0,0,.08);transition:right .18s ease;z-index:50;display:flex;flex-direction:column}
.panel.open{right:0}
.panel-head{padding:16px 18px 12px;border-bottom:1px solid var(--border)}
.panel-crumb{font-size:10.5px;color:var(--brand);font-weight:600;margin-bottom:5px}
.panel-title{font-size:15px;font-weight:650}
.panel-desc{font-size:12.5px;color:#3f3f46;margin-top:7px;line-height:1.65}
.panel-body{flex:1;overflow-y:auto;padding:12px 18px}
.sec-title{font-size:11px;font-weight:700;color:var(--muted);letter-spacing:.5px;margin:14px 0 8px;text-transform:uppercase}
.tool-row{border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;margin-bottom:8px}
.tool-head{display:flex;align-items:center;gap:7px}
.tool-name{font-family:ui-monospace,'Cascadia Code',monospace;font-size:11.5px;font-weight:600;color:#111827}
.tool-kind{font-size:9px;padding:2px 7px;border-radius:8px;font-weight:600}
.tool-note{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5}
.io-row{display:flex;gap:8px;font-size:11.5px;line-height:1.6}
.io-key{color:var(--muted);flex-shrink:0;font-weight:600}
.done-when{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:var(--radius-sm);padding:9px 12px;font-size:11.5px;color:#15803d;line-height:1.6}
.panel-close{position:absolute;top:10px;right:12px;font-size:17px;color:var(--muted);cursor:pointer;background:none;border:none;line-height:1}
.panel-close:hover{color:var(--text)}
</style>
</head>
<body>
<header>
  <h1>新功能向导</h1>
  <span class="meta">${esc(projectName)} · 七步闭环：积木 → 契约 → 胶水 → 采集 → 登记 → 验证 · 每步背后都是真实工具</span>
  <button class="wz-run" id="runBtn">▶ 模拟运行</button>
</header>
<div class="stepper">${stepperHtml}</div>
<main id="main">
  <div class="wz-inner" id="inner">
    <svg class="wz-conns" xmlns="http://www.w3.org/2000/svg">
      <defs><marker id="wz-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--conn)"/></marker></defs>
      ${pathsHtml}
    </svg>
    ${nodesHtml}
  </div>
  <div class="wz-ctrls">
    <button class="wz-ctrl" id="zin">+</button>
    <div class="wz-zval" id="zval">100%</div>
    <button class="wz-ctrl" id="zout">−</button>
    <button class="wz-ctrl" id="zfit" title="适应">⤢</button>
  </div>
  <div class="wz-done-toast" id="toast">✓ 闭环完成——新功能已进 DSL（演示）</div>
</main>
<aside class="panel" id="panel">
  <button class="panel-close" id="pclose">×</button>
  <div class="panel-head">
    <div class="panel-crumb" id="pcrumb"></div>
    <div class="panel-title" id="ptitle"></div>
    <div class="panel-desc" id="pdesc"></div>
  </div>
  <div class="panel-body" id="pbody"></div>
</aside>
<script>
const DETAIL = ${jsonForScript(detail)};
const LAYOUT = { width: ${width}, height: ${height} };
const inner = document.getElementById('inner');
const mainEl = document.getElementById('main');
let zoom = 1, panX = 0, panY = 0;
function applyTransform(){
  inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  document.getElementById('zval').textContent = Math.round(zoom * 100) + '%';
}
function fit(){
  const z = Math.min((mainEl.clientWidth - 20) / LAYOUT.width, (mainEl.clientHeight - 20) / LAYOUT.height);
  zoom = Math.max(0.15, Math.min(1.5, z));
  panX = (mainEl.clientWidth - LAYOUT.width * zoom) / 2;
  panY = (mainEl.clientHeight - LAYOUT.height * zoom) / 2;
  applyTransform();
}
document.getElementById('zin').addEventListener('click', () => { zoom = Math.min(2, zoom * 1.2); applyTransform(); });
document.getElementById('zout').addEventListener('click', () => { zoom = Math.max(0.15, zoom / 1.2); applyTransform(); });
document.getElementById('zfit').addEventListener('click', fit);
mainEl.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = mainEl.getBoundingClientRect();
  const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
  const oldZ = zoom;
  zoom = Math.max(0.15, Math.min(2, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  panX = mx - ((mx - panX) / oldZ) * zoom;
  panY = my - ((my - panY) / oldZ) * zoom;
  applyTransform();
}, { passive: false });
let drag = null;
mainEl.addEventListener('mousedown', (ev) => {
  if (ev.target.closest('.wz-node') || ev.target.closest('.wz-ctrls')) return;
  drag = { x: ev.clientX, y: ev.clientY, px: panX, py: panY };
  mainEl.classList.add('panning');
});
window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  panX = drag.px + (ev.clientX - drag.x);
  panY = drag.py + (ev.clientY - drag.y);
  applyTransform();
});
window.addEventListener('mouseup', () => { drag = null; mainEl.classList.remove('panning'); });

// 节点点击 → 悬窗（步骤详情 + 真实工具）
document.querySelectorAll('.wz-node').forEach(el => {
  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const d = DETAIL.find(x => x.id === el.dataset.step);
    if (!d) return;
    document.querySelectorAll('.wz-node').forEach(x => x.classList.remove('sel'));
    el.classList.add('sel');
    document.querySelectorAll('.wz-step').forEach(s => s.classList.toggle('active', s.dataset.step === d.id));
    document.getElementById('pcrumb').textContent = '第 ' + d.no + ' 步 · ' + d.role;
    document.getElementById('ptitle').textContent = d.label;
    document.getElementById('pdesc').textContent = d.desc;
    const kb = { 'MCP': 'wz-kind-mcp', 'CLI': 'wz-kind-cli', '人': 'wz-kind-human' };
    document.getElementById('pbody').innerHTML =
      '<div class="sec-title">背后工具</div>' +
      d.tools.map(t =>
        '<div class="tool-row"><div class="tool-head">' +
        '<span class="tool-name">' + t.name + '</span>' +
        '<span class="tool-kind ' + (kb[t.kind] || 'wz-kind-mcp') + '">' + t.kind + '</span></div>' +
        '<div class="tool-note">' + t.note + '</div></div>'
      ).join('') +
      '<div class="sec-title">输入 / 输出</div>' +
      '<div class="io-row"><span class="io-key">输入</span><span>' + d.input + '</span></div>' +
      '<div class="io-row"><span class="io-key">输出</span><span>' + d.output + '</span></div>' +
      '<div class="sec-title">完成标志</div>' +
      '<div class="done-when">✓ ' + d.doneWhen + '</div>';
    document.getElementById('panel').classList.add('open');
  });
});
document.getElementById('pclose').addEventListener('click', () => {
  document.getElementById('panel').classList.remove('open');
  document.querySelectorAll('.wz-node').forEach(x => x.classList.remove('sel'));
});
document.querySelectorAll('.wz-step').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelector('.wz-node[data-step="' + el.dataset.step + '"]')?.click();
  });
});

// 模拟运行：步骤依次点亮，连线流动（真实调用后续接 daemon）
let running = false;
document.getElementById('runBtn').addEventListener('click', () => {
  if (running) return;
  running = true;
  const btn = document.getElementById('runBtn');
  btn.disabled = true; btn.textContent = '运行中…';
  document.querySelectorAll('.wz-node').forEach(n => n.classList.remove('done', 'running'));
  document.querySelectorAll('.wz-step').forEach(s => s.classList.remove('done', 'active'));
  document.querySelectorAll('.wz-conns path').forEach(p => p.classList.remove('on'));
  document.getElementById('toast').classList.remove('show');
  const nodes = [...document.querySelectorAll('.wz-node')];
  nodes.forEach((n, i) => {
    setTimeout(() => {
      n.classList.add('running');
      document.querySelectorAll('.wz-step')[i].classList.add('active');
    }, i * 900);
    setTimeout(() => {
      n.classList.remove('running'); n.classList.add('done');
      document.querySelectorAll('.wz-step')[i].classList.remove('active');
      document.querySelectorAll('.wz-step')[i].classList.add('done');
      const flow = document.querySelector('.wz-conns path[data-flow="' + (i + 1) + '"]');
      if (flow) flow.classList.add('on');
    }, i * 900 + 750);
  });
  setTimeout(() => {
    document.getElementById('toast').classList.add('show');
    btn.disabled = false; btn.textContent = '▶ 模拟运行';
    running = false;
  }, nodes.length * 900 + 400);
});
fit();
</script>
</body>
</html>`;
}

/** 落盘便捷入口。 */
export function buildWizardHtml(opts: { projectName: string; out_file: string }): string {
  const html = renderWizardHtml(opts.projectName);
  const abs = path.resolve(opts.out_file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, html, 'utf-8');
  return html;
}
