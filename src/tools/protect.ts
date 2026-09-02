/**
 * protect —— 重建套件（rename_symbol / rename_file）的"冻结行"保护
 *
 * 背景（docs/tool-convergence "历史记录需要灰名单"）：改名/移动前要防止误伤带历史语境的
 * 行（判定/结论/核验记录）。本模块给"别的项目用"提供管理员自配的保护：不在源码硬编码路径。
 *
 * 配置（项目根 .design-canvas.json，无此文件 → 不启用，对任何项目零影响）：
 *   {
 *     "rename": {
 *       "protect": [
 *         { "globs": ["docs/tool-convergence/**", "tests/snapshots/**"],
 *           "markers": ["判定", "结论", "已实施", "核验"] }
 *       ]
 *     }
 *   }
 *   - globs  ：相对项目根的 gitignore 通配（`dir/**` 匹配其下全部文件；复用 `ignore` 库）
 *   - markers：命中任一 glob 的文件里，凡是「引用字节所在行」文本包含任一 marker → 视为冻结行。
 *
 * 语义（关键，宁稳不悬空）：
 *   跨文件改名 / 文件移动都是"原子"操作——不能在某个 importer 里只改一半、或跳过某个
 *   importer 仍让其它 importer 动（那会产生 `import { compute }` + `use tally(1)` 的坏文件，
 *   或移动后仍指向旧路径的悬空 import）。因此保护不是"部分套用"，而是：
 *    - 📌 精确判定：只在该 rename 真正要改写某个保护文件的标记行时才触发（行级瞄准）。
 *    - ⛔ 原子阻断：一旦命中，整笔操作软阻断（ok=false + 理由），不产生半成状态。
 *    - 主体文件（被改名/被移动的那个文件）永不套保护——它是操作对象本身，改全会执行。
 *    - 未命中的 rename 完全不受影响。
 */

import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

/** 一条保护规则：glob 头匹配文件，marker 行匹配被冻结的引用 */
export interface RenameProtectRule {
  globs: string[];
  markers: string[];
}

export interface RenameProtectConfig {
  rules: RenameProtectRule[];
}

/** 解析并校验 .design-canvas.json 的 rename.protect 段；无/非法 → null（不启用） */
export function loadRenameProtect(root: string): RenameProtectConfig | null {
  try {
    const p = path.join(root, '.design-canvas.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const protect = j?.rename?.protect;
    if (!Array.isArray(protect)) return null;
    const rules: RenameProtectRule[] = [];
    for (const r of protect) {
      if (!r || !Array.isArray(r.globs) || !Array.isArray(r.markers)) continue;
      const globs = r.globs.filter((g: unknown): g is string => typeof g === 'string' && g.length > 0);
      const markers = r.markers.filter((m: unknown): m is string => typeof m === 'string' && m.length > 0);
      if (globs.length > 0 && markers.length > 0) rules.push({ globs, markers });
    }
    return rules.length > 0 ? { rules } : null;
  } catch {
    return null;
  }
}

interface EditIn {
  pos: number;
  len: number;
  text: string;
}

interface CompiledRule {
  globs: string[];
  markers: string[];
  ig: Ignore;
}

/** 一次 rename 操作共享的守卫（配置只读一次，规则 ignore 只编译一次） */
export interface ProtectGuard {
  /**
   * 扫描某文件的待改写编辑：若任一编辑落在「该文件规则命中的标记行」→ blocked=true，
   * 并回传被冻结的行文本。blocked 意味着该 rename 会改写冻结行，调用方应原子阻断。
   */
  scan(absFile: string, src: string, edits: EditIn[]): { blocked: boolean; protectedLines: string[] };
  /**
   * 单点冻结判定：absFile 受某规则覆盖且 pos 所在行含标记 → true（字面量级逐处决策用）。
   * 文件不受规则覆盖 / 不在标记行 → false。
   */
  isFrozen(absFile: string, src: string, pos: number): boolean;
}

export function createProtectGuard(root: string): ProtectGuard {
  const cfg = loadRenameProtect(root);
  const compiled: CompiledRule[] = (cfg?.rules ?? []).map((r) => {
    const ig = ignore();
    ig.add(r.globs);
    return { globs: r.globs, markers: r.markers, ig };
  });

  const ruleForFile = (rel: string): CompiledRule | null => {
    if (rel === '' || rel.startsWith('../')) return null;
    for (const c of compiled) if (c.ig.ignores(rel)) return c;
    return null;
  };

  // 行起始偏移 + 二分定位：pos → 行号
  const buildLineStarts = (src: string): number[] => {
    const starts = [0];
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
    return starts;
  };
  const lineOf = (starts: number[], pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return {
    scan(absFile, src, edits) {
      if (compiled.length === 0 || !src || edits.length === 0) return { blocked: false, protectedLines: [] };
      const rel = path.relative(root, absFile).replace(/\\/g, '/');
      const rule = ruleForFile(rel);
      if (!rule) return { blocked: false, protectedLines: [] };

      const starts = buildLineStarts(src);
      const lineFlag = new Map<number, boolean>();
      const protectedLines: string[] = [];
      let blocked = false;

      for (const e of edits) {
        const li = lineOf(starts, e.pos);
        let frozen = lineFlag.get(li);
        if (frozen === undefined) {
          const end = li + 1 < starts.length ? starts[li + 1] : src.length;
          const lineText = src.slice(starts[li], end);
          frozen = rule.markers.some((m) => lineText.includes(m));
          lineFlag.set(li, frozen);
          if (frozen) protectedLines.push(lineText.trim());
        }
        if (frozen) blocked = true;
      }
      return { blocked, protectedLines };
    },
    isFrozen(absFile, src, pos) {
      if (compiled.length === 0 || !src) return false;
      const rel = path.relative(root, absFile).replace(/\\/g, '/');
      const rule = ruleForFile(rel);
      if (!rule) return false;
      const starts = buildLineStarts(src);
      const li = lineOf(starts, pos);
      const end = li + 1 < starts.length ? starts[li + 1] : src.length;
      const lineText = src.slice(starts[li], end);
      return rule.markers.some((m) => lineText.includes(m));
    },
  };
}