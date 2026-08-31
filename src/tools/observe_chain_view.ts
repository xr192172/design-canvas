/**
 * observe_chain_view —— 链路契约 + chain-broken 偏差可视化（自包含 HTML，可目验）
 *
 * 输入：DSL 链路声明（TSDLDecl[]，含 chain 的声明） + 实测链（TSChainObs[]） + 偏差报告（TSDiffReport）。
 * 输出：一个自包含 HTML（无外部依赖）。视图含：
 *   1. 概览卡：声明链数 / 实测链数 / 偏差统计（链断裂/未观测）
 *   2. 每条链路契约一眼判存亡：声明序（含未声明中间帧灰色块） vs 最接近实测链；
 *      断裂点高亮红，满足态绿，根未观测灰
 *   3. 偏差明细卡：trace_id + 实测窗口 + 断裂点探针（chain-broken / unobserved）
 *
 * 设计取向（与 llm_judge/comparator 一致）：子序列语义——未声明的中间帧
 * 不算偏差，视图里以灰色虚线块展示"被允许插入"但不报错。
 * 纯渲染，不判定、不联网、不依赖重框架；单测聚焦 HTML 结构断言。
 */

import type { TSDLDecl, TSDeviation, TSDiffReport } from '../observe/contract.js';
import type { TSChainObs } from '../observe/chain.js';

/** 视图输入：已判定的链路数据（外部用 observe/contract TSComparator + chain 装配）。 */
export interface ChainViewInput {
  title?: string;
  /** 含 chain 声明的 DSL 声明（仅取 chain 非空的）。 */
  decls: TSDLDecl[];
  /** 实测调用链（rebuildChains 产出）。 */
  chains: TSChainObs[];
  /** 偏差报告（TSComparator.compare 产出）。 */
  diff: TSDiffReport;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 是否某个偏差命中该链路契约（按 root 探针 + rule）。 */
function deviationForDecl(decl: TSDLDecl, devs: TSDeviation[]): TSDeviation | undefined {
  return devs.find((d) => d.kind === 'chain-broken' && (d.rule === decl.rule || d.probe === decl.chain?.[0]))
    ?? devs.find((d) => d.kind === 'unobserved' && d.probe === decl.chain?.[0]);
}

/** 找最接近声明序的实测链（前缀匹配最长；满足子序列优先）。 */
function closestChain(want: string[], chains: TSChainObs[]): TSChainObs | null {
  let best: TSChainObs | null = null;
  let bestMatched = -1;
  for (const c of chains) {
    if (!c.sequence.includes(want[0])) continue;
    let m = 0;
    for (const s of c.sequence) if (m < want.length && s === want[m]) m++;
    if (m > bestMatched) {
      best = c;
      bestMatched = m;
    }
    if (m === want.length) return c; // 满足即返回
  }
  return best;
}

/** 渲染一条链契约对比矩形（声明序 + 实测窗口 + 断裂点标注）。 */
function renderChainBlock(decl: TSDLDecl, chains: TSChainObs[], dev: TSDeviation | undefined): string {
  const want = decl.chain!;
  const broken = dev?.kind === 'chain-broken';
  const unobs = dev?.kind === 'unobserved';

  // 最接近实测链的窗口（子序列语义：未声明中间帧以灰色块展示但不算偏差）
  const best = closestChain(want, chains);
  const window = best?.sequence ?? [];

  const cells = (list: string[], declared: Set<string>) =>
    list.map((p) => {
      const known = declared.has(p);
      return `<span class="cnode ${known ? 'declared' : 'inter'}" title="${esc(p)}">${esc(p)}</span>`;
    }).join('');

  const declared = new Set(want);
  const stateCls = unobs ? ' state-unobs' : broken ? ' state-broken' : ' state-ok';
  const badge = unobs
    ? '<span class="cbadge b-unobs">根未观测</span>'
    : broken
      ? `<span class="cbadge b-broken">链断裂</span>`
      : '<span class="cbadge b-ok">满足</span>';

  const detail = dev
    ? `<div class="cdetail">${esc(dev.detail)}${dev.trace_id ? `<br/><code>trace=${esc(dev.trace_id)}</code>` : ''}</div>`
    : '<div class="cdetail">声明序是实测链的子序列，未声明中间帧不计偏差</div>';

  return `      <div class="cblock${stateCls}">
        <div class="chead">
          <span class="crule">${esc(decl.rule)}</span>
          ${badge}
        </div>
        <div class="crow">
          <span class="clabel">声明序</span>
          <div class="cells">${cells(want, declared)}</div>
        </div>
        <div class="crow">
          <span class="clabel">最近实测</span>
          <div class="cells">${window.length > 0 ? cells(window, declared) : '<span class="cnode inter">（该链根探针未出现在任何实测链）</span>'}</div>
        </div>
        ${detail}
      </div>`;
}

/** 从偏差报告提取链级偏差（chain-broken 优先，unobserved 次之）。 */
function chainDeviations(diff: TSDiffReport): TSDeviation[] {
  return diff.deviations.filter((d) => d.kind === 'chain-broken' || d.kind === 'unobserved');
}

/** 生成自包含 HTML 视图。 */
export function buildChainViewHtml(input: ChainViewInput): string {
  const title = input.title ?? '链路契约视图';
  const decls = input.decls.filter((d) => d.chain && d.chain.length > 0);
  const devs = chainDeviations(input.diff);
  const broken = devs.filter((d) => d.kind === 'chain-broken').length;
  const unobs = devs.filter((d) => d.kind === 'unobserved').length;

  const blocks = decls.map((d) => renderChainBlock(d, input.chains, deviationForDecl(d, devs))).join('\n');
  const noDecl = decls.length === 0
    ? '<div class="empty">⚠ 未提供含 chain 的 DSL 声明（TSDLDecl.chain 非空）——无可视化的链路契约。</div>'
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  :root { --ink:#1f2937; --sub:#6b7280; --line:#e5e7eb; --blue:#2563eb; --green:#16a34a; --red:#dc2626; --amber:#d97706; --bg:#f9fafb; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,'Microsoft YaHei',Segoe UI,sans-serif; background:var(--bg); color:var(--ink); }
  .wrap { max-width:960px; margin:0 auto; padding:24px 20px 60px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--sub); font-size:12px; margin-bottom:20px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:22px; }
  .stat { background:#fff; border:1px solid var(--line); border-radius:10px; padding:10px 16px; min-width:120px; }
  .stat b { display:block; font-size:20px; }
  .stat span { color:var(--sub); font-size:11px; }
  .stat.s-broken b { color:var(--red); } .stat.s-unobs b { color:var(--amber); }
  .cblock { background:#fff; border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:14px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .cblock.state-broken { border-left:4px solid var(--red); }
  .cblock.state-ok { border-left:4px solid var(--green); }
  .cblock.state-unobs { border-left:4px solid var(--amber); }
  .chead { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  .crule { font-weight:600; font-family:ui-monospace,Consolas,monospace; }
  .cbadge { font-size:11px; padding:2px 8px; border-radius:999px; font-weight:600; }
  .b-ok { background:#dcfce7; color:var(--green); } .b-broken { background:#fee2e2; color:var(--red); } .b-unobs { background:#fef3c7; color:var(--amber); }
  .crow { display:flex; align-items:center; gap:10px; margin:4px 0; }
  .clabel { width:64px; flex:none; color:var(--sub); font-size:11px; }
  .cells { display:flex; flex-wrap:wrap; gap:6px; flex:1; }
  .cnode { font-family:ui-monospace,Consolas,monospace; font-size:12px; padding:3px 9px; border-radius:6px; border:1px solid var(--line); background:#f3f4f6; }
  .cnode.declared { background:#eff6ff; border-color:#bfdbfe; color:#1d4ed8; }
  .cnode.inter { background:#f3f4f6; border-style:dashed; color:var(--sub); }
  .cdetail { margin-top:8px; font-size:12px; color:var(--sub); line-height:1.5; }
  .cdetail code { background:#f3f4f6; padding:1px 5px; border-radius:4px; color:var(--red); }
  .empty { background:#fffbeb; border:1px solid #fde68a; color:var(--amber); border-radius:10px; padding:14px 16px; font-size:13px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>🔗 ${esc(title)}</h1>
    <div class="sub">链路契约偏差视图 · ${esc(input.diff.generated_at)} · ${esc(String(input.diff.event_count))} 事件</div>
    <div class="stats">
      <div class="stat"><b>${decls.length}</b><span>链路契约</span></div>
      <div class="stat"><b>${input.chains.length}</b><span>实测链</span></div>
      <div class="stat"><b>${broken}</b><span>链断裂</span></div>
      <div class="stat s-unobs"><b>${unobs}</b><span>根未观测</span></div>
    </div>
    ${noDecl}
    ${blocks}
  </div>
</body>
</html>
`;
}