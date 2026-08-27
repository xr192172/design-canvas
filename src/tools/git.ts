/**
 * git —— 闭环 git 封装（基线快照 / 精确提交 / 回退）
 *
 * 一键诊断闭环的持久化边界：只用四个只读/精确操作，不在闭环外做
 * 任何破坏性 git 动作。
 *   - 基线快照：改前把当前工作区改动提交为 baseline（用户偏好：改前自动提交）
 *   - 精确提交：只 add 补丁实际改动的文件（不用 git add -A，防误入敏感文件）
 *   - 回退：验收失败时 git checkout 还原补丁改动的文件
 */

import { execSync } from 'node:child_process';

function run(dir: string, cmd: string): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
    return { ok: true, out: out.trim() };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

export function isGitRepo(dir: string): boolean {
  return run(dir, 'git rev-parse --is-inside-work-tree').ok;
}

export interface GitStatus {
  modified: string[];
  untracked: string[];
}

export function gitStatus(dir: string): GitStatus {
  const mod = run(dir, 'git diff --name-only');
  const unt = run(dir, 'git ls-files --others --exclude-standard');
  return {
    modified: mod.ok ? mod.out.split(/\r?\n/).filter(Boolean) : [],
    untracked: unt.ok ? unt.out.split(/\r?\n/).filter(Boolean) : [],
  };
}

export function gitDirty(dir: string): boolean {
  const s = gitStatus(dir);
  return s.modified.length > 0 || s.untracked.length > 0;
}

/** 精确提交指定文件（只用被补丁改过的文件，不用 -A） */
export function gitCommitFiles(dir: string, files: string[], message: string): { committed: boolean; out: string } {
  if (files.length === 0) return { committed: false, out: '无文件可提交' };
  const add = run(dir, `git add -- ${files.map((f) => JSON.stringify(f)).join(' ')}`);
  if (!add.ok) return { committed: false, out: add.out };
  const commit = run(dir, `git commit -m ${JSON.stringify(message)}`);
  return commit.ok ? { committed: true, out: commit.out } : { committed: false, out: commit.out };
}

/** 基线快照：git add -A 全量暂存后提交（改前自动提交，用户偏好） */
export function gitCommitAll(dir: string, message: string): { committed: boolean; out: string } {
  const add = run(dir, 'git add -A');
  if (!add.ok) return { committed: false, out: add.out };
  const commit = run(dir, `git commit -m ${JSON.stringify(message)}`);
  return commit.ok ? { committed: true, out: commit.out } : { committed: false, out: commit.out };
}

/** 回退：git checkout 还原指定文件（验收失败时用） */
export function gitRestoreFiles(dir: string, files: string[]): { ok: boolean; out: string } {
  if (files.length === 0) return { ok: true, out: '无需回退' };
  return run(dir, `git checkout -- ${files.map((f) => JSON.stringify(f)).join(' ')}`);
}
