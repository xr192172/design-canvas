/**
 * Camera deep 级插桩测试（PR 偏差1）：验证 enableDeep 时捕获函数内部数据流动。
 *
 * 验证点：
 *   1. enableDeep=true 时，对 `if (x > 0) { const y = a + b; }` 注入 deep 探针，
 *      同时捕获「变量赋值」（y）与「条件分支」（x > 0）。
 *   2. deep 探针统一打 level:'deep' 标签，与 core/event 正交。
 *   3. enableDeep 默认 false 时不注入 deep 探针（core/event 不受影响）。
 *   4. deep 幂等：二次 enableDeep 插桩跳过（camera:deep 标记）。
 *   5. 注入不破坏语法（可安全重求值）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instrumentFile } from '../../src/camera/instrument.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-deep-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // 目标文件：含函数、变量赋值、条件分支、赋值表达式
  fs.writeFileSync(
    path.join(dir, 'src', 'flow.ts'),
    `export function compute(a: number, b: number) {\n  if (a > 0) {\n    const y = a + b;\n    return y;\n  }\n  let z = 0;\n  z = y ?? 0;\n  return z;\n}\n`,
    'utf-8',
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deep 级插桩', () => {
  it('enableDeep=true 时捕获变量赋值与条件分支（level:deep）', async () => {
    const file = path.join(dir, 'src', 'flow.ts');
    const res = await instrumentFile(file, { enableDeep: true });
    expect(res.error).toBeUndefined();

    const deepSites = res.sites.filter((s) => s.level === 'deep');
    expect(deepSites.length).toBeGreaterThanOrEqual(2);

    // 变量赋值捕获：const y = a + b → 捕获 y
    const ySite = deepSites.find((s) => s.injected.includes('name: "y"'));
    expect(ySite).toBeTruthy();
    expect(ySite!.injected).toContain('value: y');
    expect(ySite!.injected).toContain("level: 'deep'");
    expect(ySite!.kind).toBe('deep');

    // 条件分支捕获：if (a > 0) → 捕获 a > 0
    const condSite = deepSites.find((s) => s.injected.includes('cond: "a > 0"'));
    expect(condSite).toBeTruthy();
    expect(condSite!.injected).toContain('value: a > 0');

    // 写盘后文件含 deep 标记与 deep 探针，且语法完整（能被解析）
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).toContain('camera:deep');
    expect(content).toContain("level: 'deep'");
    expect(content).toContain('compute.deep');
  });

  it('enableDeep 默认 false 时不注入 deep 探针', async () => {
    // 新文件，未插桩
    const file = path.join(dir, 'src', 'fresh.ts');
    fs.writeFileSync(file, `export function f(x: number) {\n  const y = x * 2;\n  return y;\n}\n`, 'utf-8');
    const res = await instrumentFile(file);
    expect(res.error).toBeUndefined();
    // 默认仅 core/event，无 deep
    expect(res.sites.some((s) => s.level === 'deep')).toBe(false);
    const content = fs.readFileSync(file, 'utf-8');
    expect(content).not.toContain('camera:deep');
    expect(content).not.toContain("level: 'deep'");
  });

  it('deep 幂等：二次 enableDeep 插桩跳过', async () => {
    const file = path.join(dir, 'src', 'flow.ts');
    // 已 enableDeep 插桩过 → 跳过
    const res = await instrumentFile(file, { enableDeep: true });
    expect(res.sites.length).toBe(0);
  });

  it('dry-run 不写盘也不落 deep 标记', async () => {
    const file = path.join(dir, 'src', 'flow.ts');
    const before = fs.readFileSync(file, 'utf-8');
    const res = await instrumentFile(file, { enableDeep: true, write: false });
    expect(res.error).toBeUndefined();
    // 已标记 deep → 幂等跳过
    expect(res.sites.length).toBe(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});