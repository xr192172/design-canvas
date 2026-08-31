/**
 * Observe 全自动插桩 CLI 测试：验证「扩插桩覆盖 = 跑一条命令全自动」，幂等。
 * 验证点：
 *   1. --dry-run 只报告不写盘。
 *   2. 真实写盘后源码含探针标记。
 *   3. 重跑幂等：已插桩文件跳过。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstrumentCLI } from '../../src/observe/instrument_cli.js';

let dir: string;

function capture(fn: () => Promise<void>): () => Promise<string> {
  return async () => {
    const oldLog = console.log;
    const oldErr = console.error;
    let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    console.error = (...a) => { out += a.join(' ') + '\n'; };
    try {
      await fn();
    } finally {
      console.log = oldLog;
      console.error = oldErr;
    }
    return out;
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-cli-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'util.ts'),
    `import fs from 'node:fs';\nexport function save(n: string) {\n  try { fs.writeFileSync('/tmp/x', n); } catch (e) { /* 静默 */ }\n  return true;\n}\n`,
  );
});

describe('Observe 全自动插桩 CLI', () => {
  it('--dry-run 只报告不写盘', async () => {
    const out = await capture(() => runInstrumentCLI([dir, '--dry-run']))();
    expect(out).toContain('[DRY-RUN]');
    expect(out).toContain('将注入');
    // 源码未被改写
    const content = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(content).not.toContain('observe:instrumented');
  });

  it('真实写盘后源码含探针标记', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const content = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(content).toContain('observe:instrumented');
    expect(content).toContain('captureProbe(');
  });

  it('重跑幂等：已插桩文件跳过', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const out = await capture(() => runInstrumentCLI([dir]))();
    expect(out).toContain('已含探针跳过');
    expect(out).toContain('0 文件新插桩');
  });

  it('--uninstrument 一键还原：插桩前已备份，还原后源码回到原版并删备份', async () => {
    const original = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    // 插桩并确认写盘
    await capture(() => runInstrumentCLI([dir]))();
    const instrumented = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(instrumented).toContain('observe:instrumented');
    // 备份已生成
    const backupFile = path.join(dir, '.design-canvas', 'observe-backup', 'src', 'util.ts');
    expect(fs.existsSync(backupFile)).toBe(true);
    expect(fs.readFileSync(backupFile, 'utf-8')).toBe(original);
    // 一键还原
    const out = await capture(() => runInstrumentCLI([dir, '--uninstrument']))();
    expect(out).toContain('已还原');
    expect(fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8')).toBe(original);
    // 备份目录已删除
    expect(fs.existsSync(path.join(dir, '.design-canvas', 'observe-backup'))).toBe(false);
  });

  it('--uninstrument 无备份时提示无需还原', async () => {
    const out = await capture(() => runInstrumentCLI([dir, '--uninstrument']))();
    expect(out).toContain('未找到备份');
  });

  it('写盘插桩后自动生成探针台账并统计', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const ledgerFile = path.join(dir, '.design-canvas', 'observe-ledger.json');
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8'));
    expect(ledger.projectRoot).toBe(dir);
    expect(ledger.stats.total).toBeGreaterThan(0);
    expect(ledger.stats.files).toBe(1);
    // 统计包含 perKind / perLevel
    expect(typeof ledger.stats.perKind).toBe('object');
    expect(typeof ledger.stats.perLevel).toBe('object');
    // 台账探针点与源码里的 captureProbe 数一致
    expect(ledger.sites.length).toBe(ledger.stats.total);
  });

  it('--dry-run 不生成台账', async () => {
    await capture(() => runInstrumentCLI([dir, '--dry-run']))();
    expect(fs.existsSync(path.join(dir, '.design-canvas', 'observe-ledger.json'))).toBe(false);
  });

  it('--ledger 查看台账统计与明细', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const out = await capture(() => runInstrumentCLI([dir, '--ledger']))();
    expect(out).toContain('探针台账');
    expect(out).toContain('统计：');
    expect(out).toContain('探针点');
    expect(out).toContain('util.ts');
    expect(out).toContain('enter');
  });

  it('--ledger 无台账时提示未找到', async () => {
    const out = await capture(() => runInstrumentCLI([dir, '--ledger']))();
    expect(out).toContain('未找到台账');
  });

  it('--uninstrument 一键全拔联动清理台账', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const ledgerFile = path.join(dir, '.design-canvas', 'observe-ledger.json');
    expect(fs.existsSync(ledgerFile)).toBe(true);
    const out = await capture(() => runInstrumentCLI([dir, '--uninstrument']))();
    expect(out).toContain('已清理探针台账');
    expect(fs.existsSync(ledgerFile)).toBe(false);
  });
});