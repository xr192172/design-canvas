/**
 * llm_focus：LLM 关键节点选择（"用户不是直接看整条路线，而是聚焦某些关键节点"）
 *
 * 关键节点由 LLM 列出，但数据经过整条链路的真实流转（trace_exec）——LLM 只做"选点/解释"，
 * 不做"造假值"。职责分离：
 *   - trace_exec：数据真实流转（用户输入 → 每步真实 in/out）
 *   - llm_focus：从全链里挑出值得聚焦的关键节点（判定点/汇聚点/高风险函数），附理由
 *
 * 配置（用户偏好：配置文件管理 API keys/model 参数，未来前端 HUB 集成）：
 *   <home>/.design-canvas/config.json        ← 默认（含密钥，放用户主目录，避免随项目打包/提交泄漏）
 *   <projectRoot>/.design-canvas/config.json ← 旧默认位置，读取时回退兼容
 *   { "llm": { "apiKey": "sk-...", "model": "gpt-4o-mini", "baseURL": "https://api.openai.com/v1" } }
 *   环境变量覆盖：LLM_API_KEY / LLM_MODEL / LLM_BASE_URL
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as storage from '../storage.js';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

export interface LlmConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

/** 配置主目录：DESIGN_CANVAS_HOME 显式覆盖（测试/部署用）优先，否则用户主目录 */
export function getConfigHome(): string {
  return process.env.DESIGN_CANVAS_HOME ?? os.homedir();
}

/** 写入/新位置：<configHome>/.design-canvas/config.json（默认用户主目录） */
export function configFilePath(): string {
  return path.join(getConfigHome(), '.design-canvas', 'config.json');
}

/**
 * 实际读取路径：新位置（主目录）优先；不存在时回退旧默认位置
 * （<projectRoot>/.design-canvas/config.json），兼容升级前已落盘的配置。
 */
export function configFileReadPath(): string {
  const home = configFilePath();
  if (fs.existsSync(home)) return home;
  const legacy = path.join(storage.getDataHome(), '.design-canvas', 'config.json');
  return legacy !== home && fs.existsSync(legacy) ? legacy : home;
}

// ─────────────────────────────────────────────────────────────
// Agent 配置（L3 思维导图 Agent / 管理 Agent 默认后端 = AGNES）
// ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_AGNES_MODEL = 'agnes-2.0-flash';

/**
 * 读取管理 Agent 的 LLM 配置。优先级：
 *   1) 环境变量 AGNES_API_KEY / AGNES_BASE_URL / AGNES_MODEL
 *   2) config.json 的 agent.mmd 段（{ "agent": { "mmd": {...} } }）
 * 无 key 返回 null（此时管理 Agent 走规则降级）。
 * 说明：Agent 默认后端固定为 AGNES，与科普讲解（DeepSeek）解耦。
 */
export function loadAgentConfig(): AgentConfig | null {
  const envApiKey = process.env.AGNES_API_KEY?.trim();
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      model: process.env.AGNES_MODEL?.trim() || DEFAULT_AGNES_MODEL,
      baseURL: (process.env.AGNES_BASE_URL?.trim() || DEFAULT_AGNES_BASE_URL).replace(/\/+$/, ''),
    };
  }

  const cfgPath = configFileReadPath();
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

export function loadLlmConfig(): LlmConfig | null {
  const fromEnv: Partial<LlmConfig> = {};
  if (process.env.LLM_API_KEY) fromEnv.apiKey = process.env.LLM_API_KEY;
  if (process.env.LLM_MODEL) fromEnv.model = process.env.LLM_MODEL;
  if (process.env.LLM_BASE_URL) fromEnv.baseURL = process.env.LLM_BASE_URL;

  let fileCfg: Partial<LlmConfig> = {};
  const cfgPath = configFileReadPath();
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (raw && raw.llm) {
        fileCfg = {
          apiKey: raw.llm.apiKey,
          model: raw.llm.model,
          baseURL: raw.llm.baseURL,
        };
      }
    } catch {
      // config 损坏：忽略，走环境变量/无配置
    }
  }
  let cfg: LlmConfig = {
    apiKey: fromEnv.apiKey ?? fileCfg.apiKey ?? '',
    model: fromEnv.model ?? fileCfg.model ?? 'gpt-4o-mini',
    baseURL: (fromEnv.baseURL ?? fileCfg.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
  };
  // 兜底：未配置专用 llm 段时复用 agent.mmd（AGNES，OpenAI 兼容），
  // 使 overview / feature_tree / mind_map 等通用提炼功能开箱即用
  if (!cfg.apiKey) {
    const agent = loadAgentConfig();
    if (agent) cfg = { apiKey: agent.apiKey, model: agent.model, baseURL: agent.baseURL };
  }
  return cfg.apiKey ? cfg : null;
}

// ─────────────────────────────────────────────────────────────
// OpenAI 兼容 chat 调用
// ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function callChat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  temperature = 0.2,
  /** 请求超时（默认 90s；慢端点上大 prompt 曾出现 5 分钟悬挂，必须有保护） */
  timeoutMs = 90_000,
): Promise<string> {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      response_format: { type: 'json_object' }, // 兼容 OpenAI/DeepSeek 等
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`LLM 调用失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? '';
  return content.trim();
}

// ─────────────────────────────────────────────────────────────
// 关键节点选择
// ─────────────────────────────────────────────────────────────

export interface FocusNode {
  node_id: string;
  reason: string;
}

export interface ChainNodeInfo {
  node_id: string;
  label: string;
  func_name: string;
  description: string;
  /** 是否判定节点（CFG 分支/循环） */
  is_judgement: boolean;
  /** 是否跨文件追加 */
  is_cross: boolean;
}

export interface FocusResult {
  /** 是否真正用 LLM 选点（false = 未配置/降级为启发式） */
  llm: boolean;
  key_nodes: FocusNode[];
  /** 未配置或调用失败的原因（降级说明） */
  note?: string;
}

/**
 * 从全链选关键节点。
 * - 有 LLM 配置：交给 LLM（给节点清单 + 判定上下文，返回 JSON 选点+理由）
 * - 无配置/失败：启发式降级（判定节点优先，跨文件/汇聚节点次之），如实标注 llm=false
 * 注意：LLM 只选"哪些节点值得看"，不生成任何数据值——值全部来自 trace_exec 真实流转。
 */
export async function pickKeyNodes(
  cfg: LlmConfig | null,
  chain: ChainNodeInfo[],
  opts?: { max?: number; userFocus?: string },
): Promise<FocusResult> {
  const max = opts?.max ?? 5;
  if (chain.length === 0) return { llm: false, key_nodes: [], note: '链路为空' };

  if (!cfg) {
    return {
      llm: false,
      key_nodes: heuristicFocus(chain, max),
      note: '未配置 LLM（.design-canvas/config.json 或环境变量），已用启发式选点',
    };
  }

  const chainText = chain
    .map((n, i) =>
      [
        `${i + 1}. node_id=${n.node_id}`,
        `   函数=${n.func_name}`,
        `   判定=${n.is_judgement ? '是' : '否'} 跨文件=${n.is_cross ? '是' : '否'}`,
        `   说明=${n.description || n.label}`,
      ].join('\n'),
    )
    .join('\n');

  const system =
    '你是数据流可读性助手。用户在图里追踪一条数据链路，不想看全部节点，只想聚焦少数关键节点。' +
    '请从给定的链路节点中挑选出最值得聚焦的关键节点（最多 ' + max + ' 个），并给出人话理由。' +
    '判定节点（if/循环/分支）通常优先，汇聚点（多入边）、跨文件调用、异常处理次之。' +
    '只输出 JSON：{"key_nodes":[{"node_id":"...","reason":"..."}]}，node_id 必须来自给定清单。';

  const user = (opts?.userFocus ? `用户关注的焦点：${opts.userFocus}\n\n` : '') + `数据链路节点：\n${chainText}`;

  try {
    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = JSON.parse(raw) as { key_nodes?: Array<{ node_id?: string; reason?: string }> };
    const known = new Set(chain.map((n) => n.node_id));
    const keyNodes: FocusNode[] = (parsed.key_nodes ?? [])
      .filter((k) => k.node_id && known.has(k.node_id))
      .slice(0, max)
      .map((k) => ({ node_id: k.node_id as string, reason: k.reason || '聚焦点' }));
    if (keyNodes.length === 0) {
      return { llm: true, key_nodes: heuristicFocus(chain, max), note: 'LLM 未返回有效节点，已用启发式选点' };
    }
    return { llm: true, key_nodes: keyNodes };
  } catch (e) {
    return {
      llm: false,
      key_nodes: heuristicFocus(chain, max),
      note: `LLM 调用失败（${(e as Error).message}），已用启发式选点`,
    };
  }
}

/** 启发式降级：判定节点 → 跨文件 → 汇聚节点，再按出现顺序补足 */
function heuristicFocus(chain: ChainNodeInfo[], max: number): FocusNode[] {
  const out: FocusNode[] = [];
  const push = (n: ChainNodeInfo, reason: string) => {
    if (out.length >= max) return;
    if (!out.some((o) => o.node_id === n.node_id)) out.push({ node_id: n.node_id, reason });
  };
  for (const n of chain) if (n.is_judgement) push(n, '判定点：数据在此分流，值得聚焦');
  for (const n of chain) if (!n.is_judgement && n.is_cross) push(n, '跨文件调用：数据流出本文件');
  for (const n of chain) if (!n.is_judgement && !n.is_cross) push(n, '关键处理');
  return out;
}
