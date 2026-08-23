/**
 * similar_names —— 相似名称检测与一键消歧（"重建屎山"第二刀）
 *
 * 背景：短变量改名（suggest_renames）解决 "a/b/tmp" 这类无意义名；本文件补上
 * 另一种死神代码——"易看错"的相似名：同一函数里 `count`/`count2`、`userData`/`userdata`、
 * `a1/a2/a3`、`total`/`totla` 这类孪生名，高亮下极难区分。检测聚类后，用 LLM 为
 * 冗余方建议一个语义化且与 `basis` 明显区分的新名，产物可直接喂给 renameMany 完成批量改写。
 *
 * 组成：
 *   - findSimilarNames：纯逻辑聚类（宁漏不误），返回 clusters。
 *   - suggestDisambiguations：在聚类之上请 LLM 给每个改名的 offender 一个新名+区分理由；
 *     无 LLM / 调用失败 → 如实降级只列聚类（suggested 留空）。
 *   - disambiguationItems：把消歧结果转成 renameMany 可消费的 items。
 *
 * 相似判定（confusable）：
 *   - 仅大小写不同（userData/userdata）
 *   - 数字后缀孪生（count/count2，基础名 ≥2 字符）
 *   - 相邻换位 typo（total/totla，长度 ≥4）
 *   或编辑距离 ≤1（长度 3-5）/ ≤2（长度 ≥6）
 * 边界：长度 <3 的短名不在此处理（归 suggest_renames）；`_` 忽略。
 */

import { analyzeLocals, type LocalBinding } from './ast_rename.js';
import { loadLlmConfig } from './llm_focus.js';

export interface SimilarNameEntry {
  id: number;
  name: string;
  kind: string;
  /** 所在命名函数名（顶层非函数内为 ''，匿名给 anon@offset） */
  parentFunction: string;
  /** 声明所在行源码 */
  declLine: string;
  /** LLM 建议的消歧新名（未建议为空串） */
  suggested?: string;
}

export interface SimilarNameCluster {
  /** 聚类自增 id */
  id: number;
  /** 作用域标签（所在函数名 / '(module)'） */
  scopeLabel: string;
  /** 聚类中最清晰、优先保留的名字（其余成员为待改名 offender） */
  basis: string;
  /** 聚类全部成员（含 basis） */
  entries: SimilarNameEntry[];
  /** 待改名成员（去掉 basis） */
  offenders: SimilarNameEntry[];
  /** 相似成因说明 */
  reason: string;
}

export interface DisambiguateOptions {
  /** 注入 LLM；null 强制关闭（降级）。缺省走 loadLlmConfig() */
  llm?: SimilarLlm | null;
  /** 最多处理多少个聚类（超出的仅检测不取名） */
  maxClusters?: number;
}

/** 注入 LLM：按聚类给每个 offender 一个消歧新名（key=offender.name，value=新名） */
export type SimilarLlm = (
  clusters: { scopeLabel: string; basis: string; offenders: SimilarNameEntry[] }[],
  filePath: string,
) => Promise<Array<{ name: string; renamed?: string; reason?: string }>>;

export interface DisambiguateResult {
  /** 是否真正用 LLM 生成了消歧名 */
  llm: boolean;
  /** 降级/失败原因（可选） */
  note?: string;
  clusters: SimilarNameCluster[];
}

// ─────────────────────────────────────────────────────────────
// 相似度判定
// ─────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function stripTrailingDigits(s: string): string {
  return s.replace(/\d+$/, '');
}

/** 是否只是"相邻两字符换位"的 typo（如 total/totla） */
function isAdjacentSwap(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 2) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (i + 1 >= a.length) return false;
  if (a[i] === b[i + 1] && a[i + 1] === b[i]) {
    return a.slice(i + 2) === b.slice(i + 2);
  }
  return false;
}

/** 两名字是否"易看错"（互不为空串、不相等、非 `_`） */
function confusable(a: string, b: string): boolean {
  if (!a || !b || a === '_' || b === '_' || a === b) return false;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  // 仅大小写不同
  if (al === bl) return true;
  // 数字后缀孪生（count / count2）：基础名 ≥2 字符才纳入，否则太容易误报
  const ab = stripTrailingDigits(al);
  const bb = stripTrailingDigits(bl);
  if (ab === bb && ab.length >= 2) return true;
  // 过短名（<3）归 suggest_renames，不在此判
  if (al.length < 3 || bl.length < 3) return false;
  // 相邻换位（典型 typo：total/totla），长度≥4 才纳入避免误报
  if (al.length >= 4 && isAdjacentSwap(al, bl)) return true;
  const dist = levenshtein(al, bl);
  const len = Math.max(al.length, bl.length);
  return len >= 6 ? dist <= 2 : dist <= 1;
}

// ─────────────────────────────────────────────────────────────
// 纯逻辑聚类
// ─────────────────────────────────────────────────────────────

/** 由偏移定位所在行文本（声明行上下文） */
function lineAt(src: string, index: number): string {
  let ls = src.lastIndexOf('\n', index - 1) + 1;
  let le = src.indexOf('\n', index);
  if (le === -1) le = src.length;
  return src.slice(ls, le).trim();
}

function describeReason(aName: string, bName: string): string {
  if (aName.toLowerCase() === bName.toLowerCase()) return `仅大小写不同（${aName} / ${bName}）`;
  if (stripTrailingDigits(aName) === stripTrailingDigits(bName)) return `数字后缀孪生（${aName} / ${bName}）`;
  if (isAdjacentSwap(aName.toLowerCase(), bName.toLowerCase())) return `相邻换位 typo（${aName} / ${bName}）`;
  return `仅 ${levenshtein(aName, bName)} 字符差异（${aName} / ${bName}）`;
}

/**
 * 相似名聚类：同一函数（parentFunction）内，把两两相似的孪生名聚成一个 cluster。
 * cluster.basis 取清晰度最高者；其余为 offenders。
 * 返回的 clusters 按作用域出现顺序稳定排序，id 从 1 自增。
 */
export async function findSimilarNames(
  src: string,
  filePath = 'file.ts',
): Promise<SimilarNameCluster[]> {
  const locals = await analyzeLocals(src, filePath);

  // 按作用域（函数/模块）分组
  const groups = new Map<string, LocalBinding[]>();
  for (const b of locals) {
    const key = b.parentFunction || '(module)';
    const arr = groups.get(key);
    if (arr) arr.push(b);
    else groups.set(key, [b]);
  }

  const clusters: SimilarNameCluster[] = [];
  let clusterId = 1;

  for (const [scopeLabel, members] of groups) {
    // 同作用域内，名字 → 绑定列表
    const byName = new Map<string, LocalBinding[]>();
    for (const m of members) {
      const arr = byName.get(m.name);
      if (arr) arr.push(m);
      else byName.set(m.name, [m]);
    }
    const names = [...byName.keys()];
    if (names.length < 2) continue;

    // 并查集：相似名连通块
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) ?? r;
      return r;
    };
    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const x of names) if (!parent.has(x)) parent.set(x, x);

    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (confusable(names[i], names[j])) union(names[i], names[j]);
      }
    }

    // 每个≥2不同名的连通块 → 一个 cluster
    const comp = new Map<string, string[]>();
    for (const n of names) {
      const r = find(n);
      const arr = comp.get(r);
      if (arr) arr.push(n);
      else comp.set(r, [n]);
    }
    for (const memberNames of comp.values()) {
      if (memberNames.length < 2) continue;
      const entries: SimilarNameEntry[] = [];
      for (const name of memberNames) {
        for (const b of byName.get(name)!) {
          entries.push({
            id: b.id,
            name: b.name,
            kind: b.kind,
            parentFunction: b.parentFunction,
            declLine: lineAt(src, b.declIndex),
          });
        }
      }
      // basis = 清晰度最高者：优先"无数字后缀的原生名"（count 优于 count2），再按名字更长、引用更多
      const refCount = (name: string): number => byName.get(name)?.length ?? 0;
      const better = (a: SimilarNameEntry, b: SimilarNameEntry): boolean => {
        const aDig = /\d$/.test(a.name);
        const bDig = /\d$/.test(b.name);
        if (aDig !== bDig) return !aDig;
        if (a.name.length !== b.name.length) return a.name.length > b.name.length;
        return refCount(a.name) > refCount(b.name);
      };
      let basis = entries[0];
      for (const e of entries) {
        if (e !== basis && better(e, basis)) basis = e;
      }
      const reference = memberNames.find((n) => n !== basis.name) || memberNames[1];
      const reason = describeReason(basis.name, reference);
      clusters.push({
        id: clusterId++,
        scopeLabel,
        basis: basis.name,
        entries,
        offenders: entries.filter((e) => e.name !== basis.name),
        reason,
      });
    }
  }

  return clusters;
}

// ─────────────────────────────────────────────────────────────
// LLM 消歧命名
// ─────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM =
  '你是资深 TypeScript/JS 代码审阅者。代码里存在"相似命名"（孪生名），高亮下极难区分，' +
  '需要为冗余方改一个语义化且与保留名明显区分的新名。' +
  '要求：新名必须合法标识符、camelCase、贴合变量用处、不与同一函数内已有名字撞名、且不能与保留名只差一个字符/数字后缀。' +
  '只输出严格 JSON：{"renames":[{"name":"旧名","renamed":"新名","reason":"一句话理由"}]}，key 固定。';

/** 默认 LLM：OpenAI 兼容 chat（AGNES/DeepSeek 通用） */
let cachedDefault: SimilarLlm | null | undefined;
async function defaultLlmFor(
  clusters: { scopeLabel: string; basis: string; offenders: SimilarNameEntry[] }[],
  filePath: string,
): Promise<Array<{ name: string; renamed?: string; reason?: string }>> {
  const cfg = loadLlmConfig();
  if (!cfg) throw new Error('未配置 LLM（.design-canvas/config.json 或环境变量）');
  const list = clusters
    .map((c) => {
      const members = c.offenders
        .map((o) => `- id=${o.id} · 旧名=${o.name} · 声明行：${o.declLine}`)
        .join('\n');
      return `【作用域 ${c.scopeLabel}】保留名=${c.basis}\n${members}`;
    })
    .join('\n\n');
  const user = `target: ${filePath}\n为下列冗余相似名建议消歧新名（JSON）。\n\n${list}`;
  const { callChat } = await import('./llm_focus.js');
  const raw = await callChat(cfg, [
    { role: 'system', content: DEFAULT_SYSTEM },
    { role: 'user', content: user },
  ], 0.2, 60_000);
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]) as { renames?: Array<{ name?: string; renamed?: string; reason?: string }> };
  const byName = new Map<string, { renamed: string; reason: string }>();
  for (const r of parsed.renames ?? []) {
    if (r && r.name && r.renamed && /^[A-Za-z_$][\w$]*$/.test(r.renamed) && r.renamed !== r.name) {
      byName.set(r.name, { renamed: r.renamed, reason: r.reason ?? '' });
    }
  }
  // 按聚类同序回填；未命名的维持空
  const out: Array<{ name: string; renamed?: string; reason?: string }> = [];
  for (const c of clusters) {
    for (const o of c.offenders) {
      const hit = byName.get(o.name);
      out.push({ name: o.name, renamed: hit?.renamed, reason: hit?.reason });
    }
  }
  return out;
}

/**
 * 相似名检测 + LLM 消歧建议。
 * - opts.llm 注入优先；null 强制降级（仅检测）；undefined 走 loadLlmConfig()。
 * - LLM 成功后，clusters[].offenders[].suggested 已填；降级/失败时留空。
 */
export async function suggestDisambiguations(
  src: string,
  filePath = 'file.ts',
  opts: DisambiguateOptions = {},
): Promise<DisambiguateResult> {
  const clusters = await findSimilarNames(src, filePath);
  const picked = clusters.slice(0, opts.maxClusters ?? 20);

  let llm: SimilarLlm | null;
  if (opts.llm === null) llm = null;
  else if (opts.llm === undefined) llm = cachedDefault ?? (cachedDefault = defaultLlmFor);
  else llm = opts.llm;

  if (!llm || picked.length === 0) {
    return {
      llm: false,
      clusters,
      note: picked.length === 0 ? '未发现相似名聚类' : '未配置 LLM（.design-canvas/config.json 或环境变量）',
    };
  }

  try {
    const replies = await llm(picked, filePath);
    const renameById = new Map<number, { renamed: string; reason: string }>();
    let k = 0;
    for (const c of picked) {
      for (const o of c.offenders) {
        const rep = replies[k++];
        if (rep && rep.renamed) renameById.set(o.id, { renamed: rep.renamed, reason: rep.reason ?? '' });
      }
    }
    const enriched = clusters.map((c) => ({
      ...c,
      offenders: c.offenders.map((o) => {
        const hit = renameById.get(o.id);
        return hit ? { ...o, suggested: hit.renamed, reason: hit.reason } : o;
      }),
    }));
    return { llm: true, clusters: enriched };
  } catch (e) {
    return { llm: false, clusters, note: `LLM 调用失败（${(e as Error).message}）` };
  }
}

/**
 * 便捷：把消歧结果转成 renameMany 可直接消费的 items 数组。
 * 只收集分身（offenders）里 LLM 给出了合法新名的项。
 */
export function disambiguationItems(result: DisambiguateResult): { id: number; to: string }[] {
  const items: { id: number; to: string }[] = [];
  for (const c of result.clusters) {
    for (const o of c.offenders) {
      if (o.suggested && /^[A-Za-z_$][\w$]*$/.test(o.suggested)) {
        items.push({ id: o.id, to: o.suggested });
      }
    }
  }
  return items;
}