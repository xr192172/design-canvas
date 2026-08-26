/**
 * submit_gate —— 提交层完整性自检（go:embed / 产物提交）
 *
 * 背景（一类默认构建断点归纳）：`//go:embed web/dist/*` 依赖前端构建产物，
 * 但 web/dist 曾因 .gitignore 未纳入版本控制 → 新克隆项目 `go build` 直接失败。
 * `go build` 是重构验证的常见闸门，但它只测"当前磁盘"，测不出"新克隆能否构建"。
 *
 * 本模块在重构收尾时检查：每个 `//go:embed …` 点声明的产物，
 *   ① 是否真实存在（磁盘）       → 缺失 = build 断点；
 *   ② 是否已进 git 索引（提交）  → 未提交 = 新克隆 build 断点。
 * ①②任一失败都会让"新克隆即坏"，属于重构改过文件却忘了提交产物的典型漏点。
 *
 * 无 git 仓库时降级为只查①（磁盘存在），并标记 git 检查 skip，不判失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface EmbedRequirement {
  /** 声明来源：相对 cwd 的文件路径 */
  file: string;
  /** go:embed 模式原文，如 "web/dist/*" */
  pattern: string;
  /** 该模式匹配到的磁盘文件（相对 cwd） */
  matched: string[];
  /** 模式一字未匹配（磁盘缺产物） */
  missingOnDisk: boolean;
  /** 匹配到的文件是否都已在 git 索引（有仓库时才判定） */
  inGit: boolean | null; // null = 无 git 仓库 / 未判定
}

export interface SubmitCheckResult {
  ok: boolean;
  requirements: EmbedRequirement[];
  note?: string;
  skip: boolean;
}

const GO_FILE = '*.go';

function walkGoFiles(root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const en of entries) {
      const abs = path.join(dir, en.name);
      if (en.isDirectory()) {
        if (en.name === '.git' || en.name === 'node_modules' || en.name === 'vendor') continue;
        queue.push(abs);
      } else if (en.isFile() && en.name.endsWith('.go')) {
        out.push(abs);
      }
    }
  }
  return out;
}

function gitTrackedFiles(cwd: string): Set<string> | null {
  const run = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' });
  if (run.status !== 0 || run.error) return null;
  const set = new Set<string>();
  for (const f of (run.stdout || '').split('\n')) {
    if (f) set.add(f.replace(/\\/g, '/'));
  }
  return set;
}

/** 把 go:embed 模式转成 glob，相对 host 文件所在目录匹配。 */
function expandEmbed(absFile: string, pattern: string): string[] {
  const dir = path.dirname(absFile);
  const glob = pattern.trim().replace(/\\/g, '/');
  // 只支持简单通配（*、**），生产够用；绝不出目录外
  const base = glob.split('/').slice(0, -1).join('/');
  const leaf = glob.split('/').pop() || '*';
  const walkFrom = path.join(dir, base || '.');
  const out: string[] = [];
  const reLeaf = new RegExp('^' + leaf.replace(/\./g, '\\.').replace(/\*\*/g, '.+').replace(/\*/g, '[^/]*') + '$');
  const reRest = new RegExp('^' + base.replace(/\*\*/g, '.+').replace(/\./g, '\\.').replace(/\*/g, '[^/]*'));
  const queue = [walkFrom];
  const all: string[] = [];
  while (queue.length) {
    const d = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const en of entries) {
      const abs = path.join(d, en.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (en.isDirectory()) {
        if (!reRest.test(rel + '/')) continue;
        if (base.includes('**')) queue.push(abs);
        else if (path.relative(dir, abs).split(path.sep).length <= base.split('/').filter(Boolean).length) queue.push(abs);
      } else if (en.isFile() && reLeaf.test(en.name)) {
        all.push(rel);
      }
    }
  }
  return [...new Set(all)];
}

export function checkEmbedSubmissions(cwd: string): SubmitCheckResult {
  const root = path.resolve(cwd);
  const goFiles = walkGoFiles(root);
  const requirements: EmbedRequirement[] = [];
  const gitTracked = gitTrackedFiles(root);

  for (const abs of goFiles) {
    let src = '';
    try {
      src = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const file = path.relative(root, abs).split(path.sep).join('/');
    const pats = [...src.matchAll(/\/\/go:embed\s+([^\n]+)/g)];
    for (const pm of pats) {
      const pattern = pm[1].trim();
      if (!pattern) continue;
      const matched = expandEmbed(abs, pattern);
      const missingOnDisk = matched.length === 0;
      let inGit: boolean | null = null;
      if (gitTracked) {
        inGit = matched.length > 0 && matched.every((rel) => gitTracked.has(rel));
      }
      requirements.push({ file, pattern, matched, missingOnDisk, inGit });
    }
  }

  const failures = requirements.filter((r) => r.missingOnDisk || r.inGit === false);
  const skip = requirements.length === 0;
  return {
    ok: failures.length === 0,
    requirements,
    note: skip
      ? '未发现 go:embed 声明'
      : failures.length > 0
        ? failures.map((r) => `${r.file} → embed ${r.pattern}: ${r.missingOnDisk ? '产物缺失' : '产物未提交'} (${r.matched.join(', ') || '没有匹配文件'})`).join('\n')
        : undefined,
    skip,
  };
}