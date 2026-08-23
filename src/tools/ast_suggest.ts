/**
 * ast_suggest —— 短变量智能化改名（LLM 命名建议 + 批量重命名）
 *
 * 定位：AST 重构链路的"建议层"。底层 ast_rename.renameMany 负责安全批量改写，
 * 本文件负责"该改谁、改成什么"：
 *   - findSuggestCandidates：纯逻辑挑出短名/无意义局部变量（宁漏不误），附声明行上下文。
 *   - suggestRenames：请 LLM 给每个候选一个新名+理由；无 LLM / 调用失败 → 如实降级只列候选。
 *
 * 只建议、不替用户拍板：suggested 是"建议值"，最终是否应用交给调用方连到 renameMany。
 */

import { analyzeLocals } from './ast_rename.js';
import { loadLlmConfig } from './llm_focus.js';

// ─────────────────────────────────────────────────────────────
// 低信息量变量名（启发式候选）
// ─────────────────────────────────────────────────────────────

/** 一眼无信息的通用名（候选补充集，minLen 之外的名单） */
const BAD_NAMES = new Set([
  'tmp', 'temp', 't', 'val', 'value', 'obj', 'item', 'data', 'res', 'ret', 'rs', 'out',
  'x', 'y', 'z', 'i', 'j', 'k', 'n', 'm', 'a', 'b', 'c', 'd', 'e', 'f', 'g',
  'list', 'arr', 'str', 'num', 'bool', 'cb', 'fn', 'h', 'elem', 'el',
]);

const LOCAL_KINDS = new Set(['const', 'let', 'var', 'param', 'catch']);

export interface SuggestCandidate {
  id: number;
  name: string;
  kind: string;
  /** 所在命名函数名（顶层非函数内为 ''） */
  parentFunction: string;
  /** 引用点数量（不含声明/赋值） */
  refs: number;
  /** 声明所在行源码（LLM 上下文） */
  declLine: string;
  /** LLM 建议的新名（未建议为空串） */
  suggested: string;
  /** 建议理由（LLM 给，降级为空串） */
  reason: string;
}

function isIdent(s: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(s);
}

function isBadName(name: string, minLen: number): boolean {
  if (!name || name === '_') return false; // '_' 是常见有意省略
  return name.length <= minLen || BAD_NAMES.has(name);
}

/** 由偏移定位所在行文本（声明行上下文） */
function lineAt(src: string, index: number): string {
  let ls = src.lastIndexOf('\n', index - 1) + 1;
  let le = src.indexOf('\n', index);
  if (le === -1) le = src.length;
  return src.slice(ls, le).trim();
}

/**
 * 纯逻辑候选：挑出"值得改名"的短名/无意义局部变量。
 * 只含函数体内局部绑定（parentFunction 非空），排模块顶层（可能被外部消费）。
 * minLen：名字长度阈值，<= minLen 即视为短名（默认 2）。
 */
export async function findSuggestCandidates(
  src: string,
  filePath = 'file.ts',
  minLen = 2,
): Promise<SuggestCandidate[]> {
  const locals = await analyzeLocals(src, filePath);
  const out: SuggestCandidate[] = [];
  for (const b of locals) {
    if (!b.parentFunction) continue; // 排顶层
    if (!LOCAL_KINDS.has(b.kind)) continue;
    if (!isBadName(b.name, minLen)) continue;
    out.push({
      id: b.id,
      name: b.name,
      kind: b.kind,
      parentFunction: b.parentFunction,
      refs: b.refs.length,
      declLine: lineAt(src, b.declIndex),
      suggested: '',
      reason: '',
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// LLM 命名建议
// ─────────────────────────────────────────────────────────────

/**
 * 注入的 LLM：按候选清单【同序】返回每条建议。
 * name=新名，reason=一句话理由；可少于候选数（多出的维持空）。
 */
export type SuggestLlm = (
  cands: SuggestCandidate[],
  filePath: string,
) => Promise<Array<{ name: string; reason?: string }>>;

export interface SuggestOptions {
  /** 注入 LLM；传 null 强制关闭（降级）。缺省走 loadLlmConfig() */
  llm?: SuggestLlm | null;
  /** 交给 LLM 的候选上限（装上下文预算） */
  max?: number;
  /** 短名长度阈值（透传给 findSuggestCandidates 的 minLen，默认 2） */
  minLen?: number;
}

export interface SuggestResult {
  /** 是否真正用 LLM 生成了建议 */
  llm: boolean;
  /** 降级/失败原因（可选） */
  note?: string;
  /** 候选（suggested/reason 已填） */
  candidates: SuggestCandidate[];
}

const DEFAULT_SYSTEM =
  '你是资深 TypeScript/JS 代码审阅者。给下面的短变量/无意义变量建议更语义化的新名。' +
  '要求：新名必须是合法标识符、camelCase、含义贴合变量用处、不与同一函数内已有参数/变量重名；' +
  '只输出严格 JSON：{"renames":[{"name":"旧名","new_name":"建议新名","reason":"一句话理由"}]}，key 固定。';

/** 默认 LLM：OpenAI 兼容 chat（AGNES/DeepSeek 通用），判据驱动 */
let cachedDefault: SuggestLlm | null | undefined;
async function defaultLlmCands(cands: SuggestCandidate[], filePath: string): Promise<Array<{ name: string; reason?: string }>> {
  const cfg = loadLlmConfig();
  if (!cfg) throw new Error('未配置 LLM（.design-canvas/config.json 或环境变量）');
  const list = cands
    .map((c) => `- id=${c.id} · name=${c.name} · kind=${c.kind} · 函数=${c.parentFunction} · 引用=${c.refs} · 声明行：${c.declLine}`)
    .join('\n');
  const user =
    `target: ${filePath}\n为下列短变量建议更语义化的新名（JSON）。\n变量清单：\n${list}`;
  // 延迟 import 避免顶部加载 llm_focus
  const { callChat } = await import('./llm_focus.js');
  const raw = await callChat(cfg, [
    { role: 'system', content: DEFAULT_SYSTEM },
    { role: 'user', content: user },
  ], 0.2, 60_000);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]) as { renames?: Array<{ name?: string; new_name?: string; reason?: string }> };
  const byName = new Map<string, string>();
  const byReason = new Map<string, string>();
  for (const r of parsed.renames ?? []) {
    if (r && r.name && r.new_name && isIdent(r.new_name)) {
      byName.set(r.name, r.new_name);
      byReason.set(r.name, r.reason ?? '');
    }
  }
  // 按候选同序回填；未命名维持空
  return cands.map((c) => ({
    name: byName.get(c.name) && byName.get(c.name) !== c.name ? byName.get(c.name)! : '',
    reason: byReason.get(c.name) ?? '',
  }));
}

/**
 * 为候选变量请求 LLM 命名建议。
 * - opts.llm 注入优先；null 强制降级；undefined 走 loadLlmConfig()。
 */
export async function suggestRenames(
  src: string,
  filePath = 'file.ts',
  opts: SuggestOptions = {},
): Promise<SuggestResult> {
  const cands = await findSuggestCandidates(src, filePath, opts.minLen ?? 2);
  const picked = cands.slice(0, opts.max ?? 40);
  if (picked.length === 0) return { llm: false, candidates: cands, note: '无可建议的候选变量' };

  // 解析实际使用的 LLM：null=强制降级；undefined=默认配置；fn=注入
  let llm: SuggestLlm | null;
  if (opts.llm === null) llm = null;
  else if (opts.llm === undefined) llm = cachedDefault ?? (cachedDefault = defaultLlmCands);
  else llm = opts.llm;

  if (!llm) {
    return { llm: false, candidates: cands, note: '未配置 LLM（.design-canvas/config.json 或环境变量）' };
  }

  try {
    const replies = await llm(picked, filePath);
    const enriched = picked.map((c, i) => {
      const rep = replies[i];
      const got = rep && rep.name && isIdent(rep.name) && rep.name !== c.name ? rep.name : '';
      return { ...c, suggested: got, reason: rep?.reason ?? '' };
    });
    // 合并：被 LLM 覆盖的候选在前，未覆盖的候选（超出 picked）在后保持原样
    return { llm: true, candidates: [...enriched, ...cands.slice(picked.length)] };
  } catch (e) {
    return { llm: false, candidates: cands, note: `LLM 调用失败（${(e as Error).message}）` };
  }
}