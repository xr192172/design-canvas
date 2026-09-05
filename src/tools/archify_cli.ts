/**
 * archify_cli —— Archify 官方命令的进程封装（validate / deliver，showcase 质量）
 *
 * 这是把 Archify 当内置能力的执行触点：定位 CLI（ARCHIFY_ROOT 指向含 archify/ 的根）、
 * 用官方 validate/deliver 判定 showcase 产出。validate 不达要求只带回诊断，不做几何修补。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function resolveArchifyRoot(explicit?: string): string {
  return (explicit?.trim() || process.env.ARCHIFY_ROOT?.trim() || '').replace(/[\\/]+$/, '');
}

export function archifyCliPath(root: string): string {
  return path.join(root, 'archify', 'bin', 'archify.mjs');
}

export interface CliResult { ok: boolean; stdout: string; stderr: string; note?: string }

/** 运行 archify CLI 并返回结果（不抛异常，交给调用方判定） */
function run(root: string, args: string[]): CliResult {
  const cli = archifyCliPath(root);
  const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    return { ok: false, stdout: '', stderr: '', note: 'Archify CLI 调用超时（25s）' };
  }
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  const ok = r.status === 0;
  return { ok, stdout, stderr };
}

/** validate（默认 showcase 质量；可降级 standard）。candidateJson 为绝对路径或原始 JSON 对象。 */
export function validateCandidate(root: string, type: string, candidateJson: unknown, quality: 'showcase' | 'standard', scaffoldDir?: string): CliResult {
  const dump = toFile(candidateJson, scaffoldDir, `${type}-validate.json`);
  const r = run(root, ['validate', type, dump.abspath, '--quality', quality, '--json']);
  return r;
}
/** 兼容别名：showcase 校验 */
export function validateShowcase(root: string, type: string, candidateJson: unknown, scaffoldDir?: string): CliResult {
  return validateCandidate(root, type, candidateJson, 'showcase', scaffoldDir);
}

/** deliver 出官方 HTML（默认 showcase；可降级 standard）。htmlPath 为输出目标绝对路径。 */
export function deliverHtml(root: string, type: string, candidateJson: unknown, htmlPath: string, quality: 'showcase' | 'standard', scaffoldDir?: string): CliResult {
  const dump = toFile(candidateJson, scaffoldDir, `${type}-deliver.json`);
  const r = run(root, ['deliver', type, dump.abspath, htmlPath, '--quality', quality, '--json']);
  return r;
}

/** 把 candidate 写成临时 JSON；若在 scaffoldDir 内写则保持可追溯 */
function toFile(candidateJson: unknown, scaffoldDir: string | undefined, suffix: string): { file: string; abspath: string } {
  if (typeof candidateJson === 'string') return { file: candidateJson, abspath: candidateJson };
  if (scaffoldDir) {
    fs.mkdirSync(scaffoldDir, { recursive: true });
    const rel = `${suffix}`;
    fs.writeFileSync(path.join(scaffoldDir, rel), JSON.stringify(candidateJson, null, 2), 'utf-8');
    return { file: rel, abspath: path.join(scaffoldDir, rel) };
  }
  const f = path.join(os.tmpdir(), `archify-${Date.now()}-${suffix}`);
  fs.writeFileSync(f, JSON.stringify(candidateJson, null, 2), 'utf-8');
  return { file: f, abspath: f };
}