/**
 * rewrite：局部重写建议 + 编辑应用（版本升级契约差检测 · 阶段 D）
 *
 * 检测（阶段 B/C）给出"契约对不上的部分"，本模块把它们变成可执行的局部重写：
 *   - 重写计划（buildRewritePlan）：把命中聚合成按文件的有序动作清单，
 *     每条带 类型/标签/建议/是否可确定性自动改写。
 *   - 确定性改写（suggestDeterministicEdits + applyEdits）：对**语义无歧义**的替换
 *     直接产出文本编辑（如 `new Buffer(` → `Buffer.from(`）；其余标记为"需人工/LLM"，
 *     不自动改——自动改写只做零风险子集，避免引入新契约差。
 *
 * 应用走"精确字符串替换 + 出现次数校验"：`from` 必须存在且可唯一锚定（或显式 count），
 * 否则拒绝该编辑，保证不误伤。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { FeatureHit } from './features.js';
import type { RemovedHit } from './removed.js';

/** 重写计划单条动作 */
export interface RewriteItem {
  file: string; // 相对 root 的路径
  line: number;
  kind: 'feature' | 'removed';
  label: string; // 特性/API 名
  since: number; // 引入 / 移除版本
  suggestion: string; // 重写建议
  auto: boolean; // 是否可确定性自动改写
  snippet: string;
}

/** 把阶段 B/C 命中聚合成按文件的有序重写计划 */
export function buildRewritePlan(
  featureGroups: Array<{ declaration: { projectDir: string }; hits: FeatureHit[] }>,
  removedGroups: Array<{ declaration: { projectDir: string }; hits: RemovedHit[] }>
): RewriteItem[] {
  const items: RewriteItem[] = [];
  for (const { declaration: d, hits } of featureGroups) {
    const prefix = d.projectDir === '.' ? '' : `${d.projectDir}/`;
    for (const h of hits) {
      items.push({
        file: `${prefix}${h.file}`,
        line: h.line,
        kind: 'feature',
        label: h.feature,
        since: h.since,
        suggestion: h.rewrite,
        auto: false, // 语言特性需类型上下文，一律人工/LLM
        snippet: h.snippet,
      });
    }
  }
  for (const { declaration: d, hits } of removedGroups) {
    const prefix = d.projectDir === '.' ? '' : `${d.projectDir}/`;
    for (const h of hits) {
      items.push({
        file: `${prefix}${h.file}`,
        line: h.line,
        kind: 'removed',
        label: h.api,
        since: h.since,
        suggestion: h.rewrite,
        auto: suggestDeterministicEdits([h]).length > 0,
        snippet: h.snippet,
      });
    }
  }
  return items.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
}

/** 确定性文本编辑：from → to（from 必须唯一出现或有明确 count） */
export interface PlanEdit {
  file: string; // 相对 root
  from: string;
  to: string;
}

/** 语义零风险的确定性替换表（只放无歧义、不改变行为者） */
const SAFE_SUBSTITUTIONS: Array<{ kind: 'removed'; label: string; from: string; to: string }> = [
  // Node：new Buffer() 构造器（废弃）→ Buffer.from()，语义一致
  { kind: 'removed', label: 'new Buffer(...)', from: 'new Buffer(', to: 'Buffer.from(' },
];

/** 从命中产出可确定性改写的编辑；命中无安全替换则返回空 */
export function suggestDeterministicEdits(hits: RemovedHit[]): PlanEdit[] {
  const out: PlanEdit[] = [];
  for (const h of hits) {
    for (const s of SAFE_SUBSTITUTIONS) {
      if (s.kind !== 'removed' || s.label !== h.api) continue;
      // 仅当命中行确实包含该替换串才产出（保守，防止跨文件误报）
      if (!h.snippet.includes(s.from)) continue;
      out.push({ file: h.file, from: s.from, to: s.to });
    }
  }
  return out;
}

export interface ApplyResult {
  changedFiles: string[];
  applied: number;
}

/**
 * 应用编辑（相对 root）。
 * 规则：from 必须在文件内容中出现且出现次数与 fromCount 一致（缺省 1），
 * 否则整条编辑拒绝并抛错——保证每次替换都是精确锚定、可回退。
 */
export function applyEdits(root: string, edits: PlanEdit[]): ApplyResult {
  const byFile = new Map<string, PlanEdit[]>();
  for (const e of edits) {
    const arr = byFile.get(e.file) ?? [];
    arr.push(e);
    byFile.set(e.file, arr);
  }
  const changedFiles: string[] = [];
  let applied = 0;
  for (const [file, fileEdits] of byFile) {
    const abs = path.resolve(root, file);
    const orig = fs.readFileSync(abs, 'utf-8');
    let content = orig;
    for (const e of fileEdits) {
      const count = content.split(e.from).length - 1;
      if (count < 1) {
        throw new Error(`编辑未命中：${file} 找不到 "${e.from}"`);
      }
      if (count > 1) {
        throw new Error(`编辑有歧义：${file} 中 "${e.from}" 出现 ${count} 次，请改为带上下文的 from`);
      }
      content = content.replace(e.from, e.to);
      applied += 1;
    }
    if (content !== orig) {
      fs.writeFileSync(abs, content, 'utf-8');
      changedFiles.push(file);
    }
  }
  return { changedFiles, applied };
}
