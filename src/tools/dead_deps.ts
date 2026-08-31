/**
 * dead_deps —— 死依赖检测（积木瘦身的事实层，Phase 5+）
 *
 * 回答的问题：闭包按文件搬运（Go 整目录端走是包语义的必然），文件里难免混入
 * 与种子功能无关的代码——它们 import 的三方依赖就是"死依赖"：
 * 拼装区 go.mod 里躺着、但积木核心功能（种子可达部分）根本用不到的库。
 *
 * 方法（纯静态、零 token、机器出事实）：
 *   1. 符号级可达性：从种子文件全部符号出发，沿 call/type_ref 边 BFS
 *      （限定闭包内符号）→ 活跃符号集。Go 的跨文件引用不进 edges 表
 *      （跨文件解析只认 TS relative imports），另由源码扫描补边（2.5 节）
 *   2. import 限定符映射：逐文件解析 import 语句的本地限定符
 *      （Go alias 或路径末段；TS 绑定名），再在源码里定位限定符出现处、
 *      归属到行范围覆盖它的最内层符号
 *   3. 三方依赖存活判定：被任一活跃符号引用 → 活；只被不可达符号引用 /
 *      零引用 → 死候选
 *
 * 保守规则（宁漏报死候选，不误报——报告的信任优先）：
 *   - Go init 函数 / 包级（符号 span 外）出现 / `_` 空导入 / `.` 点导入：
 *     包活才活——包活 = 目录内有任一 live 符号（引用必经 import）或被存活
 *     目录内文件的空/点导入（import 即执行的副作用）。死包（闭包整目录
 *     端走的无关文件——同目录里种子够不到的兄弟、只被死代码引用的整个包）
 *     的包级代码永不执行，其依赖按死候选报告
 *   - TS 裸副作用导入 `import 'x'` / 顶层 const → 依赖活——但 const 的
 *     "模块级代码恒执行"特权只对值可达文件成立（valueFiles 输入）：type 边
 *     拉进闭包的纯类型文件运行时不加载，其 const 不执行、依赖按死候选报告
 *   - 限定符提取失败（语法不认识）→ 依赖活
 *   - 活跃类型的方法（parent 挂靠）随类型一起活——接口方法集/反射调用
 *     静态看不见，宁可多活
 *
 * Observe 宪法同构：只报告偏差，绝不自动改写。剔除=改写=风险，
 * 须人拍板 + 四层验证（编译/源测试/observe/效果验收）产出 -slim 衍生积木。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db/db.js';
import type { ExternalDep } from './harvest_closure.js';
import { buildIndex, readGoModules, resolveImport, type FileEntry } from './import_project.js';

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
  /** live 符号明细（file → 顶层符号名列表）——go-slim 剪刀的 keep 集 */
  live_symbols_by_file: Record<string, string[]>;
  /** live 类型名全集（方法挂靠规则的剪刀侧输入：类型的全部方法随类型活） */
  live_type_names: string[];
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
  '静态可达性看不见反射/接口动态分发/字符串引用符号——瘦身为行动前必须过编译+源测试+observe 四层验证',
  'Go init/包级初始化按"包活才活"判定（目录内有 live 符号或被存活空/点导入）；TS 顶层 const 按值可达文件判活（type 边拉进闭包的纯类型文件运行时不加载）——符号 span 判定仍有近似',
  'Go 跨文件引用边由源码扫描补齐（包限定符/同包兄弟符号）——字符串里的同名出现会保守多活；TS 跨文件边依赖索引期解析',
];

/** Go import 路径的候选限定符（无 alias 时）。Go 生态惯例：主版本后缀段
 *  （v2/v3/v4…）不是包名——github.com/bmatcuk/doublestar/v4 的包名是
 *  doublestar（曾因只认末段 v4 找 `v4.` 永不命中，活依赖被误判死候选、
 *  剪刀误剪 import → undefined: doublestar）；gopkg.in 的 yaml.v2 包名是
 *  yaml；连字符段（tiktoken-go）包名不能含 `-`，补切分 token。多候选只
 *  用于"是否被引用"的匹配面——命中任一即引用，宁多活不误死。 */
export function goImportQualifierCandidates(p: string): string[] {
  const segs = p.split('/');
  const last = segs[segs.length - 1] ?? '';
  const out = new Set<string>([last]);
  if (segs.length >= 2 && /^v\d+$/.test(last)) out.add(segs[segs.length - 2]);
  const dot = last.indexOf('.');
  if (dot > 0) out.add(last.slice(0, dot));
  if (last.includes('-')) for (const t of last.split('-')) if (t) out.add(t);
  return [...out].filter((x) => x !== '');
}

/** Go import 语句解析：路径 → 候选限定符数组（alias 优先——唯一候选；
 *  无 alias 为路径派生候选集，见 goImportQualifierCandidates；`_`/`.` 为
 *  单元素特殊标记） */
export function parseGoImportQualifiers(src: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
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
      if (m) map.set(m[2], m[1] ? [m[1]] : goImportQualifierCandidates(m[2]));
      continue;
    }
    if (/^import\s*\(/.test(line)) {
      inBlock = true;
      continue;
    }
    const single = line.match(/^import\s+(?:(\w+|\.)\s+)?"([^"]+)"$/);
    if (single) map.set(single[2], single[1] ? [single[1]] : goImportQualifierCandidates(single[2]));
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
  const named = src.match(new RegExp(`import\\s+([\\w$]+)?\\s*,?\\s*\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`));
  if (named) {
    // named[1] 可能是默认导入名，也可能是 `import type { ... }` 的 `type` 关键字——
    // 后者无默认绑定，剥掉；命名项里的内联 `type X` 也剥 `type ` 前缀（否则限定符
    // 变成 `type X`，与 `X` 的裸用法匹配不上 → 活跃类型被误判死引用）
    const hasDefault = named[1] !== undefined && named[1] !== 'type';
    const out: string[] = [];
    if (hasDefault) out.push(named[1]);
    for (const piece of named[2].split(',')) {
      const p = piece.trim();
      if (!p) continue;
      const alias = p.match(/^[\w$]+\s+as\s+([\w$]+)$/);
      const base = (p.split(/\s+as\s+/)[0] ?? '').replace(/^type\s+/, '');
      out.push(alias ? alias[1] : base);
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
        return alias ? alias[1] : (p.split(/\s+as\s+/)[0] ?? '').replace(/^type\s+/, '');
      });
  }
  return null;
}

/** 源码中限定符出现行（Go：`Q.` 成员访问；TS：裸标识符出现即引用） */
/** Go 注释行剔除（保行号）：行注释 `//`（前须是行首或空白——URL 字符串
 *  "https://…" 里的 `//` 前是冒号，不当注释剥）+ 块注释中段行（以星号开头、
 *  星号后跟空白或行尾的 ` * text` 形态——解引用 `*p` 星号后紧跟标识符，
 *  不误伤）。跨行块注释状态机不做：raw string 里恰有 ` * ` 开头行的罕见
 *  场景，漏剥只是多活（安全方向），误剥会假死（危险方向）——只剥形态无
 *  歧义的行。注：本注释避免书写字面量星斜杠序列，防止提前终止块注释。 */
export function stripGoCommentishLines(src: string): string {
  return src
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .map((l) => (/^\s*\*(\s|\/|$)/.test(l) ? '' : l))
    .join('\n');
}

export function qualifierLines(src: string, qualifier: string, lang: 'go' | 'ts' | 'go-bare'): number[] {
  // 'go'：注释剔除 + Q. 成员访问；'go-bare'：注释剔除 + 裸名（同包兄弟扫描
  // 用——Go 源码走 'ts' 裸名模式时不剥注释，注释里的同名出现曾把死符号误活）；
  // 'ts'：裸名（TS 无行注释剔除）
  const scan = lang === 'ts' ? src : stripGoCommentishLines(src);
  const q = qualifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = lang === 'go' ? new RegExp(`\\b${q}\\.`, 'g') : new RegExp(`\\b${q}\\b`, 'g');
  const lines: number[] = [];
  let offset = 0;
  for (const chunk of scan.split('\n')) {
    offset += 1;
    if (re.test(chunk)) lines.push(offset);
    re.lastIndex = 0;
  }
  return lines;
}

/** Go 源码中限定符成员引用（Q.Name）：出现行 + 成员名。
 *  注释剔除同 qualifierLines（行注释 + 块注释中段行，URL 字符串保护）。 */
export function qualifierMemberLines(src: string, qualifier: string): Array<{ line: number; member: string }> {
  const scan = stripGoCommentishLines(src);
  const q = qualifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${q}\\.(\\w+)`, 'g');
  const out: Array<{ line: number; member: string }> = [];
  let offset = 0;
  for (const chunk of scan.split('\n')) {
    offset += 1;
    re.lastIndex = 0;
    for (let m = re.exec(chunk); m !== null; m = re.exec(chunk)) {
      out.push({ line: offset, member: m[1] });
    }
  }
  return out;
}

/** TS/JS 源码剥离 import/require 语句（占位换行保行号）：
 *  import 语句本身含绑定名（`import { dead } from 'deaddep'`），不剥会被
 *  当成"包级出现"误判活；解构 require 行同理。
 *  终止符用 `from '模块'` / `from "模块"`（import 语句的真实结构），**不依赖分号**——
 *  无分号风格的项目里 `/import[^;]*?;/` 会从第一个 import 贪婪吞到远处某个 `;`，
 *  把夹在中间的**使用行**一起抹掉（曾把 pet 渲染器 `image: ImageRenderer` 的活跃
 *  消费误判成死、误标下线候选）。以 `from` 定界则只在 import 语句自身范围内剔除，
 *  绝不越过模块说明符吞掉后续使用行。副作用导入 `import 'x'`（无 from）与动态
 *  `import(...)`（无 from）不匹配 → 保守保留（安全方向）。 */
export function stripTsImportLines(src: string): string {
  return src
    .replace(/^import\s+(?:type\s+)?[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, (m) => m.replace(/[^\n]/g, ' '))
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
  /** 值可达文件集（harvest_closure.value_files）：从种子只沿值 import 边可达。
   *  TS 顶层 const 的"模块初始化即执行"特权只对值可达文件生效——type 边拉进
   *  闭包的纯类型文件运行时不加载，其 const 不执行、三方依赖判死候选。
   *  缺省 = 全部闭包文件按值可达处理（向后兼容旧调用方） */
  valueFiles?: string[];
}): DeadDepsResult {
  const { db, projectDir, closureFiles, seedFiles } = opts;
  const seedSet = new Set(seedFiles);
  const valueSet = new Set(opts.valueFiles ?? closureFiles);
  const goDir = (f: string): string => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');

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
  // 根：种子文件全部符号 + 值可达文件的 TS 顶层 const（模块初始化即执行
  //     ——但只在运行时真加载的模块里成立：type 边拉进闭包的纯类型文件
  //     （configs/registry 全家）不加载，其 const 不进根、其三方依赖判死；
  //     Go 包级 var 不进符号索引，落在符号 span 外由包活性规则 2.6 管理）。
  //     Go init 不进根：包活才活（2.6）——死包的 init 永不执行
  const live = new Set<string>();
  const queue: string[] = [];
  for (const s of symbols) {
    const isTsTopConst =
      s.kind === 'const' && s.parent === null && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(s.file_path);
    if (seedSet.has(s.file_path) || (isTsTopConst && valueSet.has(s.file_path))) {
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

  // ── 2.5 Go 跨文件符号边补齐 ──
  // edges 表的 call/type_ref 只有同文件边——跨文件解析（resolveCrossFileCalls）
  // 只认 TS relative imports，Go 包导入（kind='package'）不进该通道：
  // 跨包引用（model.User）与同包兄弟文件引用（Helper()）对 BFS 不可见，
  // 活符号传不过文件边界 → 目标文件 keep 集全空 → 整文件误剪。
  // 补法（纯源码扫描；误连只会多活——宁漏报死候选，不误报）：
  //   a) 包限定符引用：import 限定符 Q 的 Q.Name 出现处归属最内层符号 →
  //      边到目标包（resolveImport 权威解析，与 harvest_closure 同规则）同名符号
  //   b) 同包兄弟引用：同目录（Go 包=目录）其他文件的顶层符号名裸出现 → 边
  //      （方法经接收者调用，由方法挂靠规则覆盖）
  //   c) 包级出现（符号 span 外）：包活才活——收集进 pkgLevelPending（按
  //      引用方文件所在目录），由 2.6 包活性不动点延迟激活；空/点导入的
  //      内部目标包收集进 sideEffectByDir，同样延迟激活
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
  const pkgLevelPending = new Map<string, Set<string>>();
  const pendPkgLevel = (fromFile: string, symbolId: string): void => {
    const dir = goDir(fromFile);
    let set = pkgLevelPending.get(dir);
    if (!set) pkgLevelPending.set(dir, (set = new Set()));
    set.add(symbolId);
  };
  const sideEffectByDir = new Map<string, Set<string>>();
  const goClosureFiles = closureFiles.filter((f) => f.endsWith('.go'));
  if (goClosureFiles.length > 0) {
    const addDerived = (from: string, to: string): void => {
      if (!symbolIds.has(from) || !symbolIds.has(to)) return;
      let arr = adj.get(from);
      if (!arr) adj.set(from, (arr = []));
      if (!arr.includes(to)) arr.push(to);
    };
    const fileEntries: FileEntry[] = goClosureFiles.map((rel) => ({
      rel,
      abs: path.join(projectDir, rel),
      ext: '.go',
      dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
    }));
    const entryByRel = new Map(fileEntries.map((e) => [e.rel, e]));
    const index = buildIndex(fileEntries);
    const goModules = readGoModules(projectDir);
    const stmtGoImports = db.prepare(
      'SELECT source, line, kind, type_only FROM imports WHERE file_path = ?',
    );
    const symbolsByNameByFile = new Map<string, Map<string, SymbolRow[]>>();
    for (const f of goClosureFiles) {
      const m = new Map<string, SymbolRow[]>();
      for (const s of byFile.get(f) ?? []) {
        let arr = m.get(s.name);
        if (!arr) m.set(s.name, (arr = []));
        arr.push(s);
      }
      symbolsByNameByFile.set(f, m);
    }

    // a) 包限定符引用边
    for (const f of goClosureFiles) {
      const src = readSrc(f);
      if (!src) continue;
      const quals = parseGoImportQualifiers(src);
      const fileSyms = byFile.get(f) ?? [];
      const rows = stmtGoImports.all(f) as Array<{
        source: string;
        line: number;
        kind: string;
        type_only: number;
      }>;
      for (const r of rows) {
        if (r.type_only === 1 || r.kind !== 'package') continue;
        const qc = quals.get(r.source);
        const targets = resolveImport(
          { source: r.source, kind: 'package', line: r.line },
          entryByRel.get(f)!,
          index,
          goModules,
        );
        if (qc !== undefined && qc.some((x) => x === '.' || x === '_')) {
          // 空/点导入的内部包：import 即执行副作用——fromDir 包活时目标包
          // 激活（2.6：目标包 init/包级代码执行）
          if (targets.length > 0) {
            const fromDir = goDir(f);
            let set = sideEffectByDir.get(fromDir);
            if (!set) sideEffectByDir.set(fromDir, (set = new Set()));
            for (const t of targets) set.add(goDir(t.rel));
          }
          continue;
        }
        if (qc === undefined || targets.length === 0) continue;
        for (const q of qc) {
          for (const hit of qualifierMemberLines(src, q)) {
            const owner = enclosingSymbol(fileSyms, hit.line);
            for (const t of targets) {
              for (const x of symbolsByNameByFile.get(t.rel)?.get(hit.member) ?? []) {
                if (owner) addDerived(owner.id, x.id);
                else pendPkgLevel(f, x.id); // 包级出现（c）：包活才活
              }
            }
          }
        }
      }
    }

    // b) 同包兄弟顶层符号裸引用边
    const goFilesByDir = new Map<string, string[]>();
    for (const f of goClosureFiles) {
      const dir = goDir(f);
      let arr = goFilesByDir.get(dir);
      if (!arr) goFilesByDir.set(dir, (arr = []));
      arr.push(f);
    }
    for (const files of goFilesByDir.values()) {
      if (files.length < 2) continue;
      for (const f of files) {
        const src = readSrc(f);
        if (!src) continue;
        const fileSyms = byFile.get(f) ?? [];
        for (const g of files) {
          if (g === f) continue;
          for (const s of byFile.get(g) ?? []) {
            if (s.parent !== null) continue;
            for (const line of qualifierLines(src, s.name, 'go-bare')) {
              const owner = enclosingSymbol(fileSyms, line);
              if (owner) addDerived(owner.id, s.id);
              else pendPkgLevel(f, s.id); // 包级引用（c）：包活才活
            }
          }
        }
      }
    }
  }

  // ── 2.6 Go 包活性不动点 ──
  // Go linker 语义的源码级复刻：包活 ⇔ 被存活代码 import ⇔ 目录内有 live
  // 符号（引用必经 import）；或被存活目录内文件的空/点导入（import 即执行
  // 副作用）。包活 ⇒ 包级初始化执行：init 函数、包级 var 表达式
  // （pkgLevelPending 收集的 span 外引用）、空/点导入目标包的顶层符号全部
  // 激活——激活产生新的 live 符号/新的包活，级联到不动点。死包（闭包整
  // 目录端走的无关文件、只被死代码引用的包）的包级代码永不执行：不激活，
  // 其依赖才能按死候选报告（go-slim 剪刀同规则：keep 集空 → 整文件剔除）。
  const aliveDirs = new Set<string>();
  const activatedDirs = new Set<string>();
  const initSymbols = symbols.filter(
    (s) => s.name === 'init' && s.parent === null && s.file_path.endsWith('.go'),
  );
  const markLive = (id: string): void => {
    if (live.has(id)) return;
    live.add(id);
    queue.push(id);
    const sym = symById.get(id);
    if (sym && sym.file_path.endsWith('.go')) {
      const dir = goDir(sym.file_path);
      if (!aliveDirs.has(dir)) {
        aliveDirs.add(dir);
        activateDir(dir);
      }
    }
  };
  function activateDir(dir: string): void {
    if (activatedDirs.has(dir)) return;
    activatedDirs.add(dir);
    for (const s of initSymbols) {
      if (goDir(s.file_path) === dir) markLive(s.id);
    }
    for (const id of pkgLevelPending.get(dir) ?? []) markLive(id);
    for (const toDir of sideEffectByDir.get(dir) ?? []) {
      if (aliveDirs.has(toDir)) continue;
      aliveDirs.add(toDir);
      // 空/点导入目标包：init/包级代码执行；顶层符号保守全活（点导入把
      // 名字直接引进作用域；空导入严格只需 init+var——全活只是多保，安全向）
      for (const s of symbols) {
        if (s.parent === null && goDir(s.file_path) === toDir) markLive(s.id);
      }
      activateDir(toDir);
    }
  }
  // 初始：种子 live 符号所在目录先激活（init/包级引用/副作用导入级联入队）
  for (const id of [...live]) {
    const sym = symById.get(id);
    if (sym?.file_path.endsWith('.go')) {
      const dir = goDir(sym.file_path);
      if (!aliveDirs.has(dir)) {
        aliveDirs.add(dir);
        activateDir(dir);
      }
    }
  }

  for (; queue.length > 0; ) {
    const batch = queue.splice(0);
    for (const id of batch) {
      const sym = symById.get(id);
      if (sym && (sym.kind === 'type' || sym.kind === 'class' || sym.kind === 'interface')) {
        activateChildren(sym);
      }
      for (const next of adj.get(id) ?? []) markLive(next);
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

  for (const f of closureFiles) {
    const isGo = f.endsWith('.go');
    const isTs = /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f);
    if (!isGo && !isTs) continue;
    // Go 包活性（2.6）：死包的包级出现/空导入不保活依赖；TS 恒活
    const dirAlive = !isGo || aliveDirs.has(goDir(f));
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
        if (q === undefined || q.some((x) => x === '.' || x === '_')) {
          if (dirAlive) a.liveHit = true; // 点导入/空导入/解析失败：包活才执行副作用
          continue;
        }
        quals = q;
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
            // 包级/模块级作用域：import 即执行的副作用——Go 须包活（死包
            // 的包级代码永不执行）；TS 模块可达恒执行
            if (dirAlive) a.liveHit = true;
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

  // live 明细（剪刀 keep 集）：文件 → 顶层符号名；类型名单独汇总
  const liveByFile: Record<string, string[]> = {};
  const liveTypeNames = new Set<string>();
  for (const id of live) {
    const sym = symById.get(id);
    if (!sym) continue;
    (liveByFile[sym.file_path] ??= []).push(sym.name);
    if (sym.kind === 'type' || sym.kind === 'class' || sym.kind === 'interface') {
      liveTypeNames.add(sym.name);
    }
  }
  for (const f of Object.keys(liveByFile)) liveByFile[f].sort();

  return {
    live_symbols: live.size,
    total_symbols: symbols.length,
    dead,
    limitations: LIMITATIONS,
    live_symbols_by_file: liveByFile,
    live_type_names: [...liveTypeNames].sort(),
  };
}
