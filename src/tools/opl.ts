/**
 * OPL —— Optimization Pipeline Loop（待改进 自驱闭环流水线）
 *
 * 把"人加待改进 → 下探真实文件 → 加设计 DSL → 改真实文件 → 真 DSL 比较 → 反上来接入导图"
 * 串成一段【自动化产线】：主人只提一条愿望（add），产线自驱推进到收敛——
 *   - 智能判定：LLM 负责任务级判断与写实现（下探真实文件出契约、按契约写真实代码），
 *     未配 LLM 或失败时降级规则（仍可自动推进，claim 以代码事实为准）。
 *   - 结构判定零 LLM：真 DSL 比较（accepted/drift/missing）解析真实源码签名，不靠 LLM 编造。
 *   - 缓存：真实文件签名按内容 hash 缓存，跨 run / 跨 OP 复用；局部触发式——只重算变更文件。
 *   - 局部更新：integrate 只 upsert 受影响 semantic.files / 导图节点，不整树全量重写语义。
 *
 * 每个原子阶段仍可单独触发（serve 感知 / 可回滚），但默认由 op=auto 一键闭环推进。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getDSL, saveDSL, getStorageRoot } from '../storage.js';
import { placeProposals, deriveMindMap } from './derive_mind_map.js';
import { callChat, loadLlmConfig } from './llm_focus.js';

export type OplStatus = 'idea' | 'located' | 'declared' | 'implementing' | 'checked' | 'integrated' | 'failed';
export type OplLiveState = 'accepted' | 'drift' | 'missing';

/** 一条设计声明契约：文件应暴露的公开 API */
export interface OplApi {
  name: string;
  /** 期望签名（含参数区与返回，空白不敏感），如 `export function scanDir(root string, exts []string)` */
  signature: string;
}

/** 设计声明：一个预期落地文件 + 契约 */
export interface OplDeclFile {
  /** impl 沙箱内的相对路径（同时是后续并入设计 DSL 的 path） */
  path: string;
  lang: 'ts' | 'go' | 'py' | 'js';
  apis: OplApi[];
}

/** 真 DSL 比较：单个声明文件的实现状态 */
export interface OplLiveFile {
  path: string;
  state: OplLiveState;
  note: string;
}

/** 一条待改进的状态 */
export interface OplState {
  id: string;
  idea: string;
  title: string;
  parentFeat?: string;
  status: OplStatus;
  mode: 'llm' | 'rule';
  decl: OplDeclFile[];
  live: OplLiveFile[];
  integrated: boolean;
  /** 自驱产线的一次执行痕迹（人观察每一步做了什么） */
  oplog?: string[];
  created: string;
  updated: string;
}

const oplRoot = (feature: string) => path.join(getStorageRoot(), 'opl', feature);
const implRoot = (feature: string, id: string) => path.join(oplRoot(feature), id, 'impl');
const stateFile = (feature: string, id: string) => path.join(oplRoot(feature), id, 'state.json');

function slugify(s: string): string {
  const z = s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return z.slice(0, 24) || 'idea';
}

function readState(feature: string, id: string): OplState {
  const f = stateFile(feature, id);
  if (!fs.existsSync(f)) throw new Error(`OPL 待改进 "${id}" 不存在（先调用 op=add）`);
  return JSON.parse(fs.readFileSync(f, 'utf-8')) as OplState;
}
function writeState(s: OplState, feature: string): OplState {
  s.updated = new Date().toISOString();
  const dir = path.dirname(stateFile(feature, s.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(feature, s.id), JSON.stringify(s, null, 2), 'utf-8');
  return s;
}

// ── 阶段 2 ADD：人加待改进 → 写入设计 DSL user_nodes（挂 root=新功能构想）──
export function oplAdd(feature: string, idea: string): OplState {
  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  const now = new Date().toISOString();
  const id = `op_${randomUUID().slice(0, 8)}`;
  dsl.user_nodes = dsl.user_nodes ?? [];
  dsl.user_nodes.push({ id, parent_id: 'root', text: idea.trim().slice(0, 300), created: now });
  saveDSL(dsl, 'browser');
  const s: OplState = {
    id,
    idea: idea.trim(),
    title: idea.trim().slice(0, 12),
    status: 'idea',
    mode: 'rule',
    decl: [],
    live: [],
    integrated: false,
    created: now,
    updated: now,
  };
  return writeState(s, feature);
}

// ── 阶段 3 LOCATE：定位归属（复用 placeProposals：LLM 出 title/parent/steps，rule 直挂根）──
export async function oplLocate(feature: string, id: string): Promise<OplState> {
  const s = readState(feature, id);
  try {
    const r = await placeProposals(feature);
    const p = (r.proposals ?? []).find((x) => x.id === id);
    if (p) {
      s.title = p.title;
      s.parentFeat = p.parent;
      s.mode = p.mode;
    }
  } catch (e) {
    throw new Error(`定位归属失败：${(e as Error).message}`);
  }
  s.status = 'located';
  return writeState(s, feature);
}

function langFromPath(p: string): OplDeclFile['lang'] {
  const e = path.extname(p).toLowerCase();
  return e === '.go' ? 'go' : e === '.py' ? 'py' : e === '.js' ? 'js' : 'ts';
}

// ── 阶段 4 DECLARE：加设计 DSL（落地文件 + 契约）→ 在 impl 沙箱写占位骨架 ──
export function oplDeclare(feature: string, id: string, overrides?: { files?: OplDeclFile[] }): OplState {
  const s = readState(feature, id);
  const files: OplDeclFile[] = overrides?.files?.length
    ? overrides.files
    : [{ path: `${slugify(s.title) || 'feature'}.ts`, lang: 'ts', apis: [] }];
  s.decl = files;
  // 在 impl 沙箱为每个声明文件写骨架（含契约头注释 + 空实现），供人/LLM 填充
  for (const f of files) {
    const abs = path.join(implRoot(feature, id), f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (fs.existsSync(abs)) continue;
    const heads: string[] = [`// ── OPL 待改进「${s.title}」· 设计声明契约 ──`, `// 预期暴露：`];
    for (const a of f.apis) heads.push(`//   ${a.signature}`);
    if (f.apis.length === 0) heads.push(`//   （未指定契约，仅要求文件存在）`);
    fs.writeFileSync(abs, heads.join('\n') + '\n\n', 'utf-8');
  }
  s.status = 'declared';
  return writeState(s, feature);
}

// ── 阶段 5 IMPLEMENT：现有实现（人在沙箱写真实代码；本步不代写，仅标记进入实现中）──
export function oplImplement(feature: string, id: string): OplState {
  const s = readState(feature, id);
  s.status = 'implementing';
  return writeState(s, feature);
}

// ── 真 DSL 比较：解析 impl 真实源码函数签名 → 与设计声明契约比对 ──
/** 从源码提取 {函数名: 签名}（顶层函数），多语言启发式，签名空白归一 */
function extractApis(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const norm = (x: string) => x.replace(/\s+/g, ' ').trim();
  // TS/JS：export function / async export function / export const f = () => ...
  for (const m of src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g) ?? []) {
    out.set(m[1], norm(`(${m[2]})`));
  }
  for (const m of src.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/g) ?? []) {
    out.set(m[1], norm(`(${m[2]})`));
  }
  // Go：func Name(params) ...（方法带 receiver 时取大写字名）
  for (const m of src.matchAll(/^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*\(([^)]*)\)/gm) ?? []) {
    out.set(m[1], norm(`(${m[2]})`));
  }
  // Python：def
  for (const m of src.matchAll(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm) ?? []) {
    out.set(m[1], norm(`(${m[2]})`));
  }
  return out;
}

// ── 签名缓存：按文件内容 hash，跨 OP / 跨 run 复用；命中不改则零重解析（局部触发式）──
function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
const opSignatureCacheFile = (feature: string) => path.join(oplRoot(feature), '_cache', 'signatures.json');
interface SignatureCacheEntry {
  h: string;
  apis: Record<string, string>;
}
type SignatureCache = Record<string, SignatureCacheEntry>;

/** 读取某文件的公开 API 签名：内容 hash 命中缓存则直接复用，否则重 parse 并只更新该条目写回 */
function fileApisWithCache(
  feature: string,
  relPath: string,
  abs: string,
): { apis: Map<string, string>; viaCache: boolean } {
  const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
  const h = sha1(src);
  const cacheFile = opSignatureCacheFile(feature);
  let cache: SignatureCache = {};
  if (fs.existsSync(cacheFile)) {
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as SignatureCache;
    } catch {
      cache = {};
    }
  }
  const hit = cache[relPath];
  if (hit && hit.h === h) return { apis: new Map(Object.entries(hit.apis)), viaCache: true };
  const apis = extractApis(src);
  cache[relPath] = { h, apis: Object.fromEntries(apis) };
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1), 'utf-8');
  return { apis, viaCache: false };
}

function signaturesEqual(actual: string, expected: string): boolean {
  const norm = (x: string) => x.replace(/\s+/g, '').replace(/['"]/g, '').trim();
  /** 取最外层参数区 `(a, b)`：actual 已是纯参数区；expected 可能带函数名/返回类型（`=> T`、无括号单返回）*/
  const outerParams = (p: string): string => {
    const t = p.trim();
    const open = t.indexOf('(');
    if (open < 0) return t;
    let d = 0;
    let end = -1;
    for (let i = open; i < t.length; i++) {
      if (t[i] === '(') d++;
      else if (t[i] === ')') {
        d--;
        if (d === 0) {
          end = i;
          break;
        }
      }
    }
    return end > open ? t.slice(open, end + 1) : t;
  };
  const aP = outerParams(actual);
  const eP = outerParams(expected);
  /** 参数名序列：具名 `@name`；rest `@name`；裸类型（无名）用 `?类型首标记` 占位，保证"同数量同形态" → 名字集合一致 */
  const paramNames = (p: string) => {
    const seg = p.replace(/^\((.*)\)$/, '$1').split(',');
    const out: string[] = [];
    for (const x of seg) {
      const s = x.trim();
      if (!s) continue;
      const m = s.match(/^\.\.\.?([A-Za-z_$][\w$]*)?/);
      if (m && m[1]) out.push('@' + m[1].replace(/^\.\.\./, ''));
      else {
        const tm = s.match(/[A-Za-z_$][\w$]*/);
        out.push('?' + (tm ? tm[0] : '?'));
      }
    }
    return out.join('|');
  };
  return paramNames(aP) === paramNames(eP) && norm(aP) === norm(eP);
}

export function oplCheck(feature: string, id: string): OplState {
  const s = readState(feature, id);
  if (s.decl.length === 0) throw new Error('尚未生成设计声明（先调用 op=declare）');
  const live: OplLiveFile[] = [];
  for (const f of s.decl) {
    const abs = path.join(implRoot(feature, id), f.path);
    if (!fs.existsSync(abs)) {
      live.push({ path: f.path, state: 'missing', note: '实现文件尚未创建' });
      continue;
    }
    const actual = fileApisWithCache(feature, f.path, abs).apis;
    if (f.apis.length === 0) {
      live.push({ path: f.path, state: 'accepted', note: '文件已存在（未指定契约）' });
      continue;
    }
    const missing: string[] = [];
    let drift = 0;
    for (const a of f.apis) {
      if (!actual.has(a.name)) { missing.push(a.name); continue; }
      const got = actual.get(a.name) ?? '';
      if (!signaturesEqual(got, a.signature)) drift++;
    }
    const state: OplLiveState = missing.length > 0 ? 'missing' : drift > 0 ? 'drift' : 'accepted';
    const note: string[] = [];
    if (missing.length) note.push(`缺 API: ${missing.join(', ')}`);
    if (drift) note.push(`${drift} 个 API 签名不一致`);
    if (state === 'accepted') note.push('声明 API 已实现且签名一致');
    live.push({ path: f.path, state, note: note.join('；') || '—' });
  }
  s.live = live;
  s.status = 'checked';
  return writeState(s, feature);
}

// ── 阶段 7 INTEGRATE：把 accepted 的实现并入设计 DSL semantic.files(done) + 重建导图 ──
export async function oplIntegrate(feature: string, id: string): Promise<OplState> {
  const s = readState(feature, id);
  if (s.status !== 'checked') throw new Error('尚未走真 DSL 比较（先调用 op=check）');
  const accepted = s.decl.filter((f) => (s.live.find((l) => l.path === f.path)?.state) === 'accepted');
  if (accepted.length === 0) throw new Error('没有通过比较的实现可接入（先实现声明 API）');

  const dsl = getDSL(feature);
  if (!dsl) throw new Error(`feature "${feature}" 不存在`);
  dsl.semantic = dsl.semantic ?? { files: [] };
  const ids = new Set(dsl.semantic.files.map((x) => x.id));
  for (const f of accepted) {
    const abs = path.join(implRoot(feature, id), f.path);
    const src = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    const actualApis = [...extractApis(src).entries()].map(([name, signature]) => ({ name, signature }));
    const fid = `op_${slugify(f.path)}_${id.slice(-4)}`;
    if (!ids.has(fid)) {
      dsl.semantic.files.push({
        id: fid,
        path: f.path,
        responsibility: s.title,
        expected_apis: f.apis.map((a) => ({ name: a.name, signature: a.signature })),
        actual_apis: actualApis,
        status: 'done',
        layer: 'feature',
      });
      ids.add(fid);
      // 也登记进 feature_tree（若存在），使新功能成为正式分支
      if (dsl.feature_tree) {
        dsl.feature_tree.file_map = dsl.feature_tree.file_map ?? {};
        const featId = slugify(s.title);
        const group = dsl.feature_tree.features.find((ft) => ft.name === s.parentFeat || ft.name === s.title);
        const fidx = dsl.feature_tree.features.findIndex((ft) => ft.name === s.parentFeat);
        if (fidx < 0) {
          dsl.feature_tree.features.push({ id: featId, name: s.title, communities: [] });
          dsl.feature_tree.file_map[fid] = { feature_id: featId, community_id: -1 };
        } else {
          dsl.feature_tree.file_map[fid] = { feature_id: dsl.feature_tree.features[fidx].id, community_id: -1 };
        }
        void group;
      }
    }
  }
  saveDSL(dsl, 'browser');
  // 反上来接入导图：局部触发式更新——结构从活 DSL 重建（可真），
  // 但只把本次接入的 accepted 文件标 dirty；未变更文件复用上次导图的人话描述，不整树重算
  try {
    await deriveMindMap({
      feature,
      view: 'structure',
      gen_descriptions: false,
      incremental: { dirty_paths: accepted.map((f) => f.path) },
    }).catch(() => undefined);
  } catch {
    await deriveMindMap({ feature, view: 'structure' }).catch(() => undefined);
  }
  s.integrated = true;
  s.status = 'integrated';
  return writeState(s, feature);
}

/** 列出某 feature 的待改进清单 */
export function oplList(feature: string): Array<{ id: string; title: string; idea: string; status: OplStatus; parentFeat?: string; integrated: boolean; updated: string }> {
  const dir = oplRoot(feature);
  if (!fs.existsSync(dir)) return [];
  const out: Array<{ id: string; title: string; idea: string; status: OplStatus; parentFeat?: string; integrated: boolean; updated: string }> = [];
  for (const id of fs.readdirSync(dir)) {
    const f = stateFile(feature, id);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf-8')) as OplState;
      out.push({ id: s.id, title: s.title, idea: s.idea, status: s.status, parentFeat: s.parentFeat, integrated: s.integrated, updated: s.updated });
    } catch {
      /* 忽略损坏 */
    }
  }
  return out;
}

/** 读取单个待改进详情 */
export function oplGet(feature: string, id: string): OplState {
  return readState(feature, id);
}

// ─────────────────────────────────────────────────────────────
// 自驱产线 AUTO：主人 add 一条愿望后，由 LLM/规则引擎自己判断并推进到收敛
// ─────────────────────────────────────────────────────────────

/** 剥掉 ```json 围栏与前后噪声，稳健解析 LLM 返回的 JSON */
function parseLlmJson(raw: string): unknown {
  const t = raw.replace(/^```(?:json)?/i, '').replace(/```$/m, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? t.slice(start, end + 1) : t);
}

/** LLM 下探真实文件：依据 feature DSL 的真实 API 清单 + 主人愿望，产出落地契约（文件+API 签名） */
async function llmDeclare(
  feature: string,
  s: OplState,
  cfg: ReturnType<typeof loadLlmConfig>,
): Promise<OplDeclFile[] | null> {
  if (!cfg) return null;
  const dsl = getDSL(feature);
  const files = (dsl?.semantic?.files ?? []).slice(0, 40);
  const context = files.length
    ? files
        .map((x) => `- ${x.path}：${x.responsibility ?? ''}${x.actual_apis?.length ? `  API=${x.actual_apis.map((a) => `${a.name}${a.signature ? '(' + a.signature + ')' : ''}`).join(', ')}` : ''}`)
        .join('\n')
    : '（该 feature 暂无语义文件清单）';
  const system =
    '你是"待改进自驱产线"的架构判断器。读主人的一条愿望，作为产品 owner 决定要在哪个文件落地、暴露哪些公开 API。' +
    '背景是 feature 的既有真实文件与真实 API（代码事实，勿编造不存在的能力）。' +
    '产出一个 JSON：{"files":[{"path":"相对路径","lang":"ts|go|py|js","apis":[{"name":"函数名","signature":"(参数区, 如 (dir: string, out: string) => Promise<string>)"}]}]}。' +
    '要求：尽量复用/贴近既有文件名；signature 只写参数区（含类型与返回类型）；单文件单职责。只输出 JSON。';
  const user = `主人愿望：${s.idea}\n\nfeature=${feature} 既有真实文件：\n${context}\n\n请产出落地契约 JSON。`;
  try {
    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = parseLlmJson(raw) as { files?: Array<{ path?: string; lang?: string; apis?: Array<{ name?: string; signature?: string }> }> };
    const files = (parsed.files ?? [])
      .filter((x) => x && typeof x.path === 'string' && x.path.trim())
      .map((x) => ({
        path: (x.path as string).trim(),
        lang: langFromPath((x.path as string).trim()),
        apis: (x.apis ?? [])
          .filter((a) => a && typeof a.name === 'string' && a.name.trim())
          .map((a) => ({ name: (a.name as string).trim(), signature: (a.signature ?? '').trim() })),
      }));
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/** LLM 改真实文件：依声明契约写真实实现代码（OpenAI 兼容返回 {files:{path:code}}） */
async function llmImplement(
  feature: string,
  s: OplState,
  cfg: ReturnType<typeof loadLlmConfig>,
): Promise<Record<string, string> | null> {
  if (!cfg || s.decl.length === 0) return null;
  const contract = s.decl
    .map(
      (f) =>
        `文件 ${f.path}（${f.lang}）：\n  ` +
        (f.apis.length ? f.apis.map((a) => `API ${a.name} ${a.signature}`).join('\n  ') : '（无契约，仅占位）'),
    )
    .join('\n');
  const system =
    '你是"待改进自驱产线"的资深后端工程师。按给定契约写真实可编译的实现代码，落到 JSON 的 files 字段。' +
    '返回格式：{"files":{"<相对路径>":"<代码文本>"}}。代码用反斜杠 n 转义换行；每个文件给出必要 import 与可运行骨架；' +
    '签名必须与契约一致（参数名/类型/返回）。只输出 JSON。';
  const user = `主人愿望：${s.idea}\n\n需要实现的契约：\n${contract}\n\n请产出实现代码 JSON。`;
  try {
    const raw = await callChat(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    const parsed = parseLlmJson(raw) as { files?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const f of s.decl) {
      const code = parsed?.files?.[f.path];
      if (typeof code === 'string' && code.trim()) out[f.path] = code;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

/**
 * 一键自驱闭环：主人给一条愿望即可（无 id 自动 add；有 id 从已有状态续推），一次性推进到收敛
 *  add ─►（LLM 下探→声明）─►（LLM/规则写实现）─► 真 DSL 比较 ─► 全 accepted? 接入导图 : 停在 failed 报卡点
 */
export async function oplAuto(feature: string, id?: string, idea?: string): Promise<OplState> {
  const s0 = id ? readState(feature, id) : oplAdd(feature, idea ?? '');
  return oplAutoImpl(feature, s0.id, s0);
}

async function oplAutoImpl(feature: string, id: string, s0: OplState): Promise<OplState> {
  const cfg = loadLlmConfig();
  const log: string[] = [];
  let s = s0;
  try {
    // 下探真实文件 + 加设计 DSL（无 decl 才做；有则跳过 = 局部增量）
    if (!s.decl || s.decl.length === 0) {
      const files = (await llmDeclare(feature, s, cfg)) ?? [
        { path: `${slugify(s.title) || 'feature'}.ts`, lang: 'ts', apis: [] as OplApi[] },
      ];
      s = oplDeclare(feature, id, { files });
      log.push(`下探真实文件 → 声明契约：${files.map((x) => x.path).join(', ')}（${cfg ? 'LLM' : '规则'}）`);
    }
    // 改真实文件（LLM 写；无 LLM 写不出则保留占位壳，check 会如实报 missing）
    const code = await llmImplement(feature, s, cfg);
    if (code) {
      for (const [p, c] of Object.entries(code)) {
        const abs = path.join(implRoot(feature, id), p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, c.replace(/\\n/g, '\n'), 'utf-8');
      }
      log.push(`LLM 已写真实实现：${Object.keys(code).join(', ')}`);
    } else {
      log.push('未配置 LLM 或写实现失败 → 保留占位壳（check 以代码事实为准）');
    }
    s.status = 'implementing';
    writeState(s, feature);
    // 真 DSL 比较（结构层 = 源码事实，零 LLM）
    s = oplCheck(feature, id);
    log.push(`真 DSL 比较：${s.live.map((l) => `${l.path}=${l.state}`).join('  ')}`);
    if (s.live.length > 0 && s.live.every((l) => l.state === 'accepted')) {
      s = await oplIntegrate(feature, id);
      log.push('全部 accepted → 已反上来接入导图（局部 upsert）');
    } else {
      s.status = 'failed';
      writeState(s, feature);
      log.push('存在未通过项 → 停在 failed，待主人裁决后再触发（真 DSL 比较以代码事实为准，不动摇）');
    }
  } catch (e) {
    log.push(`产线异常：${(e as Error).message}`);
  }
  s.oplog = log;
  return writeState(s, feature);
}