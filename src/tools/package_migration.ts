/**
 * package_migration —— 包改名/提级线（Design canvas 截至此条前缺失的那条线）
 *
 * 场景（用户洞见）：屎山积木换代时，新包常沿用旧目录/旧包名的历史残留——
 *   1. 目录已物理提到新位置，但 `package` 还是旧名（如 package v2）；
 *   2. 全项目 import 还指向"旧逻辑路径"（如 internal/hub/v2，但目录已不存在）；
 *   3. import 别名保留（hubv2 / hubclientv2 / v2），名字与换代后的包名不符；
 *   4. 日志/插桩字符串里残留旧路径字样。
 * 本线把这些一次性、确定性地涤荡干净，交给验证闭环兜底（改后黄了就回滚）。
 *
 * 纯计算（绝不落盘）：computeMigrationPlan 产出 RunningChangePlan
 * （absToNew/originals/moves），落盘+验证+回滚全由 refactor_pipeline 统一负责。
 *
 * 语义：
 *   - prefix/to 是"import 审计侧"的旧/新逻辑路径（可能带模块前缀 + 子路径子目录）。
 *     对全项目所有源文件，把 `moduleBase/<prefix>`(含其子前缀)重写为 `moduleBase/<to>`。
 *   - packageRename 作用于 packageRenameDir（缺省取 to 物理目录）的顶级源文件：
 *     `package <from>` → `package <to>`；`package <from>_test` → `package <to>_test`。
 *   - aliases 逐个清洗：把命中的 import 别名声明改名，并重写标识符用法 `<from>.` → `<to>.`。
 *   - 物理目录移动（可选，通用提级）：若 `project_dir/prefix` 目录真实存在，先整树移动到
 *     `project_dir/to`（跑在内容重写之前，moves 交给管线落盘）。若代码已物理到位
 *     （prefix 目录不存在，to 目录已含源码）则只做内容重写、不移动。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PackageMigrationSpec, RunningChangePlan } from './refactor_langs.js';

const DEFAULT_SKIP = new Set([
  '.git', 'node_modules', '.design-canvas', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.next', 'out',
]);

const DEFAULT_EXTS = new Set(['.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 递归收集项目内命中扩展名的源文件（相对 project_dir 的正斜杠路径）。 */
function collectSourceFiles(
  proj: string,
  exts: Set<string>,
  skipDirs: Set<string>,
): string[] {
  const out: string[] = [];
  const stack = [proj];
  const seen = new Set<string>();
  while (stack.length) {
    const dir = stack.pop()!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!skipDirs.has(ent.name)) stack.push(p);
        continue;
      }
      if (exts.has(path.extname(ent.name))) out.push(path.relative(proj, p).split(path.sep).join('/'));
    }
  }
  return out;
}

/** 把旧 import 全路径(含子前缀)重写为新路径。 */
function rewriteImportPaths(src: string, oldAbs: string, newAbs: string): string {
  if (!oldAbs) return src;
  let s = src;
  // 顺序：先子前缀再精确（replaceAll 无歧义，直接都替换）
  s = s.replaceAll(oldAbs + '/', newAbs + '/');
  s = s.replaceAll(oldAbs, newAbs);
  return s;
}

/** 清洗单条 import 别名：声明改名 + 标识符用法重写。 */
function cleanAlias(src: string, exactPath: string, from: string, to: string): string {
  let s = src;
  const quoted = escapeRe(exactPath);
  // 1) 别名声明：`alias "path"` → `to "path"`；to 为空则去掉别名（仅留 `"path"`）
  if (!to) {
    const decl = new RegExp(`\\b${escapeRe(from)}\\s+("${quoted}")`, 'g');
    s = s.replace(decl, '$1');
  } else if (to !== from) {
    const decl = new RegExp(`\\b${escapeRe(from)}\\s+("${quoted}")`, 'g');
    s = s.replace(decl, `${to} $1`);
  }
  // 2) 标识符用法：`from.` → `to.`（包别名调用点）
  if (to !== from) {
    s = s.replace(new RegExp(`\\b${escapeRe(from)}\\.`, 'g'), `${to}.`);
  }
  return s;
}

/** 顶层 package 声明改名（from_test → to_test 优先）。 */
function renamePackageDecl(src: string, from: string, to: string): string {
  let s = src;
  if (!from || !to || from === to) return s;
  s = s.replace(
    new RegExp(`^(\\s*)package\\s+${escapeRe(from)}_test\\b`, 'm'),
    `$1package ${to}_test`,
  );
  s = s.replace(
    new RegExp(`^(\\s*)package\\s+${escapeRe(from)}\\b`, 'm'),
    `$1package ${to}`,
  );
  return s;
}

/** 判定文件是否直接位于某个物理目录（top-level），否则在子目录内。 */
function isTopLevelOf(fileAbs: string, dirAbs: string): boolean {
  const rel = path.relative(dirAbs, fileAbs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.includes(path.sep);
}

export interface MigrationPlanOptions {
  project_dir: string;
  migrate: PackageMigrationSpec;
}

/**
 * 纯计算：产出提级计划。不改盘。会做真实文件系统读取与存在性判断。
 */
export function computeMigrationPlan(opts: MigrationPlanOptions): RunningChangePlan {
  const proj = path.resolve(opts.project_dir);
  const spec = opts.migrate;
  const exts = new Set(spec.sourceExts ?? [...DEFAULT_EXTS]);
  const skipDirs = new Set(spec.skipDirs ?? [...DEFAULT_SKIP]);

  const moduleBaseRaw = (spec.moduleBase ?? '').trim();
  // 把连续的尾随斜杠全部剥掉（moduleBase 纯斜杠形式 '///' 是最容易触发"静默数据破坏"的配置，必须拦截）。
  const moduleBase = moduleBaseRaw.endsWith('/') ? moduleBaseRaw.replace(/\/+$/, '') : moduleBaseRaw;

  // prefix / to 必须是相对 project_dir 的路径；若用户误传绝对路径（如 '/tmp/hub'、'D:\\hub'），
  // path.join(proj, ...) 会退化成直接使用绝对路径，命中非预期目录甚至盘外，属于路径穿越类隐患。
  // 注意：必须在剥前导斜杠之前判定，否则 '/tmp/pkg' 会被误剥成 'tmp/pkg' 伪装成相对路径。
  const invalidSegment = (s: string): boolean =>
    s.length > 0 && (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || s.startsWith('\\') || s.startsWith('/'));
  if (invalidSegment(spec.prefix) || invalidSegment(spec.to)) {
    throw new Error(
      `package_migration.prefix/to 必须是相对 project_dir 的正斜杠路径，prefix=${JSON.stringify(
        spec.prefix,
      )}、to=${JSON.stringify(spec.to)} 已在计划期拦截。`,
    );
  }

  const prefix = spec.prefix.replace(/^\/+|\/+$/g, '');
  const to = spec.to.replace(/^\/+|\/+$/g, '');

  // 输入护栏：moduleBase 是 import 前缀重写的锚。若被剥成空串，
  // rewriteImportPaths 会退化成"把所有 /prefix/ 替换成 /to/"——
  // 在任意文件里吞掉所有以 / 开头的路径片段，属于静默数据破坏，必须在计划期就拦截。
  if (!moduleBase) {
    throw new Error(
      `package_migration.moduleBase 解析为空（原始值 ${JSON.stringify(spec.moduleBase)}），` +
        '重写会退化成无锚点的全局替换，已在计划期拦截，请检查配置。',
    );
  }

  const importOldAbs = `${moduleBase}/${prefix}`;
  const importNewAbs = `${moduleBase}/${to}`;

  const pkgDirRel = spec.packageRenameDir ?? to;
  const pkgDirAbs = path.isAbsolute(pkgDirRel) ? path.resolve(pkgDirRel) : path.resolve(proj, pkgDirRel);
  const pkgRename = spec.packageRename;
  const topLevelOnly = spec.packageRenameTopLevelOnly ?? true;

  // 物理目录移动：仅当"旧逻辑目录真实存在且目标目录不同"时才搬（避免误判已到位）。
  // 移动跑在内容重写之前；moves 交给管线先落盘。
  const srcDirAbs = path.join(proj, ...prefix.split('/'));
  const dstDirAbs = path.join(proj, ...to.split('/'));
  const moves: NonNullable<RunningChangePlan['moves']> = [];
  const movedAbsToRel = new Map<string, string>(); // 原始绝对路径 → 移动后相对路径
  const doMove = prefix !== to && fs.existsSync(srcDirAbs) && srcDirAbs !== dstDirAbs;
  if (doMove) {
    // 递归收集源目录树内待移动文件 → moves
    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!skipDirs.has(ent.name)) walk(p);
        } else if (exts.has(path.extname(ent.name))) {
          const rel = path.relative(srcDirAbs, p).split(path.sep).join('/');
          const toAbs = path.join(dstDirAbs, rel);
          if (fs.existsSync(toAbs)) {
            throw new Error(
              `包/目录迁移撞名：目标已存在文件 ${path.relative(proj, toAbs)}（移动 ${path.relative(proj, p)}）`,
            );
          }
          moves.push({ from: p, to: toAbs });
          movedAbsToRel.set(p, path.relative(proj, toAbs).split(path.sep).join('/'));
        }
      }
    };
    if (fs.existsSync(srcDirAbs)) walk(srcDirAbs);
  }

  const files = collectSourceFiles(proj, exts, skipDirs);
  const absToNew = new Map<string, string>();
  const originals = new Map<string, string>();

  for (const rel of files) {
    const fileAbs = path.resolve(proj, rel);
    let src: string;
    try {
      src = fs.readFileSync(fileAbs, 'utf-8');
    } catch {
      continue;
    }
    let s = src;

    // (a) import 引用面重写（全量文件）
    s = rewriteImportPaths(s, importOldAbs, importNewAbs);

    // (b) 别名清洗（逐条）
    for (const al of spec.aliases ?? []) {
      s = cleanAlias(s, al.importPath, al.from, al.to);
    }

    // (c) package 文件改名：仅作用于 packageRenameDir 树内；topLevelOnly 时只改直接位
    const isUnderPkgDir =
      movedAbsToRel.get(fileAbs)?.startsWith(`${pkgDirRel}/`) || rel.startsWith(`${pkgDirRel}/`);
    if (pkgRename && isUnderPkgDir) {
      // 顶层判定用"移动后生效路径"：被移动文件以目标路径为准（否则一次"移动+改名"里
      // 源还在子目录会导致误判非顶层、跳过改名——dogfood 抓到的真实缺陷）。
      const effectiveAbs = movedAbsToRel.has(fileAbs)
        ? path.resolve(proj, movedAbsToRel.get(fileAbs)!)
        : fileAbs;
      if (topLevelOnly && !isTopLevelOf(effectiveAbs, pkgDirAbs)) {
        // 子目录源文件：不改 package，但 import 引用面/别名照旧重写完（上方已做）
      } else {
        s = renamePackageDecl(s, pkgRename.from, pkgRename.to);
      }
    }

    if (s !== src) {
      // 移动后的文件以移动后路径为 key；未移动以原路径为 key
      const key = movedAbsToRel.get(fileAbs) ?? fileAbs;
      absToNew.set(key, s);
      originals.set(fileAbs, src);
    } else if (movedAbsToRel.has(fileAbs)) {
      // 无内容改写但发生了移动：仍计入计划（absToNew 里放原样内容，便于管线计数/回滚）
      const key = movedAbsToRel.get(fileAbs)!;
      absToNew.set(key, src);
      originals.set(fileAbs, src);
    }
  }

  // 撞名守卫：内容落盘目标若已是盘上现存文件（且非本计划移动目标），视为撞名
  for (const key of absToNew.keys()) {
    if (fs.existsSync(key)) {
      const alreadyMovedTarget = movedAbsToRel.has(key); // 已是某移动的目标 → 正常覆盖
      if (!alreadyMovedTarget && !originals.has(key)) {
        throw new Error(`包/目录迁移撞名：内容写入目标已存在 ${path.relative(proj, key)}`);
      }
    }
  }

  return { absToNew, originals, moves, units: moves.length };
}