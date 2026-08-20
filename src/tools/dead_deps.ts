/**
 * dead_deps —— 死依赖检测（积木瘦身的事实层，Phase 5+）
 *
 * 回答的问题：闭包按文件搬运（Go 整目录端走是包语义的必然），文件里难免混入
 * 与种子功能无关的代码——它们 import 的三方依赖就是"死依赖"：
 * 拼装区 go.mod 里躺着、但积木核心功能（种子可达部分）根本用不到的库。
 *
 * 方法（纯静态、零 token、机器出事实）：
 *   1. 符号级可达性：从种子文件全部符号出发，沿 call/type_ref 边 BFS
 *      （限定闭包内符号）→ 活跃符号集
 *   2. import 限定符映射：逐文件解析 import 语句的本地限定符
 *      （Go alias 或路径末段；TS 绑定名），再在源码里定位限定符出现处、
 *      归属到行范围覆盖它的最内层符号
 *   3. 三方依赖存活判定：被任一活跃符号引用 → 活；只被不可达符号引用 /
 *      零引用 → 死候选
 *
 * 保守规则（宁漏报死候选，不误报——报告的信任优先）：
 *   - Go init 函数 / 包级（符号 span 外）出现 → 依赖活（import 即执行的副作用）
 *   - Go `_` 空导入（副作用）/ `.` 点导入（无法定位引用）→ 依赖活
 *   - TS 裸副作用导入 `import 'x'` → 依赖活
 *   - 限定符提取失败（语法不认识）→ 依赖活
 *   - 活跃类型的方法（parent 挂靠）随类型一起活——接口方法集/反射调用
 *     静态看不见，宁可多活
 *
 * Camera 宪法同构：只报告偏差，绝不自动改写。剔除=改写=风险，
 * 须人拍板 + 四层验证（编译/源测试/camera/效果验收）产出 -slim 衍生积木。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import type { ExternalDep } from './harvest_closure.js';

export interface DeadDepCandidate {
  source: string;
  files: string[];
  reason: 'no_reference' | 'unreachable_only';
}

export interface DeadDepsResult {
  live_symbols: number;
  total_symbols: number;
  dead: DeadDepCandidate[];
  limitations: string[];
}

interface SymbolRow {
  id: string;
  kind: string;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  parent: string | null;
}

const LIMITATIONS = [
  '静态可达性看不见反射/接口动态分发/字符串引用符号——瘦身为行动前必须过编译+源测试+camera 四层验证',
  'Go init()/包级初始化与 TS 模块级副作用已保守按"活"处理，但符号 span 判定仍有近似',
  '跨文件调用边依赖索引期解析；未解析的调用会使被调方不可达（往"活"方向保守补救靠方法挂靠规则）',
];

/** Go import 语句解析：路径 → 本地限定符（alias 优先，否则路径末段）；`_`/`.` 返回特殊标记 */
export function parseGoImportQualifiers(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = src.split('\n');
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const m = line.match(/^(?:(\w+|\.)\s+)?"([^"]+)"$/);
      if (m) map.set(m[2], m[1] ?? m[2].slice(m[2].lastIndexOf('/') + 1));
      continue;
    }
    if (/^import\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
    const single = line.match(/^import\s+(?:(\w+|\.)\s+)?"([^"]+)"$/);
    if (single) map.set(single[2], single[1] ?? single[2].slice(single[2].lastIndexOf('/') + 1));
  }
  return map;
}

/** TS/JS import 解析：模块路径 → 本地限定符列表（默认名/命名导入/别名/namespace）。
 *  返回 null = 该模块无法提取限定符（副作用导入/语法不认识）→ 调用方按"活"处理 */
export function parseTsImportQualifiers(src: string, mod: string): string[] | null {
  const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 副作用导入：import 'mod' / import "mod"
  if (new RegExp(`^\\s*import\\s+['"]${escaped}['"]`, 'm').test(src)) return null;
  // namespace：import * as NS from 'mod'
  const ns = src.match(new RegExp(`import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"]${escaped}['"]`));
  if (ns) return [ns[1]];
  // 具名/默认混合：import X, { a, b as c } from 'mod'
  const named = src.match(new RegExp(`import\\s+([\\w$]+)?\\s*,?\\s*\\{([^}]*)\\}\\s*from\\s+['"]${escaped}['"]`));
  if (named) {
    const out: string[] = [];
    if (named[1]) out.push(named[1]);
    for (const piece of named[2].split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const alias = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
      out.push(alias ? alias[1] : p.split(/\s+as\s+/)[0]);
    }
    return out;
  }
  // 纯默认：import X from 'mod'
  const def = src.match(new RegExp(`import\\s+([\\w$]+)\\s+from\\s+['"]${escaped}['"]`));
  if (def) return [def[1]];
  // CommonJS：const X = require('mod') / const { a } = require('mod')
  const cjsDef = src.match(new RegExp(`(?:const|let|var)\\s+([\\w$]+)\\s*=\\s*require\\(\\s*['"]${escaped}['"]`));
  if (cjsDef) return [cjsDef[1]];
  const cjsNamed = src.match(new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*require\\(\\s*['"]${escaped}['"]`));
  if (cjsNamed) {
    return cjsNamed[1]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const alias = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
        return alias ? alias[1] : p.split(/\s+as\s+/)[0];
      });
  }
  return null;
}

/** 源码中限定符出现行（Go：`Q.` 成员访问；TS：裸标识符出现即引用） */
export function qualifierLines(src: string, qualifier: string, lang: 'go' | 'ts'): number[] {
  const q = qualifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = lang === 'go' ? new RegExp(`\\b${q}\\.`, 'g') : new RegExp(`\\b${q}\\b`, 'g');
  const lines: number[] = [];
  let offset = 0;
  for (const chunk of src.split('\n')) {
    offset += 1;
    if (lang === 'go') {
      // Go 行注释剔除：`//` 前须是行首或空白——URL 字符串（"https://…"）里的
      // `//` 前是冒号，不当注释剥（否则字符串后的真实引用会漏判 → 假死候选）
      const code = chunk.replace(/(^|\s)\/\/.*$/, '$1');
      if (re.test(code)) lines.push(offset);
      re.lastIndex = 0;
      continue;
    }
    if (re.test(chunk)) lines.push(offset);
    re.lastIndex = 0;
  }
  return lines;
}

/** TS/JS 源码剥离 import/require 语句行（占位换行保行号）：
 *  import 语句本身含绑定名（`import { dead } from 'deaddep'`），不剥会被
 *  当成"包级出现"误判活；解构 require 行同理 */
export function stripTsImportLines(src: string): string {
  return src
    .replace(/import\s+[^;]*?;/gs, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[^\S\n]*[^\n]*=\s*require\([^)]*\)[^\n]*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

/** 行 → 最内层覆盖符号（找不到 = 包级/模块级作用域） */
function enclosingSymbol(symbols: SymbolRow[], line: number): SymbolRow | null {
  let best: SymbolRow | null = null;
  let bestSpan = Infinity;
  for (const s of symbols) {
    if (line >= s.start_line && line <= s.end_line) {
      const span = s.end_line - s.start_line;
      if (span < bestSpan) {
        bestSpan = span;
        best = s;
      }
    }
  }
  return best;
}

export function analyzeDeadThirdParty(opts: {
  db: Database;
  projectDir: string;
  /** 闭包内部文件（缓存基准相对路径） */
  closureFiles: string[];
  /** 种子文件（同基准） */
  seedFiles: string[];
  /** 闭包外部依赖（harvest_closure 结果，只取 third_party 类） */
  external: ExternalDep[];
}): DeadDepsResult {
  const { db, projectDir, closureFiles, seedFiles } = opts;
  const closureSet = new Set(closureFiles);
  const seedSet = new Set(seedFiles);

  // ── 1. 闭包符号装载 ──
  const stmtNodes = db.prepare(
    "SELECT id, kind, name, file_path, start_line, end_line, parent FROM nodes WHERE file_path = ? AND kind != 'file'",
  );
  const symbols: SymbolRow[] = [];
  const byFile = new Map<string, SymbolRow[]>();
  const symbolIds = new Set<string>();
  for (const f of closureFiles) {
    const rows = stmtNodes.all(f) as unknown as SymbolRow[];
    for (const r of rows) {
      symbols.push(r);
      symbolIds.add(r.id);
      let arr = byFile.get(r.file_path);
      if (!arr) byFile.set(r.file_path, (arr = []));
      arr.push(r);
    }
  }

  // ── 2. 可达性 BFS ──
  // 根：种子文件全部符号 + Go init 函数（import 即执行）
  //     + TS 顶层 const（模块初始化即执行——Go 包级 var 不进符号索引，
  //       落在符号 span 外自然保守按活；TS 顶层 const 是符号，须显式补根）
  const live = new Set<string>();
  const queue: string[] = [];
  for (const s of symbols) {
    const isTsTopConst =
      s.kind === 'const' && s.parent === null && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(s.file_path);
    if (seedSet.has(s.file_path) || (s.name === 'init' && s.file_path.endsWith('.go')) || isTsTopConst) {
      live.add(s.id);
      queue.push(s.id);
    }
  }
  // 邻接（闭包内符号间的 call/type_ref）
  const adj = new Map<string, string[]>();
  const edgeRows = db
    .prepare("SELECT source, target FROM edges WHERE kind IN ('call','type_ref')")
    .all() as Array<{ source: string; target: string }>;
  for (const e of edgeRows) {
    if (!symbolIds.has(e.source) || !symbolIds.has(e.target)) continue;
    let arr = adj.get(e.source);
    if (!arr) adj.set(e.source, (arr = []));
    arr.push(e.target);
  }
  // 方法挂靠：类型活跃 → 其方法活跃（接口分发/反射盲区的保守网）
  // parent 值可能是限定名或裸名；Go 方法可跨同包文件——按同名类型激活同目录下方法
  const childrenByParentKey = new Map<string, string[]>(); // `${file}|${name}` / `${dir}|go|${name}` → method ids
  for (const s of symbols) {
    if (!s.parent) continue;
    const i = s.file_path.lastIndexOf('/');
    const dir = i < 0 ? '' : s.file_path.slice(0, i);
    for (const key of [`${s.file_path}|${s.parent}`, `${dir}|go|${s.parent}`]) {
      let arr = childrenByParentKey.get(key);
      if (!arr) childrenByParentKey.set(key, (arr = []));
      arr.push(s.id);
    }
  }
  const activateChildren = (sym: SymbolRow): void => {
    const i = sym.file_path.lastIndexOf('/');
    const dir = i < 0 ? '' : sym.file_path.slice(0, i);
    const keys = [`${sym.file_path}|${sym.name}`, `${dir}|go|${sym.name}`];
    for (const key of keys) {
      for (const child of childrenByParentKey.get(key) ?? []) {
        if (!live.has(child)) {
          live.add(child);
          queue.push(child);
        }
      }
    }
  };
  const symById = new Map(symbols.map((s) => [s.id, s]));
  for (; queue.length > 0; ) {
    const batch = queue.splice(0);
    for (const id of batch) {
      const sym = symById.get(id);
      if (sym && (sym.kind === 'type' || sym.kind === 'class' || sym.kind === 'interface')) {
        activateChildren(sym);
      }
      for (const next of adj.get(id) ?? []) {
        if (!live.has(next)) {
          live.add(next);
          queue.push(next);
        }
      }
    }
  }

  // ── 3. import 限定符 → 引用归属 ──
  // 每个三方 source：liveHit（活跃符号或包级引用过）/ anyHit（有符号引用过）/ files
  interface DepAgg {
    files: Set<string>;
    liveHit: boolean;
    symbolHit: boolean;
  }
  const agg = new Map<string, DepAgg>();
  const thirdParty = opts.external.filter((e) => e.class === 'third_party');
  for (const e of thirdParty) agg.set(e.source, { files: new Set(), liveHit: false, symbolHit: false });

  const stmtImports = db.prepare(
    'SELECT source, line, kind, type_only FROM imports WHERE file_path = ?',
  );
  const srcCache = new Map<string, string>();
  const readSrc = (f: string): string => {
    let s = srcCache.get(f);
    if (s === undefined) {
      try {
        s = fs.readFileSync(path.join(projectDir, f), 'utf-8');
      } catch {
        s = '';
      }
      srcCache.set(f, s);
    }
    return s;
  };

  for (const f of closureFiles) {
    const isGo = f.endsWith('.go');
    const isTs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f);
    if (!isGo && !isTs) continue;
    const src = readSrc(f);
    if (!src) continue;
    const fileSyms = byFile.get(f) ?? [];
    const goQuals = isGo ? parseGoImportQualifiers(src) : null;
    // TS：剥离 import/require 行再扫（import 语句本身含绑定名，会假"包级出现"）
    const scanSrc = isGo ? src : stripTsImportLines(src);

    const rows = stmtImports.all(f) as Array<{
      source: string;
      line: number;
      kind: string;
      type_only: number;
    }>;
    for (const r of rows) {
      if (r.type_only === 1 || r.kind !== 'package') continue;
      const a = agg.get(r.source);
      if (!a) continue; // 非三方（stdlib/unresolved）不进死候选
      a.files.add(f);

      let quals: string[] | null;
      if (isGo) {
        const q = goQuals?.get(r.source);
        if (q === undefined || q === '.' || q === '_') {
          a.liveHit = true; // 点导入/空导入/解析失败：保守按活
          continue;
        }
        quals = [q];
      } else {
        quals = parseTsImportQualifiers(src, r.source);
        if (quals === null) {
          a.liveHit = true; // 副作用导入/语法不认识：保守按活
          continue;
        }
      }
      for (const q of quals) {
        for (const line of qualifierLines(scanSrc, q, isGo ? 'go' : 'ts')) {
          const owner = enclosingSymbol(fileSyms, line);
          if (owner === null) {
            a.liveHit = true; // 包级/模块级作用域：import 即执行的副作用
          } else {
            a.symbolHit = true;
            if (live.has(owner.id)) a.liveHit = true;
          }
        }
      }
    }
  }

  // ── 4. 汇总死候选 ──
  const dead: DeadDepCandidate[] = [];
  for (const e of thirdParty) {
    const a = agg.get(e.source)!;
    if (a.liveHit) continue;
    dead.push({
      source: e.source,
      files: [...a.files].sort(),
      reason: a.symbolHit ? 'unreachable_only' : 'no_reference',
    });
  }
  dead.sort((x, y) => (x.source < y.source ? -1 : 1));

  return {
    live_symbols: live.size,
    total_symbols: symbols.length,
    dead,
    limitations: LIMITATIONS,
  };
}
