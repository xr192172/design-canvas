/**
 * extract_contracts —— 积木契约提取（Brick Harvest Phase 2，静态阶段）
 *
 * 按 docs/plans/2026-08-19-cross-project-brick-harvest.md Phase 2.5 schema 草案，
 * 对项目文件提取 BrickContract（挂 DSL SemanticFile.contract）：
 *
 *   ① role（主线2：业务/功能二分）——依赖方向图算法，零 token：
 *      种子识别（入口模式：cmd/、main.*、server.*、cli/、handler/）
 *      → 不动点传播（X import business ⇒ X 是装配者，business）
 *      → 其余 = functional；confidence 按 fan-in 与证据强度计
 *      （"功能不依赖业务，业务组装功能"——箭头永远指向功能层）
 *   ② shapes（主线3：结构体形状映射）——nodes 表 struct/interface/class/type 符号
 *      按行范围读源码解析字段（signature 列只有名字，字段在源码里）
 *   ③ effects——静态候选扫描（Phase 2b 第一步，origin='ast'）：
 *      reads_config：env/flag 读取点（Go: os.Getenv/flag；TS: process.env.X）
 *      writes：包级/模块级变量赋值与自增、文件写/删调用——"写外部状态"候选
 *      holds：listen/文件句柄/worker/timer/subprocess（Go 另有 goroutine/db-pool）
 *      emits：chan send（Go）/ emit·publish·postMessage（TS）
 *      候选 ≠ 事实：camera 观测窗口内命中 → 转正 origin='runtime'；候选外
 *      观测到新 target → 契约不完整告警（动静结合的动静对账）
 *
 * 提取来源纪律：结构化字段只接受 AST（此处）与 camera（后续）；LLM 不产生事实。
 * runtime 字段本阶段不填——静态判定的 confidence 自然受 schema 语义封顶 0.7（由调用方执行）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDSL, saveDSL } from '../storage.js';
import { getProjectCacheDb, type Database } from '../db/db.js';
import { buildImportGraph, type ImportGraph } from './import_graph.js';
import type {
  BrickContract,
  BrickRole,
  ShapeSchema,
  ShapeField,
  EffectTarget,
} from '../dsl/contract.js';

export interface ExtractContractsInput {
  /** 被分析项目的根目录（其下 .design-canvas/cache.db 是符号缓存） */
  project_dir: string;
  /** 提供时把 contract 写回该 feature 的 DSL（SemanticFile.contract）；不提供只返回结果 */
  feature?: string;
  /** 可选：限定提取范围的文件（相对项目根）；缺省 = 全部已索引文件 */
  files?: string[];
  /** 默认 true：feature 提供时写回 DSL；false = 只读预演（dry-run） */
  write_dsl?: boolean;
}

export interface FileContractReport {
  path: string;
  language: string;
  role: BrickRole;
  fan_in: number;
  fan_out: number;
  shape_count: number;
  reads_config: string[];
  /** effects 候选计数（origin='ast'，待 camera 观测转正）；详情在 DSL 契约 */
  effects: {
    writes: number;
    holds: number;
    emits: number;
    /** 候选样例（最多 3 条，便于人扫一眼） */
    samples: string[];
  };
}

export interface ExtractContractsResult {
  project_dir: string;
  feature?: string;
  written_to_dsl: boolean;
  files: FileContractReport[];
  stats: {
    total: number;
    business: number;
    functional: number;
    hybrid: number;
    avg_confidence: number;
    low_confidence: number; // < 0.7，LLM 兜底候选
    shapes_extracted: number;
    config_keys: number;
    /** effects 候选汇总（静态扫描，origin='ast'） */
    writes_candidates: number;
    holds_candidates: number;
    emits_candidates: number;
  };
  message: string;
}

// ── role 判定：种子模式（入口/装配层启发）──────────────────────────
const BUSINESS_SEED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)cmd\//, reason: 'cmd 入口目录' },
  { re: /(^|\/)main\.(go|ts|js|mjs)$/, reason: 'main 入口文件' },
  { re: /(^|\/)(server|app|bootstrap)\.(go|ts|js)$/, reason: '服务装配入口' },
  { re: /(^|\/)cli\//, reason: 'cli 装配目录' },
  { re: /(^|\/)handlers?\//, reason: 'handler 胶水目录' },
];

function seedReason(p: string): string | undefined {
  for (const { re, reason } of BUSINESS_SEED_PATTERNS) {
    if (re.test(p)) return reason;
  }
  return undefined;
}

/**
 * 依赖方向 role 判定（图算法，basis='graph'）：
 *   种子 = 入口模式；传播 = import business ⇒ business（装配者依赖业务侧）；
 *   不动点迭代；其余 functional（功能文件只依赖功能/外部）。
 * confidence：seed 0.9；传播 business 随跳数衰减 [0.55, 0.85]；
 *   functional 按 fan-in：≥2 → 0.85（被多方复用的典型功能特征）、1 → 0.65、0 → 0.4（孤岛证据不足）。
 *   全体静态判定（无 runtime 证据）后续由调用侧封顶 0.7，此处先给原始值。
 */
function classifyRoles(graph: ImportGraph): Map<string, { role: BrickRole; fanIn: number; fanOut: number }> {
  const { importeeOf, importerOf } = graph;
  const result = new Map<string, { role: BrickRole; fanIn: number; fanOut: number }>();

  // 种子
  const business = new Map<string, { hop: number; reason: string }>();
  for (const f of graph.files) {
    const r = seedReason(f.rel);
    if (r) business.set(f.rel, { hop: 0, reason: r });
  }
  // 不动点传播：X import 已判 business 的文件 ⇒ X 是装配者
  let changed = true;
  let round = 0;
  while (changed && round < 16) {
    changed = false;
    round++;
    for (const [src, deps] of importeeOf) {
      if (business.has(src)) continue;
      for (const d of deps) {
        const b = business.get(d.to);
        if (b) {
          business.set(src, { hop: b.hop + 1, reason: `import 业务侧 ${d.to}` });
          changed = true;
          break;
        }
      }
    }
  }

  for (const f of graph.files) {
    const fanIn = (importerOf.get(f.rel) || []).length;
    const fanOut = (importeeOf.get(f.rel) || []).length;
    const b = business.get(f.rel);
    let role: BrickRole;
    if (b) {
      const confidence = b.hop === 0 ? 0.9 : Math.max(0.55, 0.85 - 0.1 * b.hop);
      role = {
        class: 'business',
        basis: 'graph',
        confidence,
        reasons: [b.hop === 0 ? `种子：${b.reason}` : `第 ${b.hop} 跳传播：${b.reason}`],
      };
    } else {
      // functional：依赖里没有 business 成员（否则传播会覆盖到）
      const confidence = fanIn >= 2 ? 0.85 : fanIn === 1 ? 0.65 : 0.4;
      role = {
        class: 'functional',
        basis: 'graph',
        confidence,
        reasons: [
          fanIn >= 2
            ? `依赖方向纯功能向（fan-in=${fanIn}，被多方复用）`
            : fanIn === 1
              ? `依赖方向功能向（fan-in=1）`
              : `无依赖证据（fan-in=0 孤岛，置信度受限）`,
        ],
      };
    }
    result.set(f.rel, { role, fanIn, fanOut });
  }
  return result;
}

// ── shapes 提取：nodes 表符号 + 源码行范围字段解析 ──────────────────

interface SymbolRow {
  name: string;
  kind: string;
  signature: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

/** TS interface/class 字段行：name[:?] type; —— 方法行（name( 后跟括号）自然不匹配 */
const TS_FIELD_RE = /^[\s]*(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|abstract\s+|override\s+|declare\s+)*([a-zA-Z_$][\w$]*)\s*(\?)?\s*:\s*([^;=]+)[;=]?/;
/** Go struct 字段行：Name Type //comment */
const GO_FIELD_RE = /^[\t ]*([A-Z]\w*)\s+([\w\[\]\*\.\{\}"' ]+?)[\t ]*(?:\/\/.*)?$/;
/** Go interface 方法行：Name(args) rets */
const GO_METHOD_RE = /^[\t ]*(\w+)\s*\(([^)]*)\)\s*(.*)$/;

function parseShapeFields(lines: string[], language: string, kind: string): ShapeField[] {
  const fields: ShapeField[] = [];
  const isGo = language === 'go';
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/*')) continue;
    if (isGo) {
      if (kind === 'interface') {
        const m = GO_METHOD_RE.exec(line);
        if (m && m[1] !== 'type') {
          fields.push({ name: m[1], type: `(${m[2]}) ${m[3].trim()}`.trim() });
        }
        continue;
      }
      // struct：跳过声明行与花括号
      if (/^\s*(type\s|}\s*$|\w+\s+\w+\s*$)/.test(line) && !GO_FIELD_RE.test(line)) continue;
      const m = GO_FIELD_RE.exec(line);
      if (m && !/^(type|struct|interface|package|import|func)$/.test(m[1])) {
        fields.push({ name: m[1], type: m[2].trim(), required: true });
      }
    } else {
      const m = TS_FIELD_RE.exec(line);
      if (m && m[1] !== 'constructor') {
        const type = m[3].replace(/\/\/.*$/, '').trim();
        if (type) fields.push({ name: m[1], type, required: !m[2] });
      }
    }
  }
  return fields.slice(0, 40); // 防御：超大形状截断
}

function extractShapes(db: Database, root: string, langOf: Map<string, string>): Map<string, ShapeSchema[]> {
  const rows = db
    .prepare(
      "SELECT name, kind, signature, file_path, start_line, end_line FROM nodes " +
        "WHERE kind IN ('struct','interface','class','type') AND file_path != ''",
    )
    .all() as unknown as SymbolRow[];
  const byFile = new Map<string, ShapeSchema[]>();
  const srcCache = new Map<string, string[]>();

  for (const r of rows) {
    let lines = srcCache.get(r.file_path);
    if (lines === undefined) {
      try {
        lines = fs.readFileSync(path.join(root, r.file_path), 'utf-8').split('\n');
      } catch {
        lines = [];
      }
      srcCache.set(r.file_path, lines);
    }
    const span = lines.slice(r.start_line - 1, r.end_line);
    if (span.length === 0) continue;
    const language = langOf.get(r.file_path) ?? (r.file_path.endsWith('.go') ? 'go' : 'ts');
    const fields = parseShapeFields(span, language, r.kind);
    const shape: ShapeSchema = {
      name: r.name,
      kind: r.kind as ShapeSchema['kind'],
      fields,
      origin: 'ast',
    };
    let arr = byFile.get(r.file_path);
    if (!arr) byFile.set(r.file_path, (arr = []));
    if (!arr.some((s) => s.name === shape.name)) arr.push(shape);
  }
  return byFile;
}

// ── effects.reads_config：env/flag 读取点扫描 ──────────────────────

const GO_ENV_RES = [
  /\bos\.Getenv\(\s*"([^"]+)"\s*\)/g,
  /\bflag\.\w+\(\s*"([^"]+)"/g,
];
const TS_ENV_RES = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bprocess\.env\[\s*['"]([^'"]+)['"]\s*\]/g,
];

function scanConfigKeys(source: string, language: string): string[] {
  const keys = new Set<string>();
  const res = language === 'go' ? GO_ENV_RES : TS_ENV_RES;
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) keys.add(m[1]);
  }
  return [...keys].sort();
}

// ── effects 候选点静态扫描（Phase 2b 第一步：AST 定位，camera 确认）──
//
// 动静结合的"静"半边：只标候选（origin='ast'），不产生事实——
// 候选 = "这里疑似写外部状态/占资源/发事件"，camera 观测后转正或证伪。

/** 收集包级（Go）/模块级（TS）变量名——赋值目标只有它们才算"写外部状态" */
function collectModuleVars(source: string, language: string): Set<string> {
  const names = new Set<string>();
  if (language === 'go') {
    let inVarBlock = false;
    for (const raw of source.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (/^var\s*\(/.test(line)) {
        inVarBlock = true;
        continue;
      }
      if (inVarBlock && /^\)/.test(line)) {
        inVarBlock = false;
        continue;
      }
      if (line.trim().startsWith('//')) continue;
      const m = inVarBlock
        ? /^\s+([A-Za-z_]\w*)\s*(?:=[^=]|[\w\[\]\*\.])/.exec(line) // 块内：Name T / Name = init
        : /^var\s+([A-Za-z_]\w*)\s*(?:=[^=]|[\w\[\]\*\.])/.exec(line); // 顶层：var Name T / var Name = init
      if (m && !/^(type|func|package|import)$/.test(m[1])) names.add(m[1]);
    }
  } else {
    for (const raw of source.split('\n')) {
      const line = raw.replace(/\r$/, '');
      let m = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) {
        names.add(m[1]);
        continue;
      }
      // const 对象/数组：整体不可重绑定但字段/元素可写（const obj = {…}; obj.f = 1）
      m = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*[{\[]/.exec(line);
      if (m) names.add(m[1]);
    }
  }
  return names;
}

/** 对模块级变量的赋值/自增扫描。`=(?![=>])` 排除 `==` 与 `=>`；Go `:=` 被 `\s*=` 天然拒绝 */
function scanVarWrites(source: string, moduleVars: Set<string>): EffectTarget[] {
  const seen = new Set<string>();
  const out: EffectTarget[] = [];
  for (const name of moduleVars) {
    const assign = new RegExp(`\\b${name}(\\.[\\w.]+|\\[[^\\]]*\\])?\\s*=(?![=>])`, 'g');
    const incr = new RegExp(`\\b${name}\\s*(?:\\+\\+|--)|(?<![\\w.])\\+\\+${name}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = assign.exec(source)) !== null) {
      const suffix = m[1] ?? '';
      const target = name + (suffix.startsWith('.') ? suffix : suffix.startsWith('[') ? '[]' : '');
      if (!seen.has(target)) {
        seen.add(target);
        out.push({ target, op: 'write', origin: 'ast' });
      }
    }
    if (incr.test(source) && !seen.has(name)) {
      seen.add(name);
      out.push({ target: name, op: 'write', origin: 'ast' });
    }
  }
  return out;
}

/** 文件系统写/删调用（字面量路径直接记；变量路径记表达式名） */
const GO_FILE_WRITE_RES: Array<{ re: RegExp; op: EffectTarget['op'] }> = [
  { re: /\bos\.WriteFile\(\s*(?:"([^"]+)"|([\w.]+))/g, op: 'write' },
  { re: /\bos\.(?:Remove|RemoveAll)\(\s*(?:"([^"]+)"|([\w.]+))/g, op: 'delete' },
];
const TS_FILE_WRITE_RES: Array<{ re: RegExp; op: EffectTarget['op'] }> = [
  { re: /\bfs\.(?:writeFile|writeFileSync)\(\s*(?:['"]([^'"]+)['"]|([\w.]+))/g, op: 'write' },
  { re: /\bfs\.(?:appendFile|appendFileSync)\(\s*(?:['"]([^'"]+)['"]|([\w.]+))/g, op: 'append' },
  { re: /\bfs\.(?:unlink|unlinkSync|rm|rmSync)\(\s*(?:['"]([^'"]+)['"]|([\w.]+))/g, op: 'delete' },
];

/** 资源占用（拔积木须释放） */
const GO_HOLD_RES: Array<{ re: RegExp; make: (m: RegExpExecArray) => EffectTarget }> = [
  { re: /net\.Listen\(\s*"[^"]*"\s*,\s*(?:"([^"]+)"|([\w.]+))/g, make: (m) => ({ target: `listen:${m[1] ?? m[2]}`, op: 'acquire', origin: 'ast' }) },
  { re: /http\.ListenAndServe\(\s*(?:"([^"]*)"|([\w.]+))/g, make: (m) => ({ target: `listen:${m[1] ?? m[2]}`, op: 'acquire', origin: 'ast' }) },
  { re: /os\.(?:Open|Create|OpenFile)\(\s*(?:"([^"]+)"|([\w.]+))/g, make: (m) => ({ target: `file:${m[1] ?? m[2]}`, op: 'acquire', origin: 'ast' }) },
  { re: /sql\.Open\(\s*"(\w+)"/g, make: (m) => ({ target: `db-pool:${m[1]}`, op: 'acquire', origin: 'ast' }) },
  { re: /\bgo\s+(?:func\b|\w)/g, make: () => ({ target: 'goroutine', op: 'acquire', origin: 'ast' }) },
  { re: /time\.New(?:Ticker|Timer)\(/g, make: () => ({ target: 'ticker', op: 'acquire', origin: 'ast' }) },
];
const TS_HOLD_RES: Array<{ re: RegExp; make: (m: RegExpExecArray) => EffectTarget }> = [
  { re: /\.listen\(\s*(\d+)/g, make: (m) => ({ target: `listen:${m[1]}`, op: 'acquire', origin: 'ast' }) },
  { re: /\bfs\.(?:open|openSync|createWriteStream|createReadStream)\(\s*(?:['"]([^'"]+)['"]|([\w.]+))/g, make: (m) => ({ target: `file:${m[1] ?? m[2]}`, op: 'acquire', origin: 'ast' }) },
  { re: /new\s+Worker\(/g, make: () => ({ target: 'worker', op: 'acquire', origin: 'ast' }) },
  { re: /\bsetInterval\(/g, make: () => ({ target: 'timer', op: 'acquire', origin: 'ast' }) },
  // exec 加 (?<!\.)：排除 db.exec / regexp.exec 等方法调用（真实项目踩过：db.ts 的 SQL exec 误报）
  { re: /(?<!\.)\bexec\s*\(|\b(?:spawn|execFile|fork)\s*\(/g, make: () => ({ target: 'subprocess', op: 'acquire', origin: 'ast' }) },
];

/** chan send / 事件发送。Go 逐行处理：含 `= <-` 的行是 receive，跳过 */
const GO_CHAN_KEYWORDS = new Set([
  'case', 'default', 'if', 'for', 'return', 'switch', 'select', 'go', 'defer',
  'else', 'break', 'continue', 'var', 'const', 'type', 'func', 'range',
]);

function scanGoEmits(source: string): string[] {
  const out = new Set<string>();
  for (const raw of source.split('\n')) {
    const code = raw.replace(/\r$/, '').replace(/\/\/.*$/, '');
    if (!code.includes('<-')) continue;
    if (/=\s*<-/.test(code)) continue; // receive 赋值（x := <-ch / x = <-ch）
    // send：word <- value。word 为关键字时是 `case <-ch:`（无赋值 receive）等形态，跳过
    const m = /\b([\w.]+)\s*<-\s*\S/.exec(code);
    if (m && !GO_CHAN_KEYWORDS.has(m[1].split('.')[0])) out.add(`chan:${m[1]}`);
  }
  for (const re of [/\.Publish\(\s*(?:fmt\.Sprintf\()?\s*"([^"]+)"/g, /\.Emit\(\s*"([^"]+)"/g]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.add(`event:${m[1]}`);
  }
  return [...out];
}

function scanTsEmits(source: string): string[] {
  const out = new Set<string>();
  for (const re of [
    /\.emit\(\s*['"]([\w: -]+)['"]/g,
    /\.publish\(\s*['"]([\w: -]+)['"]/g,
    /dispatchEvent\(\s*new\s+(\w+)/g,
  ]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.add(m[1].startsWith('event:') || m[1].startsWith('chan:') ? m[1] : `event:${m[1]}`);
  }
  if (/\bpostMessage\(/.test(source)) out.add('event:postMessage');
  return [...out];
}

interface EffectCandidates {
  writes: EffectTarget[];
  holds: EffectTarget[];
  emits: string[];
}

/** effects 候选扫描总入口（每类上限 20 防大文件爆表；详情在 DSL 契约里） */
function scanEffectCandidates(source: string, language: string): EffectCandidates {
  const isGo = language === 'go';
  const writes = scanVarWrites(source, collectModuleVars(source, language));
  for (const { re, op } of isGo ? GO_FILE_WRITE_RES : TS_FILE_WRITE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const t = m[1] ?? m[2];
      writes.push({ target: `file:${t}`, op, origin: 'ast' });
    }
  }
  const dedupWrites = [...new Map(writes.map((w) => [`${w.op}:${w.target}`, w])).values()].slice(0, 20);

  const holds: EffectTarget[] = [];
  for (const { re, make } of isGo ? GO_HOLD_RES : TS_HOLD_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) holds.push(make(m));
  }
  const dedupHolds = [...new Map(holds.map((h) => [h.target, h])).values()].slice(0, 20);

  const emits = (isGo ? scanGoEmits(source) : scanTsEmits(source)).slice(0, 20);
  return { writes: dedupWrites, holds: dedupHolds, emits };
}

// ── 主流程 ────────────────────────────────────────────────────────

export function extractContracts(input: ExtractContractsInput): ExtractContractsResult {
  const { project_dir, feature, write_dsl = true } = input;
  const root = path.resolve(project_dir);

  let db: Database;
  try {
    db = getProjectCacheDb(root);
  } catch (e) {
    throw new Error(
      `无法打开缓存 ${path.join(root, '.design-canvas', 'cache.db')}：${(e as Error).message}。` +
        '请先对该项目运行 import_project 建立符号缓存。',
    );
  }

  // 限定范围（可选）
  let scope: Set<string> | undefined;
  if (input.files && input.files.length > 0) {
    scope = new Set(
      input.files.map((f) => {
        const abs = path.isAbsolute(f) ? f : path.join(root, f);
        const rel = path.relative(root, abs).split(path.sep).join('/');
        return rel.startsWith('src/') ? [rel, rel.slice(4)] : [rel];
      }).flat(),
    );
  }

  // 语言表
  const langOf = new Map<string, string>();
  for (const row of db.prepare('SELECT path, language FROM files').all() as Array<{ path: string; language: string }>) {
    langOf.set(row.path, row.language);
  }

  // ① role（依赖方向图）
  const graph = buildImportGraph(db, root);
  const roles = classifyRoles(graph);

  // ② shapes
  const shapesByFile = extractShapes(db, root, langOf);

  // ③ 组装契约 + 扫描 reads_config
  const reports: FileContractReport[] = [];
  const contracts = new Map<string, BrickContract>();
  for (const f of graph.files) {
    if (scope && !scope.has(f.rel)) continue;
    const { role, fanIn, fanOut } = roles.get(f.rel) ?? {
      role: { class: 'functional' as const, basis: 'graph' as const, confidence: 0.4, reasons: ['未入图'] },
      fanIn: 0,
      fanOut: 0,
    };
    // 静态判定 confidence 封顶 0.7（schema 语义：无 runtime 证据）
    const cappedRole: BrickRole = { ...role, confidence: Math.min(role.confidence, 0.7) };

    let readsConfig: string[] = [];
    let effectCand: EffectCandidates = { writes: [], holds: [], emits: [] };
    try {
      const src = fs.readFileSync(path.join(root, f.rel), 'utf-8');
      const lang = langOf.get(f.rel) ?? 'ts';
      readsConfig = scanConfigKeys(src, lang);
      effectCand = scanEffectCandidates(src, lang);
    } catch {
      // 源文件读取失败（可能已删除），config/effects 清单置空
    }

    const contract: BrickContract = {
      schema_version: 1,
      role: cappedRole,
      shapes: { exposes: shapesByFile.get(f.rel) ?? [], consumes: [] },
      effects: {
        writes: effectCand.writes,
        holds: effectCand.holds,
        emits: effectCand.emits,
        reads_config: readsConfig,
      },
    };
    contracts.set(f.rel, contract);
    const samples = [
      ...effectCand.writes.slice(0, 2).map((w) => `${w.op} ${w.target}`),
      ...effectCand.holds.slice(0, 1).map((h) => `hold ${h.target}`),
      ...effectCand.emits.slice(0, 1),
    ].slice(0, 3);
    reports.push({
      path: f.rel,
      language: langOf.get(f.rel) ?? 'unknown',
      role: cappedRole,
      fan_in: fanIn,
      fan_out: fanOut,
      shape_count: contract.shapes.exposes.length,
      reads_config: readsConfig,
      effects: {
        writes: effectCand.writes.length,
        holds: effectCand.holds.length,
        emits: effectCand.emits.length,
        samples,
      },
    });
  }

  reports.sort((a, b) => a.path.localeCompare(b.path));

  // 写回 DSL
  let written = false;
  if (feature && write_dsl) {
    const dsl = getDSL(feature);
    if (!dsl) throw new Error(`feature "${feature}" 不存在`);
    let matched = 0;
    for (const sf of dsl.semantic?.files ?? []) {
      if (!sf.path) continue;
      // 路径基准适配（语义 path 与缓存 path 可能差 src/ 前缀）
      const candidates = sf.path.startsWith('src/') ? [sf.path, sf.path.slice(4)] : [sf.path];
      const hit = candidates.map((c) => contracts.get(c)).find(Boolean);
      if (hit) {
        sf.contract = hit;
        matched++;
      }
    }
    if (matched > 0) {
      saveDSL(dsl, 'mcp');
      written = true;
    }
  }

  // 统计
  const business = reports.filter((r) => r.role.class === 'business').length;
  const functional = reports.filter((r) => r.role.class === 'functional').length;
  const hybrid = reports.filter((r) => r.role.class === 'hybrid').length;
  const avgConf =
    reports.length > 0 ? reports.reduce((s, r) => s + r.role.confidence, 0) / reports.length : 0;
  const lowConf = reports.filter((r) => r.role.confidence < 0.7).length;
  const shapeCount = reports.reduce((s, r) => s + r.shape_count, 0);
  const configKeySet = new Set(reports.flatMap((r) => r.reads_config));
  const writesCount = reports.reduce((s, r) => s + r.effects.writes, 0);
  const holdsCount = reports.reduce((s, r) => s + r.effects.holds, 0);
  const emitsCount = reports.reduce((s, r) => s + r.effects.emits, 0);

  const message =
    `契约提取：${reports.length} 个文件（business ${business} / functional ${functional} / hybrid ${hybrid}），` +
    `形状 ${shapeCount} 个，配置键 ${configKeySet.size} 个，平均置信度 ${avgConf.toFixed(2)}，` +
    `低置信（<0.7，LLM 兜底候选）${lowConf} 个；` +
    `effects 候选（origin=ast）：写 ${writesCount} / 占用 ${holdsCount} / 事件 ${emitsCount}` +
    (feature ? (written ? `，已写回 DSL "${feature}"` : `，DSL "${feature}" 无匹配文件未写回`) : '') +
    `。候选待 camera 运行观测转正（origin=runtime）。`;

  return {
    project_dir: root,
    feature,
    written_to_dsl: written,
    files: reports,
    stats: {
      total: reports.length,
      business,
      functional,
      hybrid,
      avg_confidence: Math.round(avgConf * 100) / 100,
      low_confidence: lowConf,
      shapes_extracted: shapeCount,
      config_keys: configKeySet.size,
      writes_candidates: writesCount,
      holds_candidates: holdsCount,
      emits_candidates: emitsCount,
    },
    message,
  };
}
