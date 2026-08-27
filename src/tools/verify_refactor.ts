/**
 * verify_refactor —— 改前/改后验证闭环（重构安全网）
 *
 * 与瘦身/改名等"确定性改写执行器"配合，保证人拍板后的改写在生产环境的
 * 编译 + 测试仍是绿的。核心契约：**改前必须绿，改后也须绿；改后黄了就回滚。**
 *
 * 闭环三步：
 *   1. 基线（baseline）——改写前在项目目录跑验证命令组。基线失败则拒绝执行，
 *      一个文件都不改（不把坏地基上的改动怪到首刀头上）。
 *   2. 落盘（apply）——执行改写、写盘。
 *   3. 重验（after）——同一批命令再跑一遍。通过则收工；失败则回滚（把写盘
 *      前的文件内容还原），并把"改后回归已回滚"如实报告。
 *
 * 设计：
 *   - 纯命令化（cmd + args），不绑定具体构建系统；spawnSync 顺序跑命令组。
 *   - `runVerification` 与 `defaultVerifyCommands` 都是纯函数，便于单测直接注入
 *     verify spy（applyWithVerify 的 verify 可替换），不必真跑工具链。
 *   - 缺省命令按项目形态探测：有 go.mod → go build ./... + go test ./...；
 *     有 package.json → tsc --noEmit + npm test（若配了 test script）。
 *   - 探测不出的项目形态返回空命令组 → 视为"不可验证"，由调用方决定降级。
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { adapters } from '../version_upgrade/adapters/registry.js';

// ── 命令与结果类型 ─────────────────────────────────────────

export interface VerifyCommand {
  /** 人类可读标签（写进 detail 便于排查） */
  label: string;
  cmd: string;
  args: string[];
  timeoutMs?: number;
}

export interface VerificationOutcome {
  status: 'pass' | 'fail' | 'skipped';
  at: string;
  detail?: string;
}

/** 顺序跑命令组；任一失败立即 return fail（后续命令不再执行）。 */
export function runVerification(opts: { cwd: string; commands: VerifyCommand[] }): VerificationOutcome {
  const at = new Date().toISOString();
  const runs: string[] = [];
  for (const c of opts.commands ?? []) {
    const run: SpawnSyncReturns<string> = spawnSync(c.cmd, c.args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: c.timeoutMs ?? 300_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      // Windows：spawn('npx')/spawn('npm') 不走 shell 解析不会自动补 .cmd 扩展名 → ENOENT。
      // 验证命令组里 npx/npm 是缺省（不可选），必须能在这平台上真正跑起来。
      shell: process.platform === 'win32',
    });
    if (run.error) {
      runs.push(`[${c.label}] 启动失败：${run.error.message}`);
      return { status: 'fail', at, detail: runs.join('\n') };
    }
    const out = `${run.stdout || ''}\n${run.stderr || ''}`.trim().slice(-4000);
    if (run.status !== 0) {
      runs.push(`[${c.label}] exit ${run.status}${out ? `\n${out}` : ''}`);
      return { status: 'fail', at, detail: runs.join('\n') };
    }
    runs.push(`[${c.label}] pass${out ? `\n${out}` : ''}`);
  }
  return { status: 'pass', at, detail: runs.join('\n') || undefined };
}

/** 按项目形态给缺省验证命令组（可被调用方 commands 覆盖）。委托语言适配器。 */
export function defaultVerifyCommands(cwd: string): VerifyCommand[] {
  for (const a of adapters) {
    if (!a.verifyCommands) continue;
    const cmds = a.verifyCommands(cwd);
    if (cmds.length > 0) return cmds;
  }
  return [];
}

// ── 闭环编排 ─────────────────────────────────────────────────

export type VerifyOutcomeKind = 'applied_verified' | 'baseline_fail' | 'regression_rolled_back' | 'no_change' | 'not_verifiable';

export interface ApplyWithVerifyResult {
  /** 是否最终把改动留在盘上（true = 已落盘且通过验证；false = 未落盘/已回滚） */
  applied: boolean;
  outcome: VerifyOutcomeKind;
  baseline: VerificationOutcome | null;
  after: VerificationOutcome | null;
  /** 回滚动作说明（regression_rolled_back 时存在） */
  rollback?: string[];
}

export interface ApplyWithVerifyOpts {
  /** 验证命令的工作目录（通常 = 项目根） */
  cwd: string;
  /** 改前/改后共用的验证命令组 */
  commands: VerifyCommand[];
  /** 执行改写并回到是否真正落盘（返回 false = 无实际变更）的函数 */
  apply: () => boolean;
  /** 改后验证失败时把文件还原的回滚函数 */
  rollback: () => void;
  /** 内部验证执行器；单测可注入 spy，默认跑真命令 */
  verify?: (o: { cwd: string; commands: VerifyCommand[] }) => VerificationOutcome;
}

export function applyWithVerify(opts: ApplyWithVerifyOpts): ApplyWithVerifyResult {
  const run = opts.verify ?? runVerification;

  const baseline = run({ cwd: opts.cwd, commands: opts.commands });
  if (baseline.status === 'fail') {
    // 地基就是黄的——拒绝执行，一个文件都不改
    return { applied: false, outcome: 'baseline_fail', baseline, after: null };
  }

  const changed = opts.apply();
  if (!changed) {
    return { applied: false, outcome: 'no_change', baseline, after: { status: 'pass', at: baseline.at } };
  }

  const after = run({ cwd: opts.cwd, commands: opts.commands });
  if (after.status === 'fail') {
    opts.rollback();
    return {
      applied: false,
      outcome: 'regression_rolled_back',
      baseline,
      after,
      rollback: ['还原全部改写文件到写盘前内容（改后验证回归已回滚）'],
    };
  }

  return { applied: true, outcome: 'applied_verified', baseline, after };
}