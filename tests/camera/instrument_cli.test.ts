/**
 * Camera 全自动插桩 CLI 测试：验证「扩插桩覆盖 = 跑一条命令全自动」，幂等。
 * 验证点：
 *   1. --dry-run 只报告不写盘。
 *   2. 真实写盘后源码含探针标记。
 *   3. 重跑幂等：已插桩文件跳过。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstrumentCLI } from '../../src/camera/instrument_cli.js';

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

describe('Camera 全自动插桩 CLI', () => {
  it('--dry-run 只报告不写盘', async () => {
    const out = await capture(() => runInstrumentCLI([dir, '--dry-run']))();
    expect(out).toContain('[DRY-RUN]');
    expect(out).toContain('将注入');
    // 源码未被改写
    const content = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(content).not.toContain('camera:instrumented');
  });

  it('真实写盘后源码含探针标记', async () => {
    await capture(() => runInstrumentCLI([dir]))();
    const content = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(content).toContain('camera:instrumented');
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
    expect(instrumented).toContain('camera:instrumented');
    // 备份已生成
    const backupFile = path.join(dir, '.design-canvas', 'camera-backup', 'src', 'util.ts');
    expect(fs.existsSync(backupFile)).toBe(true);
    expect(fs.readFileSync(backupFile, 'utf-8')).toBe(original);
    // 一键还原
    const out = await capture(() => runInstrumentCLI([dir, '--uninstrument']))();
    expect(out).toContain('已还原');
    expect(fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8')).toBe(original);
    // 备份目录已删除
    expect(fs.existsSync(path.join(dir, '.design-canvas', 'camera-backup'))).toBe(false);
  });

  it('--uninstrument 无备份时提示无需还原', async () => {
    const out = await capture(() => runInstrumentCLI([dir, '--uninstrument']))();
    expect(out).toContain('未找到备份');
  });
});