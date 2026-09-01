/**
 * install_package_cli —— 语言包按需安装 CLI（install-package）
 *
 * 背景：ts_kernel 的 probe 运行时动态扫 node_modules——装了哪个 tree-sitter 语言包，
 * 对应语言的 AST 解析就启用；没装则静默跳过（优雅降级）。所以「语言包化」的落地点是
 * rewrite 一份「按需安装」命令，而不是改动 kernel 的装配机制。
 *
 * 做法：
 *   - 6 个跨语言解析器（go/python/java/rust/c_sharp/php）已从硬依赖迁到
 *     optionalDependencies——默认 `npm install` 仍会装，`npm install --omit=optional`
 *     可减负。TS/JS/TSX 是工具链自身语言，恒为硬依赖，不受影响。
 *   - 本 CLI 提供 install/uninstall/list，把「装哪个语言包 + 钉死 ABI 兼容版本」
 *     收敛成一条命令，避免用户手抄 `tree-sitter@0.21` 的 peer 约束踩坑。
 *
 * 用法：
 *   node dist/src/tools/install_package_cli.js list
 *   node dist/src/tools/install_package_cli.js install go python
 *   node dist/src/tools/install_package_cli.js uninstall rust
 *   node dist/src/tools/install_package_cli.js index [--json <out.json>]   # GitHub 分发索引
 *   node dist/src/tools/install_package_cli.js list --json <out.json>
 *
 * 对齐上游 tree-sitter 分发模型：
 *   - install 后自动做 ABI 运行时校验（读包 peerDependencies.tree-sitter vs 已装核心）
 *   - install 后提示当前平台是否有 prebuild（缺则可能现场 node-gyp 编译）
 *   - `index` 输出语言↦GitHub 上游语法仓库 + npm 包 + ABI 钉版，供 GitHub 侧分发/文档引用
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LANGUAGES } from './ts_kernel/languages.js';

/**
 * 语言包 ABI 钉版表：已实测与 `tree-sitter@0.21` 核心兼容的版本（含 bindings 导出 .language）。
 * 加语言包 = 在此登记 {pkg 版本} + 在 LANGUAGES/适配器/resolver 各加一行。
 */
const PACK_PINS: Record<string, string> = {
  go: '^0.21.2',
  python: '^0.21.0',
  java: '^0.23.5',
  rust: '^0.21.0',
  'c-sharp': '^0.21.3', // note: LANGUAGES.pkg 用的是 'c-sharp'（tree-sitter-c-sharp）
  php: '^0.23.12',
};

/** 语言包清单行（导出供单测/JSON 输出） */
export interface LangPackRow {
  /** LANGUAGES 中的语言名（即 languages.ts 的 name） */
  lang: string;
  /** npm 包名（tree-sitter-{pkg}） */
  pkg: string;
  /** 钉版版本范围 */
  pin?: string;
  /** 是否已安装（node_modules 里存在该包） */
  installed: boolean;
  /** 已安装版本 */
  installedVersion?: string;
  /** 是否深适配语言（有 import 边/调用边提取） */
  adapted: boolean;
}

/** 派生语言：没有独立 npm 包，语法随父包（如 tsx 随 tree-sitter-typescript、jsx 随 tree-sitter-javascript）。不可独立安装。 */
const DERIVED: Record<string, string> = { tsx: 'typescript', jsx: 'javascript' };

/** 读某 npm 包的 package.json（node_modules/{name}/package.json），不存在返回 null */
function readPkgJson(name: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(findNodeModulesRoot(), name, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/** 已装 tree-sitter 核心版本（node_modules/tree-sitter/package.json 的 version） */
function coreTreeSitterVersion(): string | undefined {
  const j = readPkgJson('tree-sitter');
  return typeof j?.version === 'string' ? j.version : undefined;
}

/** 版本三元组参与数（去预发布/补零），返回 [maj,min,pat, 显式声明的组件数] */
function parseVer(s: string): [number, number, number, number] {
  const p = s.trim().replace(/-.*$/, '').split('.');
  const num = (i: number): number => Number.isFinite(Number(p[i])) ? Number(p[i]) : 0;
  const count = Math.max(1, p.filter((_, i) => i < 3 && Number.isFinite(Number(p[i]))).length);
  return [num(0), num(1), num(2), count];
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * 极简 semver 范围匹配（不引 semver 依赖），够用于提示型 ABI 校验：
 *   - `^0.21.0` → [0.21.0, 0.22.0)（caret：bump 有显式值的最低组件）
 *   - `~0.21`  → [0.21.0, 0.22.0)；`~0.21.0` → [0.21.0, 0.21.1)
 *   - `>=0.21.0` → 单下限
 *   - 纯版本 / 别名（latest）→ 默认通过（不误报）
 * 拿不准时返回 true。
 */
export function rangeOk(range: string, version: string): boolean {
  const r = range.trim();
  const v = version.trim();
  const vv = parseVer(v);
  const m = r.match(/^(\^|~|>=?|<=?)?\s*(\d+(?:\.\d+){0,2})/);
  if (!m) return true; // 别名/裸 latest 之类 → 不误报
  const op = m[1] || '';
  const target = parseVer(m[2]);
  const [tmaj, tmin, tpat] = target;
  const tcount = target[3];
  if (op === '>=' || op === '>') return cmp([vv[0], vv[1], vv[2]], [tmaj, tmin, tpat]) >= (op === '>' ? 1 : 0);
  if (op === '<=' || op === '<') return cmp([vv[0], vv[1], vv[2]], [tmaj, tmin, tpat]) <= (op === '<' ? -1 : 0);
  if (op === '^' || op === '~') {
    if (cmp([vv[0], vv[1], vv[2]], [tmaj, tmin, tpat]) < 0) return false; // 低于下限
    const bump = op === '~' ? Math.max(0, tcount - 1) : (tmaj > 0 ? 0 : (tmin > 0 ? 1 : 2));
    // bump 位即上界的前一组件：bump 0 → pat 到 99 都行（主版本内）；这里简化为主版本内
    if (bump === 0) return vv[0] === tmaj;
    if (bump === 1) return vv[0] === tmaj && vv[1] < tmin + 1;
    return vv[0] === tmaj && vv[1] === tmin && vv[2] < tpat + 1;
  }
  // 精确版本（无操作符）→ 同主版本（宽松）
  return vv[0] === tmaj;
}

/**
 * ABI 运行时校验（install 后）：读已装语言包 peerDependencies.tree-sitter，与核心版本比对。
 * 返回告警列表（空=兼容）。
 */
export function verifyAbi(pkg: string): string[] {
  const j = readPkgJson(`tree-sitter-${pkg}`);
  if (!j) return [];
  const core = coreTreeSitterVersion();
  if (!core) return [`${pkg}: 无法读取核心 tree-sitter 版本，跳过 ABI 校验`];
  const peer = (j.peerDependencies as Record<string, unknown> | undefined)?.['tree-sitter'];
  if (typeof peer !== 'string') return [];
  if (!rangeOk(peer, core)) {
    return [`${pkg}: 声明的 peer tree-sitter「${peer}」，但已装核心 v${core} —— ABI 可能不兼容（建议统一到同一核心版本）`];
  }
  return [];
}

/** 平台 prebuild 提示：检查 package 是否带当前平台的预编译 .node（缺则 install 时可能现场 node-gyp 编译） */
export function checkPrebuild(pkg: string): string[] {
  const nm = findNodeModulesRoot();
  const dir = path.join(nm, `tree-sitter-${pkg}`);
  const plat = process.platform; // win32 / darwin / linux
  const arch = process.arch; // x64 / arm64
  const tag = `${plat}-${arch}`;
  const prebuildDir = path.join(dir, 'prebuilds', tag);
  const has = (() => {
    try {
      return fs.readdirSync(prebuildDir).some((f) => f.endsWith('.node'));
    } catch {
      return false;
    }
  })();
  if (!has) {
    return [`${pkg}: 未找到 ${tag} 预编译产物（prebuilds/${tag}）——若需在本机多个平台运行，可能依靠 install 时 node-gyp 现场编译`];
  }
  return [];
}

function isInstalled(pkg: string): { installed: boolean; version?: string } {
  // 纯 fs 探 node_modules/tree-sitter-{pkg}/package.json（ESM 无 require；口径与 ts_kernel/probe 一致）。
  // 从模块位置（dist/src/tools/install_package_cli.js）和 cwd 向上找最近的 node_modules（同 probe.getNodeModulesRoot）。
  const nm = findNodeModulesRoot();
  const dir = path.join(nm, `tree-sitter-${pkg}`);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    return { installed: true, version: typeof j.version === 'string' ? j.version : undefined };
  } catch {
    return { installed: false };
  }
}

/** 向上找最近的 node_modules 根（从模块自身位置 + cwd 两路，保证任何工作目录下都找到项目包） */
function findNodeModulesRoot(): string {
  const candidates = new Set<string>();
  const pushAncestors = (start: string): void => {
    let d = start;
    while (d !== path.dirname(d)) {
      candidates.add(d);
      d = path.dirname(d);
    }
  };
  const fileDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  pushAncestors(fileDir);
  pushAncestors(process.cwd());
  for (const c of candidates) {
    const p = path.join(c, 'node_modules');
    if (fs.existsSync(p)) return p;
  }
  return path.join(process.cwd(), 'node_modules');
}

/** 纯计算：语言包清单（导出供单测；CLI list 也复用此数据源） */
export function collect(): LangPackRow[] {
  // 所有 tree-sitter 语言（含未深适配的，如 typescript/js/javascript）都进清单，便于 list 全览
  const rows: LangPackRow[] = [];
  for (const l of LANGUAGES) {
    if (!l.pkg) continue;
    // 派生语言（tsx/jsx）随父包判定已装；不可独立 install/uninstall
    const parent = DERIVED[l.pkg];
    const { installed, version } = isInstalled(parent ?? l.pkg);
    rows.push({
      lang: l.name,
      pkg: l.pkg,
      pin: PACK_PINS[l.pkg],
      installed,
      installedVersion: version,
      adapted: l.import_nodes && l.import_nodes.length > 0 ? true : false,
    });
  }
  // 按「深适配 + 未装」优先排序，方便一眼看到还能补的
  rows.sort((a, b) => (a.adapted === b.adapted ? (a.installed === b.installed ? a.lang.localeCompare(b.lang) : (a.installed ? 1 : -1)) : (a.adapted ? -1 : 1)));
  return rows;
}

function findRowByName(rows: LangPackRow[], key: string): LangPackRow | undefined {
  return rows.find((r) => r.lang === key || r.pkg === key);
}

function runNpm(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    cwd: path.dirname(findNodeModulesRoot()),
  });
  return { status: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

/** 每个语言包对应的 GitHub 上游语法仓库（tree-sitter 官方组织尽力对齐；未登记路径按 tree-sitter-{pkg} 推断） */
const GH_SOURCES: Record<string, string> = {
  go: 'https://github.com/tree-sitter/tree-sitter-go',
  python: 'https://github.com/tree-sitter/tree-sitter-python',
  java: 'https://github.com/tree-sitter/tree-sitter-java',
  rust: 'https://github.com/tree-sitter/tree-sitter-rust',
  'c-sharp': 'https://github.com/tree-sitter/tree-sitter-c-sharp',
  php: 'https://github.com/tree-sitter/tree-sitter-php',
  javascript: 'https://github.com/tree-sitter/tree-sitter-javascript',
  typescript: 'https://github.com/tree-sitter/tree-sitter-typescript',
};
/** 兜底：官方组织统一走 `tree-sitter/tree-sitter-{pkg}`（多数语法都在该组织），登记外语言按此推断 */
function ghSource(pkg: string): string {
  return GH_SOURCES[pkg] ?? `https://github.com/tree-sitter/tree-sitter-${pkg}`;
}
/** 导出供测试 */
export { ghSource };

function main(): void {
  const args = process.argv.slice(2);
  const jsonOutIdx = args.indexOf('--json');
  const jsonOut = jsonOutIdx >= 0 && args[jsonOutIdx + 1] ? path.resolve(args[jsonOutIdx + 1]) : undefined;
  const cmd = args[0] ?? 'list';
  const targets = args.slice(1).filter((a) => !a.startsWith('--'));

  const rows = collect();

  if (cmd === 'list') {
    const lines = rows.map((r) => {
      const derived = DERIVED[r.pkg];
      const status = r.installed ? (r.installedVersion === (r.pin ? r.pin.replace('^', '') : '') ? '✓' : `✓ v${r.installedVersion}`) : '–';
      const adapted = r.adapted ? '深适配' : '通用';
      const hint = derived
        ? `(随 tree-sitter-${derived})`
        : r.installed
          ? ` (v${r.installedVersion})`
          : `  → npm i tree-sitter-${r.pkg}@${r.pin ?? 'latest'}`;
      return `${status.padEnd(8)} ${r.pkg.padEnd(18)} ${adapted}${r.pin && !derived ? ` 钉版 ${r.pin}` : ''} ${hint}`;
    });
    console.log(['语言包清单（path: node_modules/tree-sitter-*；装即用，未装静默跳过）：', ...lines].join('\n'));
    if (jsonOut) {
      fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
      fs.writeFileSync(jsonOut, JSON.stringify(rows, null, 2), 'utf-8');
      console.log(`\n[install-package] JSON → ${jsonOut}`);
    }
    return;
  }

  // index：GitHub 分发索引（语言↦上游语法仓库 + npm 包 + 钉版），供 GitHub 侧分发/文档引用
  if (cmd === 'index') {
    const index = rows.map((r) => ({
      lang: r.lang,
      pkg: `tree-sitter-${r.pkg}`,
      pin: DERIVED[r.pkg] ? undefined : (r.pin ?? 'latest'),
      adapted: r.adapted,
      github: DERIVED[r.pkg] ? ghSource(DERIVED[r.pkg]) : ghSource(r.pkg),
      note: DERIVED[r.pkg] ? `派生语法，随 tree-sitter-${DERIVED[r.pkg]}` : undefined,
    }));
    const out = index;
    const text = [
      '# 语言包分发索引（GitHub）',
      '',
      `> 生成时间：${new Date().toISOString()} · 核心 tree-sitter v${coreTreeSitterVersion() ?? '?'}（ABI 钉版基准）`,
      '> 每个语言包 = 独立 npm 包 + 上游语法仓库。安装 `npm run install-package install <lang>`；',
      '> 移除依赖 `npm i --omit=optional` 时可整体减负，装哪个用哪个。',
      '',
      '## 深适配语言（可被闭包/引用图消费）',
      '',
      '| 语言 | npm 包 | ABI 钉版 | GitHub 上游语法仓库 |',
      '| --- | --- | --- | --- |',
      ...index.filter((x) => x.adapted).map((x) => `| ${x.lang} | \`${x.pkg}\` | ${x.pin ?? '（派生，随父包）'} | [${x.github}](${x.github}) |`),
      '',
      '## 通用语言（AST 解析，不参与跨文件引用图）',
      '',
      '| 语言 | npm 包 | GitHub 上游语法仓库（推断） |',
      '| --- | --- | --- |',
      ...index.filter((x) => !x.adapted).map((x) => `| ${x.lang} | \`${x.pkg}\` | [${x.github}](${x.github}) |`),
      '',
    ].join('\n');
    console.log(text);
    if (jsonOut) {
      fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
      fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2), 'utf-8');
      console.log(`\n[install-package] JSON → ${jsonOut}`);
    }
    return;
  }

  // install / uninstall：只允许操作「已知语言」的包（不随意装未知包）
  const unknown = targets.filter((t) => !findRowByName(rows, t));
  if (unknown.length > 0) {
    console.error(`✗ 未知语言：${unknown.join(', ')}\n  已知：${rows.map((r) => r.lang).join(', ')}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('✗ 需要指定语言名（list 查看可用语言）');
    process.exit(1);
  }
  // 派生语言（tsx/jsx 无独立包）不可 install/uninstall
  const derived = targets.filter((t) => DERIVED[findRowByName(rows, t)!.pkg]);
  if (derived.length > 0) {
    console.error(`✗ ${derived.join(', ')} 是派生语法（随父语言包），无需独立安装：tsx→tree-sitter-typescript、jsx→tree-sitter-javascript`);
    process.exit(1);
  }

  if (cmd === 'install') {
    const pkgs = targets.map((t) => {
      const r = findRowByName(rows, t)!;
      const pinned = PACK_PINS[r.pkg] ?? 'latest';
      // 派生语言不可独立装（已在上方拦截）；这里只需真实包
      return `tree-sitter-${r.pkg}@${pinned}`;
    });
    console.log(`[install-package] npm install ${pkgs.join(' ')} --save-optional`);
    const res = runNpm(['install', ...pkgs, '--save-optional', '--no-audit', '--no-fund']);
    console.log(res.out.slice(-2000));
    if (res.status !== 0) {
      console.error(`✗ 安装失败（退出码 ${res.status}）`);
      process.exit(1);
    }
    console.log('\n✓ 已安装。ts_kernel probe 会在下次进程重启后自动启用对应语言。');
    // 对齐上游：装后做 ABI 运行时校验 + 平台 prebuild 提示
    const resolved = targets.map((t) => findRowByName(rows, t)!.pkg);
    const abiWarnings: string[] = [];
    const prebuildWarnings: string[] = [];
    for (const pkg of resolved) {
      if (DERIVED[pkg]) continue; // 派生语言随父包，校验父包（已在数组里如含 typescript 则校验）
      abiWarnings.push(...verifyAbi(pkg));
      prebuildWarnings.push(...checkPrebuild(pkg));
    }
    // 若父包被派生目标带上（如只装 tsx 不会走这里），父包本身在硬依赖，无需重复校验
    if (abiWarnings.length) console.log('\n⚠ ABI 校验：\n' + abiWarnings.map((w) => `  - ${w}`).join('\n'));
    if (prebuildWarnings.length) console.log('\n⚙ prebuild 提示：\n' + prebuildWarnings.map((w) => `  - ${w}`).join('\n'));
    return;
  }

  if (cmd === 'uninstall') {
    const pkgs = targets.map((t) => `tree-sitter-${findRowByName(rows, t)!.pkg}`);
    console.log(`[install-package] npm uninstall ${pkgs.join(' ')}`);
    const res = runNpm(['uninstall', ...pkgs]);
    console.log(res.out.slice(-1000));
    if (res.status !== 0) {
      console.error(`✗ 卸载失败（退出码 ${res.status}）`);
      process.exit(1);
    }
    console.log('\n✓ 已卸载。对应语言 AST 解析将静默禁用。');
    return;
  }

  console.error(`✗ 未知命令：${cmd}（支持 list / install / uninstall / index）`);
  process.exit(1);
}

// 直接执行才跑 main（被测试 import 时仅暴露 collect/类型，不触网不装包）
if (process.argv[1] && /install_package_cli\.(js|ts)$/.test(process.argv[1])) {
  main();
}