/**
 * Camera 插桩器契约模式测试（与 Go 侧 instrument.Options.ContractProbes 语义对齐）。
 *
 * 验证点：
 *   1. 契约模式：只注入声明的探针点（精确匹配 <mod>.<fn>.<suffix>）。
 *   2. 契约模式：未声明探针不注入。
 *   3. 契约模式：声明不存在的探针 → 0 探针。
 *   4. 探索模式（缺省 contractProbes）→ 全量插桩（与旧行为一致）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { instrumentFile } from '../../src/camera/instrument.js';

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-inst-contract-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'src', 'store.ts'),
    `import fs from 'node:fs';\n\nexport function save(name: string) {\n  fs.writeFileSync('/tmp/x', name);\n  return true;\n}\n\nexport function mk() {\n  fs.mkdirSync('/tmp/d');\n}\n`,
    'utf-8',
  );
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 每个用例用独立子目录，避免幂等标记干扰 */
function freshDir(t: { name: string }): string {
  const sub = path.join(dir, t.name.replace(/\s+/g, '_'));
  fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
  fs.copyFileSync(
    path.join(dir, 'src', 'store.ts'),
    path.join(sub, 'src', 'store.ts'),
  );
  return sub;
}

describe('契约模式插桩', () => {
  it('只注入声明的探针点（store.save.writefile），其余不注入', async () => {
    const sub = freshDir({ name: 'filtered' });
    const res = await instrumentFile(path.join(sub, 'src', 'store.ts'), {
      contractProbes: ['store.save.writefile'],
    });
    expect(res.error).toBeUndefined();
    // 只应有 save.writefile 一个 io 探针
    expect(res.sites.length).toBe(1);
    expect(res.sites[0].kind).toBe('io');
    const content = fs.readFileSync(path.join(sub, 'src', 'store.ts'), 'utf-8');
    expect(content).toContain('"store.save.writefile"');
    expect(content).not.toContain('"store.save.enter"');
    expect(content).not.toContain('"store.mk.mkdirall"');
  });

  it('声明多个探针（enter + writefile）时全部精确注入', async () => {
    const sub = freshDir({ name: 'multiple' });
    const res = await instrumentFile(path.join(sub, 'src', 'store.ts'), {
      contractProbes: ['store.save.enter', 'store.save.writefile'],
    });
    expect(res.error).toBeUndefined();
    expect(res.sites.length).toBe(2);
    const kinds = res.sites.map((s) => s.kind);
    expect(kinds).toContain('enter');
    expect(kinds).toContain('io');
    const content = fs.readFileSync(path.join(sub, 'src', 'store.ts'), 'utf-8');
    expect(content).toContain('"store.save.enter"');
    expect(content).toContain('"store.save.writefile"');
    expect(content).not.toContain('"store.mk.mkdirall"');
  });

  it('声明不存在的探针 → 0 探针（不写盘）', async () => {
    const sub = freshDir({ name: 'nomatch' });
    const res = await instrumentFile(path.join(sub, 'src', 'store.ts'), {
      contractProbes: ['other.fn.enter'],
    });
    expect(res.error).toBeUndefined();
    expect(res.sites.length).toBe(0);
    const content = fs.readFileSync(path.join(sub, 'src', 'store.ts'), 'utf-8');
    expect(content).not.toContain('captureProbe');
    expect(content).not.toContain('camera:instrumented');
  });

  it('探索模式（缺省 contractProbes）→ 全量插桩', async () => {
    const sub = freshDir({ name: 'explore' });
    const res = await instrumentFile(path.join(sub, 'src', 'store.ts'));
    expect(res.error).toBeUndefined();
    // save: enter + exit(return true) + writefile；mk: enter + exit(尾部) + mkdirall
    expect(res.sites.length).toBeGreaterThanOrEqual(5);
    const content = fs.readFileSync(path.join(sub, 'src', 'store.ts'), 'utf-8');
    expect(content).toContain('"store.save.enter"');
    expect(content).toContain('"store.save.writefile"');
    expect(content).toContain('"store.mk.mkdirall"');
  });
});
