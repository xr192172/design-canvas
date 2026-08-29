/**
 * derive_mind_map —— L3 思维导图层生成
 *
 * 把 L2 设计图层（feature_tree 功能树 + semantic 语义文件）提炼成
 * 普通人能看懂的逐级思维导图（root → 功能 → 社区 → 文件）。
 *
 * 数据来源：
 *   - dsl.feature_tree：项目 → 功能 → 社区（analyze_monolith 聚类）→ 文件
 *   - dsl.semantic.files：文件职责描述（responsibility）+ 行数 + 状态
 *   - dsl.layers：架构分层（作为功能描述补充）
 *
 * 提炼策略：
 *   - 骨架：无 LLM 也能生成（规则骨架，恒可用），供可观测产物兜底。
 *   - LLM 提炼（gen_descriptions=true）：用内置 LLM 为每个功能/社区生成
 *     "人话"描述（这是什么、解决什么问题），让思维导图对普通人也友好。
 *
 * 锚点：文件节点 id 与 L2 共享（file_xxx），保证思维导图 → 设计图 → 代码可追溯。
 *
 * 产出（单一路径：最终交互页统一为 /mindmap/<feature>，本层只产中间数据）：
 *   - structure 骨架 JSON：<storageRoot>/mindmap/<feature>.json（中间步骤，不作为交付物）
 *   - teach 科普导图 JSON：<storageRoot>/mindmap/<feature>.teach.json（/mindmap/ 交互页的数据源）
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, getStorageRoot, getPackageRoot } from '../storage.js';
import { extractJsonObject } from './explain_gen.js';
import { loadAgentConfig, callChat } from './llm_focus.js';
import type { ChatMessage } from './llm_focus.js';
import { openDb } from '../db/db.js';
import type { Database } from '../db/db.js';
import type { DesignDSL, FeatureNode, FeatureTree, SemanticFile } from '../dsl/types.js';
import type { MindMap, MindMapNode, TeachStep, TeachPin, TeachFlowEdge, TeachGap, ProposalFeature } from '../dsl/mindmap.js';
import { buildScenes } from '../dsl/narration.js';

export interface DeriveMindMapInput {
  /** feature 名（必填） */
  feature: string;
  /** 是否用 LLM 提炼描述（默认 false；未配置 LLM 时静默降级为规则骨架） */
  gen_descriptions?: boolean;
  /** 单个社区最多展开的文件节点数（默认 20，防止导图过大） */
  max_files_per_community?: number;
  /** 产物输出路径（可选，默认 output/mind_map_<feature>.html） */
  output_path?: string;
  /** 视图形态（默认 structure）：
   *  structure = 结构树（功能→社区→文件，开发者下钻用）
   *  teach     = 科普教学（功能 + 实现原理分镜 steps，像科普视频讲解，小白用） */
  view?: 'structure' | 'teach';
  /** 局部触发式更新：上次导图已生成人话描述的未变更文件，直接复用旧描述、不进 LLM 重算；
   *  结构仍从活 DSL 重建（结构层始终是代码事实）。dirty_paths = 本次实际变更/新增的相对路径。 */
  incremental?: { dirty_paths?: string[] };
}

export interface DeriveMindMapResult {
  feature: string;
  mode: 'llm' | 'rule';
  /** 思维导图 JSON */
  mind_map: MindMap;
  /** JSON 落盘路径 */
  jsonFile: string;
  message: string;
}

/** 思维导图 JSON 落盘路径：<storageRoot>/mindmap/<feature>.json（teach 版加 .teach 后缀） */
export function getMindMapFile(feature: string, view: 'structure' | 'teach' = 'structure'): string {
  const suffix = view === 'teach' ? '.teach' : '';
  return path.join(getStorageRoot(), 'mindmap', `${feature}${suffix}.json`);
}

/** 取文件名（去掉路径），用于文件节点标题 */
function basename(p: string): string {
  const seg = p.split(/[\\/]/);
  return seg[seg.length - 1] || p;
}

/**
 * 噪音社区名（C）：聚类锚点常把"数据结构/通用辅助器"类名当社区名
 * （MinHeap、Trie、LruCache、RingBuffer…），LLM 直译成"最小堆"仍是噪音。
 * 命中的社区不送 LLM 翻译、不占"协作模块"注意力，统一标为「内部组件」——
 * 它确实是功能内部的一颗螺丝钉，只是不配当 L3 的叙事主角。
 */
const NOISE_COMMUNITY_RE =
  /^(min|max|small|big)?(heap|hash|map|set|list|stack|queue|tree|trie|lru|fifo|ring|buffer|pool|sync|mutex|lock|timer|clock|util|helper|common|base|const|types?|dto|vo|enums?|errs?|warn|log|metrics?|stats?|configs?|opts?|params?)$/i;
function isNoiseCommunity(name: string): boolean {
  return NOISE_COMMUNITY_RE.test(name.trim());
}
/** 噪音社区的统一中文兜底名（比裸英文"MinHeap"可读，也比直译"最小堆"诚实） */
const NOISE_ZH = '内部组件';

export interface FileInfo {
  id: string;
  path: string;
  responsibility: string;
  lines?: number;
  status?: string;
  layer?: string;
  /** 关键函数签名（actual_apis 优先，teach 模式喂给 LLM 的实现材料） */
  apis?: string[];
}

/** 文件索引：exact（path 精确）+ bySuffix（≥2 段后缀匹配），契约投影的输入 */
export type FileIndex = { exact: Map<string, FileInfo>; bySuffix: Map<string, FileInfo> };

/** 从语义层构建 文件路径 → FileInfo 索引，并保留 id（= geometry node id）。
 *  另建后缀索引（≥2 段）：功能树社区的 files 相对 cache.db 项目根，
 *  DSL 路径相对导入快照根，前缀可能不一致（如 camera/internal/… vs internal/…）。 */
export function buildFileIndex(dsl: DesignDSL): FileIndex {
  const exact = new Map<string, FileInfo>();
  const bySuffix = new Map<string, FileInfo>();
  for (const f of dsl.semantic?.files ?? []) {
    if (!f.path) continue;
    const info: FileInfo = {
      id: f.id,
      path: f.path,
      responsibility: f.responsibility || '',
      lines: f.lines,
      status: f.status,
      layer: f.layer,
      apis: (f.actual_apis ?? f.expected_apis ?? []).slice(0, 24).map((a) => a.signature),
    };
    exact.set(f.path, info);
    const segs = f.path.split('/');
    for (let k = 0; k < segs.length - 1; k++) {
      const key = segs.slice(k).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, info); // 长后缀优先
    }
  }
  return { exact, bySuffix };
}

/** 精确 → 后缀（至少保留 2 段）查文件信息 */
function lookupFile(idx: { exact: Map<string, FileInfo>; bySuffix: Map<string, FileInfo> }, rel: string): FileInfo | undefined {
  const hit = idx.exact.get(rel);
  if (hit) return hit;
  const segs = rel.split('/');
  for (let k = 0; k < segs.length - 1; k++) {
    const s = idx.bySuffix.get(segs.slice(k).join('/'));
    if (s) return s;
  }
  return undefined;
}

// ── 契约投影 · 数据形态（纯规则，零 LLM）─────────────────────────
// 从函数的 actual_apis 签名投影"这一步吃什么数据 / 吐什么数据"：
//   结构层（数量/方向）是代码事实，任何上下文都不允许改。
//   命名层（人话名）优先用参数名/类型名，规则词典压成可读名词。
//   控制类（ctx / error）不是业务数据形态，不投影成针脚。
//   集合类（[]T / []*T / map[..]T）提质为"一条数据形态"，而非 N 条。

// 类型 → 人话名词的规则词典（命名层锚：查不到才用参数名兜底）
const TYPE_HUMAN: Array<[RegExp, string]> = [
  [/raw\s*event/i, '原始事件'],
  [/event/i, '事件'],
  [/probe\s*(point)?/i, '探针点位'],
  [/config/i, '配置'],
  [/file/i, '文件'],
  [/result/i, '结果'],
  [/log|entry/i, '日志'],
  [/query|search/i, '查询'],
  [/request|req\b/i, '请求'],
  [/response|resp\b/i, '响应'],
  [/id\b/i, '标识'],
  [/time|stamp/i, '时间'],
  [/str(ing)?$|text/i, '文本'],
  [/path\b/i, '路径'],
  [/json/i, 'JSON'],
  [/map\s*\[/i, '映射'],
];

// 参数名去修饰提纯：去掉前缀接口/类型名，给一个可读名
function pinNameFromParam(name: string): string {
  let s = name.trim();
  // `a, b int` 这类共享类型：只看其中一个即可，前端按数量展开
  s = s.split(/[\s,]+/).pop() ?? s; // 取最后一个标识符
  s = s.replace(/[^A-Za-z0-9_]/g, '');
  return s;
}

// 把类型 token 压成人话名词（集合→单条语义、指针→元素、dict 保留；查不到返回空=用参数名）
function humanizeType(t: string): string {
  let ty = t.trim();
  ty = ty.replace(/^\[\]\*?/, '').replace(/^\*/, ''); // []T / []*T / *T → T
  const mapMatch = ty.match(/^map\s*\[\s*[^\]]+\]\s*(.+)$/); // map[K]V → V
  if (mapMatch) ty = mapMatch[1].trim();
  ty = ty.replace(/[<].*?[>]/g, ''); // 泛型参数剥离：List[Event] → List
  ty = ty.split('.').pop() ?? ty; // 取包内简名：RawEvent 而非 pkg.RawEvent
  for (const [re, human] of TYPE_HUMAN) {
    if (re.test(ty)) return human;
  }
  // 单词/驼峰 → 中文分词兜底（如 RawEvent → 事件）：退化为用人话接口，认不出则空
  const words = ty.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const [, human] of TYPE_HUMAN) {
    if (words.indexOf(human) >= 0) return human;
  }
  return '';
}

/** 单条签名 → {参数入针脚, 返回值出针脚}；解析失败返回 null（调用方回落到顺序推导） */
export function projectSignature(sig: string): { ins: TeachPin[]; outs: TeachPin[] } | null {
  // 从签名里定位参数表与返回区：Go `f(a int) (b string, err error)`
  // / TS `f(a: string): Event[]` / Python `def f(a, b: int) -> str`
  const open = sig.indexOf('(');
  if (open < 0) return null;
  const depthScan = (() => {
    let d = 0, end = -1;
    for (let i = open; i < sig.length; i++) {
      const c = sig[i];
      if (c === '(') d++;
      else if (c === ')') { d--; if (d === 0) { end = i; break; } }
    }
    return end;
  })();
  const close = depthScan;
  if (close < 0) return null;
  const paramsRaw = sig.slice(open + 1, close);
  const after = sig.slice(close + 1).trim();
  // 返回区：Go `(a,b) error` / `T`（无括号单返回） / TS `: T` / Python `-> T`
  let retStr = '';
  const arrowAfter = after.match(/^->\s*(.*)$/);
  if (arrowAfter) retStr = arrowAfter[1];
  else if (after.startsWith(':')) retStr = after.replace(/^:\s*/, '');
  else if (after.startsWith('(')) { const o = after.indexOf('('), c2 = after.indexOf(')'); retStr = o >= 0 && c2 > o ? after.slice(o + 1, c2) : ''; }
  else {
    // Go 单返回无括号：`f(...) T` → after 直接就是类型；剔除函数体残留 `{...}` / `;`
    const cut = after.replace(/;.*$/, '').replace(/\{.*$/, '').trim();
    if (cut && !cut.startsWith('{')) retStr = cut; // 否则视为无返回值
  }

  const splitTop = (src: string): string[] => {
    const out: string[] = []; let d = 0, cur = '';
    for (const ch of src) {
      if (ch === '(' || ch === '[' || ch === '<' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '>' || ch === '}') d--;
      if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
  };

  // ── 输入针脚：参数表分格，格内取"类型"（跳过控制/上下文）──
  const ins: TeachPin[] = [];
  for (const seg of splitTop(paramsRaw)) {
    // Go: `a, b int`（多参共享类型）→ 类型=最后一个词，名=前面所有；TS: `a: int`；Python: `a: int = 1`
    if (/\bfunc\s*\(/i.test(seg)) continue; // 函数类型参数（回调/谓词/闭包）：内部数据流，不是可投影的数据形态
    const colon = seg.lastIndexOf(':');
    let typeToken = ''; let namesPart = '';
    if (colon >= 0) { typeToken = seg.slice(colon + 1).replace(/=.*$/, '').trim(); namesPart = seg.slice(0, colon).trim(); }
    else { const m = seg.match(/^(.*?)\s+(\S+)$/); if (m) { namesPart = m[1].trim(); typeToken = m[2].trim(); } else { namesPart = seg; } }
    if (!typeToken) continue; // 无类型标注（罕见），跳过
    if (/\bcontext\.Context\b|\bctx\b/i.test(typeToken)) continue;   // 控制上下文，非业务数据
    if (/\berror\b/i.test(typeToken)) continue;                       // 错误不是数据形态
    const cleanType = typeToken.replace(/^\[\]\*?/, '').replace(/^\*/, '').replace(/\*$/, '').split('.').pop() || typeToken;
    // 多参数共享一个类型 `a, b int` → namesPart 有多个名字 → 展开为多条针脚
    const names = namesPart ? namesPart.split(',').map((x) => pinNameFromParam(x)).filter(Boolean) : [];
    if (names.length === 0) { ins.push({ n: humanizeType(cleanType) || cleanType, t: cleanType }); continue; }
    for (const nm of names) ins.push({ n: toHumanName(nm, cleanType), t: cleanType });
  }

  // ── 输出针脚：返回区格内取"类型"，控制类同剔除 ──
  const outs: TeachPin[] = [];
  for (const seg of splitTop(retStr)) {
    const ty = seg.trim().replace(/^[*.]/, '');
    if (!ty || /\berror\b/i.test(ty)) continue;
    if (/\bcontext\.Context\b|\bctx\b/i.test(ty)) continue;
    const ct = ty.replace(/^\[\]\*?/, '').replace(/^\*/, '').replace(/\*$/, '').split('.').pop() || ty;
    outs.push({ n: humanizeType(ct) || ct, t: ct });
  }

  if (ins.length === 0 && outs.length === 0) return null;
  return { ins, outs };
}

/** 参数名优先：入针脚用人话名承载作者意图（root/args/sender 这种业务标签），
 *  短到无信息量的单字母参数（s/r）退化为类型人或类型本身。出针脚（无参数名）走类型人。 */
function toHumanName(param: string, typeToken: string): string {
  if (param && param.length >= 2) return param; // 参数名优先：作者笔下的业务含义，最忠实
  const h = humanizeType(typeToken);
  return h || param || typeToken;
}

/**
 * 签名"代表力"打分：挑「最能代表该步数据流」的主签名，而不是首文件首 API。
 * 主函数强信号 = 返回复杂类型（非泛型/非 boolean/this/error）；纯辅助函数（返回基础类型
 * 且无业务入参）降权——否则投影出来全是 boolean/this 占位，跨步连线永远 0 条。
 */
function signatureScore(sig: string): number {
  const shape = projectSignature(sig);
  if (!shape) return -Infinity;
  const isGenericT = (t: string): boolean => {
    const c = cleanPinStr(t).replace(/\|.*$/, '').replace(/[\[\]*<>].*$/, '').split('.').pop()?.trim() ?? '';
    // 含 [ ] < > 的原始类型=泛型容器/粘连类型（如 Mapstring[...] / Promise<T>），代表力弱
    return !c || c.length < 2 || GENERIC_T.has(c) || c.startsWith('{') || /[\[\]<>]/.test(t);
  };
  let score = 0;
  for (const o of shape.outs) score += isGenericT(o.t) ? 1 : 4; // 有意义的返回类型=主函数强信号
  for (const i of shape.ins) score += isGenericT(i.t) ? 0 : 2;  // 业务入参加分
  if (shape.outs.length === 0) score -= 2;                      // 无返回弱
  return score;
}

/**
 * 契约投影主入口：拿步骤的 involves 文件 → actual_apis 签名 → 汇总针脚。
 * 不只挑一个主签名——收集涉及的所有文件 × 全部 API 的可投影签名，按「有意义身份优先、
 * 代表力降序」收敛去重到每侧 Top-N（cap）。有意义针脚（能跨步连线）必在前，
 * 泛型针脚（boolean/string/this…）仅作展示补充、不参与连线，避免噪声淹没卡片。
 */
export function projectStepDataShape(
  involves: string[] | undefined,
  fileIndex: FileIndex,
  cap = 6,
): { inputs: TeachPin[]; outputs: TeachPin[] } | null {
  if (!involves || involves.length === 0) return null;
  const inCand: Array<{ p: TeachPin; score: number; meaningful: boolean }> = [];
  const outCand: Array<{ p: TeachPin; score: number; meaningful: boolean }> = [];
  for (const rel of involves) {
    const info = lookupFile(fileIndex, rel);
    if (!info || !info.apis || info.apis.length === 0) continue;
    for (const sig of info.apis) {
      const shape = projectSignature(sig);
      if (!shape) continue;
      const score = signatureScore(sig);
      for (const p of shape.ins) inCand.push({ p, score, meaningful: pinIdentity(p) !== null });
      for (const p of shape.outs) outCand.push({ p, score, meaningful: pinIdentity(p) !== null });
    }
  }
  const pick = (cand: Array<{ p: TeachPin; score: number; meaningful: boolean }>): TeachPin[] => {
    cand.sort((a, b) => Number(b.meaningful) - Number(a.meaningful) || b.score - a.score);
    const seen = new Set<string>();
    const out: TeachPin[] = [];
    for (const { p } of cand) {
      const id = pinIdentity(p);
      const key = id ? id.key : `${p.n}|${p.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= cap) break;
    }
    return out;
  };
  const inputs = pick(inCand);
  const outputs = pick(outCand);
  if (inputs.length === 0 && outputs.length === 0) return null;
  return { inputs, outputs };
}

/**
 * 逐文件契约投影：单独投影【一个文件】的 API 签名针脚（L4 文件视图高亮用）。
 * 与步骤级投影同款逻辑（有意义身份优先、代表力降序、去重收敛），只是材料收敛到单个文件，
 * cap 更小——单文件 API 少，只留最能代表「这文件吃什么/吐什么」的 Top-N 针脚。
 */
export function projectFileDataShape(
  file: string,
  fileIndex: FileIndex,
  cap = 3,
): { inputs: TeachPin[]; outputs: TeachPin[] } | null {
  const info = lookupFile(fileIndex, file);
  if (!info || !info.apis || info.apis.length === 0) return null;
  const inCand: Array<{ p: TeachPin; score: number; meaningful: boolean }> = [];
  const outCand: Array<{ p: TeachPin; score: number; meaningful: boolean }> = [];
  for (const sig of info.apis) {
    const shape = projectSignature(sig);
    if (!shape) continue;
    const score = signatureScore(sig);
    for (const p of shape.ins) inCand.push({ p, score, meaningful: pinIdentity(p) !== null });
    for (const p of shape.outs) outCand.push({ p, score, meaningful: pinIdentity(p) !== null });
  }
  const pick = (cand: Array<{ p: TeachPin; score: number; meaningful: boolean }>): TeachPin[] => {
    cand.sort((a, b) => Number(b.meaningful) - Number(a.meaningful) || b.score - a.score);
    const seen = new Set<string>();
    const out: TeachPin[] = [];
    for (const { p } of cand) {
      const id = pinIdentity(p);
      const key = id ? id.key : `${p.n}|${p.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
      if (out.length >= cap) break;
    }
    return out;
  };
  const inputs = pick(inCand);
  const outputs = pick(outCand);
  if (inputs.length === 0 && outputs.length === 0) return null;
  return { inputs, outputs };
}

/* ============================================================
   产线数据流推导（二期：真实出边/入边 + 管线缺口）
   各步入/出针脚来自契约投影（涉及文件 API 签名，非 LLM 编造）。跨步骤连线同样不编造——
   按「数据形态名」保守匹配：输出针脚与【后续步骤】的输入针脚，清洗后的类型或中文人话名
   一致才连一条真边；泛型噪声（string/number/boolean/this/...）不参与匹配，避免全连。
   缺口 = 某步的入/出无法在本功能内闭环 → 管线可能漏了一步 / 该步投影失败，如实标记。
   ============================================================ */
/** 泛型噪声类型：不承载业务语义，不能作为跨步连线身份 */
const GENERIC_T = new Set([
  'string', 'number', 'boolean', 'bool', 'int', 'int32', 'int64', 'uint', 'uint32', 'uint64',
  'float', 'float32', 'float64', 'this', 'void', 'any', 'unknown', 'null', 'undefined', 'nil',
  'object', 'Object', 'true', 'false', 'never', 'bigint', 'symbol', 'byte', 'rune', 'error',
  'func', 'function', 'promise', 'Promise', 'array', 'Array', 'map', 'Map', 'record', 'Record',
  // JS/Node/浏览器内置：到处出现、不承载本项目数据语义，同样不能当连线身份
  'Date', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'String', 'Number', 'Boolean', 'Function',
  'BigInt', 'Symbol', 'Buffer', 'URL', 'URLSearchParams', 'JSON', 'Math', 'console', 'process',
  'PromiseLike', 'Iterator', 'Iterable', 'Generator', 'AsyncIterable', 'ArrayLike', 'Timer',
  'Timeout', 'Interval', 'AbortSignal', 'AbortController', 'Event', 'EventTarget', 'Node',
]);

/** 泛型中文人话名：与 GENERIC_T 同义的中文写法（文本=string / 数字=number …），同样不参与连线 */
const GENERIC_T_ZH = new Set([
  '文本', '字符串', '数字', '数值', '布尔', '数组', '对象', '字典', '映射', '列表', '集合',
  '空', '无', '任意', '未知', '函数', '键值对', '标识',
]);

/** 清洗针脚字段：去前导 `:` `*` 空白、尾部空白/右括号 */
function cleanPinStr(s: string): string {
  return (s || '').replace(/^[:*\s]+/, '').replace(/[\s\]\)]+$/, '').trim();
}

/**
 * 针脚 → 语义身份（供跨步连线匹配）：
 * 优先「清洗后非泛型的类型」（契约身份，两端都是同一代码类型才算同一数据）；
 * 泛型类型（string→文本 / void→标识…）不再回退中文名——否则文本/标识这种最普遍的
 * 针脚会全连，淹没真实缺口。中文人话名兜底仅限「无类型信息」且非泛型中文词时。
 * 两者皆无 → null（不参与连线）。
 */
function pinIdentity(p: TeachPin): { key: string; name: string } | null {
  const t = cleanPinStr(p.t)
    .replace(/\|.*$/, '')            // 联合类型取首成员：string | undefined → string
    .replace(/[\[\]*<>].*$/, '')     // 泛型/下标/指针取基底：ParsedSymbol['kind'] → ParsedSymbol
    .split('.').pop()                // 取包内简名
    ?.trim() ?? '';
  const n = cleanPinStr(p.n);
  // 字面量值（'static-rule' / "x" / 42）不是数据形态，不能当数据身份
  if (t && (t.startsWith("'") || t.startsWith('"') || /^\d+$/.test(t))) return null;
  // 内联对象类型碎片（含 { }）与函数调用签名（含 ( )）不是数据形态：
  // 契约投影常把多行对象字面量切成「string }」「Array<...>;\r\n }」、把调用捕获成「now(」
  if (t && /[{}()\r\n]/.test(t)) return null;
  if (t && t.length >= 2 && !GENERIC_T.has(t) && !t.startsWith('{')) return { key: t, name: n || t };
  if (!t && n && /[\u4e00-\u9fa5]/.test(n) && !GENERIC_T_ZH.has(n)) return { key: n, name: n };
  return null;
}

/** 针脚列表 → 去重后的语义身份 key 集合（与 pinIdentity 同款清洗，供跨功能 global 集用） */
export function pinIdentityKeys(pins: TeachPin[] | undefined): Set<string> {
  const s = new Set<string>();
  for (const p of pins ?? []) {
    const id = pinIdentity(p);
    if (id) s.add(id.key);
  }
  return s;
}

export interface StepFlowOut {
  edges: TeachFlowEdge[];
  gaps: TeachGap[];
}

/**
 * 按数据形态名推导跨步骤真实出边/入边 + 管线缺口（steps 与 stepIds 同序对应）。
 * global：跨功能视角的产出/消费集合（可缺省）。有它时，「无源/悬空」缺口只在
 * 全项目都没有产出者/消费方时才报——避免把「来自其它功能的外部输入」误判成漏步。
 */
export function deriveStepFlow(
  steps: TeachStep[],
  stepIds: string[],
  global?: { produced?: Set<string>; consumed?: Set<string> },
): StepFlowOut {
  const edges: TeachFlowEdge[] = [];
  const gaps: TeachGap[] = [];
  const N = steps.length;
  if (N === 0) return { edges, gaps };

  // 各步针脚身份（identity 为 null 的泛型针脚不参与连线/缺口闭环判定）
  const pinIn = steps.map((s) => (s.inputs ?? []).map((p) => pinIdentity(p)));
  const pinOut = steps.map((s) => (s.outputs ?? []).map((p) => pinIdentity(p)));

  // —— 0) 唯一产出者：同一数据名被 ≥2 个步骤产出 → 太泛（基础设施类型 / 事件总线），
  //    不配做跨步连线身份，否则 SyntaxNodeLike/ParsedSymbol 这类"每步都出现"的共享类型
  //    会把相邻步骤全连成噪声。仅"全功能内唯一产出"的数据名参与连线（缺口判定同款过滤）。
  const prodByKey = new Map<string, number>();
  for (let i = 0; i < N; i++) for (const o of pinOut[i]) if (o) prodByKey.set(o.key, (prodByKey.get(o.key) ?? 0) + 1);
  const isUniqueProducer = (key: string): boolean => (prodByKey.get(key) ?? 0) === 1;

  // —— 1) 跨步连线：仅前 → 后，输出身份 == 输入身份，且产出者唯一 ——
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      for (const o of pinOut[i]) {
        if (!o || !isUniqueProducer(o.key)) continue;
        for (const k of pinIn[j]) {
          if (k && k.key === o.key && !edges.some((e) => e.from === stepIds[i] && e.to === stepIds[j] && e.data === o.key)) {
            edges.push({ from: stepIds[i], to: stepIds[j], data: o.key });
          }
        }
      }
    }
  }

  // —— 1.5) 共享文件连续边：相邻两步共享源码文件 → 结构上必有承接关系（弱数据流信号）。
  //    类型匹配太严格导致大部分连续步（约 30/72）无数据边、节点孤立，补上共享文件边让管线可见。
  //    已在同一对上画了数据边的，不再重复画共享边。
  const fileBasename = (p: string): string => {
    const seg = p.split(/[\\/]/);
    return seg[seg.length - 1] || p;
  };
  for (let i = 0; i + 1 < N; i++) {
    if (edges.some((e) => e.from === stepIds[i] && e.to === stepIds[i + 1])) continue;
    const cur = new Set(steps[i].involves ?? []);
    let shared = '';
    for (const p of steps[i + 1].involves ?? []) {
      if (cur.has(p)) { shared = fileBasename(p); break; }
    }
    if (shared) edges.push({ from: stepIds[i], to: stepIds[i + 1], data: `共件·${shared}` });
  }

  // —— 2) 缺口（只报真异常，把噪声压到最低）——
  //    此前「入边在本功能/全项目都没有产出者就报无源」会把大量合法的外部输入（跨功能类型、
  //    标准库、共享模型）误判成漏步（实测 413 → 全是噪声）。新口径：
  //      · in_missing / out_missing：不再报（投影缺料由前端面板「未投影出/入边」info 提示兜底）；
  //      · 顺序倒挂（in_no_source / out_no_consumer）：数据在管线里真实存在，但先消费后产出。
  //        仅当消费步与产出步共享至少一个涉及源码文件时才报——两步不共享文件，多半是
  //        Database/Impact/WorkbenchData 这类跨文件独立使用的「共享基础类型」，并非管线数据流，
  //        把它们当「漏步/错序」报会再次制造误报（实测 Database/WorkbenchData/Impact 4 例全中）。
  // 唯一产出步序号（该数据名被哪个步骤产出；无则 -1）
  const producerSeqOf = (key: string): number => {
    for (let j = 0; j < N; j++) for (const o of pinOut[j]) if (o && o.key === key) return j;
    return -1;
  };
  // 该数据名「任一消费步」序号（无则 -1）
  const consumerSeqOf = (key: string): number => {
    for (let j = 0; j < N; j++) for (const k of pinIn[j]) if (k && k.key === key) return j;
    return -1;
  };
  // 两步是否共享至少一个涉及源码文件（不共享 → 共享基础类型，非管线数据流 → 不报缺口）
  const sharesFile = (a: number, b: number): boolean => {
    if (a < 0 || b < 0 || a === b) return false;
    const ia = new Set(steps[a]?.involves ?? []);
    return (steps[b]?.involves ?? []).some((p) => ia.has(p));
  };

  for (let i = 0; i < N; i++) {
    const id = stepIds[i];
    const ins = pinIn[i], outs = pinOut[i];
    // 入边无源：唯一产出者排在本步之后，且两步共享文件 → 顺序倒挂（疑漏/错序）
    if (i !== 0) {
      for (const k of ins) {
        if (!k || !isUniqueProducer(k.key)) continue;
        const p = producerSeqOf(k.key);
        if (p <= i) continue;          // 产出者不晚于本步 → 非倒挂
        if (!sharesFile(i, p)) continue; // 不共享文件 → 共享基础类型 → 非管线数据流
        gaps.push({ step: id, seq: i, kind: 'in_no_source', data: k.key, msg: `入边「${k.key}」的产出步骤排在本步之后——先消费后产出，疑似中间漏了一步或步骤顺序错乱。` });
      }
    }
    // 出边悬空：唯一消费方排在本步之前，且两步共享文件 → 同样先消费后产出的顺序倒挂
    if (i !== N - 1) {
      for (const o of outs) {
        if (!o || !isUniqueProducer(o.key)) continue;
        const c = consumerSeqOf(o.key);
        if (c < 0 || c >= i) continue; // 消费方不早于本步 → 非倒挂
        if (!sharesFile(i, c)) continue;
        gaps.push({ step: id, seq: i, kind: 'out_no_consumer', data: o.key, msg: `出边「${o.key}」的消费步骤排在本步之前——先消费后产出，疑似中间漏了一步或步骤顺序错乱。` });
      }
    }
  }
  return { edges, gaps };
}

/* ============================================================
   跨功能数据流（L2 功能介绍视图高亮用）：数据名跨功能「产出 → 消费」。
   保守规则同 deriveStepFlow 升级版：一个数据名只被【一个功能】产出（唯一产出者）
   才连线——被多个功能产出说明是公共基础设施（事件总线 / 共享模型），连了反而全亮成噪声。
   ============================================================ */
export interface CrossFeatureFlowEdge {
  /** 产出功能 id（源） */
  from: string;
  /** 消费功能 id（目标） */
  to: string;
  /** 流转的数据形态名 */
  data: string;
}

/** 跨功能数据流推导：features 为 { id, steps } 列表，返回唯一产出者的跨功能连线 */
export function deriveCrossFeatureFlow(
  features: Array<{ id: string; steps: TeachStep[] }>,
): CrossFeatureFlowEdge[] {
  const edges: CrossFeatureFlowEdge[] = [];
  const outsByFeature = new Map<string, Set<string>>();
  const insByFeature = new Map<string, Set<string>>();
  const prodCount = new Map<string, number>();
  for (const f of features) {
    const outs = new Set<string>(), ins = new Set<string>();
    for (const s of f.steps) {
      for (const p of s.outputs ?? []) {
        const id = pinIdentity(p);
        if (id && !outs.has(id.key)) {
          outs.add(id.key);
          prodCount.set(id.key, (prodCount.get(id.key) ?? 0) + 1);
        }
      }
      for (const p of s.inputs ?? []) {
        const id = pinIdentity(p);
        if (id) ins.add(id.key);
      }
    }
    outsByFeature.set(f.id, outs);
    insByFeature.set(f.id, ins);
  }
  for (const a of features) {
    for (const key of outsByFeature.get(a.id) ?? []) {
      if ((prodCount.get(key) ?? 0) !== 1) continue; // 非唯一产出者不连（公共基础设施）
      for (const b of features) {
        if (b.id === a.id) continue;
        if (insByFeature.get(b.id)?.has(key)) edges.push({ from: a.id, to: b.id, data: key });
      }
    }
  }
  return edges;
}

/* ============================================================
   文件级数据流（L4 文件视图高亮用）：某功能内「文件产出 → 文件消费」。
   材料 = 逐文件契约投影的针脚（projectFileDataShape，非 LLM 编造）；
   连线规则与 deriveStepFlow 同款保守：数据身份一致、且唯一产出者才连，
   方向不限（文件间无工序顺序，只要 A 产 B 吃即可）。id 用文件路径（l2_ref）。
   ============================================================ */
export interface FileFlowNode {
  /** 文件路径（与 teach 文件节点 meta.l2_ref 一致） */
  id: string;
  inputs?: TeachPin[];
  outputs?: TeachPin[];
}

/** 文件级数据流推导：files 为功能内全部文件（跨步骤去重收集），返回唯一产出者的文件连线 */
export function deriveFileFlow(files: FileFlowNode[]): TeachFlowEdge[] {
  const edges: TeachFlowEdge[] = [];
  const N = files.length;
  if (N < 2) return edges;
  const pinIn = files.map((f) => (f.inputs ?? []).map((p) => pinIdentity(p)));
  const pinOut = files.map((f) => (f.outputs ?? []).map((p) => pinIdentity(p)));
  // 唯一产出者：同一数据名被 ≥2 个文件产出 → 共享类型/基础设施，不连线（防噪声全连）
  const prodByKey = new Map<string, number>();
  for (const outs of pinOut) for (const o of outs) if (o) prodByKey.set(o.key, (prodByKey.get(o.key) ?? 0) + 1);
  const isUnique = (key: string): boolean => (prodByKey.get(key) ?? 0) === 1;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      if (i === j) continue;
      for (const o of pinOut[i]) {
        if (!o || !isUnique(o.key)) continue;
        for (const k of pinIn[j]) {
          if (k && k.key === o.key && !edges.some((e) => e.from === files[i].id && e.to === files[j].id && e.data === o.key)) {
            edges.push({ from: files[i].id, to: files[j].id, data: o.key });
          }
        }
      }
    }
  }
  return edges;
}

/** 规则描述：功能节点 */
function ruleFeatureDesc(f: { name: string; communities: unknown[] }, fileCount: number): string {
  return `由 ${f.communities.length} 个子模块组成，共 ${fileCount} 个文件`;
}

/** 规则描述：社区节点 */
function ruleCommunityDesc(c: { files: string[]; est_lines?: number; symbol_count?: number }): string {
  const parts = [`包含 ${c.files.length} 个文件`];
  if (c.est_lines) parts.push(`约 ${c.est_lines} 行`);
  if (c.symbol_count) parts.push(`${c.symbol_count} 个符号`);
  return parts.join(' · ');
}

/** 规则描述：文件节点 */
function ruleFileDesc(f: FileInfo): string {
  if (f.responsibility) return f.responsibility;
  const parts: string[] = [];
  if (f.lines) parts.push(`${f.lines} 行`);
  if (f.status) parts.push(`状态:${f.status}`);
  return parts.join(' · ') || '（无描述）';
}

/**
 * 用 LLM 为一批功能/社区节点批量生成人话描述。
 * 分批并行（每批 12 个条目，批间 Promise.all），单批 60s 超时——
 * 一次性喂几十个条目会让慢端点生成超长输出甚至悬挂（实测 5 分钟）。
 * 返回 { 节点id → 描述 }（合并各批成功部分）；全部失败返回 null（调用方降级规则）。
 */
async function llmEnrichDescriptions(
  nodes: Array<{ id: string; label: string; kind: string; hint: string; owner?: string }>,
  projectTitle: string,
): Promise<Map<string, string> | null> {
  const cfg = loadAgentConfig();
  if (!cfg) return null;
  const BATCH = 12;
  const chunks: Array<typeof nodes> = [];
  for (let i = 0; i < nodes.length; i += BATCH) chunks.push(nodes.slice(i, i + BATCH));
  const system =
    '你是软件项目的"人话翻译官"。用户要把一个项目的结构做成给普通人看的思维导图。' +
    '给定项目里的功能/子模块/文件清单，请为每个条目写一句**通俗易懂且有针对性**的介绍（2-3 句以内），' +
    '讲清"这是什么、大概干嘛用、在所属功能里承担什么角色"，避免只重复技术名词，' +
    '也避免给不同条目写雷同的套话——每个条目的介绍必须体现它自己的特点。' +
    '铁律：条目信息中给出的功能名/路径/职责是唯一事实来源，介绍里提到功能名时必须原样引用给定名称，' +
    '严禁发明清单里没有的功能名或项目背景；信息不足就只描述文件本身，不要推测。' +
    '只输出 JSON：{"descriptions":{"<id>":"<人话描述>", ...}}，id 必须来自给定清单，且必须覆盖清单中的每一个 id。';
  const kindLabel = (k: string): string => (k === 'feature' ? '功能' : k === 'file' ? '文件' : '子模块');
  /** 单批调用：成功返回 Map，失败（网络/超时/JSON 截断）返回 null */
  const fetchChunk = async (
    chunk: Array<{ id: string; label: string; kind: string; hint: string; owner?: string }>,
  ): Promise<Map<string, string> | null> => {
    const list = chunk
      .map((n) => `- id=${n.id} · ${kindLabel(n.kind)}「${n.label}」（所属功能名只能用：${n.owner ?? '未提供'}）· ${n.hint}`)
      .join('\n');
    try {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `项目：${projectTitle}\n条目清单：\n${list}` },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? '';
      const parsed = extractJsonObject(content);
      const raw = parsed?.descriptions as Record<string, unknown> | undefined;
      if (!raw || typeof raw !== 'object') return null;
      const out = new Map<string, string>();
      for (const [id, v] of Object.entries(raw)) {
        const s = typeof v === 'string' ? v.trim() : '';
        if (s) out.set(id, s);
      }
      return out.size > 0 ? out : null;
    } catch {
      return null;
    }
  };
  const results = await Promise.all(chunks.map((c) => fetchChunk(c)));
  const merged = new Map<string, string>();
  for (const r of results) if (r) for (const [k, v] of r) merged.set(k, v);
  // 收敛补漏：首轮未覆盖的条目重组小批**串行**重跑——
  // 服务不稳/限流时并行批易整批失败，串行小批（8 个/批）成功率高
  let pending = nodes.filter((n) => !merged.has(n.id));
  for (let round = 0; round < 3 && pending.length > 0; round++) {
    for (let i = 0; i < pending.length; i += 8) {
      const r = await fetchChunk(pending.slice(i, i + 8));
      if (r) for (const [k, v] of r) merged.set(k, v);
    }
    pending = nodes.filter((n) => !merged.has(n.id));
  }
  return merged.size > 0 ? merged : null;
}

// ─────────────────────────────────────────────────────────────
// 能力支柱合成：把代码自动聚出的"细功能"归并成"这个项目能干嘛"的业务能力
// 上下文来源 = MCP 工具注册表（server_registry）——比目录聚类更能回答"能干嘛"
// ─────────────────────────────────────────────────────────────

/** 从工程的 MCP 工具注册文件提取"能力清单"（工具名 + 一句话），供能力合成作上下文 */
function extractToolContext(dsl: DesignDSL): string {
  // source_root 在 live 快照上可能缺省，回退到包根；server_registry.ts 就在 <包根>/src/。
  // 不要在语义文件路径里猜：其基准常是 src/ 且旧正则易误配 daemon/server.ts 等，
  // 直接按包根实际搜索真实存在的注册文件，找不到即跳过能力合成。
  const base = (dsl.source_root && dsl.source_root.trim()) || getPackageRoot();
  if (!base) return '';
  try {
    let abs = '';
    // 兜底候选（文件已存在才作数）：先 server_registry，其次任意 registry/server.ts
    const names = ['server_registry.ts', 'server_registry.tsx', 'registry.ts', 'server.ts'];
    for (const n of names) {
      const p = path.join(base, 'src', n);
      if (fs.existsSync(p)) { abs = p; break; }
    }
    if (!abs) return '';
    const text = fs.readFileSync(abs, 'utf-8');
    const tools: string[] = [];
    // 逐块抓 tool 定义（name + description），正则防御性、失败即止
    const re = /name:\s*'([a-zA-Z0-9_]+)'[\s\S]*?description:\s*([\s\S]*?)(?:inputSchema:|handler:)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && tools.length < 40) {
      const desc = m[2]
        .replace(/['"`]|\s*\+\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
      if (m[1] && desc) tools.push(`${m[1]}：${desc}`);
    }
    return tools.map((t) => `- ${t}`).join('\n');
  } catch {
    return '';
  }
}

/** 用 LLM 把细功能归并成几个业务能力支柱：返回 [{name, explanation, features}] 或 null */
async function llmSynthesizeCapabilities(
  features: FeatureNode[],
  toolContext: string,
  title: string,
): Promise<Array<{ name: string; explanation: string; features: string[] }> | null> {
  const cfg = loadAgentConfig();
  if (!cfg || features.length === 0) return null;
  // 能力归并只需功能名即可，不带子模块细节（那会令输入膨胀、拖慢冷启动数十秒）
  const list = features.map((f) => `-「${f.name}」`).join('\n');
  const contextBlock = toolContext
    ? `\n这个项目是一个 MCP server，注册了以下工具（即它能提供的能力）：\n${toolContext}\n` +
      `请以这些能力为准来命名/归并下面的功能。\n`
    : '';
  const prompt =
    `下面是一个软件项目导图里自动聚类出的 ${features.length} 个太过细致的"功能"。${contextBlock}\n` +
    `请把它们归并成 **3-5 个业务能力支柱**，每个支柱是"这个项目给用户/开发者解决什么问题"这件事。\n` +
    `命名要像"重构屎山""剥离积木块""摄像头自动测试"这种**面向使用场景的能力动宾短语**（2-6 字），` +
    `不要用"渲染能力""可观测性""服务治理"这类技术分类词。\n` +
    `每个支柱给出：\n` +
    `1) 简短中文能力名（2-6 字，动宾、面向场景）；\n` +
    `2) 一句**对普通人友好**的能力说明（用它做什么、解决什么问题，避免堆技术名词）；\n` +
    `3) features 数组：包含哪些功能（必须**原样**用上面给定的功能名）。\n` +
    `要求：\n` +
    `- 每个功能必须且只能归入一个支柱；\n` +
    `- 归并依据是"用户要它解决什么问题"，不是目录名或技术分类；\n` +
    `- 提供工具上下文时，命名优先贴合工具体现的做事场景；\n` +
    `- 信息不足时不要发明清单里没有的功能或能力。\n` +
    `只输出紧凑 JSON：{"capabilities":[{"name":"重构屎山","explanation":"一句话说明","features":["功能A","功能B"]}]}`;
  // 冷启动兜底：端点首个 LLM 调用常达 30+s（随后热缓存秒回）。超时放大到 180s，
  // 失败时重试一次以命中热缓存——否则冷启动必触发 90s 超时，能力支柱层"静默消失"。
  const messages: ChatMessage[] = [
    { role: 'system', content: '你是软件架构的"能力翻译官"：把代码聚出的细粒度功能，转成业务负责人一眼看懂的能力导图。' },
    { role: 'user', content: `项目：${title}\n功能清单：\n${list}\n\n${prompt}` },
  ];
  let content = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      content = await callChat(cfg, messages, 0.4, 180_000);
      break; // 成功即出
    } catch (e) {
      console.error(`[cap] llmSynthesizeCapabilities attempt${attempt + 1} fail:`, (e as Error).message?.slice(0, 160));
      if (attempt === 1) return null; // 两次都失败 → 回退规则
    }
  }
  try {
    const parsed = extractJsonObject(content);
    const raw = parsed?.capabilities;
    if (!Array.isArray(raw) || raw.length === 0) { console.error('[cap] llm 无 capabilities 字段, raw=', JSON.stringify(parsed).slice(0, 200)); return null; }
    const nameSet = new Set(features.map((f) => f.name));
    const used = new Set<string>();
    const out: Array<{ name: string; explanation: string; features: string[] }> = [];
    for (const c of raw.slice(0, 8)) {
      const name = typeof c?.name === 'string' ? c.name.trim().slice(0, 10) : '';
      const explanation = typeof c?.explanation === 'string' ? c.explanation.trim() : '';
      if (!name) continue;
      const refs = Array.isArray(c?.features)
        ? (c.features as unknown[]).filter((r): r is string => typeof r === 'string' && nameSet.has(r.trim()))
        : [];
      const feats = (refs.length ? refs : []).map(String);
      if (feats.length === 0) continue;
      out.push({ name, explanation, features: feats });
      feats.forEach((x) => used.add(x));
    }
    // 未被任何支柱收纳的功能 → 归入"其他"
    const missing = features.map((f) => f.name).filter((n) => !used.has(n));
    if (missing.length > 0) out.push({ name: '其他', explanation: '未归入上述能力的功能', features: missing });
    return out.length > 0 ? out : null;
  } catch (e) {
    console.error('[cap] llmSynthesizeCapabilities exception:', (e as Error).name, (e as Error).message?.slice(0, 200));
    return null;
  }
}

/** 递归统计子树文件数 */
function countFiles(n: MindMapNode): number {
  if (!n.children || n.children.length === 0) return n.kind === 'file' || n.kind === 'brick' ? 1 : 0;
  return n.children.reduce((s, c) => s + countFiles(c), 0);
}

// ─────────────────────────────────────────────────────────────
// teach 模式：科普教学导图（功能 + 实现原理分镜）
// 叙事框架参考科普视频：项目是什么 → 有哪些功能 → 每个功能怎么实现的（分镜）
// 材料三层：文件职责（静态）+ 函数签名（静态）+ 真实调用链（cache.db 动态证据）
// ─────────────────────────────────────────────────────────────

/** 给 LLM 的科普分镜产出 */
interface TeachScript {
  what: string;
  steps: TeachStep[];
  /** 产线判定提议：该功能是否像一条产线/流水线（数据有单向先后流向）。LLM 只出候选，人确认后才成为事实 */
  pipeline_like?: { like?: boolean; why?: string };
}

/** 定位 feature 对应的 cache.db（与 overview/feature_tree 同一套候选逻辑） */
function findCacheDb(feature: string, dsl: DesignDSL): string | null {
  const candidates = [
    path.join(getStorageRoot(), `import_cache_${feature}.db`),
    dsl.source_root ? path.join(dsl.source_root, '.design-canvas', 'cache.db') : '',
    path.join(process.cwd(), '.design-canvas', 'cache.db'),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** 后缀匹配（≥2 段）判断 cache.db 路径是否属于功能文件集合（两套相对根可能前缀不同） */
function makeFileMatcher(featureRels: string[]): (p: string) => boolean {
  const exact = new Set(featureRels);
  const suffixes = new Set<string>();
  for (const f of featureRels) {
    const segs = f.split('/');
    for (let k = 0; k < segs.length - 1; k++) suffixes.add(segs.slice(k).join('/'));
  }
  return (p: string) => {
    if (exact.has(p)) return true;
    const segs = p.split('/');
    for (let k = 0; k < segs.length - 1; k++) if (suffixes.has(segs.slice(k).join('/'))) return true;
    return false;
  };
}

/**
 * 从 cache.db 取该功能的真实跨文件调用边（科普分镜的执行顺序证据）。
 * 按调用频次取 top N，一屏可读；文件粒度去重（同一对文件最多 2 条，防 hub 函数刷屏）。
 * 返回人读格式："a.ts:fnA → b.ts:fnB ×12"；db 不可用返回 []。
 */
function loadCallEdges(db: Database, featureRels: string[], maxEdges = 40): string[] {
  const match = makeFileMatcher(featureRels);
  const rows = db
    .prepare(
      `SELECT n1.file_path AS sf, n1.name AS sn, n2.file_path AS tf, n2.name AS tn, COUNT(*) AS w
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'call' AND n1.file_path != n2.file_path
       GROUP BY n1.file_path, n1.name, n2.file_path, n2.name
       ORDER BY w DESC`,
    )
    .all() as Array<{ sf: string; sn: string; tf: string; tn: string; w: number }>;
  const perPair = new Map<string, number>();
  const out: string[] = [];
  for (const r of rows) {
    if (!match(r.sf) || !match(r.tf)) continue;
    const pairKey = [r.sf, r.tf].sort().join('⇔');
    const cnt = perPair.get(pairKey) ?? 0;
    if (cnt >= 2) continue;
    perPair.set(pairKey, cnt + 1);
    out.push(`${r.sf}:${r.sn} → ${r.tf}:${r.tn}（×${r.w}）`);
    if (out.length >= maxEdges) break;
  }
  return out;
}

/**
 * 功能内文件热度：该文件在功能集合中作为跨文件调用 source/target 的总次数。
 * teach 功能节点下的"关键文件"子层按它取 topN——下钻有据，不是全量平铺（那是星图的杂乱）。
 */
function loadFileHeat(db: Database, featureRels: string[]): Map<string, number> {
  const match = makeFileMatcher(featureRels);
  const rows = db
    .prepare(
      `SELECT n1.file_path AS sf, n2.file_path AS tf, COUNT(*) AS w
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'call' AND n1.file_path != n2.file_path
       GROUP BY n1.file_path, n2.file_path`,
    )
    .all() as Array<{ sf: string; tf: string; w: number }>;
  const heat = new Map<string, number>();
  for (const r of rows) {
    if (match(r.sf)) heat.set(r.sf, (heat.get(r.sf) ?? 0) + r.w);
    if (match(r.tf)) heat.set(r.tf, (heat.get(r.tf) ?? 0) + r.w);
  }
  return heat;
}

/**
 * 跨功能依赖聚合：从 cache.db 真实调用边算"功能 A 的文件调用功能 B 的文件"总次数。
 * 树管归属（is-part-of）、线管依赖（depends-on）——底座功能不占兄弟名目，用叠加层表达。
 * 同时识别底座：被 ≥2 个功能调用、且调出量不到调入量一半（入度 >> 出度）的基建。
 */
function loadFeatureDeps(
  db: Database,
  featureNames: string[],
  featureRels: string[][],
): {
  deps: Array<{ from: string; to: string; weight: number; via_files?: string[] }>;
  foundations: string[];
  shared: Array<{ file: string; used_by: Array<{ feature: string; count: number }>; total: number }>;
} {
  const matchers = featureRels.map((rels) => makeFileMatcher(rels));
  /** 文件 → 功能索引（首次匹配）；一个文件只归一个功能（与分拣口径一致） */
  const fileOwner = new Map<string, number>();
  const ownerOf = (p: string): number => {
    if (fileOwner.has(p)) return fileOwner.get(p) as number;
    let hit = -1;
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i](p)) {
        hit = i;
        break;
      }
    }
    fileOwner.set(p, hit);
    return hit;
  };
  const rows = db
    .prepare(
      `SELECT n1.file_path AS sf, n2.file_path AS tf, COUNT(*) AS w
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source
       JOIN nodes n2 ON n2.id = e.target
       WHERE e.kind = 'call' AND n1.file_path != n2.file_path
       GROUP BY n1.file_path, n2.file_path`,
    )
    .all() as Array<{ sf: string; tf: string; w: number }>;
  const pairW = new Map<string, number>();
  /** pairKey → 目标文件 → 次数：功能粒度会失真（调用方可能只用功能里一小块），文件证据揭示真正踩的地板 */
  const pairFiles = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const a = ownerOf(r.sf);
    const b = ownerOf(r.tf);
    if (a < 0 || b < 0 || a === b) continue;
    const key = `${a}→${b}`;
    pairW.set(key, (pairW.get(key) ?? 0) + r.w);
    const fm = pairFiles.get(key) ?? new Map<string, number>();
    fm.set(r.tf, (fm.get(r.tf) ?? 0) + r.w);
    pairFiles.set(key, fm);
  }
  const deps: Array<{ from: string; to: string; weight: number; via_files?: string[] }> = [];
  for (const [key, w] of pairW) {
    if (w < 3) continue; // 噪声边：偶发引用不算依赖
    const [a, b] = key.split('→').map(Number);
    const via = [...(pairFiles.get(key) ?? new Map())]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([f, c]) => `${f}（×${c}）`);
    deps.push({ from: featureNames[a], to: featureNames[b], weight: w, via_files: via });
  }
  deps.sort((x, y) => y.weight - x.weight);
  // 底座识别：入度（被依赖）≥2 个功能 且 调出 < 调入一半
  const inW = new Array(featureNames.length).fill(0);
  const inFans: Set<number>[] = featureNames.map(() => new Set<number>());
  const outW = new Array(featureNames.length).fill(0);
  for (const [key, w] of pairW) {
    const [a, b] = key.split('→').map(Number);
    inW[b] += w;
    inFans[b].add(a);
    outW[a] += w;
  }
  const foundations: string[] = [];
  for (let i = 0; i < featureNames.length; i++) {
    if (inFans[i].size >= 2 && inW[i] >= 8 && outW[i] < inW[i] / 2) foundations.push(featureNames[i]);
  }
  // 共享能力文件：跨功能被调总次数 ≥3（含单功能高频调用，如 watch 工具被某功能 ×6）。
  // 聚类会把这类"隐形地板"吸进某个大功能变得不可见，这里按调用证据显式挖出来。
  const fileFans = new Map<string, Map<number, number>>(); // 目标文件 → (调用方功能 → 次数)
  for (const r of rows) {
    const a = ownerOf(r.sf);
    const b = ownerOf(r.tf);
    if (a < 0 || b < 0 || a === b) continue;
    const m = fileFans.get(r.tf) ?? new Map<number, number>();
    m.set(a, (m.get(a) ?? 0) + r.w);
    fileFans.set(r.tf, m);
  }
  const shared = [...fileFans.entries()]
    .map(([file, m]) => ({
      file,
      used_by: [...m.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([i, c]) => ({ feature: featureNames[i], count: c })),
      total: [...m.values()].reduce((x, y) => x + y, 0),
    }))
    .filter((s) => s.total >= 3)
    .sort((x, y) => y.total - x.total)
    .slice(0, 12);
  return { deps: deps.slice(0, 14), foundations, shared };
}

/** detail 中的技术噪声检测：函数调用/路径/驼峰/snake_case 标识（验收"零函数名"规矩；放行普通英文单词） */
const TECH_NOISE_RE =
  /[\w./-]+\(\s*\)|[\w-]+\.(ts|tsx|js|mjs|go|py|rs|java)\b|\b[a-z]+[A-Z][a-zA-Z]*\b|\b[a-z]+(_[a-z0-9]+)+\b/;

/** 限并发 map：每批最多 limit 个任务并发（避免全量并行打爆 LLM API 限流） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 科普编剧 v2（teach 核心）。材料三区：职责清单 / 调用记录 / 函数签名。
 * 硬规矩：what 必须痛点开场（不说"XX功能用于"）；detail 零技术标识，
 * 锚点只进 involves；steps 顺序以调用记录为证据。
 * 返回 null 表示失败/未配置（调用方降级）。
 */
async function llmTeachFeature(material: string, featureName = ''): Promise<TeachScript | null> {
  const cfg = loadAgentConfig();
  if (!cfg) return null;
  const system =
    '你是技术科普编剧，擅长把软件功能讲成普通人爱看的科普视频（类似"3分钟看懂搜索引擎原理"）。\n' +
    '给定一个功能的材料：【职责】每个文件是干嘛的；【调用记录】真实代码里谁调用谁、调用多少次（这是真实执行顺序的证据，材料区允许出现函数名供你理解，但你的输出不许照搬）；【主人批注】项目主人在导图上写的理解/纠正（如有，优先级最高，人的说法与材料冲突时以人为准）。\n\n' +
    '请为这个功能写科普分镜：\n' +
    '1. what：从**痛点/场景**开场（"如果没它会怎样"或"它像生活中的什么"），1-2 句。禁止用"本功能用于/是一个…的功能"这类说明书腔。可以打生活类比（如"给程序装行车记录仪"）。\n' +
    '2. steps：实现原理分镜 3-6 步，像视频镜头按**真实执行/数据流顺序**推进——顺序必须以【调用记录】为证据，不能凭目录名猜。每步：\n' +
    '   - title：≤12 字动宾短语（如「埋下探针」「比对流水账」）；\n' +
    '   - detail：1-2 句纯人话，讲清这步发生什么、数据从哪来到哪去。**严禁**出现函数名、文件名、路径、英文驼峰词——技术细节只许放进 involves；\n' +
    '   - involves：这步依据的关键文件（只能从【职责】清单的文件里选，给想深挖的工程师看）。\n' +
    '3. pipeline_like（可选）：这个功能整体是否像一条**产线/流水线**？\n' +
    '   - 判断标准：数据有**单向先后流向**——上一道工序的产物（返回值/结果）喂给下一道，前后有明确先后，如 埋针→采集→传输→入库→查询。若符合，输出 {"like":true,"why":"一句话依据（如 数据沿调用链单向流动）"}。\n' +
    '   - 不符合则输出 {"like":false,"why":"一句话依据"}。\n' +
    '只基于给定材料，不得编造。只输出 JSON（无其他文字）：\n' +
    '{"what":"...","steps":[...],"pipeline_like":{"like":true,"why":"..."}}';
  const callOnce = async (
    userContent: string,
  ): Promise<{ ok: boolean; status: number; content: string; finishReason: string; retryable: boolean; err?: string }> => {
    try {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(150_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, content: body.slice(0, 300), finishReason: '', retryable: res.status === 429 || res.status >= 500, err: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      const choice = data.choices?.[0];
      return { ok: true, status: res.status, content: choice?.message?.content ?? '', finishReason: choice?.finish_reason ?? '', retryable: false };
    } catch (e) {
      const err = e as Error;
      // 超时/网络中断可重试；配置类错误重试也没用
      const retryable = err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'TypeError';
      return { ok: false, status: 0, content: '', finishReason: '', retryable, err: `${err.name}: ${err.message}` };
    }
  };

  /** 解析 + 零函数名过滤。返回放行后的 script（可能为 null）与被拦截步骤的违规明细（供重写） */
  const parseAndFilter = (content: string): { script: TeachScript | null; violations: string[] } => {
    const parsed = extractJsonObject(content);
    if (!parsed) return { script: null, violations: [] };
    const what = typeof parsed.what === 'string' ? parsed.what.trim() : '';
    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
    const steps: TeachStep[] = [];
    const violations: string[] = [];
    for (const s of rawSteps) {
      const step = s as { title?: unknown; detail?: unknown; involves?: unknown };
      const t = typeof step.title === 'string' ? step.title.trim() : '';
      const d = typeof step.detail === 'string' ? step.detail.trim() : '';
      if (!t || !d) continue;
      // 零函数名规矩：detail 带技术噪声的步骤先记违规；重写失败才整步丢弃（宁缺毋滥，不污染科普）
      if (TECH_NOISE_RE.test(d)) {
        violations.push(`「${t}」：${d}`);
        continue;
      }
      const inv = Array.isArray(step.involves)
        ? step.involves.filter((x): x is string => typeof x === 'string' && !!x).slice(0, 5)
        : undefined;
      steps.push({ title: t.slice(0, 24), detail: d.slice(0, 300), involves: inv });
    }
    if (!what || steps.length === 0) return { script: null, violations };
    // 产线判定提议（可选）：like 必须是布尔量；why 限一句话，非法则丢弃（宁缺毋滥，不替主人拍板）
    let pipeline_like: TeachScript['pipeline_like'];
    const pl = parsed.pipeline_like as { like?: unknown; why?: unknown } | undefined;
    if (pl && typeof pl.like === 'boolean') {
      pipeline_like = {
        like: pl.like,
        why: typeof pl.why === 'string' && pl.why.trim() ? pl.why.slice(0, 80) : undefined,
      };
    }
    return {
      script: { what: what.slice(0, 200), steps: steps.slice(0, 8), pipeline_like },
      violations,
    };
  };

  try {
    // 首遍调用：空 content（模型偶发返回空）/超时/限流 → 退避重试，最多 3 次尝试
    type CallResult = Awaited<ReturnType<typeof callOnce>>;
    const needRetry = (x: CallResult): boolean => (!x.ok && x.retryable) || (x.ok && x.content.trim() === '');
    let r = await callOnce(material);
    for (let attempt = 2; attempt <= 3 && needRetry(r); attempt++) {
      console.error(`[teach] 功能「${featureName}」第 ${attempt - 1} 次尝试失败（${r.err || r.content.slice(0, 100) || '空 content'}），${attempt * 2}s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      r = await callOnce(material);
    }
    if (!r.ok) {
      console.error(`[teach] 功能「${featureName}」LLM 调用失败：${r.err ?? ''} ${r.content}`);
      return null;
    }
    let { script, violations } = parseAndFilter(r.content);
    if (!script && r.content.trim() === '') {
      console.error(`[teach] 功能「${featureName}」LLM 返回空 content（finish_reason=${r.finishReason}）`);
    }
    // 违规重写回路：≥2 步带技术标识（或全灭）时，把违规明细发回 LLM 重写一次——
    // LLM 常照搬材料里的 snake_case 模块名，丢弃会导致整个功能无分镜，重写才能两全（零噪声 + 有分镜）
    if (violations.length >= 2 && (script === null || script.steps.length < 3)) {
      console.error(`[teach] 功能「${featureName}」${violations.length} 步含技术标识，触发重写回路`);
      const rewriteUser =
        material +
        '\n\n【重写要求】你上一遍输出的以下步骤 detail 含函数名/文件名/英文驼峰或下划线标识，已全部作废：\n' +
        violations.map((v) => `- ${v}`).join('\n') +
        '\n请重新输出完整 JSON（what + 全部 steps）：违规步骤用纯生活化语言重写（如「总指挥模块」「翻译官」这类角色化说法替代具体标识），未违规的步骤保持原样。involves 字段仍可写真实文件名。';
      const r2 = await callOnce(rewriteUser);
      if (r2.ok) {
        const second = parseAndFilter(r2.content);
        if (second.script && (script === null || second.script.steps.length > script.steps.length)) {
          console.error(`[teach] 功能「${featureName}」重写成功：${second.script.steps.length} 步全部合规`);
          script = second.script;
        }
      }
    }
    if (!script) {
      console.error(`[teach] 功能「${featureName}」无有效分镜（违规 ${violations.length} 步重写后仍不合规）`);
      return null;
    }
    return script;
  } catch (e) {
    console.error(`[teach] 功能「${featureName}」意外异常：`, (e as Error).message);
    return null;
  }
}

/** 组装单个功能的实现材料 v2：职责 + 调用记录（顺序证据）+ 主人批注
 *  rels 传入功能的**文件全集**（社区文件 + 目录直挂文件），
 *  零社区功能（dsl/db/daemon 等纯定义/服务目录）也能拿到真实文件喂给分镜。 */
function buildTeachMaterial(
  projectTitle: string,
  fName: string,
  rels: string[],
  communities: FeatureTree['features'][number]['communities'],
  fileIndex: ReturnType<typeof buildFileIndex>,
  callEdges: string[],
  ownerNotes: string[],
): string {
  const anchors = communities
    .filter((c) => !isNoiseCommunity(c.name))
    .slice(0, 8)
    .map((c) => c.name);
  const MAX = 25;
  const shown = rels.slice(0, MAX);
  const parts: string[] = [
    `项目：${projectTitle}`,
    `功能：${fName}（${rels.length} 个文件${anchors.length ? `，协作模块：${anchors.join('、')}` : ''}）`,
    '【职责】各文件是干嘛的：',
  ];
  for (const rel of shown) {
    const info = lookupFile(fileIndex, rel);
    if (!info) continue;
    const resp = info.responsibility || '（无职责说明）';
    parts.push(`- ${rel}：${resp}`);
  }
  if (rels.length > shown.length) parts.push(`（职责清单截断，共 ${rels.length} 个文件）`);
  if (callEdges.length > 0) {
    parts.push('【调用记录】真实代码里的跨文件调用（按频次排序，是分镜顺序的证据）：');
    parts.push(...callEdges.map((e) => `- ${e}`));
  } else {
    parts.push('【调用记录】无（该功能无跨文件调用数据，分镜顺序依据职责推断并在 detail 中说明）');
  }
  if (ownerNotes.length > 0) {
    parts.push('【主人批注】项目主人在这张导图上写的批注（人的理解和纠正，优先级最高，必须融入 what/steps）：');
    parts.push(...ownerNotes.map((n) => `- ${n}`));
  }
  return parts.join('\n');
}

/**
 * involves 管线兜底：LLM 产出的 involves 常有两类病——
 *   1. 裸文件名（丢了目录前缀，如 `trace_exec.ts`，lookupFile/下钻都解析不到）；
 *   2. 引用不全（只点出个别关键文件，功能其余文件在 L4 下钻不可达，如「能力矩阵」13 文件只引 2 个）。
 * 以该功能真实文件全集 rels（file_map 目录优先归属，权威）为准：
 *   - 裸文件名按 basename 归一到全路径，无法解析的条目丢弃；
 *   - 未引用的文件**按文件名词元相似度匹配到最相关步骤**（以 LLM 已引用的关键文件为锚点，
 *     如 leftover 里的 `arch_layer.ts` 会匹配到已含 `arch_layer/monolith` 的「识别架构分层」步骤，
 *     而不是被轮流塞进无关步骤）；完全无相似锚点的文件才按轮转兜底。
 *     文件均为该功能真实成员，非编造。
 */
function fileTokenSet(base: string): Set<string> {
  return new Set(base.replace(/\.(tsx?|go|js)$/i, '').split(/[^a-z0-9]+/i).filter(Boolean));
}

/** 文件与步骤的语义相关度：该文件与步骤已引用文件的文件名词元最大重叠数 */
function stepSimilarity(file: string, step: TeachStep): number {
  const ft = fileTokenSet(file.split('/').pop() ?? file);
  let best = 0;
  for (const inv of step.involves ?? []) {
    const it = fileTokenSet(inv.split('/').pop() ?? inv);
    let hits = 0;
    for (const t of ft) if (it.has(t)) hits++;
    if (hits > best) best = hits;
  }
  return best;
}

function polishStepInvolves(script: { steps: TeachStep[] }, rels: string[]): void {
  if (rels.length === 0) return;
  const byBase = new Map<string, string>();
  for (const p of rels) {
    const b = p.split('/').pop() ?? p;
    if (!byBase.has(b)) byBase.set(b, p);
  }
  const used = new Set<string>();
  // 第一遍：归一化裸文件名 → 全路径；无法解析的条目丢弃
  for (const s of script.steps) {
    if (!s.involves) continue;
    const out: string[] = [];
    for (const p of s.involves) {
      const full = rels.includes(p) ? p : byBase.get(p.split('/').pop() ?? '');
      if (full) {
        out.push(full);
        used.add(full);
      }
    }
    s.involves = out;
  }
  // 第二遍：未引用文件按语义相关度匹配到最相关步骤；无锚点可依的再轮转兜底
  const leftover = rels.filter((p) => !used.has(p));
  if (leftover.length === 0) return;
  const unmatched: string[] = [];
  for (const p of leftover) {
    let bestS = -1;
    let bestScore = 0;
    script.steps.forEach((s, i) => {
      const sc = stepSimilarity(p, s);
      if (sc > bestScore) {
        bestScore = sc;
        bestS = i;
      }
    });
    if (bestScore > 0 && bestS >= 0) {
      const s = script.steps[bestS];
      if (!s.involves) s.involves = [];
      s.involves.push(p);
      used.add(p);
    } else {
      unmatched.push(p);
    }
  }
  if (unmatched.length === 0) return;
  const order = script.steps
    .map((s, i) => ({ i, n: s.involves?.length ?? 0 }))
    .sort((a, b) => a.n - b.n || a.i - b.i);
  let k = 0;
  while (k < unmatched.length) {
    for (const { i } of order) {
      if (k >= unmatched.length) break;
      const s = script.steps[i];
      if (!s.involves) s.involves = [];
      s.involves.push(unmatched[k++]);
    }
  }
}

/**
 * 构建 teach 导图：root → 功能（what + 实现原理分镜 steps）。
 * useLlm=true 时各功能并行调科普编剧；失败/未配置降级规则版（无分镜，仅描述）。
 * teach 只落 JSON（小白入口是项目页圆框图，不需要独立 HTML 查看器）。
 */
/**
 * 积木黑盒卡（semantic 条目 → MindMapNode kind='brick'）。
 * 数据事实：import_project 折叠时写入的 semantic 条目（id=brick_* 锚点、
 * path=dest_root、responsibility=盒内人话+黑盒注记、expected_apis=契约投影）。
 * 纪律：description 直接用盒内 manifest 的快照——不由 LLM 重述（盒内事实只有一份）。
 */
function brickCardFromSemantic(sf: SemanticFile): MindMapNode {
  // responsibility 格式 "{盒内人话}（积木黑盒：N 文件折叠，契约投影自 assembly.json）"
  const desc = (sf.responsibility ?? '').split('（积木黑盒：')[0] || '治理好的黑盒积木';
  return {
    id: sf.id,
    label: (sf.path ?? '').replace(/\/$/, '') || sf.id,
    description: desc,
    kind: 'brick',
    meta: {
      lines: sf.lines,
      symbols: sf.expected_apis?.length,
      l2_ref: sf.id,
      apis: sf.expected_apis?.map((a) => a.signature).slice(0, 12),
    },
  };
}

/** 根下补挂积木区（structure/teach × 功能树/平铺 全路径共用）：
 *  积木折叠后盒内文件不进 feature_tree/社区/平铺——不补位则导图上积木整体消失。
 *  积木卡与功能平级（"项目用了哪些标准件"），工厂产线视图里它就是产线上的外购件工位。 */
function appendBrickZone(root: MindMapNode, dsl: DesignDSL): void {
  const brickEntries = (dsl.semantic?.files ?? []).filter((sf) => sf.id.startsWith('brick_') && sf.path);
  if (brickEntries.length === 0) return;
  (root.children ??= []).push({
    id: 'bricks',
    label: '🧱 已验证积木',
    description: `${brickEntries.length} 块治理好的黑盒资产：拎自其他项目、契约已登记、行为已验证。点卡片看它对外暴露什么`,
    kind: 'feature',
    meta: { files: brickEntries.length },
    children: brickEntries.map(brickCardFromSemantic),
  });
}

async function buildTeachMindMap(
  dsl: DesignDSL,
  feature: string,
  title: string,
  useLlm: boolean,
): Promise<DeriveMindMapResult> {
  const fileIndex = buildFileIndex(dsl);
  const ft = dsl.feature_tree;
  const jsonFile = getMindMapFile(feature, 'teach');

  // 旧 teach JSON 保留主人资产（在下方 feature 遍历之前读取，避免 TDZ）：
  //  - prevProposals：placeProposals 写入的构想分镜，重建不能抹掉
  //  - prevPipelineLike：主人已拍板的"是/否产线"，重建只允许 LLM 再出提议、绝不覆盖确认
  let prevProposals: MindMap['proposals'];
  let prevPipelineLike: MindMap['pipeline_like'];
  try {
    if (fs.existsSync(jsonFile)) {
      const prev = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as MindMap;
      prevProposals = prev.proposals;
      prevPipelineLike = prev.pipeline_like;
    }
  } catch {
    /* 旧文件损坏则忽略 */
  }

  // 平铺兜底：无功能树（早期数据）——诚实降级，与 structure 一致
  if (!ft || ft.features.length === 0) {
    const root: MindMapNode = {
      id: 'root',
      label: title,
      description: '项目总览（未生成功能树，按文件平铺）',
      kind: 'root',
      children: (dsl.semantic?.files ?? [])
        // 积木条目（brick_*）不进平铺：统一进根下积木区（appendBrickZone）
        .filter((f) => f.path && !f.id.startsWith('brick_'))
        .slice(0, 30)
        .map((f) => ({
          id: f.id,
          label: basename(f.path),
          description: f.responsibility || '（无描述）',
          kind: 'file' as const,
        })),
    };
    appendBrickZone(root, dsl);
    const mindMap: MindMap = {
      feature,
      mode: 'rule',
      view: 'teach',
      root,
      generated_at: new Date().toISOString(),
      note: '该项目缺少源码快照（早期导入数据），无法生成科普分镜；重新导入可获得完整教学视图',
    };
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');
    return { feature, mode: 'rule', mind_map: mindMap, jsonFile, message: mindMap.note ?? '' };
  }

  // LLM 科普编剧：各功能并行（材料含真实调用链证据）
  // db 打不开时 edges=[]，材料仍以职责清单为主（LLM 会标注顺序为推断）
  let db: Database | null = null;
  const dbFile = findCacheDb(feature, dsl);
  if (dbFile) {
    try {
      db = openDb(dbFile);
    } catch {
      db = null;
    }
  }
  // 功能 → 文件全集：以 file_map（目录/能力域优先归属，权威）为准。
  // 社区按 cache.db 跨文件聚类，成员常横跨多个目录且混入测试/过滤文件——若整组并进来，
  // 文件数会被虚高（「查询理解」43 文件被顶到 168）且 involves 会指向非语义文件，
  // 下游 L4 下钻与 LLM 分镜材料都失真。社区节点仍单独按 f.communities 构建，不依赖 rels。
  const fidFiles = new Map<string, string[]>();
  if (ft.file_map) {
    for (const sf of dsl.semantic?.files ?? []) {
      const m = ft.file_map[sf.id];
      if (!m) continue;
      const arr = fidFiles.get(m.feature_id) ?? [];
      arr.push(sf.path);
      fidFiles.set(m.feature_id, arr);
    }
  }
  const featureRels = ft.features.map((f) => [...new Set(fidFiles.get(f.id) ?? [])]);
  const callEdgeLists = featureRels.map((rels) => (db ? loadCallEdges(db, rels) : []));
  // 跨功能依赖叠加层（树管归属、线管依赖）：真实调用边聚合 + 底座识别
  const { deps, foundations, shared } = db
    ? loadFeatureDeps(db, ft.features.map((f) => f.name), featureRels)
    : { deps: [], foundations: [] as string[], shared: [] as Array<{ file: string; used_by: Array<{ feature: string; count: number }>; total: number }> };
  // 功能内文件热度：teach 下钻"关键文件"子层的排序依据（db 关闭前算好）
  const fileHeat = featureRels.map((rels) => (db ? loadFileHeat(db, rels) : new Map<string, number>()));
  db?.close();

  // 主人批注分拣：导图节点 id f{i}（功能）/ f{i}:{j}（步骤），target_id 前缀匹配
  const humanNotes = (dsl.annotations ?? []).filter((a) => a.author === 'human' && !a.resolved && a.text);
  // 用户手写节点（人机共笔）：挂功能/步骤下的整棵子树（含嵌套）作为该功能的理解补充；
  // 挂 root 的作为项目级理解，进所有功能材料。parent_id 索引漂移时按 parent_label 匹配功能名兜底。
  const userNodes = dsl.user_nodes ?? [];
  const uChildren = new Map<string, string[]>();
  for (const u of userNodes) {
    const arr = uChildren.get(u.parent_id) ?? [];
    arr.push(u.id);
    uChildren.set(u.parent_id, arr);
  }
  const uById = new Map(userNodes.map((u) => [u.id, u]));
  /** 展开用户子树为 "根 → 子 → 孙" 路径文本 */
  const uTreeText = (id: string): string => {
    const u = uById.get(id);
    if (!u) return '';
    const kids = (uChildren.get(id) ?? []).map(uTreeText).filter(Boolean);
    return u.text + (kids.length ? `（延伸：${kids.join('；')}）` : '');
  };
  const belongsToFeature = (u: { parent_id: string; parent_label?: string }, i: number): boolean => {
    if (u.parent_id === `f${i}` || u.parent_id.startsWith(`f${i}:`)) return true;
    return !!u.parent_label && u.parent_label === ft.features[i].name;
  };
  const rootLevelNotes = userNodes
    .filter((u) => u.parent_id === 'root')
    .map((u) => uTreeText(u.id))
    .filter(Boolean);
  const notesPerFeature = ft.features.map((_, i) => {
    const prefix = `f${i}:`;
    const annTexts = humanNotes
      .filter((a) => a.target_id === `f${i}` || a.target_id?.startsWith(prefix))
      .map((a) => a.text);
    // 只取直挂本功能子树的顶层节点（嵌套已由 uTreeText 展开），避免重复
    const nodeTexts = userNodes
      .filter((u) => belongsToFeature(u, i) && !u.parent_id.startsWith('u_'))
      .map((u) => `主人新增的笔记节点「${uTreeText(u.id)}」`);
    return [...annTexts, ...nodeTexts, ...rootLevelNotes.map((t) => `（项目级理解）${t}`)].slice(0, 14);
  });

  // 旧 teach JSON 的分镜缓存：功能名没变 + 本次不强制 LLM 时直接复用，
  // 避免规则重建（gen_descriptions=false）把已有 LLM 分镜覆盖成降级文案
  const prevScripts = new Map<string, TeachScript>();
  // 社区名中文缓存（community_zh）：社区名是聚类算法从代码标识生成的英文，译成人话
  let communityZh: Record<string, string> = {};
  // 节点专属描述缓存（desc_cache）：社区/文件层的人话介绍，key 为稳定锚点，避免"X 个文件"通用模板
  let descCache: Record<string, string> = {};
  try {
    if (fs.existsSync(jsonFile)) {
      const old = JSON.parse(fs.readFileSync(jsonFile, 'utf-8')) as MindMap;
      // 递归收集所有 feature 节点的分镜缓存——feature 可能直接挂 root.children，
      // 也可能被能力支柱（capability）顶层收纳在下级（teach 自定义路径）。只扫顶层会把分镜缓存全丢，
      // 导致重建时全量重调 LLM、遇 AGNES 抖动就整批退回占位（"中间产物"事故根因之一）。
      const collectFeatures = (nodes: MindMapNode[]): void => {
        for (const c of nodes) {
          if (c.kind === 'feature' && c.steps?.length && c.description)
            prevScripts.set(c.label, { what: c.description, steps: c.steps });
          if (c.children?.length) collectFeatures(c.children);
        }
      };
      collectFeatures(old.root?.children ?? []);
      if (old.community_zh && typeof old.community_zh === 'object') communityZh = old.community_zh;
      if (old.desc_cache && typeof old.desc_cache === 'object') descCache = old.desc_cache;
    }
  } catch {
    /* 旧文件损坏则忽略 */
  }
  // 缺译名的社区 → LLM 批量翻译（一次性，之后走缓存；开销与分镜无关独立判断）。
  // 噪音名（数据结构/辅助器类）不送 LLM：直译（最小堆）还是噪音，统一按「内部组件」兜底。
  const allCommNames = [...new Set(ft.features.flatMap((f) => f.communities.map((c) => c.name)))];
  for (const n of allCommNames) if (!communityZh[n] && isNoiseCommunity(n)) communityZh[n] = NOISE_ZH;
  const needZh = allCommNames.filter((n) => !communityZh[n]);
  if (needZh.length > 0) {
    const cfg = loadAgentConfig();
    if (cfg) {
      try {
        const res = await fetch(`${cfg.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              {
                role: 'system',
                content:
                  '把代码模块名翻译成简短中文名（≤6字，说明这组文件在做什么，如 TSProbeCapture→探针捕获、LLMJudge→AI判读）。' +
                  '专有技术词可保留（如 PDF、API）。只输出 JSON：{"zh":{"<原名>":"<中文名>"}}，键必须来自给定清单。',
              },
              { role: 'user', content: needZh.join('\n') },
            ],
            temperature: 0.2,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
          const parsed = extractJsonObject(data.choices?.[0]?.message?.content ?? '');
          const zh = parsed?.zh as Record<string, unknown> | undefined;
          if (zh && typeof zh === 'object') {
            for (const n of needZh) {
              const v = zh[n];
              if (typeof v === 'string' && v.trim()) communityZh[n] = v.trim().slice(0, 12);
            }
          }
        }
      } catch {
        /* 翻译失败保持英文原名，下次重建再试 */
      }
    }
  }

  // 限并发调用（3 个一批）：全量 Promise.all 并行易触发 API 限流（429），导致整批"AI 分镜暂不可用"
  const scripts: (TeachScript | null)[] = useLlm
    ? await mapLimit(
        ft.features,
        3,
        async (f, i) => {
          // 已有有效分镜（≥3 步）直接复用，避免每次重建全量重调 LLM；
          // 只对缺失/占位（steps<3，如"AI 分镜暂不可用"/"材料不足"）的功能重新生成——
          // 支持逐步补齐：掉了哪个功能，重跑一次只需补那一个。
          const prev = prevScripts.get(f.name);
          if (prev && prev.steps.length >= 3) return prev;
          return llmTeachFeature(
            buildTeachMaterial(title, f.name, featureRels[i], f.communities, fileIndex, callEdgeLists[i], notesPerFeature[i]),
            f.name,
          );
        },
      )
    : ft.features.map((f) => prevScripts.get(f.name) ?? (null as TeachScript | null));
  const anyLlm = scripts.some((s) => s !== null);

  // 展示顺序：底座功能排根下首位（承认其"地板"身份），但 f{i} id 保持原始索引——批注/用户节点锚点不漂移
  const isFoundation = (i: number) => foundations.includes(ft.features[i].name);
  const order = [
    ...ft.features.map((_, i) => i).filter((i) => isFoundation(i)),
    ...ft.features.map((_, i) => i).filter((i) => !isFoundation(i)),
  ];

  // 社区/文件专属描述生成目标：构建树时收集（带稳定 key + 材料 hint），树成型后统一补描述
  const descTargets: Array<{ node: MindMapNode; key: string; kind: 'community' | 'file'; hint: string; owner: string }> = [];
  // 产线判定提议：功能名 → 一句话依据。LLM 只出候选，确认前不影响渲染（机器不代主人拍板）
  const pipelineProposals: Record<string, string> = {};
  const root: MindMapNode = {
    id: 'root',
    label: title,
    description: `项目总览：${ft.features.length} 个功能`,
    kind: 'root',
    children: order.map((i) => {
      const f = ft.features[i];
      const rels = featureRels[i];
      const script = scripts[i];
      const hasEdges = callEdgeLists[i].length > 0;
      if (script?.pipeline_like?.like) pipelineProposals[f.name] = script.pipeline_like.why ?? '';
      // 真三层下钻：功能 → 子模块（社区=聚类真实产物，按内部热度 top3）→ 关键文件（每社区热度 top4）。
      // 分镜单独成组（🎬 stepgroup），不再与文件混在功能下一级——结构层与讲解层分开。
      const heat = fileHeat[i] ?? new Map<string, number>();
      const usedFileIds = new Set<string>();
      // 收集描述生成目标（key 稳定：文件用路径、社区用聚类原名，跨重建命中缓存）
      const fileNode = (p: string): MindMapNode | null => {
        const info = lookupFile(fileIndex, p);
        if (!info || usedFileIds.has(info.id)) return null;
        usedFileIds.add(info.id);
        const node: MindMapNode = {
          id: info.id,
          label: basename(p),
          description: info.responsibility || '',
          kind: 'file',
          meta: { lines: info.lines, l2_ref: info.id },
        };
        descTargets.push({
          node,
          key: `f:${p}`,
          kind: 'file',
          owner: f.name,
          hint: `路径 ${p} · 被调用 ${heatOf(p)} 次${info.responsibility ? ` · 现有职责描述：${info.responsibility.slice(0, 60)}` : ''}`,
        });
        return node;
      };
      const heatOf = (p: string) => heat.get(p) ?? 0;
      const communityChildren: MindMapNode[] = f.communities
        .map((c) => ({ c, h: c.files.reduce((s, p) => s + heatOf(p), 0) }))
        .sort((a, b) => b.h - a.h)
        .slice(0, 3)
        .map(({ c }, k) => {
          const kids = c.files
            .map((p) => ({ p, w: heatOf(p) }))
            .sort((a, b) => b.w - a.w)
            .slice(0, 4)
            .map(({ p }) => fileNode(p))
            .filter((n): n is MindMapNode => !!n);
          const zhName = communityZh[c.name];
          const cNode: MindMapNode & { kind: 'community' } = {
            id: `f${i}:c${k}`,
            label: zhName ?? c.name,
            description: `${c.files.length} 个文件${c.est_lines ? `，约 ${c.est_lines} 行` : ''}的子模块${zhName ? `（原名 ${c.name}）` : ''}`,
            kind: 'community' as const,
            children: kids,
            meta: { files: c.files.length, lines: c.est_lines, symbols: c.symbol_count },
          };
          // 社区描述材料：成员文件及其职责（讲清"这组文件合力做什么"，而非通用模板）
          const memberHint = c.files
            .slice(0, 5)
            .map((p) => {
              const r = lookupFile(fileIndex, p)?.responsibility ?? '';
              return `${basename(p)}${r ? `（${r.slice(0, 30)}）` : ''}`;
            })
            .join('、');
          descTargets.push({
            node: cNode,
            key: `c:${c.name}`,
            kind: 'community',
            owner: f.name,
            hint: `共 ${c.files.length} 个文件，成员：${memberHint}`,
          });
          return cNode;
        })
        .filter((c) => (c.children?.length ?? 0) > 0);
      // involves 管线兜底：归一化裸文件名 + 空步回填（详见 polishStepInvolves）
      if (script) polishStepInvolves(script, rels);
      const steps: TeachStep[] = script?.steps ?? [
        {
          title: hasEdges ? 'AI 分镜暂不可用' : '材料不足，暂无法讲解',
          detail: hasEdges
            ? '本次 AI 讲解生成失败（可稍后重试），以下是该功能的静态概览。'
            : '该功能缺少源码调用记录（早期导入的数据），无法生成原理讲解；重新导入项目后可获得完整分析。',
          involves: rels.slice(0, 3),
        },
      ];
      // 产线视图：默认所有功能直接走工厂流水线（工序盒+针脚+涉及文件入住为子卡片）。
      // 工厂流水线就是分镜的标准呈现，无需逐一拍板；仅主人显式点过「✗ 否」才回落普通步骤。
      const isLine = !(prevPipelineLike && prevPipelineLike[f.name] === false);
      // 产线内涉及文件的去重集合：一个文件只入住首个引用它的工序盒
      const usedInLine = new Set<string>();
      // 二期：按数据形态名推导跨步骤真实出边/入边 + 管线缺口（契约投影针脚，非 LLM 编造）
      const flow = deriveStepFlow(steps, steps.map((_, j) => `f${i}:${j}`));
      // 二期·L4：逐文件契约投影针脚（每个涉及文件单独投影「吃什么/吐什么」，供文件视图渲染+连线）
      const filePinsByStep = steps.map((s) =>
        (s.involves ?? []).map((p) => {
          const fs = projectFileDataShape(p, fileIndex);
          return { path: p, inputs: fs?.inputs, outputs: fs?.outputs };
        }),
      );
      // 二期·L4：文件级数据流边（功能内全部文件跨步骤去重收集 → 唯一产出者连线，供 L4 高亮）
      const allFiles: Array<{ id: string; inputs?: TeachPin[]; outputs?: TeachPin[] }> = [];
      const seenFile = new Set<string>();
      filePinsByStep.forEach((fps) => fps.forEach((fp) => {
        if (seenFile.has(fp.path)) return;
        seenFile.add(fp.path);
        allFiles.push({ id: fp.path, inputs: fp.inputs, outputs: fp.outputs });
      }));
      const fileEdges = deriveFileFlow(allFiles);
      const stepGroup: MindMapNode = {
        id: `f${i}:sg`,
        label: '工作步骤',
        description: `${steps.length} 步讲清这个功能怎么跑起来`,
        kind: 'stepgroup',
        // pending 标记：分镜是"AI 分镜暂不可用/材料不足"占位（script 为空）时挂上，前端据此显示待生成态、不伪装成品
        meta: {
          pending: !script,
          // 跨步骤数据流边 + 管线缺口（二期：前端据此画真连线、标漏步）
          ...(flow.edges.length ? { flowEdges: flow.edges } : {}),
          ...(flow.gaps.length ? { gaps: flow.gaps } : {}),
          // 文件级数据流边（二期·L4：前端各文件视图按可见性过滤展示 → 点击文件高亮上下游）
          ...(fileEdges.length ? { fileEdges } : {}),
        },
        children: steps.map((s, j) => {
          // 契约投影·数据形态（仅产线步骤才需要，但统一投影成本低且无害）：
          // 从涉及文件的 actual_apis 签名推导 inputs/outputs（非 LLM 编造）。
          const shape = projectStepDataShape(s.involves, fileIndex);
          const stepNode: MindMapNode = {
            id: `f${i}:${j}`,
            label: s.title,
            description: s.detail,
            kind: 'step',
            meta: {
              involves: s.involves,
              inputs: shape?.inputs,
              outputs: shape?.outputs,
              // 逐文件针脚（L4 文件视图：每张文件卡渲染自己的入/出针脚）
              filePins: filePinsByStep[j],
              // 叙事分镜（manim 式：进料口→工序→出料口）：针脚即契约投影的代码事实，
              // 前端点开工序盒折叠面板即可看这步"吃了什么/做什么/吐出什么"
              narration: buildScenes(shape ?? undefined, s.title, s.detail),
            },
          };
          // 已确认产线的功能：把 steps 升级为骨架（工序盒）——涉及文件入住为工序的子卡片。
          // 共享文件不重复入住（一个文件只住进首个引用它的工序盒，其余工序仅画连线）。
          if (isLine && s.involves?.length) {
            const kids: MindMapNode[] = [];
            for (const p of s.involves) {
              if (usedInLine.has(p)) continue;
              usedInLine.add(p);
              const info = lookupFile(fileIndex, p);
              const fp = filePinsByStep[j].find((x) => x.path === p);
              kids.push({
                id: `f${i}:sg:${j}:${kids.length}`,
                label: basename(p),
                description: info?.responsibility ?? '涉及文件',
                kind: 'file',
                meta: { l2_ref: p, inputs: fp?.inputs, outputs: fp?.outputs },
              });
            }
            if (kids.length) stepNode.children = kids;
          }
          return stepNode;
        }),
      };
      return {
        id: `f${i}`,
        label: f.name,
        kind: 'feature' as const,
        description: script?.what ?? `由 ${f.communities.length} 个子模块协作完成的业务功能`,
        steps,
        children: [stepGroup, ...communityChildren],
        // storyboard 权威标记：LLM 分镜是唯一最终产物——有有效分镜(done) vs 占位(pending)。前端据此判定是否已完成科普
        meta: { files: rels.length, storyboard: script ? 'done' : 'pending' },
      };
    }),
  };

  // ── 能力支柱顶层（teach 视图）──
  // 与 structure 一致：把根下平铺的功能用 MCP 工具上下文归并成 2-6 个"这项目能干嘛"的支柱，
  // 每个支柱挂回原功能子树（feature 节点 id 不改，批注/用户节点锚点不漂移）。
  let capGroups: Array<{ name: string; explanation: string; features: string[] }> | null = null;
  // 能力合成与分镜描述解耦：只要配置了 LLM 即合成（功能名都够），
  // 不依赖 useLlm/gen_descriptions——避免 overview 默认不传 gen_descriptions 时"能干嘛"层静默缺失。
  if (loadAgentConfig()) {
    const toolCtx = extractToolContext(dsl);
    capGroups = toolCtx ? await llmSynthesizeCapabilities(ft.features, toolCtx, title) : null;
  }
  if (capGroups && capGroups.length > 0) {
    // root.children 已按 order 排好序；按 ft.features[order[i]].name → root.children[i] 建映射
    const nameToNode = new Map<string, MindMapNode>();
    order.forEach((i, idx) => {
      const node = root.children?.[idx];
      if (node) nameToNode.set(ft.features[i].name, node);
    });
    const usedNode = new Set<MindMapNode>();
    const capKids: MindMapNode[] = [];
    for (const g of capGroups) {
      const kids: MindMapNode[] = [];
      for (const ref of g.features ?? []) {
        const nn = nameToNode.get(ref);
        if (nn && !usedNode.has(nn)) { usedNode.add(nn); kids.push(nn); }
      }
      if (kids.length === 0) continue;
      capKids.push({
        id: `cap_teach_${capKids.length}`,
        label: g.name,
        description: g.explanation,
        kind: 'capability' as const,
        meta: { files: kids.reduce((s, n) => s + ((n.meta?.files as number) || 0), 0) },
        children: kids,
      } as MindMapNode);
    }
    const leftover = (root.children ?? []).filter((n) => !usedNode.has(n));
    if (leftover.length > 0) {
      capKids.push({
        id: 'cap_teach_other',
        label: '其他',
        description: '未归入上述能力支柱的功能',
        kind: 'capability' as const,
        meta: { files: leftover.reduce((s, n) => s + ((n.meta?.files as number) || 0), 0) },
        children: leftover,
      } as MindMapNode);
    }
    if (capKids.length > 0) root.children = capKids;
  }

  // ── 积木区（拼装区黑盒资产的一等公民呈现）──
  appendBrickZone(root, dsl);

  // 社区/文件专属描述：缓存未命中的批量 LLM 生成，命中的直接复用——
  // 通用模板（"X 个文件约 Y 行"/导入期批量职责）只作兜底，LLM 描述按各自材料定制
  const needDesc = descTargets.filter((t) => !descCache[t.key]);
  if (needDesc.length > 0) {
    const got = await llmEnrichDescriptions(
      needDesc.map((t) => ({ id: t.key, label: t.node.label, kind: t.kind, hint: t.hint, owner: t.owner })),
      title,
    );
    if (got) for (const [k, v] of got) descCache[k] = v;
  }
  let descHit = 0;
  for (const t of descTargets) {
    const d = descCache[t.key];
    if (d) {
      t.node.description = d;
      descHit++;
    }
  }

  // 文件流转链：设计图层的手绘边（geometry.edges，file→file）透传给思维导图——
  // 盒内卡片按此排 1→2→3 业务顺序并画连线（顺序来自设计事实，不按字母序）
  const fileIdSet = new Set((dsl.semantic?.files ?? []).map((sf) => sf.id));
  const flows = (dsl.geometry?.edges ?? [])
    .filter((e) => fileIdSet.has(e.from) && fileIdSet.has(e.to) && e.from !== e.to)
    .map((e) => ({ from: e.from, to: e.to, label: e.label }));

  const mindMap: MindMap = {
    feature,
    mode: anyLlm ? 'llm' : 'rule',
    view: 'teach',
    root,
    deps: deps.length > 0 ? deps : undefined,
    flows: flows.length > 0 ? flows : undefined,
    foundations: foundations.length > 0 ? foundations : undefined,
    shared: shared.length > 0 ? shared : undefined,
    community_zh: Object.keys(communityZh).length > 0 ? communityZh : undefined,
    desc_cache: Object.keys(descCache).length > 0 ? descCache : undefined,
    proposals: prevProposals,
    pipeline_like: prevPipelineLike,
    pipeline_like_proposals: Object.keys(pipelineProposals).length > 0 ? pipelineProposals : undefined,
    generated_at: new Date().toISOString(),
    note: anyLlm
      ? `已用 LLM（${loadAgentConfig()?.model ?? ''}）生成科普分镜；子模块/文件专属描述 ${descHit}/${descTargets.length} 条`
      : 'LLM 分镜不可用（未配置或调用失败），已降级规则描述',
  };
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');
  return {
    feature,
    mode: mindMap.mode,
    mind_map: mindMap,
    jsonFile,
    message: `科普教学导图（teach）已生成：${jsonFile}\n说明：${mindMap.note}`,
  };
}

// ─────────────────────────────────────────────────────────────
// 新功能构想定位：主人在根节点写"我要加个 XXX" → LLM 找到适合的位置画上去
// 人出意图、LLM 出结构——主人不需要理解现有树该在哪挂分支
// ─────────────────────────────────────────────────────────────

export interface PlaceProposalsResult {
  proposals: ProposalFeature[];
  mode: 'llm' | 'rule';
  message: string;
}

/** 根级 user_nodes 即"新功能构想"（页面约定：挂 root = 新功能，挂功能/步骤 = 补充理解） */
export async function placeProposals(feature: string): Promise<PlaceProposalsResult> {
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  const ideas = (dsl.user_nodes ?? []).filter((u) => u.parent_id === 'root' && (u.text ?? '').trim());
  const teachFile = getMindMapFile(feature, 'teach');
  let mindMap: MindMap;
  if (fs.existsSync(teachFile)) {
    mindMap = JSON.parse(fs.readFileSync(teachFile, 'utf-8')) as MindMap;
  } else {
    mindMap = (await buildTeachMindMap(dsl, feature, dsl.title || feature, false)).mind_map;
  }

  if (ideas.length === 0) {
    if (mindMap.proposals?.length) {
      delete mindMap.proposals;
      fs.writeFileSync(teachFile, JSON.stringify(mindMap, null, 2), 'utf-8');
    }
    return { proposals: [], mode: 'rule', message: '没有待定位的新功能构想（根级节点为空）' };
  }

  // 现有功能清单 = 树里的真实功能（JSON root.children 不含前端合成的 shared 分支）
  const featNames = (mindMap.root.children ?? []).map((c) => c.label);
  const featDescs = (mindMap.root.children ?? []).map((c) => `${c.label}：${(c.description || '').slice(0, 60)}`).join('\n');

  const cfg = loadAgentConfig();
  let proposals: ProposalFeature[] = [];
  let mode: 'llm' | 'rule' = 'rule';
  if (cfg) {
    const list = ideas.map((u) => `- ${u.id}：「${u.text.slice(0, 120)}」`).join('\n');
    try {
      const res = await fetch(`${cfg.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            {
              role: 'system',
              content:
                '你是软件架构师。主人要在项目里加新功能，他只写一句构想，你来定位：\n' +
                '1. 起个功能名（≤8字，动宾或名词）；\n' +
                '2. 一句人话介绍（15~40字，解决什么问题）；\n' +
                '3. parent：它属于哪个现有功能（是其子能力）？独立新功能则填 ""；\n' +
                '4. steps：2-3 步实现分镜（每步 title ≤12字 + detail 一两句）；\n' +
                '5. depends_on：预判它要踩哪些现有功能（数组，可空）。\n' +
                '基于给定现有功能事实判断，不要编造不存在的功能名。只输出 JSON：\n' +
                '{"proposals":{"<id>":{"title":"","desc":"","parent":"","steps":[{"title":"","detail":""}],"depends_on":[""]}}}',
            },
            { role: 'user', content: `项目：${dsl.title || feature}\n\n现有功能：\n${featDescs}\n\n主人的新功能构想：\n${list}` },
          ],
          temperature: 0.4,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const parsed = extractJsonObject(data.choices?.[0]?.message?.content ?? '');
        const raw = parsed?.proposals as Record<string, Record<string, unknown>> | undefined;
        if (raw && typeof raw === 'object') {
          for (const u of ideas) {
            const r = raw[u.id];
            if (!r || typeof r !== 'object') continue;
            const parent = typeof r.parent === 'string' && featNames.includes(r.parent) ? r.parent : undefined;
            const dependsOn = Array.isArray(r.depends_on)
              ? r.depends_on.filter((d): d is string => typeof d === 'string' && featNames.includes(d))
              : [];
            const steps = Array.isArray(r.steps)
              ? r.steps
                  .filter((s): s is { title: string; detail: string } => !!s && typeof (s as { title?: unknown }).title === 'string')
                  .slice(0, 3)
                  .map((s) => ({ title: String(s.title).slice(0, 16), detail: String(s.detail ?? '').slice(0, 160) }))
              : [];
            proposals.push({
              id: u.id,
              raw: u.text,
              title: typeof r.title === 'string' && r.title.trim() ? r.title.trim().slice(0, 12) : u.text.slice(0, 10),
              desc: typeof r.desc === 'string' ? r.desc.trim().slice(0, 80) : u.text,
              parent,
              steps: steps.length > 0 ? steps : undefined,
              depends_on: dependsOn.length > 0 ? dependsOn : undefined,
              mode: 'llm',
            });
          }
        }
      }
    } catch {
      /* LLM 失败走 rule 降级 */
    }
  }
  // 降级 / 兜底：没配 LLM 或调用失败——构想直挂根，原文即介绍（不丢主人输入）
  if (proposals.length === 0) {
    proposals = ideas.map((u) => ({
      id: u.id,
      raw: u.text,
      title: u.text.slice(0, 10),
      desc: u.text,
      mode: 'rule' as const,
    }));
  } else {
    mode = 'llm';
  }

  mindMap.proposals = proposals;
  fs.writeFileSync(teachFile, JSON.stringify(mindMap, null, 2), 'utf-8');
  return {
    proposals,
    mode,
    message:
      mode === 'llm'
        ? `AI 已定位 ${proposals.length} 个构想（挂靠关系见 parent 字段）`
        : `已按原始构想直挂根节点（${proposals.length} 个）——LLM 不可用，未做智能定位`,
  };
}

/** 构建思维导图（规则骨架 + 可选 LLM 描述） */
export async function deriveMindMap(input: DeriveMindMapInput): Promise<DeriveMindMapResult> {
  const { feature, gen_descriptions = false, max_files_per_community = 20 } = input;
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在，请先 render_dsl 或 import_project 创建`);

  const title = dsl.title || feature;

  // teach 模式独立分支：科普教学导图（功能 + 实现原理分镜）
  // 分镜是小白真正看的"表达产物"——只要配了 LLM 就默认生成（与 structure 一致），
  // 不依赖调用方传 gen_descriptions，避免默认路径生成"空分镜"并长期缓存。
  if ((input.view ?? 'structure') === 'teach') {
    return buildTeachMindMap(dsl, feature, title, gen_descriptions || !!loadAgentConfig());
  }
  const fileIndex = buildFileIndex(dsl);
  const ft: FeatureTree | undefined = dsl.feature_tree;

  // 记录已尝试 LLM 提炼的节点，供批量生成描述（增量局部更新时可收窄）
  let llmTargets: Array<{ id: string; label: string; kind: 'feature' | 'community' | 'file'; hint: string }> = [];
  /** 改名/迁移遗留空壳：无导出 API 且个位数行（如 l3.go 仅剩 3 行注释占位）——
   *  导图不收，避免以"独立卡片"误导（其业务本体已改名迁走、在链上） */
  const isHuskFile = (f: { lines?: number; actual_apis?: unknown[]; expected_apis?: unknown[] }): boolean =>
    (f.lines ?? 999) < 10 && !f.actual_apis?.length && !f.expected_apis?.length;

  // AI 设计标注索引（node_id → 标注文本）：DSL 里挂的借鉴/决策标注，
  // 作为文件描述的"增量"段拼进导图——每个模块不只说"是什么"，还说"要变什么"
  const aiNotesByNode = new Map<string, string>();
  for (const a of dsl.annotations ?? []) {
    if (!a.node_id || a.resolved) continue;
    if (aiNotesByNode.has(a.node_id)) continue; // 每节点取第一条，避免描述爆炸
    aiNotesByNode.set(a.node_id, a.text);
  }

  /** 规则合成文件描述：API 摘要（干瘪统计 → 具体函数名）+ AI 增量段（→ 借鉴：…） */
  const fileDesc = (f: { id: string; path?: string; responsibility?: string; actual_apis?: Array<{ signature: string }>; expected_apis?: Array<{ signature: string }> }): string => {
    const sigs = (f.actual_apis ?? f.expected_apis ?? []).map((a) => String(a.signature).split('(')[0].trim()).filter(Boolean);
    const names = [...new Set(sigs)].slice(0, 3);
    const base = names.length > 0
      ? `API：${names.join(' · ')}${sigs.length > 3 ? ` …（共 ${sigs.length} 个）` : ''}`
      : (f.responsibility || '');
    const note = aiNotesByNode.get(f.id);
    if (!note) return base;
    // 增量段截断到 ~56 字，保住两行内可读
    const short = note.length > 56 ? note.slice(0, 56) + '…' : note;
    return `${base}\n→ ${short}`;
  };
  let mode: 'llm' | 'rule' = 'rule';
  let note: string | undefined;
  let root: MindMapNode;

  if (ft && ft.features.length > 0) {
    // ── 有功能树：先建"功能 → 社区 → 文件"子树，能力合成可行时再在顶上套能力支柱 ──
    root = { id: 'root', label: title, description: `项目总览：${ft.features.length} 个功能`, kind: 'root', children: [] };
    const featureSubtrees: MindMapNode[] = [];
    for (const f of ft.features) {
      const communityIds = new Set<string>();
      let fFileCount = 0;
      for (const c of f.communities) {
        for (const rel of c.files) {
          if (!communityIds.has(rel)) { communityIds.add(rel); fFileCount++; }
        }
      }
      const fNode: MindMapNode = {
        id: f.id || `feature_${root.children!.length}`,
        label: f.name,
        description: ruleFeatureDesc(f, fFileCount),
        kind: 'feature',
        meta: { files: fFileCount },
        children: [],
      };
      llmTargets.push({ id: fNode.id, label: f.name, kind: 'feature', hint: ruleFeatureDesc(f, fFileCount) });
      const semById = new Map((dsl.semantic?.files ?? []).map((sf) => [sf.id, sf]));
      for (const c of f.communities) {
        const fileNodes: MindMapNode[] = [];
        const files = c.files.slice(0, max_files_per_community);
        for (const rel of files) {
          const info = lookupFile(fileIndex, rel);
          if (!info) continue;
          const fNode: MindMapNode = {
            id: info.id,
            label: basename(rel),
            description: fileDesc(semById.get(info.id) ?? { id: info.id, responsibility: info.responsibility }),
            kind: 'file',
            meta: { lines: info.lines, l2_ref: info.id },
          };
          fileNodes.push(fNode);
          // 文件节点也进 LLM 目标，使 feature_tree 分支的增量局部更新（dirty_paths 复用人话描述）同样生效
          llmTargets.push({ id: fNode.id, label: fNode.label, kind: 'file', hint: fNode.description });
        }
        // 超出上限时折叠成"…更多文件"占位
        if (c.files.length > max_files_per_community) {
          fileNodes.push({
            id: `more_${c.id}`,
            label: `… 还有 ${c.files.length - max_files_per_community} 个文件`,
            description: '为保持导图可读，其余文件已折叠',
            kind: 'note',
          });
        }
        const cNode: MindMapNode = {
          id: `community_${c.id}`,
          label: c.name,
          description: ruleCommunityDesc(c),
          kind: 'community',
          meta: { files: c.files.length, lines: c.est_lines, symbols: c.symbol_count },
          children: fileNodes,
        };
        llmTargets.push({ id: cNode.id, label: c.name, kind: 'community', hint: ruleCommunityDesc(c) });
        fNode.children!.push(cNode);
      }
      featureSubtrees.push(fNode);
    }

    // 能力支柱合成：把细功能归并成"这个项目能干嘛"的业务能力。
    // 只要配置了 LLM 即启用（单次调用、便宜），不依赖 gen_descriptions——
    let capGroups: Array<{ name: string; explanation: string; features: string[] }> | null = null;
    if (loadAgentConfig()) {
      const toolCtx = extractToolContext(dsl);
      capGroups = toolCtx ? await llmSynthesizeCapabilities(ft.features, toolCtx, title) : null;
    }
    if (capGroups && capGroups.length > 0) {
      // 功能名/id → 子树节点 映射（能力支柱把它下面的功能子树整棵搬进去）
      const nameToNode = new Map<string, MindMapNode>();
      ft.features.forEach((f, i) => {
        const n = featureSubtrees[i];
        if (!n) return;
        nameToNode.set(f.name, n);
        if (f.id) nameToNode.set(f.id, n);
      });
      const usedNode = new Set<string>();
      root.children = capGroups.map((g, i) => {
        const kids: MindMapNode[] = [];
        for (const ref of (g.features ?? [])) {
          const nn = nameToNode.get(ref);
          if (nn && !usedNode.has(nn.id)) { usedNode.add(nn.id); kids.push(nn); }
        }
        return {
          id: `cap_${i}`,
          label: g.name,
          description: g.explanation,
          kind: 'capability',
          meta: { files: kids.reduce((s, n) => s + ((n.meta?.files as number) || 0), 0) },
          children: kids,
        } as MindMapNode;
      });
      // 未被任何支柱收纳的功能 → 兜底挂"其他"
      const leftover = featureSubtrees.filter((n) => !usedNode.has(n.id));
      if (leftover.length > 0) {
        root.children!.push({
          id: 'cap_other',
          label: '其他',
          description: '未归入上述能力支柱的功能',
          kind: 'capability',
          meta: { files: leftover.reduce((s, n) => s + ((n.meta?.files as number) || 0), 0) },
          children: leftover,
        } as MindMapNode);
      }
      mode = 'llm';
    } else {
      root.children = featureSubtrees;
    }
  } else {
    // ── 无功能树兜底（两级）──
    // 1) 设计视图有语义分组（geometry.module 节点 + 文件 swimlane）：root → 分组 → 文件
    //    （fork 后在设计层提炼的分组容器是"人工功能树"，优先于平铺）
    // 2) 否则：root → 文件（按语义层平铺）
    const gnodes = dsl.geometry?.nodes ?? [];
    const modules = gnodes
      .filter((n) => n.type === 'module' && typeof n.id === 'string')
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    const laneOf = new Map<string, string>();
    for (const n of gnodes) {
      if (n.type === 'file' && typeof n.swimlane === 'string') laneOf.set(n.id, n.swimlane);
    }

    // 积木条目（brick_*）不进分组/平铺：折叠资产统一进根下积木区（appendBrickZone）
    const semanticFiles = (dsl.semantic?.files ?? []).filter((f) => f.path && !isHuskFile(f) && !f.id.startsWith('brick_'));
    const grouped = new Map<string, typeof semanticFiles>(modules.map((m) => [m.id as string, []]));
    const ungrouped: typeof semanticFiles = [];
    for (const f of semanticFiles) {
      const lane = laneOf.get(f.id);
      if (lane && grouped.has(lane)) grouped.get(lane)!.push(f);
      else ungrouped.push(f);
    }
    const anyGrouped = [...grouped.values()].some((arr) => arr.length > 0);

    if (modules.length > 0 && anyGrouped) {
      root = {
        id: 'root',
        label: title,
        description: `项目总览：${modules.filter((m) => (grouped.get(m.id as string) ?? []).length > 0).length} 个功能分组（设计视图语义分组）`,
        kind: 'root',
        children: [],
      };
      const buildFileNodes = (files: typeof semanticFiles, groupId: string): MindMapNode[] => {
        const out: MindMapNode[] = files.slice(0, max_files_per_community).map((f) => {
          const desc = fileDesc(f);
          const n: MindMapNode = {
            id: f.id,
            label: basename(f.path as string),
            description: desc,
            kind: 'file',
            meta: { lines: f.lines, l2_ref: f.id },
          };
          llmTargets.push({ id: n.id, label: n.label, kind: 'file', hint: desc });
          return n;
        });
        if (files.length > max_files_per_community) {
          out.push({
            id: `more_${groupId}`,
            label: `… 还有 ${files.length - max_files_per_community} 个文件`,
            description: '为保持导图可读，其余文件已折叠',
            kind: 'note',
          });
        }
        return out;
      };
      for (const m of modules) {
        const files = grouped.get(m.id as string) ?? [];
        if (files.length === 0) continue;
        const mNode: MindMapNode = {
          id: m.id as string,
          label: m.label || (m.id as string),
          description: m.description || `${files.length} 个文件`,
          kind: 'feature',
          meta: { files: files.length },
          children: buildFileNodes(files, m.id as string),
        };
        llmTargets.push({ id: mNode.id, label: mNode.label, kind: 'feature', hint: mNode.description ?? '' });
        root.children!.push(mNode);
      }
      if (ungrouped.length > 0) {
        root.children!.push({
          id: 'grp_ungrouped',
          label: '未分组',
          description: '设计视图中未归入任何分组容器的文件',
          kind: 'feature',
          meta: { files: ungrouped.length },
          children: buildFileNodes(ungrouped, 'ungrouped'),
        });
      }
    } else {
      root = { id: 'root', label: title, description: '项目总览（未生成功能树，按文件平铺）', kind: 'root', children: [] };
      for (const f of semanticFiles) {
        const desc = fileDesc(f);
        root.children!.push({
          id: f.id,
          label: basename(f.path as string),
          description: desc,
          kind: 'file',
          meta: { lines: f.lines, l2_ref: f.id },
        });
        llmTargets.push({ id: f.id, label: basename(f.path as string), kind: 'file', hint: desc });
      }
    }
  }

  // ── 积木区（拼装区黑盒资产的一等公民呈现，与 teach 路径同一份逻辑）──
  appendBrickZone(root, dsl);

  // 汇总文件数（root/feature 层）
  const fillCounts = (n: MindMapNode): void => {
    if (n.children) {
      for (const c of n.children) fillCounts(c);
      if (n.kind === 'root' || n.kind === 'feature') {
        n.meta = { ...(n.meta ?? {}), files: countFiles(n) };
      }
    }
  };
  fillCounts(root);

  // 悬停气泡的纯文本 meta（不含 HTML）
  const bubbleMetaOf = (n: MindMapNode, files: number): string => {
    const parts: string[] = [];
    if (n.kind === 'root' || n.kind === 'feature') parts.push(`${files} 个文件`);
    if (n.kind === 'community') {
      if (n.meta?.files) parts.push(`${n.meta.files} 个文件`);
      if (n.meta?.lines) parts.push(`约 ${n.meta.lines} 行`);
      if (n.meta?.symbols) parts.push(`${n.meta.symbols} 个符号`);
    }
    if (n.kind === 'file' || n.kind === 'brick') {
      if (n.meta?.lines) parts.push(`${n.meta.lines} 行`);
    }
    if (n.kind === 'brick' && n.meta?.symbols) parts.push(`${n.meta.symbols} 项契约`);
    return parts.join(' · ');
  };

  // LLM 提炼描述（可选）

  // 局部触发式更新：只对 dirty_paths 涉及的文件重提炼；其余文件复用上次导图的人话描述、踢出 LLM 目标
  const dirty = new Set(input.incremental?.dirty_paths ?? []);
  if (dirty.size > 0) {
    const pathById = new Map((dsl.semantic?.files ?? []).map((sf) => [sf.id, sf.path] as const));
    const isDirty = (n: MindMapNode): boolean => {
      const p = pathById.get(n.id);
      return p !== undefined && (dirty.has(p) || dirty.has(basename(p)));
    };
    let old: MindMap | null = null;
    try {
      const file = getMindMapFile(feature, 'structure');
      if (fs.existsSync(file)) old = JSON.parse(fs.readFileSync(file, 'utf-8')) as MindMap;
    } catch {
      old = null; // 旧导图损坏/缺失 → 全部重算
    }
    if (old?.root) {
      const oldDesc = new Map<string, string>();
      const walk = (n: MindMapNode): void => {
        if (n.kind === 'file' && n.description) oldDesc.set(n.id, n.description);
        if (n.children) for (const c of n.children) walk(c);
      };
      walk(old.root);
      const targetIds = new Set(llmTargets.map((t) => t.id));
      const reuse = (n: MindMapNode): void => {
        if (n.kind === 'file' && !isDirty(n)) {
          const d = oldDesc.get(n.id);
          if (d && targetIds.has(n.id)) {
            n.description = d; // 复用已提炼人话，不重算
            targetIds.delete(n.id);
          }
        }
        if (n.children) for (const c of n.children) reuse(c);
      };
      reuse(root);
      if (targetIds.size !== llmTargets.length) llmTargets = llmTargets.filter((t) => targetIds.has(t.id));
    }
  }

  if (gen_descriptions && llmTargets.length > 0) {
    const enriched = await llmEnrichDescriptions(llmTargets, title);
    if (enriched) {
      mode = 'llm';
      const apply = (n: MindMapNode): void => {
        const d = enriched!.get(n.id);
        if (d) {
          // LLM 只负责"是什么"的人话；描述里"→ 增量段"（DSL 标注投影）必须保留，否则借鉴标注被覆盖丢失
          const delta = (n.description ?? '')
            .split('\n')
            .filter((s) => s.trim().startsWith('→'))
            .join('\n');
          n.description = delta ? `${d}\n${delta}` : d;
        }
        if (n.children) for (const c of n.children) apply(c);
      };
      apply(root);
      note = `已用 LLM（${loadAgentConfig()?.model ?? ''}）提炼功能/子模块描述`;
    } else {
      note = 'LLM 提炼不可用（未配置或调用失败），已用规则描述';
    }
  }

  const mindMap: MindMap = {
    feature,
    mode,
    view: 'structure',
    root,
    generated_at: new Date().toISOString(),
    note,
  };

  // 落盘 JSON
  const jsonFile = getMindMapFile(feature);
  fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
  fs.writeFileSync(jsonFile, JSON.stringify(mindMap, null, 2), 'utf-8');

  const message = [
    `L3 结构骨架已生成（${mode === 'llm' ? 'LLM 提炼' : '规则骨架'}）：${jsonFile}`,
    `（本路径只产中间骨架数据，最终交互导图统一由 /mindmap/${feature} 提供，不再产出独立 HTML）`,
    note ? `说明：${note}` : '',
  ].filter(Boolean).join('\n');

  return { feature, mode, mind_map: mindMap, jsonFile, message };
}

