/**
 * go_instrument —— 把 go-observe 的 Go 插桩器桥接进 design-canvas 工具面。
 *
 * 背景：observe_instrument 原本只支持 TS（instrumentProject，往 .ts 插 captureProbe）；
 * Go 工程的自动插桩（go-observe：go/ast 注入 camprobe.Capture）退在同一仓库但没接线。
 * 本模块把它接上：检测是否 Go 工程 → 驱动 `go run ./cmd/instrument`（go-observe）→
 * 解析统一报告 {files:[{file,sites:[{line,kind,level,probe}]}], restored}。
 *
 * 运行前提：被测 Go 工程须能编译含 `import camprobe "go-observe/probe"` 的代码，
 * 即需在其 go.mod 加 replace/require 指向 go-observe（插桩本身不校验，编译时见）。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface GoSite { line: number; kind: string; level: string; probe: string }
export interface GoFileResult { file: string; sites: GoSite[]; error?: string }
export interface GoInstrumentOut { files: GoFileResult[]; restored: number }

export interface GoInstrumentOptions {
  dryRun?: boolean;
  deep?: boolean;
  effects?: boolean;
  contractProbes?: string[];
}

/** 是否 Go 工程：目录含 go.mod 且含离散 .go 文件（排除 .design-canvas/node_modules）。 */
function scanDir(root: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (e.name === '.design-canvas' || e.name === 'node_modules' || e.name === '.git' || e.name === 'bin') continue;
      if (scanDir(path.join(root, e.name))) return true;
    } else if (e.name.endsWith('.go') && !e.name.endsWith('_test.go')) {
      return true;
    }
  }
  return false;
}

export function isGoProject(root: string): boolean {
  try {
    if (!fs.existsSync(path.join(root, 'go.mod'))) return false;
    return scanDir(root);
  } catch { return false; }
}

/** 定位 go-observe 模块目录（含 go.mod 的 go-observe）。env DC_GO_OBSERVE_DIR 优先。 */
export function goObserveDir(): string {
  if (process.env.DC_GO_OBSERVE_DIR && fs.existsSync(path.join(process.env.DC_GO_OBSERVE_DIR, 'go.mod'))) {
    return process.env.DC_GO_OBSERVE_DIR;
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const cand = path.join(dir, 'go-observe');
    if (fs.existsSync(path.join(cand, 'go.mod'))) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未定位 go-observe 模块目录（可设环境变量 DC_GO_OBSERVE_DIR）');
}

function runGo(moduleDir: string, args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('go', args, { cwd: moduleDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.kill('SIGKILL');
      reject(new Error(`go-observe 插桩执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 go（请确认已安装 Go 工具链）：${e.message}`));
    });
    p.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) reject(new Error((err || `go 退出码 ${code}`).trim().slice(0, 300)));
      else resolve(out);
    });
  });
}

function parseReport(raw: string): GoInstrumentOut {
  try {
    return JSON.parse(raw.trim()) as GoInstrumentOut;
  } catch {
    return { files: [], restored: 0 };
  }
}

/** 对 Go 工程插桩（或 dry-run）。返回与 go-observe CLI 一致的报告。 */
export async function instrumentGoProject(root: string, opts: GoInstrumentOptions = {}): Promise<GoInstrumentOut> {
  const mod = goObserveDir();
  const args = ['run', './cmd/instrument', root];
  if (opts.dryRun) args.push('--dry-run');
  if (opts.deep) args.push('--deep');
  if (opts.effects) args.push('--effects');
  if (opts.contractProbes && opts.contractProbes.length > 0) {
    args.push('--probes', JSON.stringify(opts.contractProbes));
  }
  const raw = await runGo(mod, args);
  return parseReport(raw);
}

/** 一键还原被插桩的 Go 工程（从 .design-canvas/observe-backup 拷回原文件并删备份）。 */
export async function restoreGoProject(root: string): Promise<number> {
  const mod = goObserveDir();
  const raw = await runGo(mod, ['run', './cmd/instrument', root, '--restore']);
  const rep = parseReport(raw);
  return rep.restored ?? 0;
}

/** 统计报告（与 TS instrument 一致的展示形态） */
export function goReportSummary(rep: GoInstrumentOut): { totalSites: number; instrumented: number; skipped: number; errors: number } {
  let totalSites = 0, instrumented = 0, skipped = 0, errors = 0;
  for (const f of rep.files) {
    if (f.error) errors++;
    else if (f.sites.length > 0) { instrumented++; totalSites += f.sites.length; }
    else skipped++;
  }
  return { totalSites, instrumented, skipped, errors };
}

// ─────────────────────────────────────────────
// 被测 Go 工程接 go-observe（go.mod replace/require）
// instrument 注入 `import camprobe "go-observe/probe"`，被测工程须能解析该模块，
// 否则插桩后编译报错。本函数检查/补连接（默认 dry-run 预览，可实际写）。
// ─────────────────────────────────────────────

const GO_OBSERVE_MODULE = 'go-observe';

export interface GoDepsCheck {
  /** 是否需要补 replace（false=工程已能解析 go-observe） */
  needs_replace: boolean;
  /** 是否需要补 require */
  needs_require: boolean;
  /** 若需补，写入的前缀行（require/replace），已在行内带路径 */ 
  require_line?: string;
  replace_line?: string;
  /** 若已就绪，简要说明 */
  note?: string;
}

/** 检查被测工程 go.mod 是否已能解析 go-observe（有 require + 有 replace 指向 go-observe）。 */
export function checkGoObserveDeps(root: string, moduleDir?: string): GoDepsCheck {
  const modPath = path.join(root, 'go.mod');
  let src = '';
  try { src = fs.readFileSync(modPath, 'utf-8'); } catch {
    return { needs_replace: true, needs_require: true, require_line: `require ${GO_OBSERVE_MODULE} v0.0.0`, replace_line: `// 无 go.mod：${modPath}`, note: '目标目录缺少 go.mod，插桩需先有可编译的 Go 工程' };
  }
  const hasRequire = new RegExp(`(^|\\s)require\\s+${GO_OBSERVE_MODULE}\\b`, 'm').test(src);
  const hasBlockRequire = new RegExp(`require\\s*\\([^)]*${GO_OBSERVE_MODULE}`, 's').test(src);
  const needsRequire = !(hasRequire || hasBlockRequire);
  const hasReplace = new RegExp(`replace\\s+${GO_OBSERVE_MODULE}\\s*=>`).test(src);
  const needsReplace = !hasReplace;
  if (!needsRequire && !needsReplace) {
    return { needs_replace: false, needs_require: false, note: 'go.mod 已含 go-observe 的 require 与 replace，可直接编译插桩后代码' };
  }
  const goDir = moduleDir ?? (() => { try { return goObserveDir(); } catch { return ''; } })();
  const replacePath = goDir ? JSON.stringify(goDir.replace(/\\/g, '/')) : `<go-observe 模块目录>`;
  return {
    needs_replace: needsReplace,
    needs_require: needsRequire,
    require_line: `require ${GO_OBSERVE_MODULE} v0.0.0`,
    replace_line: `replace ${GO_OBSERVE_MODULE} => ${replacePath}`,
    note: `待补 require + replace（指向 ${goDir || 'go-observe 模块目录'}）`,
  };
}

/** 补桥：把 go-observe 的 require/replace 追加到被测工程 go.mod（默认 dry-run 只返回将写内容）。
 *  返回是否实际写盘 changed。 */
export function ensureGoObserveIntegration(root: string, moduleDir?: string, write = false): { changed: boolean; check: GoDepsCheck } {
  const check = checkGoObserveDeps(root, moduleDir);
  if (!check.needs_require && !check.needs_replace) return { changed: false, check };
  if (!write) return { changed: false, check };
  const modPath = path.join(root, 'go.mod');
  let src = '';
  try { src = fs.readFileSync(modPath, 'utf-8'); } catch { return { changed: false, check }; }
  const adds: string[] = [];
  if (check.needs_require && check.require_line) adds.push(check.require_line);
  if (check.needs_replace && check.replace_line && !check.replace_line.startsWith('//')) adds.push(check.replace_line);
  if (adds.length === 0) return { changed: false, check };
  const sep = src.endsWith('\n') ? '' : '\n';
  const next = src + sep + '\n' + adds.join('\n') + '\n';
  try { fs.writeFileSync(modPath, next, 'utf-8'); } catch { return { changed: false, check }; }
  return { changed: true, check };
}