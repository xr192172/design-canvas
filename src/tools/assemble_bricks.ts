/**
 * assemble_bricks —— 拼装区（Brick Harvest Phase 5：实码搬运与重组）
 *
 * 用户核心决策（2026-08-20）：每次拼装都要一个**新的拼装区**，
 * 绝不在原项目上抽取和拼装——原项目（design-canvas / OCR 克隆 / 任何源）永远只读。
 * 拼装区是一次性新目录：可 git init、可编译运行、可 import_project 解析，
 * 用完不满意整个删掉，零残留。
 *
 *   积木盒（已验证资产）──assemble_bricks──▶ 拼装区（全新目录）
 *                                            + LLM 写 glue 粘合代码
 *                                                ▼
 *                                             新项目（可再入盒，滚雪球）
 *
 * 布局：`<target>/<brick_name>/<原闭包相对路径>`——积木名做顶层命名空间，
 * 不同积木永不撞路径，来源一眼可溯。积木内保持原包结构：
 *
 *   assembly-001/
 *     go.mod                      module <module>（有 Go 积木时生成）
 *     assembly.json               出生证明（哪些积木、来源 commit、重写记录）
 *     go_logging/internal/logging/*.go      ← 盒内积木原样搬运
 *     ocr_diff_resolver/internal/diff/*.go ← import 路径已重接
 *     cmd/main.go                 ← LLM 写的 glue（本工具不生成）
 *
 * import 重接规则（核心红利：积木=种子+传递闭包整体入盒，闭包内部相对
 * 路径原样保留——同积木内 TS 相对 import / Go 同包引用零改动）：
 *   - TS/JS：零重写（闭包内相对位置不变）
 *   - Go：内部包 import 带 source module 前缀（如
 *     github.com/alibaba/open-code-review/internal/model）——按闭包目录
 *     **最长后缀匹配**识别内部 import，重写为 `<module>/<brick_name>/<后缀>`。
 *     不需要知道源 module 名：后缀落在闭包目录集合内 ⇔ 是内部 import。
 *
 * 诚实边界（decline rather than guess）：
 *   - 三方依赖版本只从积木的 go_mod_requires 存档取（源项目 go.mod 原文，
 *     不猜不升版）；存档缺项/TS 依赖 → 汇总 pending 清单由人/LLM 补
 *   - 多积木同库不同版本：MVS 语义取高版本 + version_conflicts 留档警告
 *   - go.sum 不生成（需 go 工具链算哈希）——拼装区跑 go mod tidy 补
 *   - 跨积木闭包重叠文件只**警告**不合并——两份同源代码在 Go 里是两个
 *     不兼容的包，静默合并等于猜；正确解法（提升共享积木）留给下次入盒
 *   - glue 代码不生成——粘合是 LLM 的活，工具只搬已验证实码
 */

import fs from 'node:fs';
import path from 'node:path';
import type { BrickManifest } from '../dsl/contract.js';
import { resolveGoThirdParty, compareGoVersion } from './go_mod.js';
import { getStorageRoot } from '../storage.js';

export interface AssembleBricksInput {
  /** 要拼装的积木名列表（须已在盒中） */
  bricks: string[];
  /** 拼装区目录（绝对或相对路径；必须不存在或为空目录——拼装区一次性原则） */
  target_dir: string;
  /** 新项目 Go module 名（闭包含 .go 文件时必填，如 example.com/assembly-001） */
  module?: string;
  /** go.mod 的 go 版本（默认 1.25.5；只是最低版本声明） */
  go_version?: string;
  /** 积木盒根目录（默认 <dataHome>/.design-canvas/bricks，与 harvest/slim 同源） */
  box_dir?: string;
  /** false 只预演：输出搬运计划与 import 重写预览，不落盘（默认 true） */
  write?: boolean;
}

export interface AssembledBrickReport {
  name: string;
  /** 搬运文件数 */
  files_copied: number;
  /** 拼装区内落位根（<brick_name>/） */
  dest_root: string;
  /** Go import 重写明细（old → new；TS 积木为空） */
  imports_rewritten: string[];
  /** 闭包里的三方依赖（全量；其中自动 require 的见 third_party_resolved） */
  third_party: string[];
  /** 三方依赖中从 go_mod_requires 存档定位到版本的 module（自动进拼装区 go.mod） */
  third_party_resolved: string[];
  source_project?: string;
  commit?: string;
}

export interface AssembleBricksResult {
  target_dir: string;
  module?: string;
  bricks: AssembledBrickReport[];
  /** 跨积木闭包重叠警告（同路径文件出现在多个积木闭包里） */
  overlaps: string[];
  /** 无法从存档定位版本的三方依赖（待人/LLM 补进 go.mod 或 package.json） */
  third_party_pending: string[];
  /** 自动写进拼装区 go.mod 的 require 块（module → version，版本来自源项目 go.mod 存档） */
  go_requires: Record<string, string>;
  /** 多积木同库不同版本的冲突记录（MVS 取高，决策留档） */
  version_conflicts: string[];
  /** 自动 require 项中的死依赖候选（slim_candidates 档案投影——剔除前须四层验证） */
  dead_require_candidates: string[];
  go_mod_written: boolean;
  assembly_manifest_written: boolean;
  written: boolean;
  message: string;
}

/** 闭包目录集合（posix；manifest 路径恒为正斜杠形态） */
function closureDirs(internal: string[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of internal) {
    const i = f.lastIndexOf('/');
    if (i > 0) dirs.add(f.slice(0, i));
  }
  return dirs;
}

/**
 * Go 积木落位路径：解除顶层 internal/ 段。
 * Go 的 internal 语义按路径走——不去段则 <brick>/internal/... 只能被
 * <brick>/ 子树引用，子树外的 glue 无法 import（编译期拒绝）。
 * 语义上：源项目的 internal 是防外部引用的封装；积木被选中拼装，
 * 即成为新项目的公开部件，封装在拼装区被打开。
 */
export function goDestRel(rel: string): string {
  return rel.startsWith('internal/') ? rel.slice('internal/'.length) : rel;
}

/**
 * Go import path 重映射：最长后缀匹配闭包目录。
 * 返回 null = 不是本积木内部 import（stdlib/三方/他积木，原样保留）。
 */
function remapGoImport(
  importPath: string,
  dirs: Set<string>,
  newPrefix: string,
): string | null {
  const segs = importPath.split('/');
  for (let len = segs.length; len >= 1; len--) {
    const suffix = segs.slice(-len).join('/');
    // suffix !== importPath：内部 import 必带 source module 前缀，
    // import path 本身等于闭包相对目录的不是 Go 内部 import 形态
    if (suffix !== importPath && dirs.has(suffix)) {
      return `${newPrefix}/${goDestRel(suffix)}`;
    }
  }
  return null;
}

/**
 * 重写单个 Go 文件的 import（顶部 import 块逐行状态机，gofmt 形态）。
 * 返回改写后的全文与重写明细；不需要重写时原样返回。
 */
export function rewriteGoFile(
  src: string,
  dirs: Set<string>,
  newPrefix: string,
): { text: string; rewritten: string[] } {
  const lines = src.split('\n');
  let inBlock = false;
  const rewritten: string[] = [];
  const tryRemap = (line: string, quoted: string): string | null => {
    const np = remapGoImport(quoted, dirs, newPrefix);
    if (!np) return null;
    rewritten.push(`${quoted} → ${np}`);
    return line.replace(`"${quoted}"`, `"${np}"`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      if (/^\s*\)/.test(line)) {
        inBlock = false;
        continue;
      }
      const m = line.match(/^\s*(?:[A-Za-z_][A-Za-z0-9_.]*\s+)?"([^"]+)"/);
      if (m) {
        const nl = tryRemap(line, m[1]);
        if (nl) lines[i] = nl;
      }
      continue;
    }
    const single = line.match(/^import\s+(?:[A-Za-z_][A-Za-z0-9_.]*\s+)?"([^"]+)"/);
    if (single) {
      const nl = tryRemap(line, single[1]);
      if (nl) lines[i] = nl;
      continue;
    }
    if (/^import\s*\(/.test(line)) inBlock = true;
  }
  return { text: lines.join('\n'), rewritten };
}

/** 闭包文件里是否含 .go（决定是否需要 module / go.mod） */
function hasGoFiles(internal: string[]): boolean {
  return internal.some((f) => f.endsWith('.go'));
}

export async function assembleBricks(input: AssembleBricksInput): Promise<AssembleBricksResult> {
  if (!input.bricks?.length) {
    throw new Error('bricks 不能为空：至少指定一个积木名（search_bricks 可查盒内清单）');
  }
  // 盒根默认与 harvest_from_url / slim_brick 同源（getStorageRoot）：曾用
  // <cwd>/.design-canvas/bricks，测试环境（DESIGN_CANVAS_HOME 重定向）下
  // 与写入方分裂——slim 写临时盒、拼装读持久盒，拼到过期残废产物
  const boxDir = path.resolve(input.box_dir ?? path.join(getStorageRoot(), 'bricks'));
  if (!fs.existsSync(boxDir)) {
    throw new Error(`积木盒不存在：${boxDir}（先 harvest_from_url 入盒）`);
  }

  // ── 读积木（全部校验通过才动手，防半拼装） ──
  const loaded: Array<{ manifest: BrickManifest; dir: string }> = [];
  const missing: string[] = [];
  for (const name of input.bricks) {
    const dir = path.join(boxDir, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      missing.push(name);
      continue;
    }
    loaded.push({ manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BrickManifest, dir });
  }
  if (missing.length) {
    const existing = fs
      .readdirSync(boxDir)
      .filter((n) => fs.existsSync(path.join(boxDir, n, 'manifest.json')));
    throw new Error(
      `积木不在盒中：${missing.join('、')}。盒内现有：${existing.join('、') || '（空）'}`,
    );
  }

  // ── 重叠检测（只警告不合并：两份同源代码在 Go 是两个不兼容的包） ──
  const overlaps: string[] = [];
  const seen = new Map<string, string>();
  for (const { manifest } of loaded) {
    for (const f of manifest.closure?.internal ?? []) {
      const prev = seen.get(f);
      if (prev) overlaps.push(`${f} 同时在 ${prev} 与 ${manifest.name} 闭包中（未合并，两份副本将类型不兼容）`);
      else seen.set(f, manifest.name);
    }
  }

  // ── Go 积木必须有 module 名 ──
  const anyGo = loaded.some(({ manifest }) => hasGoFiles(manifest.closure?.internal ?? []));
  if (anyGo && !input.module) {
    throw new Error('闭包含 Go 文件，必须提供 module（新项目 go.mod 的 module 名，如 example.com/assembly-001）');
  }

  // ── target 校验（拼装区一次性：不存在或空目录） ──
  const targetDir = path.resolve(input.target_dir);
  const write = input.write !== false;
  if (fs.existsSync(targetDir)) {
    const entries = fs.readdirSync(targetDir);
    if (entries.length > 0) {
      const msg = `拼装区 ${targetDir} 非空（${entries.length} 项）——拼装区必须是一次性新目录，拒绝覆盖已有内容`;
      if (write) throw new Error(msg);
      overlaps.push(`[预演警告] ${msg}`);
    }
  } else if (write) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // ── 逐积木搬运 ──
  const reports: AssembledBrickReport[] = [];
  const thirdPartyPending = new Set<string>();
  // Go 三方依赖版本归并（module → version；版本事实来自各积木 go_mod_requires 存档）
  const goRequires = new Map<string, string>();
  const modOwner = new Map<string, string>();
  const versionConflicts: string[] = [];
  // module root → 跨积木使用统计（live/dead 计数；全 dead 才进 dead_require_candidates）
  const moduleUse = new Map<string, { live: number; dead: number }>();
  for (const { manifest, dir } of loaded) {
    const internal = manifest.closure?.internal ?? [];
    const dirs = closureDirs(internal);
    const filesDir = path.join(dir, 'files');
    const destRoot = manifest.name;
    const importsRewritten: string[] = [];
    let copied = 0;

    const isGoBrick = hasGoFiles(internal);
    for (const rel of internal) {
      const src = path.join(filesDir, rel);
      if (!fs.existsSync(src)) continue;
      // Go 积木：全部文件去顶层 internal/ 段（包目录与 import path 同构）
      const destRel = path.join(destRoot, isGoBrick ? goDestRel(rel) : rel);
      const goTarget = isGoBrick && input.module ? `${input.module}/${destRoot}` : null;
      if (goTarget) {
        // Go 文件：过 import 重写状态机（预演只收集明细，写盘落重写后全文）
        const { text, rewritten } = rewriteGoFile(fs.readFileSync(src, 'utf-8'), dirs, goTarget);
        importsRewritten.push(...rewritten);
        if (write) {
          fs.mkdirSync(path.join(targetDir, path.dirname(destRel)), { recursive: true });
          fs.writeFileSync(path.join(targetDir, destRel), text, 'utf-8');
        }
      } else if (write) {
        // TS/JS/其他：闭包内相对位置不变，原样复制零重接
        fs.mkdirSync(path.join(targetDir, path.dirname(destRel)), { recursive: true });
        fs.copyFileSync(src, path.join(targetDir, destRel));
      }
      copied++;
    }

    const thirdParty = (manifest.closure?.external ?? [])
      .filter((e) => e.class === 'third_party')
      .map((e) => e.source);

    // 三方依赖治理：Go 积木凭 go_mod_requires 存档自动定位版本（MVS 取高，冲突留档）；
    // TS 积木/无存档/归并不上 → 全量进 pending（decline rather than guess）
    let resolvedMods: string[] = [];
    if (isGoBrick && manifest.go_mod_requires) {
      const { resolved, unresolved } = resolveGoThirdParty(thirdParty, manifest.go_mod_requires);
      resolvedMods = Object.keys(resolved);
      for (const src of unresolved) thirdPartyPending.add(src);
      for (const [mod, ver] of Object.entries(resolved)) {
        const prev = goRequires.get(mod);
        if (prev === undefined) {
          goRequires.set(mod, ver);
          modOwner.set(mod, manifest.name);
        } else if (prev !== ver) {
          const pick = compareGoVersion(prev, ver) >= 0 ? prev : ver;
          versionConflicts.push(
            `${mod}：${modOwner.get(mod)}=${prev} vs ${manifest.name}=${ver} → 取 ${pick}（MVS 取高）`,
          );
          goRequires.set(mod, pick);
        }
      }
      // 死候选聚合：source → module root 映射，按"任一积木活用即保留"取交集
      const deadSources = new Set(
        (manifest.slim_candidates?.dead_third_party ?? []).map((d) => d.source),
      );
      for (const src of thirdParty) {
        let cur = src;
        for (;;) {
          if (manifest.go_mod_requires[cur] !== undefined) break;
          const i = cur.lastIndexOf('/');
          if (i < 0) {
            cur = '';
            break;
          }
          cur = cur.slice(0, i);
        }
        if (!cur) continue;
        const agg = moduleUse.get(cur) ?? { live: 0, dead: 0 };
        if (deadSources.has(src)) agg.dead += 1;
        else agg.live += 1;
        moduleUse.set(cur, agg);
      }
    } else {
      for (const t of thirdParty) thirdPartyPending.add(t);
    }

    reports.push({
      name: manifest.name,
      files_copied: copied,
      dest_root: `${destRoot}/`,
      imports_rewritten: importsRewritten,
      third_party: thirdParty,
      third_party_resolved: resolvedMods,
      source_project: manifest.provenance?.source_project,
      commit: manifest.provenance?.commit,
    });
  }

  // ── go.mod（有 Go 积木时；require 块版本来自源项目 go.mod 存档，不猜不升版） ──
  let goModWritten = false;
  const goRequiresObj: Record<string, string> = {};
  for (const [m, v] of [...goRequires.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    goRequiresObj[m] = v;
  }
  if (write && anyGo && input.module) {
    const goVersion = input.go_version ?? '1.25.5';
    let goMod = `module ${input.module}\n\ngo ${goVersion}\n`;
    if (goRequires.size) {
      goMod += '\nrequire (\n';
      for (const m of Object.keys(goRequiresObj)) goMod += `\t${m} ${goRequiresObj[m]}\n`;
      goMod += ')\n';
    }
    fs.writeFileSync(path.join(targetDir, 'go.mod'), goMod, 'utf-8');
    goModWritten = true;
  }

  // ── assembly.json 出生证明 ──
  let manifestWritten = false;
  // 死依赖候选投影（提前算：assembly.json 与返回值共用）
  const deadRequireCandidates = [...moduleUse.entries()]
    .filter(([, u]) => u.dead > 0 && u.live === 0)
    .map(([m]) => m)
    .sort();
  if (write) {
    const assembly = {
      assembled_at: new Date().toISOString(),
      tool: 'assemble_bricks',
      module: input.module,
      bricks: reports.map((r) => ({
        name: r.name,
        dest_root: r.dest_root,
        files: r.files_copied,
        go_imports_rewritten: r.imports_rewritten.length,
        source_project: r.source_project,
        commit: r.commit,
      })),
      third_party_pending: [...thirdPartyPending],
      go_requires: goRequiresObj,
      version_conflicts: versionConflicts,
      dead_require_candidates: deadRequireCandidates,
      overlaps,
    };
    fs.writeFileSync(path.join(targetDir, 'assembly.json'), JSON.stringify(assembly, null, 2), 'utf-8');
    manifestWritten = true;
  }

  const totalFiles = reports.reduce((s, r) => s + r.files_copied, 0);
  const totalRewrites = reports.reduce((s, r) => s + r.imports_rewritten.length, 0);
  const message =
    `拼装${write ? '完成' : '预演'}：${reports.length} 积木 → ${targetDir}` +
    `（${totalFiles} 文件${totalRewrites ? `，Go import 重写 ${totalRewrites} 处` : ''}）` +
    (goModWritten ? `，go.mod module=${input.module}` : '') +
    (goRequires.size ? `，三方依赖自动 require ${goRequires.size} 项（版本来自源项目 go.mod 存档）` : '') +
    (deadRequireCandidates.length
      ? `，其中死依赖候选 ${deadRequireCandidates.length} 项（slim 前须四层验证，见 dead_require_candidates）`
      : '') +
    (thirdPartyPending.size ? `；无版本存档待补 ${thirdPartyPending.size} 项（见 third_party_pending）` : '') +
    (versionConflicts.length ? `；版本冲突 ${versionConflicts.length} 处（MVS 取高，见 version_conflicts）` : '') +
    (overlaps.length ? `；重叠警告 ${overlaps.length} 条` : '') +
    (goModWritten && goRequires.size ? '。跑 go mod tidy 补 go.sum 与 indirect' : '') +
    `。下一步：写 glue（cmd/main.go 或入口文件）后编译验证。`;

  return {
    target_dir: targetDir,
    module: input.module,
    bricks: reports,
    overlaps,
    third_party_pending: [...thirdPartyPending],
    go_requires: goRequiresObj,
    version_conflicts: versionConflicts,
    dead_require_candidates: deadRequireCandidates,
    go_mod_written: goModWritten,
    assembly_manifest_written: manifestWritten,
    written: write,
    message,
  };
}
