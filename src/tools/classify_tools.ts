/**
 * classify_tools —— 工具标注官：给功能条目打四维标签（多维度组织的落点）
 *
 * 用户定调（2026-08-25）：功能（MCP 工具+CLI 命令）应该"分级放出来"，且有
 * "很多种方向很多维度"去组织；不同功能的暴露形态（MCP 独占/CLI 独占/双入口）
 * 也是一维。本模块给每个功能条目打标：
 *   - domain 能力域（8 域封闭集合）：做什么类型的事
 *   - tier 分级：P0 日常高频 / P1 进阶 / P2 专家低频
 *   - slot 解剖槽位：复用 pipeline-v1 taxonomy（工具在流水线的位置）
 *   - kind 暴露形态：确定性（MCP/CLI/双入口），不走 LLM
 *   - summary：≤16 字人话功能名（从描述精炼，不发明）
 *
 * LLM 缺席/失败 → 关键词启发式降级；命中不了 → 诚实进 unclassified。
 */

import type { FunctionEntry } from './collect_functions.js';
import type { BrickifyResult } from './brickify.js';
import { loadLlmConfig, callChat } from './llm_focus.js';
import { loadExplainConfig } from './explain_gen.js';
import { defaultPipelineTaxonomy, type Taxonomy } from './taxonomy.js';

export interface ToolDomain {
  id: string;
  label: string;
  desc: string;
}

/** 8 能力域（封闭集合）。 */
export function defaultDomains(): ToolDomain[] {
  return [
    { id: 'design', label: '设计编辑', desc: '改设计/DSL/脚手架/渲染设计视图——塑造沙盘本身' },
    { id: 'query', label: '查询理解', desc: '读设计/读代码/搜索定位——看清楚现状' },
    { id: 'refactor', label: '重构治理', desc: '重命名/装配/瘦身/管线——改变代码结构' },
    { id: 'observe', label: '观测质检', desc: '插桩/拍照/裁决/一致性——看系统跑得对不对' },
    { id: 'judge', label: '治理裁决', desc: '人审闭环/问题上抛——拿不定主意的交给人' },
    { id: 'edit', label: '代码编辑', desc: '直接改代码内容（补丁/编辑）' },
    { id: 'harvest', label: '逆向采集', desc: '从 URL/已有项目反向采集材料' },
    { id: 'export', label: '交付导出', desc: '产出给人看的最终交付物' },
  ];
}

export interface ToolAnnotation {
  domain: string;
  tier: 'P0' | 'P1' | 'P2';
  slot: string;
  summary: string;
  confidence: number;
  mode: 'llm' | 'rule';
}

export interface MappedTool {
  name: string;
  title: string;
  description: string;
  summary: string;
  domain: string;
  tier: 'P0' | 'P1' | 'P2';
  slot: string;
  /** 暴露形态（确定性，不走 LLM） */
  kind: 'mcp_only' | 'cli_only' | 'both';
  confidence: number;
  mode: 'llm' | 'rule';
  /** 触达的实现簇（含积木 id）——确定性连线（import 分析） */
  implClusters: Array<{ cluster: string; brick: string }>;
  /** 没匹配上积木文件的模块（诚实上报） */
  unmatchedModules: string[];
}

export interface ToolsMapResult {
  domains: ToolDomain[];
  tools: MappedTool[];
  meta: { mode: 'llm' | 'rule'; llm_ok: number; total: number };
  limitations: string[];
}

function toLlmCfg(c: ReturnType<typeof loadExplainConfig>) {
  return c ? { apiKey: c.apiKey, model: c.model, baseURL: c.baseURL } : null;
}

/** 规则降级：名称/描述关键词 → domain/slot/tier。 */
function annotateByRule(tools: FunctionEntry[], taxonomy: Taxonomy): Record<string, ToolAnnotation> {
  const out: Record<string, ToolAnnotation> = {};
  const KW: Array<[string, string[]]> = [
    ['design', ['dsl', 'feature', 'scaffold', 'render', 'simulation']],
    ['query', ['get_', 'explore', 'diff', 'search', 'find_']],
    ['refactor', ['rename', 'assemble', 'slim', 'brick', 'pipeline', 'dead', 'contract', 'effects']],
    ['observe', ['observe', 'log', 'judge', 'consistency', 'instrument', 'narrate', 'trace']],
    ['harvest', ['harvest', 'import_']],
    ['edit', ['edit_']],
    ['export', ['export']],
  ];
  for (const t of tools) {
    const hay = `${t.name} ${t.summarySource}`.toLowerCase();
    let domain = 'query';
    let bestHits = 0;
    for (const [d, kws] of KW) {
      const hits = kws.filter((k) => hay.includes(k)).length;
      if (hits > bestHits) {
        bestHits = hits;
        domain = d;
      }
    }
    let slot = 'compute';
    let bestSlot = 0;
    for (const s of taxonomy.slots) {
      const hits = s.keywords.filter((k) => hay.includes(k)).length;
      if (hits > bestSlot) {
        bestSlot = hits;
        slot = s.id;
      }
    }
    out[t.name] = {
      domain,
      tier: 'P1',
      slot,
      summary: t.summarySource.slice(0, 16),
      confidence: 0.3,
      mode: 'rule',
    };
  }
  return out;
}

/** LLM 标注官：三维标签一次出（分批防 payload 爆）。 */
async function annotateByLlm(
  cfg: { apiKey: string; model: string; baseURL: string },
  tools: FunctionEntry[],
  domains: ToolDomain[],
  taxonomy: Taxonomy,
): Promise<Record<string, ToolAnnotation> | null> {
  const domainsText = domains.map((d) => `- ${d.id}（${d.label}）：${d.desc}`).join('\n');
  const slotsText = taxonomy.slots.map((s) => `- ${s.id}（${s.label}）`).join('\n');

  const BATCH = 16;
  const out: Record<string, ToolAnnotation> = {};
  for (let i = 0; i < tools.length; i += BATCH) {
    const group = tools.slice(i, i + BATCH);
    const toolsText = group
      .map(
        (t) =>
          `### ${t.name}（${t.kind === 'both' ? 'MCP+CLI 双入口' : t.kind === 'cli_only' ? 'CLI 独占' : 'MCP 独占'}）\n描述: ${t.desc.slice(0, 200) || t.summarySource}\n触达模块: ${t.implModules.slice(0, 6).join(', ') || '（内联实现）'}`,
      )
      .join('\n\n');

    const system =
      '你是 MCP 工具标注官。给每个工具打三维标签：\n' +
      '1. domain：能力域，只能从给定 8 域选 id；\n' +
      '2. tier：P0=日常高频核心 / P1=进阶 / P2=专家低频；\n' +
      '3. slot：解剖槽位，只能从给定 7 槽位选 id；\n' +
      '4. summary：≤16 字人话功能名，从描述精炼，禁止发明描述里没有的功能。\n' +
      'confidence 0..1。每个工具都必须有结果。\n' +
      '只输出 JSON：{"tools":[{"name":"...","domain":"...","tier":"P0","slot":"...","summary":"...","confidence":0.9}]}，name 来自给定清单。';

    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `能力域：\n${domainsText}\n\n槽位：\n${slotsText}\n\n工具清单（${group.length} 个）：\n${toolsText}`,
      },
    ]);
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence ? fence[1] : raw;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
      tools?: Array<{ name?: string; domain?: string; tier?: string; slot?: string; summary?: string; confidence?: number }>;
    };
    const domainIds = new Set(domains.map((d) => d.id));
    const slotIds = new Set(taxonomy.slots.map((s) => s.id));
    const known = new Set(group.map((g) => g.name));
    for (const a of parsed.tools ?? []) {
      if (!a.name || !known.has(a.name) || !a.domain || !domainIds.has(a.domain)) continue;
      const tier = a.tier === 'P0' || a.tier === 'P2' ? (a.tier as 'P0' | 'P2') : 'P1';
      out[a.name] = {
        domain: a.domain,
        tier,
        slot: a.slot && slotIds.has(a.slot) ? a.slot : 'compute',
        summary: (a.summary ?? '').trim().slice(0, 16),
        confidence: Math.max(0, Math.min(1, a.confidence ?? 0.6)),
        mode: 'llm',
      };
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 主入口：统一功能条目（MCP+CLI）→ 四维标注 + 映射到积木实现簇。
 * implModules → 簇映射是确定性的（brickify 文件集精确匹配），匹配不上如实上报。
 */
export async function classifyTools(
  tools: FunctionEntry[],
  r: BrickifyResult,
  opts: { taxonomy?: Taxonomy; domains?: ToolDomain[] } = {},
): Promise<ToolsMapResult> {
  const taxonomy = opts.taxonomy ?? defaultPipelineTaxonomy();
  const domains = opts.domains ?? defaultDomains();

  // 模块（无扩展名）→ {cluster, brick} 索引
  const moduleIndex = new Map<string, { cluster: string; brick: string }>();
  for (const b of r.bricks) {
    for (const s of b.sub_clusters) {
      for (const f of s.files) {
        moduleIndex.set(f.replace(/\.tsx?$/, '').replace(/\.go$/, ''), { cluster: s.id, brick: b.id });
      }
    }
  }

  const rule = annotateByRule(tools, taxonomy);
  let annotations = rule;
  let llmOk = 0;
  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (cfg) {
    try {
      const llm = await annotateByLlm(cfg, tools, domains, taxonomy);
      if (llm) {
        annotations = { ...rule, ...llm };
        llmOk = Object.keys(llm).length;
      }
    } catch {
      // LLM 失败：保持启发式
    }
  }

  const mapped: MappedTool[] = tools.map((t) => {
    const a = annotations[t.name];
    const implClusters: Array<{ cluster: string; brick: string }> = [];
    const unmatchedModules: string[] = [];
    const seen = new Set<string>();
    for (const m of t.implModules) {
      const hit = moduleIndex.get(m);
      if (hit && !seen.has(hit.cluster)) {
        seen.add(hit.cluster);
        implClusters.push(hit);
      } else if (!hit) {
        unmatchedModules.push(m);
      }
    }
    return {
      name: t.name,
      title: t.mcp?.title ?? t.name,
      description: t.desc,
      summary: a?.summary || t.summarySource.slice(0, 16),
      domain: a?.domain ?? 'query',
      tier: a?.tier ?? 'P1',
      slot: a?.slot ?? 'compute',
      kind: t.kind,
      confidence: a?.confidence ?? 0.3,
      mode: a?.mode ?? 'rule',
      implClusters,
      unmatchedModules,
    };
  });

  const unmatchedTotal = mapped.reduce((acc, t) => acc + t.unmatchedModules.length, 0);
  const noImpl = mapped.filter((t) => t.implClusters.length === 0).length;

  return {
    domains,
    tools: mapped,
    meta: { mode: llmOk > 0 ? 'llm' : 'rule', llm_ok: llmOk, total: tools.length },
    limitations: [
      llmOk === 0 ? 'LLM 未配置/失败，当前为关键词启发式标注（mode=rule），置信度有限' : '',
      noImpl > 0 ? `${noImpl} 个工具未连上实现簇（内联实现或 import 分析未命中），如实标注` : '',
      unmatchedTotal > 0 ? `${unmatchedTotal} 个触达模块未匹配到积木文件（非 src/ 下或动态引用）` : '',
    ].filter(Boolean),
  };
}
