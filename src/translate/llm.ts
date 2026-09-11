/**
 * llm —— 接入设计内置 AGNES key 池的 HoleTranslator（fork 自 dsh-brain/packages/key-pool-proxy）
 *
 * key-pool-proxy 本身是一个本地 OpenAI 兼容反向代理：读 `AGNES_KEY_POOL`（逗号分隔多 key），
 * round-robin 分摊 + 遇 429/5xx 冷却换 key 重试，上游 apihub.agnes-ai.com。本文件不在跑代理，
 * 而是把那套轮换语义内联成纯客户端函数，让 translate 的 HoleTranslator 自包含即可翻译——
 * 不必依赖 dsh-brain 代理进程是否在跑。
 *
 * 轮换语义（对齐 key-pool-proxy）：遇 retryStatuses（默认 429/5xx）把当前 key 打入冷却窗口，
 * 立即换下一个 key 重试，直到成功或重试耗尽；平时 round-robin。
 */
import type { FillContext, HoleTranslator, BatchHoleTranslator } from './fill.js';
import { buildBatchFillPrompt, type BatchUnitView } from './prompts.js';

/** 极简 fetch 形态（Node 18+ 全局 fetch 不依赖 DOM lib，这里显式声明） */
export type MinimalFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface PooledTranslatorConfig {
  /** 上游 OpenAI 兼容根（不含 /v1）。缺省 AGNES_UPSTREAM_BASE 或 key-pool-proxy 默认 agnes */
  baseURL?: string;
  /** 模型。缺省 AGNES_MODEL 或 deepseek-chat */
  model?: string;
  /** 主 key 池 env 名（逗号分隔多 key）。缺省 AGNES_KEY_POOL */
  poolEnv?: string;
  /** 回退 env（逗号分隔合并） */
  fallbackEnvs?: string[];
  /** 显式 key 列表（测试注入；缺省从 env 读取） */
  keys?: string[];
  cooldownMs?: number;
  maxRetries?: number;
  retryStatuses?: number[];
  temperature?: number;
  maxTokens?: number;
  /** 自定义 fetch（测试桩 / 代理） */
  fetchImpl?: MinimalFetch;
}

/** 多 key 轮换池（round-robin + 冷却窗口） */
export class KeyPool {
  private ptr = 0;
  private blockedUntil: number[];
  constructor(readonly keys: string[]) {
    this.blockedUntil = new Array(keys.length).fill(0);
  }
  get length(): number {
    return this.keys.length;
  }
  /** 取一个未冷却的 key 下标；全冷却返回 -1 */
  pick(now: number): number {
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.ptr + i) % this.keys.length;
      if (this.blockedUntil[idx] <= now) {
        this.ptr = (idx + 1) % this.keys.length;
        return idx;
      }
    }
    return -1;
  }
  hasAvailable(now: number): boolean {
    return this.blockedUntil.some((t) => t <= now);
  }
  cooldown(idx: number, now: number, ms: number): void {
    this.blockedUntil[idx] = now + ms;
  }
}

/** 从主池 + 回退 env 读取去重 key 列表（fork key-pool-proxy 语义） */
export function loadKeys(poolEnv: string, fallbackEnvs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    for (const raw of value.split(',')) {
      const k = raw.trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  };
  const main = process.env[poolEnv];
  if (main) add(main);
  for (const e of fallbackEnvs) {
    const v = process.env[e];
    if (v) add(v);
  }
  return out;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 单次 chat 请求：返回 { status, content }；解析失败/无内容时 content 为空串 */
async function chatOnce(fetchImpl: MinimalFetch, baseURL: string, key: string, body: unknown): Promise<{ status: number; content: string }> {
  const res = await fetchImpl(baseURL.replace(/\/+$/, '') + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(body),
  });
  let content = '';
  try {
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = data.choices?.[0]?.message?.content?.trim?.() ?? '';
  } catch {
    /* 非 JSON 响应 → 当作空内容 */
  }
  return { status: res.status, content };
}

/** 剥掉模型常见的 markdown 代码围栏（```lang ... ```），只取内层函数体 */
export function normalizeBody(c: string): string {
  const s = c.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)```\s*$/.exec(s);
  return (m ? m[1].trim() : s).trim();
}

/** 共享的池化 chat：遇冷却/空内容自动换 key 重试，返回原始 content 文本（含 markdown 围栏，由各翻译器自行剥） */
function buildChat(config: PooledTranslatorConfig): (messages: ChatMessage[]) => Promise<string> {
  const baseURL = (config.baseURL ?? process.env.AGNES_UPSTREAM_BASE ?? 'https://apihub.agnes-ai.com').replace(/\/+$/, '');
  // 显式配 baseURL（典型指向本地 key-pool-proxy）→ 客户端无需 key，Bearer 占位，轮换发生在上游代理自己的池。
  let keys = config.keys ?? loadKeys(config.poolEnv ?? 'AGNES_KEY_POOL', config.fallbackEnvs ?? []);
  const explicitBase = config.baseURL !== undefined || process.env.AGNES_UPSTREAM_BASE !== undefined;
  if (keys.length === 0 && explicitBase) keys = ['proxy-caller'];
  if (keys.length === 0) {
    throw new Error(
      `[translate/llm] 空 key 池：可设 ${config.poolEnv ?? 'AGNES_KEY_POOL'}（逗号分隔多 key），` +
        `或设 AGNES_UPSTREAM_BASE 指向本地 key-pool-proxy、或传入 keys 显式提供。`,
    );
  }
  const pool = new KeyPool(keys);
  const fetchImpl =
    config.fetchImpl ?? (((globalThis as { fetch?: MinimalFetch }).fetch as MinimalFetch | undefined)?.bind(globalThis) as MinimalFetch);
  if (!fetchImpl) throw new Error('[translate/llm] 环境无 fetch（Node >= 18）。');
  const model = config.model ?? process.env.AGNES_MODEL ?? 'deepseek-chat';
  const cooldownMs = config.cooldownMs ?? 15000;
  const maxRetries = config.maxRetries ?? 3;
  const retrySet = new Set<number>(config.retryStatuses ?? [429, 500, 502, 503, 504]);
  const temperature = config.temperature ?? 0.2;
  const maxTokens = config.maxTokens ?? 2048;

  return async (messages: ChatMessage[]): Promise<string> => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const now = Date.now();
      if (!pool.hasAvailable(now)) break;
      const idx = pool.pick(now);
      if (idx < 0) break;
      const { status, content } = await chatOnce(fetchImpl, baseURL, pool.keys[idx], {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      });
      if (content) return content; // 有内容即成功（是否合法由 fill 侧闸把关）
      if (retrySet.has(status) && attempt < maxRetries) {
        pool.cooldown(idx, Date.now(), cooldownMs);
        continue;
      }
      throw new Error(`LLM 返回 ${status}（key 池第 ${idx + 1} 把）：${content || '空内容/非 JSON'}`);
    }
    throw new Error('[translate/llm] key 池已全部冷却或重试耗尽');
  };
}

const SYSTEM_FILL = '你是源码翻译器。严格遵守 user 的约束：只输出目标函数体，不得生成 export function 外壳、不得改动签名。';
const SYSTEM_BATCH =
  '你是源码翻译器。必须为每个函数各输出一个 `<unit id="...">函数体</unit>` 标记块，块数=题目函数数，ID 逐一对应，块间无其它文字、不改签名。';

/**
 * 基于 AGNES key 池的 HoleTranslator（单孔）工厂。
 * 返回的翻译器：把 FillContext.prompt 发给 LLM，只取函数体文本返回。空 key 池/无 fetch 时抛错。
 */
export function createPooledHoleTranslator(config: PooledTranslatorConfig = {}): HoleTranslator {
  const chat = buildChat(config);
  return async (ctx: FillContext): Promise<string> => {
    return normalizeBody(await chat([{ role: 'system', content: SYSTEM_FILL }, { role: 'user', content: ctx.prompt }]));
  };
}

/**
 * 基于 AGNES key 池的 BatchHoleTranslator（多孔一次性）工厂。
 * 一次调用把一批 FillContext 拼成一个批量 prompt（共享 system/项目调用约定），返回
 * `<unit id>body</unit>` 标记块的原始文本；切分/逐单元验证见 fill.fillUnitsBatched。
 */
export function createPooledBatchTranslator(config: PooledTranslatorConfig = {}): BatchHoleTranslator {
  const chat = buildChat(config);
  const view = (c: FillContext): BatchUnitView => ({ unit: c.unit, skeleton: c.skeleton, srcSnippet: c.srcSnippet, constraints: c.constraints });
  return async (ctxs: FillContext[]): Promise<string> => {
    const prompt = buildBatchFillPrompt(ctxs.map(view), ctxs[0]?.projectNote);
    return normalizeBody(await chat([{ role: 'system', content: SYSTEM_BATCH }, { role: 'user', content: prompt }]));
  };
}