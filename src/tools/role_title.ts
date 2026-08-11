/**
 * role_title —— 文件节点人话职责标题生成
 *
 * import_project 会为每个源文件生成一个节点，label 默认是文件名（如
 * `dir_tools · 12 APIs`）。对非母语开发者，"文件名"很难一眼看懂文件在干什么。
 * 本模块用文本 LLM 为每个文件批量生成一句中文职责摘要（如"命令行工具注册"），
 * 作为节点主标题（node.title），原始文件名保留为副标题（label）。
 *
 * 复用 llm_focus 的配置与调用基建（config.json 的 llm 段 / LLM_* 环境变量），
 * 分批并发调用以控制成本；未配置 / 调用失败时返回空 map，调用方静默降级为
 * 现状（只显示文件名），不阻塞导入流程。
 */

import { loadLlmConfig, callChat, configFilePath } from './llm_focus.js';
import { loadExplainConfig } from './explain_gen.js';

/** 单个待生成职责的文件 */
export interface RoleFileInput {
  /** 文件相对路径（如 src/tools/import_project.ts） */
  path: string;
  /** 相对 project_dir 的目录（如 src/tools） */
  dir: string;
  /** 解析出的 API 签名（前 N 个），供 LLM 判断职责 */
  apis: string[];
}

export interface RoleTitleOptions {
  /** 每批最多文件数，默认 20（控制单次 payload 长度） */
  batch?: number;
  /** 并发批数上限，默认 3 */
  concurrency?: number;
}

interface TitleEntry {
  path: string;
  title: string;
}

/**
 * 为一批文件名生成中文职责标题。
 * @returns { path: title } 映射；未配置 LLM 或全部失败返回空对象。
 */
export async function generateFileRoleTitles(
  files: RoleFileInput[],
  opts: RoleTitleOptions = {},
): Promise<Record<string, string>> {
  if (files.length === 0) return {};
  // 配置优先级：通用 LLM 段（llm_focus）→ 讲解后端（explain_gen，兼容 DEEPSEEK/AGNES 环境变量）
  const cfg = loadLlmConfig() ?? toLlmCfg(loadExplainConfig());
  if (!cfg) return {}; // 未配置 LLM：降级，不生成

  const batch = opts.batch ?? 20;
  const concurrency = opts.concurrency ?? 3;
  const batches: RoleFileInput[][] = [];
  for (let i = 0; i < files.length; i += batch) {
    batches.push(files.slice(i, i + batch));
  }

  const out: Record<string, string> = {};
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= batches.length) return;
      const group = batches[idx];
      try {
        const entries = await generateOne(cfg, group);
        for (const e of entries) out[e.path] = e.title;
      } catch {
        // 单批失败不阻塞整体，其余批次继续
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
  );
  return out;
}

async function generateOne(
  cfg: NonNullable<ReturnType<typeof loadLlmConfig>>,
  group: RoleFileInput[],
): Promise<TitleEntry[]> {
  const listText = group
    .map(
      (f, i) =>
        `${i + 1}. path=${f.path}\n` +
        `   目录=${f.dir}\n` +
        `   API=${(f.apis.length ? f.apis.slice(0, 6) : ['(无)']).join(' ; ')}`,
    )
    .join('\n');

  const system =
    '你是项目代码结构解读助手。给定一组源文件（路径+目录+API 签名），请为每个文件生成一句' +
    '不超过 12 个汉字的中文职责标题，让人不看文件名也能懂这个文件在干什么。' +
    '要求：直接描述功能（如"参数解析与校验"、"HTTP 路由注册"），不要出现文件名/扩展名/路径，' +
    '不要重复，不要标点。只输出 JSON：{"titles":[{"path":"...","title":"..."}]}，path 必须来自给定清单。';

  const user = `请为以下 ${group.length} 个文件生成职责标题：\n${listText}`;
  const raw = await callChat(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);

  // 兼容 code-fence / 前导杂话：提取 JSON 对象
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
    titles?: Array<{ path?: string; title?: string }>;
  };
  const known = new Set(group.map((f) => f.path));
  const entries: TitleEntry[] = [];
  for (const t of parsed.titles ?? []) {
    if (t.path && known.has(t.path) && t.title) {
      entries.push({ path: t.path, title: t.title.trim().slice(0, 24) });
    }
  }
  return entries;
}

export { configFilePath };

/** 把讲解后端配置（ExplainConfig）转成通用 LLM 配置（LlmConfig），供 callChat 使用 */
function toLlmCfg(c: ReturnType<typeof loadExplainConfig>) {
  return c ? { apiKey: c.apiKey, model: c.model, baseURL: c.baseURL } : null;
}