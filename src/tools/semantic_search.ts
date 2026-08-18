/**
 * semantic_search：全项目符号语义搜索（路线图序号 8）
 *
 * 数据源零新增：复用 cache.db 的 nodes 表（name/qualified_name/signature/file_path）。
 * 检索文本 = 符号名 + 限定名 + 签名 + 所属文件，用硅基流动 BAAI/bge-m3（OpenAI 兼容
 * /embeddings，1024 维）向量化，query 向量化后做余弦相似度 top-k。
 *
 * 向量缓存（符号侧无损复用）：进程内内存 Map<model:sha256(text) → vector>。
 * 符号文本不变则除首次外全部命中缓存，避免重复调 embedding；相同 query 也命中。
 * 未配置 / embedding 调用失败时自动降级为现有 FTS trigram 全文检索（searchSymbols）。
 *
 * 配置（复用 config.json 机制，见 llm_focus.ts）：
 *   { "embedding": { "apiKey": "sk-...", "model": "BAAI/bge-m3",
 *                    "baseURL": "https://api.siliconflow.cn/v1", "dim": 1024 } }
 *   环境变量覆盖：EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL / EMBEDDING_DIM
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { configFilePath } from './llm_focus.js';
import { getProjectCacheDb, type Database } from '../db/db.js';
import { searchSymbols, type SymbolHit } from '../db/symbols.js';
import { ensureFreshIndex, hasChanges } from './index_freshness.js';

// ─────────────────────────────────────────────────────────────
// 配置
// ─────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  dim: number;
}

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_MODEL = 'BAAI/bge-m3';
const DEFAULT_DIM = 1024;

/** 读取 embedding 配置（config.json 的 embedding 段 + 环境变量覆盖）。无 key 返回 null。 */
export function loadEmbeddingConfig(): EmbeddingConfig | null {
  const fromEnv: Partial<EmbeddingConfig> = {};
  if (process.env.EMBEDDING_BASE_URL) fromEnv.baseURL = process.env.EMBEDDING_BASE_URL;
  if (process.env.EMBEDDING_API_KEY) fromEnv.apiKey = process.env.EMBEDDING_API_KEY;
  if (process.env.EMBEDDING_MODEL) fromEnv.model = process.env.EMBEDDING_MODEL;
  if (process.env.EMBEDDING_DIM) fromEnv.dim = Number(process.env.EMBEDDING_DIM);

  let fileCfg: Partial<EmbeddingConfig> = {};
  const cfgPath = configFilePath();
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (raw && raw.embedding) {
        fileCfg = {
          baseURL: raw.embedding.baseURL,
          apiKey: raw.embedding.apiKey,
          model: raw.embedding.model,
          dim: raw.embedding.dim,
        };
      }
    } catch {
      // config 损坏：忽略，走环境变量/无配置
    }
  }

  const cfg: EmbeddingConfig = {
    apiKey: fromEnv.apiKey ?? fileCfg.apiKey ?? '',
    model: fromEnv.model ?? fileCfg.model ?? DEFAULT_MODEL,
    baseURL: (fromEnv.baseURL ?? fileCfg.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    dim: fromEnv.dim ?? fileCfg.dim ?? DEFAULT_DIM,
  };
  return cfg.apiKey ? cfg : null;
}

// ─────────────────────────────────────────────────────────────
// Embedding（OpenAI 兼容 /embeddings，协议与 ai-base RemoteEmbedder 一致）
// ─────────────────────────────────────────────────────────────

/** 进程内向量缓存：model:sha256(text) → vector。符号侧文本不变即命中，复用免重算。 */
const embedCache = new Map<string, number[]>();

// 缓存统计（供冒烟/观测：验证「向量化一次即可复用」）
let cacheHits = 0;
let apiCalls = 0;

/** 返回 embedding 缓存统计：cache_size 缓存条数 / cache_hits 命中次数 / api_calls 实际调用次数。 */
export function embeddingCacheStats(): { cache_size: number; cache_hits: number; api_calls: number } {
  return { cache_size: embedCache.size, cache_hits: cacheHits, api_calls: apiCalls };
}

function cacheKey(cfg: EmbeddingConfig, text: string): string {
  // key 含 dim：换维度配置（同模型 matryoshka 截断等）自动 miss，内存/持久两层一致
  return `${cfg.model}:${cfg.dim}:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

interface EmbeddingResponseItem {
  embedding: number[];
  index: number;
}

/** 批量向量化。三层查找：进程内存 → 持久 cache.db（embedding_cache 表）→ embedding API。
 * 任一缓存层命中即免 API 调用；API 结果回写内存 + db（传 db 时）。
 * 持久层按 model:sha256(文本)+dim 查表——同一符号文本+模型不变，重启后直接查表。
 * 按传入顺序返回。 */
export async function embedTexts(cfg: EmbeddingConfig, texts: string[], db?: Database): Promise<number[][]> {
  const out: (number[] | null)[] = texts.map(() => null);
  const pending: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const k = cacheKey(cfg, texts[i]);
    const hit = embedCache.get(k);
    if (hit) {
      cacheHits++;
      out[i] = hit;
    } else {
      pending.push(i);
    }
  }

  // 持久层：db 命中的回填内存缓存（本进程后续免查库）。dim 过滤——
  // 换 embedding 模型维度配置时旧向量自动 miss，不产生错配相似度。
  if (db && pending.length > 0) {
    const readStmt = db.prepare('SELECT vector FROM embedding_cache WHERE cache_key = ? AND dim = ?');
    const stillPending: number[] = [];
    for (const i of pending) {
      const row = readStmt.get(cacheKey(cfg, texts[i]), cfg.dim) as
        | { vector: Uint8Array }
        | undefined;
      if (row && row.vector && row.vector.byteLength > 0) {
        const vec = decodeVectorBlob(row.vector);
        embedCache.set(cacheKey(cfg, texts[i]), vec);
        cacheHits++;
        out[i] = vec;
      } else {
        stillPending.push(i);
      }
    }
    pending.length = 0;
    pending.push(...stillPending);
  }

  if (pending.length === 0) return out as number[][];

  // 分批调用，避免单次超 token 上限（首批 128 条）
  const BATCH = 128;
  for (let s = 0; s < pending.length; s += BATCH) {
    const batchIdx = pending.slice(s, s + BATCH);
    const batchInputs = batchIdx.map((i) => texts[i]);
    const vectors = await callEmbeddings(cfg, batchInputs);
    for (let n = 0; n < batchIdx.length; n++) {
      const i = batchIdx[n];
      const k = cacheKey(cfg, texts[i]);
      embedCache.set(k, vectors[n]);
      out[i] = vectors[n];
    }
  }

  // 持久化写入：API 新向量批量落库（单事务）。落库失败不影响本次返回
  // （内存已缓存，本进程不受影响；下次进程重新 embed，语义不损失）。
  if (db) {
    const ins = db.prepare(
      'INSERT OR REPLACE INTO embedding_cache(cache_key, dim, vector, created_at) VALUES (?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    try {
      for (const i of pending) {
        ins.run(cacheKey(cfg, texts[i]), cfg.dim, encodeVectorBlob(out[i]!), Date.now());
      }
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
    }
  }
  return out as number[][];
}

function encodeVectorBlob(v: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(v).buffer);
}

function decodeVectorBlob(b: Uint8Array): number[] {
  return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
}

async function callEmbeddings(cfg: EmbeddingConfig, inputs: string[]): Promise<number[][]> {
  apiCalls++;
  const res = await fetch(`${cfg.baseURL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({ model: cfg.model, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embeddings API returned ${res.status}: ${body.slice(0, 300)}`);
  }
  const parsed = (await res.json()) as { data?: EmbeddingResponseItem[] };
  if (!parsed.data || parsed.data.length !== inputs.length) {
    throw new Error(`embeddings returned ${parsed.data?.length ?? 0} vectors for ${inputs.length} inputs`);
  }
  // 按 index 重排（API 不保证顺序）
  const ordered = new Array<number[]>(inputs.length);
  for (const d of parsed.data) {
    if (d.index < 0 || d.index >= inputs.length) {
      throw new Error(`embeddings returned out-of-range index ${d.index}`);
    }
    if (d.embedding.length !== cfg.dim) {
      throw new Error(`embeddings dim mismatch: got ${d.embedding.length}, configured ${cfg.dim}`);
    }
    ordered[d.index] = d.embedding;
  }
  return ordered;
}

/** 余弦相似度（任一零向量返回 0）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ─────────────────────────────────────────────────────────────
// 语义搜索
// ─────────────────────────────────────────────────────────────

export interface SemanticHit {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  signature: string | null;
  score: number;
}

export interface SemanticSearchInput {
  project_dir: string;
  query: string;
  limit?: number;
  min_score?: number;
}

export interface SemanticSearchResult {
  query: string;
  /** exact=标识符查询命中精确符号索引（零向量）；semantic=向量相似度；fts=无配置/失败降级 */
  provider: 'exact' | 'semantic' | 'fts';
  indexed: number;
  hits: SemanticHit[];
  message: string;
}

/** query 形如符号名（标识符 / 点限定名如 Calc.reset）→ 精确符号索引可解，无需向量 */
const SYMBOL_QUERY_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** 单符号检索文本：符号名 + 限定名 + 签名 + 所属文件。 */
function symbolText(row: { name: string; qualified_name: string; file_path: string; signature: string | null }): string {
  return [row.name, row.qualified_name, row.signature ?? '', row.file_path].filter(Boolean).join('\n');
}

/** 全项目符号语义搜索。三层路由：
 *   1. exact——标识符查询（如 normalizeCode / Calc.reset）直接走 FTS 符号索引，
 *      命中即返回，零 embedding 开销（AI 查代码绝大多数是"知道符号名要定位"）；
 *   2. semantic——自然语言意图或标识符未命中（拼错名时语义相近符号仍有价值）→ 向量相似度；
 *   3. fts——无 embedding 配置 / API 失败自动降级 trigram 全文检索。 */
export async function semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchResult> {
  const query = input.query.trim();
  const limit = input.limit ?? 20;
  const minScore = input.min_score ?? 0;

  if (!query) {
    return { query, provider: 'fts', indexed: 0, hits: [], message: '查询为空' };
  }

  // project_dir 必填：缺失时抛可行动错误（而非静默空结果，LLM 会误判为"索引不存在"）
  if (!input.project_dir || !String(input.project_dir).trim()) {
    throw new Error(
      '缺参数 "project_dir"：语义搜索需要指定要搜索的项目根目录（该项目需先运行 import_project 建立符号索引）。',
    );
  }

  // 打开缓存：打不开 = 索引未建立，抛可行动错误（callTool 层会标 isError）
  let db: Database;
  try {
    db = getProjectCacheDb(path.resolve(input.project_dir));
  } catch (e) {
    throw new Error(
      `无法打开符号缓存：${(e as Error).message}。请先对该项目运行 import_project 建缓存。`,
    );
  }

  // 索引自动保鲜：外部改动（git pull / 手动编辑 / 其他 agent）懒校验增量重同步——
  // 查询永远基于最新代码，不报已删符号、不漏新符号。失败不阻断查询。
  const fresh = await ensureFreshIndex(db, path.resolve(input.project_dir));
  const freshNote = (hasChanges(fresh) || fresh.skipped_adds > 0)
    ? `（索引自刷新 ${fresh.ms}ms：重同步 ${fresh.resynced} / 新增 ${fresh.added} / 删除 ${fresh.removed}${fresh.failed ? ` / 解析失败 ${fresh.failed}` : ''}${fresh.skipped_adds > 0 ? `；另有 ${fresh.skipped_adds} 个新文件超出保鲜补全上限未纳入，建议重新 import_project` : ''}）`
    : '';

  const rows = db
    .prepare(
      `SELECT id, kind, name, qualified_name, file_path, start_line, signature
       FROM nodes WHERE kind != 'file' ORDER BY start_line, id`,
    )
    .all() as Array<{
    id: string;
    kind: string;
    name: string;
    qualified_name: string;
    file_path: string;
    start_line: number;
    signature: string | null;
  }>;

  if (rows.length === 0) {
    throw new Error(
      `项目 "${input.project_dir}" 的符号缓存为空（尚未建立索引）。请先运行 import_project 导入该项目后再搜索。`,
    );
  }

  // 精确层前置：标识符查询走符号索引（零向量开销，省 embedding 费用与首查延迟）。
  // 未命中不返回——落到向量层，拼错名时语义相近符号仍有价值。
  if (SYMBOL_QUERY_RE.test(query)) {
    const sigByKey = new Map(rows.map((r) => [`${r.qualified_name}:${r.start_line}`, r.signature]));
    const fts = searchSymbols(db, query, limit);
    if (fts.length > 0) {
      const hits: SemanticHit[] = fts.map((s) => ({
        ...s,
        signature: sigByKey.get(`${s.qualified_name}:${s.start_line}`) ?? null,
        score: 1,
      }));
      return {
        query, provider: 'exact', indexed: rows.length, hits,
        message: `精确符号命中 ${hits.length} 个（标识符查询未走向量，零 embedding 开销）。${freshNote}`,
      };
    }
  }

  // 取配置；无配置走降级
  const cfg = loadEmbeddingConfig();
  if (!cfg) {
    return ftsFallback(db, query, limit, rows.length, undefined, freshNote);
  }

  // 向量化符号 + query（传 db：命中持久向量表免 API，重启后不全量 embed）
  try {
    const statsBefore = embeddingCacheStats();
    const vectors = await embedTexts(cfg, rows.map(symbolText), db);
    const qvec = (await embedTexts(cfg, [query], db))[0];
    const statsAfter = embeddingCacheStats();
    const dHits = statsAfter.cache_hits - statsBefore.cache_hits;
    const dApi = statsAfter.api_calls - statsBefore.api_calls;
    const scored = rows.map((r, i) => ({ r, score: cosineSimilarity(qvec, vectors[i]) }));
    scored.sort((a, b) => b.score - a.score);
    const hits: SemanticHit[] = scored
      .filter((s) => s.score >= minScore)
      .slice(0, limit)
      .map((s) => ({ ...s.r, score: s.score }));
    return {
      query, provider: 'semantic', indexed: rows.length, hits,
      message: `语义搜索完成，索引 ${rows.length} 个符号（缓存命中 ${dHits}，API 调用 ${dApi} 次${dApi === 0 ? '，全量来自持久向量表' : ''}）。${freshNote}`,
    };
  } catch (e) {
    // embedding 失败（网络/限流/模型错误）→ 降级 FTS
    return ftsFallback(db, query, limit, rows.length, (e as Error).message, freshNote);
  }
}

function ftsFallback(
  db: Database, query: string, limit: number, indexed: number, reason?: string, freshNote = '',
): SemanticSearchResult {
  const fts = searchSymbols(db, query, limit);
  const hits: SemanticHit[] = fts.map((s: SymbolHit) => ({
    ...s,
    signature: null,
    score: 0,
  }));
  return {
    query, provider: 'fts', indexed, hits,
    message: reason
      ? `语义搜索失败（${reason}），已降级为关键词全文检索。${freshNote}`
      : `未配置 embedding（config.json 缺 embedding 段），已用关键词全文检索。${freshNote}`,
  };
}