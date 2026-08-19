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
 *   ③ effects.reads_config——env/flag 读取点源码扫描（Go: os.Getenv/flag；
 *      TS: process.env.X / process.env['X']）——积木"出厂环境要求"
 *      writes/holds/emits 留空：静态提取范围外，由 camera 运行证据补（Phase 2b）
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
    try {
      const src = fs.readFileSync(path.join(root, f.rel), 'utf-8');
      readsConfig = scanConfigKeys(src, langOf.get(f.rel) ?? 'ts');
    } catch {
      // 源文件读取失败（可能已删除），config 清单置空
    }

    const contract: BrickContract = {
      schema_version: 1,
      role: cappedRole,
      shapes: { exposes: shapesByFile.get(f.rel) ?? [], consumes: [] },
      effects: { writes: [], holds: [], emits: [], reads_config: readsConfig },
    };
    contracts.set(f.rel, contract);
    reports.push({
      path: f.rel,
      language: langOf.get(f.rel) ?? 'unknown',
      role: cappedRole,
      fan_in: fanIn,
      fan_out: fanOut,
      shape_count: contract.shapes.exposes.length,
      reads_config: readsConfig,
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

  const message =
    `契约提取：${reports.length} 个文件（business ${business} / functional ${functional} / hybrid ${hybrid}），` +
    `形状 ${shapeCount} 个，配置键 ${configKeySet.size} 个，平均置信度 ${avgConf.toFixed(2)}，` +
    `低置信（<0.7，LLM 兜底候选）${lowConf} 个` +
    (feature ? (written ? `，已写回 DSL "${feature}"` : `，DSL "${feature}" 无匹配文件未写回`) : '') +
    `。writes/holds/emits 留待 camera 运行证据（Phase 2b）。`;

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
    },
    message,
  };
}
