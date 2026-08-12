/**
 * mindmap_agent —— L3 思维导图只读问答 Agent（轻量 ReAct）
 *
 * 用户想对着思维导图提问（"这是什么 / 某个模块干嘛用 / 为什么这样分"），
 * 由 agent 结合三样上下文回答：
 *   1. 工具介绍（可调用的只读工具）
 *   2. L1/L2 DSL（实际代码定位 + 设计图层结构）
 *   3. 当前思维导图（JSON）
 *
 * 首版为【只读问答】：不调用任何写工具，agent 只做"读 + 查 + 解释"。
 * 数据流：用户消息 → 组装上下文 → LLM 输出 {thought, action, args} →
 *         执行只读工具 → 观察 → 循环 → 最终回答。
 *
 * 安全边界：
 *   - 本层工具全部只读，不落盘、不改 DSL，改图/回写 L2 由后续版本加入。
 *   - 不伪造数据：LLM 只基于真实 DSL/导图内容回答，值全部来自 getDSL/getMindMapFile。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, getDataHome } from '../storage.js';
import { extractJsonObject } from './explain_gen.js';
import { getMindMapFile } from './derive_mind_map.js';
import type { MindMap, MindMapNode } from '../dsl/mindmap.js';

// ─────────────────────────────────────────────────────────────
// Agent 配置（默认后端 = AGNES，认证走 config.json 或环境变量）
// ─────────────────────────────────────────────────────────────

const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_AGNES_MODEL = 'agnes-2.0-flash';

interface AgentConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

/**
 * 读取思维导图 Agent 的 LLM 配置。优先级：
 *   1) 环境变量 AGNES_API_KEY / AGNES_BASE_URL / AGNES_MODEL
 *   2) config.json 的 agent.mmd 段（{ "agent": { "mmd": {...} } }）
 * 无 key 返回 null（此时走规则降级回答）。
 * 说明：Agent 默认后端固定为 AGNES，与科普讲解（DeepSeek）解耦。
 */
export function loadAgentConfig(): AgentConfig | null {
  const envApiKey = process.env.AGNES_API_KEY?.trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      model: process.env.AGNES_MODEL?.trim() || DEFAULT_AGNES_MODEL,
      baseURL: ((process.env.AGNES_BASE_URL?.trim() || DEFAULT_AGNES_BASE_URL).replace(/\/+$/, '')),
    };
  }

  const cfgPath = path.join(getDataHome(), '.design-canvas', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const mmd = raw?.agent?.mmd;
      if (mmd && mmd.apiKey) {
        return {
          apiKey: mmd.apiKey,
          model: mmd.model || DEFAULT_AGNES_MODEL,
          baseURL: (mmd.baseURL || DEFAULT_AGNES_BASE_URL).replace(/\/+$/, ''),
        };
      }
    } catch {
      // config 损坏：忽略，无配置走规则回答
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 输入 / 输出
// ─────────────────────────────────────────────────────────────

export interface MindmapAgentInput {
  /** feature 名（必填） */
  feature: string;
  /** 用户消息 */
  message: string;
  /** 历史消息（可选，多轮对话） */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 最大工具调用轮数（默认 6，防死循环） */
  max_steps?: number;
}

export interface MindmapAgentMessage {
  /** 工具调用过程中的中间观察（供进度展示） */
  step?: { thought: string; action: string; args: string; observation: string };
  /** 最终回复 */
  answer?: string;
  /** 是否真正用了 LLM（false = 未配置/失败降级为规则回答） */
  llm: boolean;
  /** 说明（降级原因等） */
  note?: string;
}

// ─────────────────────────────────────────────────────────────
// 只读工具集
// ─────────────────────────────────────────────────────────────

interface MMContext {
  feature: string;
  mindMap: MindMap | null;
  mindMapErr?: string;
  dsl: ReturnType<typeof getDSL>;
}

/** 读取思维导图 JSON */
function loadMindMap(feature: string): MindMap | null {
  const file = getMindMapFile(feature);
  if (!file) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as MindMap;
  } catch {
    return null;
  }
}

/** 展开思维导图为扁平节点列表 */
function flatten(n: MindMapNode, acc: MindMapNode[] = []): MindMapNode[] {
  acc.push(n);
  for (const c of n.children ?? []) flatten(c, acc);
  return acc;
}

/** 工具描述（注入上下文，供 LLM 选择） */
interface ToolDoc { name: string; args?: string; desc: string }
const TOOL_DESCRIPTIONS: ToolDoc[] = [
  { name: 'mindmap.get', desc: '读取当前思维导图的完整 JSON，返回 {feature, mode, root}。' },
  { name: 'mindmap.search', args: '{"q":"关键词"}', desc: '按 label/description 关键词搜索导图节点，返回命中的节点（含路径与说明）。' },
  { name: 'design.get', args: '{"id":"file_xxx"}', desc: '读取 L2 设计图层某节点（按 id 或相对路径），返回其几何位置/职责/行数。用于把导图节点定位到设计图。' },
];

function toolDoc(): string {
  return TOOL_DESCRIPTIONS
    .map((t) => `- ${t.name}${t.args ? `(${t.args})` : ''}：${t.desc}`)
    .join('\n');
}

/** 组装上下文：工具介绍 + L1/L2 DSL 摘要 + 导图 */
function buildContext(ctx: MMContext): string {
  const parts: string[] = [];
  parts.push('## 可用工具（只读）\n' + toolDoc());
  parts.push('## 当前思维导图\n' + (ctx.mindMap ? JSON.stringify(ctx.mindMap, null, 2) : ctx.mindMapErr ?? '（未生成）'));
  const dsl = ctx.dsl;
  if (dsl) {
    const ft = dsl.feature_tree;
    const feat = ft?.features ?? [];
    parts.push(
      '## L2 设计图层摘要\n' +
        `标题：${dsl.title ?? ctx.feature}\n` +
        `功能树：${feat.length} 个功能\n` +
        feat.map((f) => `- ${f.name}（${f.communities.length} 子模块）`).join('\n'),
    );
    const sem = dsl.semantic?.files ?? [];
    parts.push(`## L1 语义文件\n${sem.length} 个文件。常用：\n` + sem.slice(0, 40).map((s) => `- ${s.path}：${s.responsibility ?? ''}`).join('\n'));
  } else {
    parts.push('## L2 设计图层\n（无 DSL）');
  }
  return parts.join('\n\n');
}

// ─────────────────────────────────────────────────────────────
// 工具执行（只读）
// ─────────────────────────────────────────────────────────────

function runTool(ctx: MMContext, name: string, rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return '参数解析失败：需要 JSON 格式。';
  }
  switch (name) {
    case 'mindmap.get': {
      if (!ctx.mindMap) return '当前未生成思维导图，请先 POST /api/mind-map 或调用 derive_mind_map。';
      const root = ctx.mindMap.root;
      const summary = summarizeTree(root);
      return `思维导图（${ctx.mindMap.mode === 'llm' ? 'LLM 提炼' : '规则骨架'}）：\n${summary}`;
    }
    case 'mindmap.search': {
      const q = String(args.q ?? '').trim().toLowerCase();
      if (!q) return '缺少 q 参数。';
      if (!ctx.mindMap) return '当前未生成思维导图。';
      const hits = flatten(ctx.mindMap.root).filter(
        (n) => (n.label ?? '').toLowerCase().includes(q) || (n.description ?? '').toLowerCase().includes(q),
      );
      if (hits.length === 0) return `未找到与"${q}"相关的节点。`;
      return hits
        .slice(0, 20)
        .map((n) => `[${n.kind}] ${n.label}：${n.description ?? ''}（id=${n.id}）`)
        .join('\n');
    }
    case 'design.get': {
      const id = String(args.id ?? '').trim();
      if (!id) return '缺少 id 参数。';
      const dsl = ctx.dsl;
      if (!dsl) return '无 L2 DSL。';
      const sem = dsl.semantic?.files?.find((f) => f.id === id || f.path === id);
      if (sem) {
        return `文件节点 ${sem.path}：\n- 职责：${sem.responsibility ?? ''}\n- 行数：${sem.lines ?? '?'}\n- 状态：${sem.status ?? '?'}\n- id：${sem.id}`;
      }
      const geo = dsl.geometry?.nodes?.find((n: { id?: string }) => n.id === id);
      if (geo) return `设计图节点 ${id}：${JSON.stringify(geo)}`;
      return `未在设计图层找到节点 ${id}。`;
    }
    default:
      return `未知工具：${name}`;
  }
}

/** 递归摘要树（缩进展示层级） */
function summarizeTree(n: MindMapNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  const meta =
    n.kind === 'file' ? `（${n.meta?.lines ?? '?'} 行）` : n.meta?.files ? `（${n.meta.files} 文件）` : '';
  let out = `${pad}[${n.kind}] ${n.label}${meta}：${n.description ?? ''}`;
  for (const c of n.children ?? []) out += '\n' + summarizeTree(c, depth + 1);
  return out;
}

// ─────────────────────────────────────────────────────────────
// ReAct 主循环
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  '你是项目的"思维导图讲解助手"。用户会针对一张项目的思维导图提问。' +
  '你可以调用【只读工具】去查导图节点、搜索关键词、定位到设计图层，从而给出准确、有依据的回答。' +
  '工作方式（ReAct）：你每次输出一个 JSON 动作，执行后我会把观察结果返回给你，直到你给出最终回答。' +
  '输出格式二选一：\n' +
  '- 需要查数据：{"thought":"理由","action":"工具名","args":"{...}"}\n' +
  '- 给出回答：{"thought":"思路","action":"final","answer":"你的回答"}\n' +
  '要求：只基于工具观察到的真实数据回答，不编造；回答用中文，讲人话，2-5 句。';

export async function runMindmapAgent(input: MindmapAgentInput): Promise<MindmapAgentMessage> {
  const { feature, message, history = [], max_steps = 6 } = input;
  const cfg = loadAgentConfig();
  const ctx: MMContext = { feature, mindMap: loadMindMap(feature), dsl: getDSL(feature) };
  if (!ctx.mindMap) ctx.mindMapErr = `feature "${feature}" 尚未生成思维导图（请先调用 derive_mind_map）。`;

  if (!cfg) {
    return {
      llm: false,
      note: '未配置 LLM（.design-canvas/config.json 或环境变量），本次为规则回答',
      answer: ruleAnswer(ctx, message),
    };
  }

  const context = buildContext(ctx);
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `项目上下文：\n${context}\n\n用户问题：${message}` },
  ];

  for (const h of history) messages.push({ role: h.role, content: h.content });

  let steps: MindmapAgentMessage['step'] | undefined;
  for (let i = 0; i < max_steps; i++) {
    let raw: string;
    try {
      raw = await callChat(cfg, messages);
    } catch (e) {
      return {
        llm: true,
        note: `LLM 调用失败（${(e as Error).message}），已回退规则回答`,
        answer: ruleAnswer(ctx, message),
      };
    }
    const parsed = extractJsonObject(raw);
    const action = parsed?.action as string | undefined;
    if (action === 'final' || !action) {
      return {
        llm: true,
        answer: (parsed?.answer as string) ?? ruleAnswer(ctx, message),
        step: steps,
      };
    }
    const args = typeof parsed?.args === 'string' ? parsed.args : JSON.stringify(parsed?.args ?? {});
    let observation: string;
    try {
      observation = runTool(ctx, action, args);
    } catch (e) {
      observation = `工具执行异常：${(e as Error).message}`;
    }
    steps = { thought: String(parsed?.thought ?? ''), action, args, observation };
    messages.push({ role: 'assistant', content: raw });
    messages.push({ role: 'user', content: `观察：${observation}` });
  }

  return {
    llm: true,
    note: '达到最大工具轮数，已用当前观察给出回答',
    answer: ruleAnswer(ctx, message),
    step: steps,
  };
}

/** 规则降级回答：无 LLM 时也能给出基本答案（基于导图/DSL 摘要） */
function ruleAnswer(ctx: MMContext, message: string): string {
  const mm = ctx.mindMap;
  if (!mm) return '当前未生成思维导图。';
  const root = mm.root;
  const featCount = (root.children ?? []).length;
  const fileCount = flatten(root).filter((n) => n.kind === 'file').length;
  return `这是「${root.label}」的思维导图，共 ${featCount} 个功能 / 子模块，汇总 ${fileCount} 个文件。\n你说的是："${message}"。请配置 LLM（.design-canvas/config.json 或环境变量）以获得基于工具查询的详细问答。`;
}

async function callChat(
  cfg: { apiKey: string; model: string; baseURL: string },
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.2, response_format: { type: 'json_object' } }),
  });
  if (!res.ok) throw new Error(`LLM 调用失败 ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}