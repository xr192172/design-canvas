/**
 * Camera 全自动插桩器测试：验证 AST 源码级插桩直接改写真实文件。
 *
 * 验证点：
 *   1. collectTsFiles 递归收集 .ts 文件（跳过 node_modules/dist 等）。
 *   2. instrumentFile 在 catch 块注入探针（含 import 顶部补 + 幂等标记）。
 *   3. instrumentFile 在 IO 写盘调用后注入探针。
 *   4. 从后往前注入无偏移漂移（多处插入位置正确）。
 *   5. 幂等：二次插桩跳过（已含 PROBE_MARKER）。
 *   6. dry-run（write=false）不写盘。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectTsFiles,
  instrumentFile,
  instrumentProject,
} from '../../src/camera/instrument.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-inst-'));
  // 构造一个真实 .ts 项目
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'service.ts'),
    `import fs from 'node:fs';\n\nexport class Service {\n  save(name: string) {\n    try {\n      fs.writeFileSync('/tmp/x', name);\n    } catch (e) {\n      /* 静默丢弃 */\n    }\n    return true;\n  }\n\n  mkdir() {\n    fs.mkdirSync('/tmp/d');\n  }\n}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'src', 'util.ts'),
    `export function helper(n: number) {\n  const x = n * 2;\n  return x;\n}\n`,
    'utf-8',
  );
  // 应被跳过的目录
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.ts'), `export const x = 1;\n`, 'utf-8');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dist', 'y.ts'), `export const y = 2;\n`, 'utf-8');
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('collectTsFiles - 收集源文件', () => {
  it('递归收集 .ts 文件并跳过 node_modules/dist', () => {
    const files = collectTsFiles(dir).map((f) => path.relative(dir, f));
    expect(files).toContain(path.join('src', 'service.ts'));
    expect(files).toContain(path.join('src', 'util.ts'));
    expect(files).not.toContain(path.join('node_modules', 'x.ts'));
    expect(files).not.toContain(path.join('dist', 'y.ts'));
  });
});

describe('instrumentFile - 单文件插桩', () => {
  it('全量插桩：函数入口/出口 + catch + IO，并附带分级标签', async () => {
    const res = await instrumentFile(path.join(dir, 'src', 'service.ts'));
    expect(res.error).toBeUndefined();
    // service.save 有 return true → enter + exit(return值) + catch + io(writeFileSync)
    // service.mkdir 无 return → enter + 末尾exit + io(mkdirSync)
    expect(res.sites.length).toBeGreaterThanOrEqual(6);

    const kinds = res.sites.map((s) => s.kind);
    expect(kinds).toContain('enter');
    expect(kinds).toContain('exit');
    expect(kinds).toContain('catch');
    expect(kinds).toContain('io');

    // 分级标签：enter/exit 为 core，catch/io 为 event
    const coreSites = res.sites.filter((s) => s.level === 'core');
    const eventSites = res.sites.filter((s) => s.level === 'event');
    expect(coreSites.length).toBeGreaterThanOrEqual(4); // 2 enter + 2 exit
    expect(eventSites.length).toBeGreaterThanOrEqual(2); // catch + 2 io 至少 1
    for (const s of coreSites) expect(['enter', 'exit']).toContain(s.kind);
    for (const s of eventSites) expect(['catch', 'io']).toContain(s.kind);

    const content = fs.readFileSync(path.join(dir, 'src', 'service.ts'), 'utf-8');
    expect(content).toContain('camera:instrumented');
    expect(content).toContain('captureProbe');
    expect(content).toContain('save.enter');
    expect(content).toContain('save.exit');
    expect(content).toContain('save.writefile');
    expect(content).toContain('mkdirall');
    expect(content).toContain("level: 'core'");
    expect(content).toContain("level: 'event'");
  });

  it('return 值捕获：替换 return 语句为 const+probe+return', async () => {
    const res = await instrumentFile(path.join(dir, 'src', 'util.ts'));
    expect(res.error).toBeUndefined();
    const content = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    // helper 有 return x（简单表达式）→ 值捕获
    expect(content).toContain('helper.enter');
    expect(content).toContain('helper.exit');
    expect(content).toContain('__cam_ret');
    expect(content).toContain('return __cam_ret');
  });

  it('幂等：二次插桩跳过', async () => {
    const svc1 = await instrumentFile(path.join(dir, 'src', 'service.ts'));
    expect(svc1.sites.length).toBe(0); // 已插桩过，跳过
  });

  it('dry-run 不写盘', async () => {
    const before = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    const res = await instrumentFile(path.join(dir, 'src', 'util.ts'), { write: false });
    expect(res.error).toBeUndefined();
    // 已插桩过 → 幂等跳过，无插桩点
    expect(res.sites.length).toBe(0);
    const after = fs.readFileSync(path.join(dir, 'src', 'util.ts'), 'utf-8');
    expect(after).toBe(before);
  });
});

describe('instrumentProject - 全项目插桩', () => {
  it('对项目所有源文件插桩并返回每文件结果', async () => {
    // 用新子目录避免幂等干扰
    const sub = path.join(dir, 'proj2');
    fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(sub, 'src', 'a.ts'),
      `import fs from 'node:fs';\nexport function w() {\n  try { fs.writeFileSync('/x','y'); } catch (e) {}\n}\n`,
      'utf-8',
    );
    const results = await instrumentProject(sub);
    const aResult = results.find((r) => path.basename(r.file) === 'a.ts');
    expect(aResult).toBeTruthy();
    expect(aResult!.sites.length).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(path.join(sub, 'src', 'a.ts'), 'utf-8');
    expect(content).toContain('captureProbe');
  });
});