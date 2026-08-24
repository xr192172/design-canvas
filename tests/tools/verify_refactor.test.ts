/**
 * verify_refactor 改前/改后验证闭环测试
 *
 * 覆盖：
 *   - applyWithVerify 通用闭环：基线绿+改后绿 → applied_verified；基线黄 → baseline_fail
 *     且不改；改后黄 → regression_rolled_back 且已回滚；无变更 → no_change。
 *   - removeDeadImportsWithVerify 集成：verify 缺省/false 只执行不验证；true 走闭环；
 *     verifyImpl（注入 spy）驱动基线失败 / 改后回归回滚 / 改后通过；命令探测不到不可验证。
 *   - runVerification / defaultVerifyCommands 的纯行为。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll, vi } from 'vitest';
import { runVerification, defaultVerifyCommands, applyWithVerify, type VerifyCommand } from '../../src/tools/verify_refactor';
import { removeDeadImportsWithVerify, type RemoveDeadImportsVerifyResult } from '../../src/tools/remove_dead_imports';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      // Windows 占用，留给 OS
    }
  }
});

function tempRoot(): string {
  const dir = path.join(os.tmpdir(), `vrfy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const ok: ReturnType<typeof runVerification> = { status: 'pass', at: 't' };
const fail: ReturnType<typeof runVerification> = { status: 'fail', at: 't', detail: 'boom' };

/** 顺序返回各次验证结果的 spy（依次消耗 provided；耗尽后用最后一个） */
function spy(seq: ('pass' | 'fail')[]) {
  let i = 0;
  return vi.fn((o: { cwd: string; commands: VerifyCommand[] }) => {
    // 缺省 walk 目录，让测例可当作 auto-detect 输入
    return seq[Math.min(i++, seq.length - 1)] === 'pass' ? { ...ok, at: 't' } : { ...fail, at: 't' };
  });
}

describe('runVerification', () => {
  it('全部命令通过 → pass', () => {
    const r = runVerification({ cwd: '.', commands: [] });
    expect(r.status).toBe('pass');
  });

  it.skipIf(process.platform !== 'win32')('Windows：npx 能通过 shell 解析启动（回归：spawn("npx") 不补 .cmd → ENOENT）', () => {
    const dir = tempRoot();
    const r = runVerification({ cwd: dir, commands: [{ label: 'npx version', cmd: 'npx', args: ['--version'] }] });
    expect(r.status).toBe('pass');
    expect(r.detail).toContain('pass');
  });

  it('defaultVerifyCommands：有 go.mod → go build + go test', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n', 'utf-8');
    const c = defaultVerifyCommands(dir);
    expect(c.map((x) => x.label)).toEqual(['go build', 'go test']);
  });

  it('defaultVerifyCommands：有 package.json + test script → tsc + npm test；无 test → 仅 tsc', () => {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }), 'utf-8');
    expect(defaultVerifyCommands(dir).map((x) => x.label)).toEqual(['tsc noEmit', 'npm test']);

    const dir2 = tempRoot();
    fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ name: 'y' }), 'utf-8');
    expect(defaultVerifyCommands(dir2).map((x) => x.label)).toEqual(['tsc noEmit']);
  });

  it('defaultVerifyCommands：无 go.mod/package.json → 空（不可自动验证）', () => {
    const dir = tempRoot();
    expect(defaultVerifyCommands(dir)).toEqual([]);
  });
});

describe('applyWithVerify', () => {
  function mkFile() {
    const dir = tempRoot();
    const f = path.join(dir, 'a.ts');
    fs.writeFileSync(f, 'original\n', 'utf-8');
    return { dir, f, read: () => fs.readFileSync(f, 'utf-8') };
  }

  it('基线绿 + 改后绿 → applied_verified，改动落盘', () => {
    const { dir, f, read } = mkFile();
    const verify = spy(['pass', 'pass']);
    const r = applyWithVerify({
      cwd: dir,
      commands: [{ label: 't', cmd: 'true', args: [] }],
      verify,
      apply: () => {
        fs.writeFileSync(f, 'changed\n', 'utf-8');
        return true;
      },
      rollback: () => fs.writeFileSync(f, 'original\n', 'utf-8'),
    });
    expect(r.outcome).toBe('applied_verified');
    expect(r.applied).toBe(true);
    expect(read()).toBe('changed\n');
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('基线失败 → baseline_fail，一个文件都不改', () => {
    const { dir, f, read } = mkFile();
    const verify = spy(['fail']);
    const applied = vi.fn();
    const r = applyWithVerify({
      cwd: dir,
      commands: [{ label: 't', cmd: 'true', args: [] }],
      verify,
      apply: () => {
        applied();
        fs.writeFileSync(f, 'changed\n', 'utf-8');
        return true;
      },
      rollback: () => fs.writeFileSync(f, 'original\n', 'utf-8'),
    });
    expect(r.outcome).toBe('baseline_fail');
    expect(r.applied).toBe(false);
    expect(applied).not.toHaveBeenCalled(); // 基线不过 → 不执行 apply
    expect(read()).toBe('original\n');
  });

  it('改后回归 → regression_rolled_back，已回滚到原位', () => {
    const { dir, f, read } = mkFile();
    const verify = spy(['pass', 'fail']);
    const r = applyWithVerify({
      cwd: dir,
      commands: [{ label: 't', cmd: 'true', args: [] }],
      verify,
      apply: () => {
        fs.writeFileSync(f, 'changed\n', 'utf-8');
        return true;
      },
      rollback: vi.fn(() => fs.writeFileSync(f, 'original\n', 'utf-8')),
    });
    expect(r.outcome).toBe('regression_rolled_back');
    expect(r.applied).toBe(false);
    expect(r.rollback).toBeDefined();
    expect(read()).toBe('original\n'); // 已回滚
  });

  it('无实际变更 → no_change，不落盘不重验', () => {
    const { dir } = mkFile();
    const verify = spy(['pass']);
    const rollback = vi.fn();
    const r = applyWithVerify({
      cwd: dir,
      commands: [{ label: 't', cmd: 'true', args: [] }],
      verify,
      apply: () => false,
      rollback,
    });
    expect(r.outcome).toBe('no_change');
    expect(r.applied).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1); // 只跑基线，不重验
    expect(rollback).not.toHaveBeenCalled();
  });
});

describe('removeDeadImportsWithVerify · 闭环', () => {
  function goFixture() {
    const dir = tempRoot();
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module demo\n\ngo 1.25\n', 'utf-8');
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    const f = path.join(dir, 'pkg/a.go');
    fs.writeFileSync(f, 'package p\n\nimport (\n\t"fmt"\n\t"github.com/dead/dd"\n)\n\nfunc F() int { return 1 }\n', 'utf-8');
    const dead = [{ source: 'github.com/dead/dd', files: ['pkg/a.go'], reason: 'no_reference' as const }];
    return { dir, dead, read: () => fs.readFileSync(f, 'utf-8') };
  }

  it('verify 缺省/false：只执行不验证（not_verifiable）', () => {
    const { dir, dead, read } = goFixture();
    const r = removeDeadImportsWithVerify({ project_dir: dir, dead, verify: false });
    expect(r.files_changed).toBe(1);
    expect(r.verification.outcome).toBe('not_verifiable');
    expect(r.verification.enabled).toBe(false);
    expect(read()).not.toContain('github.com/dead/dd');
  });

  it('基线绿 + 改后绿 → applied_verified，改动落盘', () => {
    const { dir, dead, read } = goFixture();
    const r = removeDeadImportsWithVerify({
      project_dir: dir,
      dead,
      verify: { commands: [{ label: 't', cmd: 'true', args: [] }] },
      verifyImpl: spy(['pass', 'pass']),
    });
    expect(r.verification.outcome).toBe('applied_verified');
    expect(r.files_changed).toBe(1);
    expect(read()).not.toContain('github.com/dead/dd');
  });

  it('基线失败 → baseline_fail，一个都不写', () => {
    const { dir, dead, read } = goFixture();
    const r = removeDeadImportsWithVerify({
      project_dir: dir,
      dead,
      verify: { commands: [{ label: 't', cmd: 'true', args: [] }] },
      verifyImpl: spy(['fail']),
    });
    expect(r.verification.outcome).toBe('baseline_fail');
    expect(r.files_changed).toBe(0);
    expect(read()).toContain('github.com/dead/dd'); // 未动
  });

  it('改后回归 → regression_rolled_back，已回滚到写盘前内容', () => {
    const { dir, dead, read } = goFixture();
    const before = read();
    const r = removeDeadImportsWithVerify({
      project_dir: dir,
      dead,
      verify: { commands: [{ label: 't', cmd: 'true', args: [] }] },
      verifyImpl: spy(['pass', 'fail']),
    });
    expect(r.verification.outcome).toBe('regression_rolled_back');
    expect(r.verification.rolled_back).toBe(true);
    expect(read()).toBe(before); // 已还原
  });

  it('改后无回调前内容变化时 no_change（无实际变更）', () => {
    const { dir, dead, read } = goFixture();
    // 目标源 dead 已在磁盘之外给已删版本：传入指向不含该源的源 → 无变更
    const r = removeDeadImportsWithVerify({
      project_dir: dir,
      dead: [{ source: 'not-present', files: ['pkg/a.go'], reason: 'no_reference' }],
      verify: { commands: [{ label: 't', cmd: 'true', args: [] }] },
      verifyImpl: spy(['pass']),
    });
    expect(r.verification.outcome).toBe('no_change');
    expect(r.files_changed).toBe(0);
  });

  it('命令探测不到（无 go.mod/package.json）→ not_verifiable，仍执行改写', () => {
    const dir = tempRoot();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    const f = path.join(dir, 'src/b.ts');
    fs.writeFileSync(f, "import { x } from 'dead-ts';\n", 'utf-8');
    const r = removeDeadImportsWithVerify({
      project_dir: dir,
      dead: [{ source: 'dead-ts', files: ['src/b.ts'], reason: 'no_reference' }],
      verify: true, // 自动探测 → 空命令组
    });
    expect(r.verification.outcome).toBe('not_verifiable');
    expect(r.verification.enabled).toBe(true);
    expect(r.files_changed).toBe(1);
    expect(fs.readFileSync(f, 'utf-8')).not.toContain('dead-ts');
  });
});