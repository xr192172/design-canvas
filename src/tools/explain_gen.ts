/**
 * explain_gen：科普式讲解导览的角色化文案生成（Persona-Adaptive UI 的 LLM 后端）
 *
 * 手写 EXPLAIN_SCRIPT 只作为兜底；本模块用文本 LLM（OpenAI 兼容
 * /chat/completions，接入方式复用本仓库既有抽取约定）为每个讲解模块实时生成
 * 三档角色文案：newbie（口语）/ pm（业务价值）/ senior（技术实现）。
 * 生成失败 / 未配置时回退手写文案，不阻塞讲解播放。
 *
 * 默认后端为 DeepSeek（能力更强），模型 deepseek-v4-flash；保留 Agnes 兼容。
 * 配置（复用 config.json 机制，见 llm_focus.ts）：
 *   { "explain": { "apiKey": "sk-...", "model": "deepseek-v4-flash",
 *                  "baseURL": "https://api.deepseek.com/v1" } }
 *   环境变量覆盖：DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL
 *   （未配置 DeepSeek 时兼容 AGNES_API_KEY / AGNES_BASE_URL / AGNES_MODEL）
 */

import fs from 'node:fs';
import path from 'node:path';
import { configFileReadPath } from './llm_focus.js';
import { getStorageRoot } from '../storage.js';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

export interface ExplainConfig {
  apiKey: string;
  model: string;
  baseURL: string;
}

const DEFAULT_DS_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_DS_MODEL = 'deepseek-v4-flash';
const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1';
const DEFAULT_AGNES_MODEL = 'agnes-2.0-flash';

/** 读取讲解文案生成配置。优先级：DeepSeek 环境变量 > config.json explain 段 > Agnes 环境变量。无 key 返回 null。 */
export function loadExplainConfig(): ExplainConfig | null {
  // DeepSeek（首选后端）
  const dsEnv: Partial<ExplainConfig> = {};
  if (process.env.DEEPSEEK_API_KEY) dsEnv.apiKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.DEEPSEEK_BASE_URL) dsEnv.baseURL = process.env.DEEPSEEK_BASE_URL;
  if (process.env.DEEPSEEK_MODEL) dsEnv.model = process.env.DEEPSEEK_MODEL;

  // Agnes（兼容后端）
  const agnesEnv: Partial<ExplainConfig> = {};
  if (process.env.AGNES_API_KEY) agnesEnv.apiKey = process.env.AGNES_API_KEY;
  if (process.env.AGNES_BASE_URL) agnesEnv.baseURL = process.env.AGNES_BASE_URL;
  if (process.env.AGNES_MODEL) agnesEnv.model = process.env.AGNES_MODEL;

  let fileCfg: Partial<ExplainConfig> = {};
  const cfgPath = configFileReadPath();
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (raw && raw.explain) {
        fileCfg = {
          apiKey: raw.explain.apiKey,
          model: raw.explain.model,
          baseURL: raw.explain.baseURL,
        };
      }
    } catch {
      // config 损坏：忽略，走环境变量/无配置
    }
  }

  // 1) DeepSeek 环境变量
  if (dsEnv.apiKey) {
    return {
      apiKey: dsEnv.apiKey,
      model: dsEnv.model ?? DEFAULT_DS_MODEL,
      baseURL: (dsEnv.baseURL ?? DEFAULT_DS_BASE_URL).replace(/\/+$/, ''),
    };
  }
  // 2) config.json explain 段（默认落到 DeepSeek）
  if (fileCfg.apiKey) {
    return {
      apiKey: fileCfg.apiKey,
      model: fileCfg.model ?? DEFAULT_DS_MODEL,
      baseURL: (fileCfg.baseURL ?? DEFAULT_DS_BASE_URL).replace(/\/+$/, ''),
    };
  }
  // 3) Agnes 环境变量（兼容）
  if (agnesEnv.apiKey) {
    return {
      apiKey: agnesEnv.apiKey,
      model: agnesEnv.model ?? DEFAULT_AGNES_MODEL,
      baseURL: (agnesEnv.baseURL ?? DEFAULT_AGNES_BASE_URL).replace(/\/+$/, ''),
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 三档角色文案生成
// ─────────────────────────────────────────────────────────────

export interface GeneratedNarrations {
  newbie: string;
  pm: string;
  senior: string;
}

/** 从 LLM 返回文本中稳健提取 JSON 对象（兼容 code-fence / 前导杂话）。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  // 从第一个 '{' 到最后一个 '}' 截取
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 用 Agnes 为单个模块生成三档角色文案。
 * @param moduleLabel  模块标题（如「入口：MCP 服务」）
 * @param background   权威技术说明（通常传手写 senior 文案，作为唯一事实来源）
 * @param cfg          Agnes 配置
 */
export async function generateModuleNarrations(
  moduleLabel: string,
  background: string,
  cfg: ExplainConfig,
): Promise<GeneratedNarrations> {
  const system =
    '你是软件科普讲解小编剧。给定一个模块的权威技术说明，请为同一模块写出三档讲解文案，服务于不同读者。' +
    '要求：' +
    '1. newbie：口语化、少术语，面向第一次接触的新人，讲清"这是什么、用来干嘛"；2-3 句。' +
    '2. pm：面向产品/管理者，讲"解决什么问题、业务价值在哪"，少写代码；2-3 句。' +
    '3. senior：面向资深开发，讲"内部怎么实现、关键机制/API"，保留技术术语；2-4 句。' +
    '三档都基于给定的权威技术说明，不得编造事实。' +
    '只输出 JSON：{"newbie":"...","pm":"...","senior":"..."}，不要输出其他内容。';

  const user = `模块：${moduleLabel}\n权威技术说明：\n${background}`;

  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    throw new Error(`Agnes 调用失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  const parsed = extractJsonObject(content);
  if (!parsed) {
    throw new Error('Agnes 未返回有效 JSON 文案');
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const out: GeneratedNarrations = {
    newbie: str(parsed.newbie),
    pm: str(parsed.pm),
    senior: str(parsed.senior),
  };
  if (!out.newbie && !out.pm && !out.senior) {
    throw new Error('Agnes 返回的文案为空');
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 三档文案持久化
// ─────────────────────────────────────────────────────────────

/** 生成文案落盘路径：<dataHome>/.design-canvas/explain.gen.json */
export function getExplainGenFile(): string {
  return path.join(getStorageRoot(), 'explain.gen.json');
}

/**
 * 读取已生成的 LLM 三档文案，按模块标题索引。
 * 返回空对象表示尚无持久化文案（此时播放器用回手写 EXPLAIN_SCRIPT）。
 */
export function loadGeneratedNarrations(): Record<string, GeneratedNarrations> {
  const file = getExplainGenFile();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const map: Record<string, GeneratedNarrations> = {};
    if (raw && typeof raw === 'object') {
      for (const [title, v] of Object.entries(raw)) {
        const n = v as GeneratedNarrations;
        if (n && typeof n.newbie === 'string' && typeof n.pm === 'string' && typeof n.senior === 'string') {
          map[title] = n;
        }
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** 合并保存一批生成文案（按标题覆盖），返回落盘路径。 */
export function saveGeneratedNarrations(entries: Array<{ title: string; narrations: GeneratedNarrations }>): string {
  const map = loadGeneratedNarrations();
  for (const e of entries) {
    if (e.title && e.narrations) map[e.title] = e.narrations;
  }
  const file = getExplainGenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2), 'utf-8');
  return file;
}