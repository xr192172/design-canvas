/**
 * rename_file —— 文件级智能重命名测试（防文件悬空）
 *
 * 覆盖：
 *   - 干跑(dry_run)：只算影响面，不迁移/不改写/不重索引。
 *   - 真实重命名：被引用文件全部改写 + 源消失 + 目标出现 + 内部相对导入重锚定。
 *   - 扩展名引用(/src/foo 用 ./foo.js 引)改后保留扩展名风格。
 *   - 目录桶(index.ts)移动：引用 ./dirname 语义变化 → pending 提醒，引用改写为指向新文件。
 *   - 原子阻断：目标已存在 / 源缺失 → ok=false、blocked、不落盘。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameFile } from '../../src/tools/rename_file';
import { closeProjectCacheDb } from '../../src/db/db';

function mkProj(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rf-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

// 被移动文件带一个内部相对导入，验证跨目录移动时自身也重锚定
const FOO = 'export function a() { return 1; }\n';

describe('renameFile - 干跑只算影响面', () => {
  it('不改任何文件，报出将被改写引用清单', async () => {
    const dir = mkProj({
      'src/foo.ts': FOO,
      'src/entry.ts': "import { a } from './foo';\nimport { x } from './foo';\nimport { y } from './other';\n",
      'src/util.ts': "const m = require('./foo');\n",
      'src/other.ts': 'export const y = 2;\n',
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'src/bar.ts', dry_run: true });
      expect(r.ok).toBe(true);
      expect(r.dryRun).toBe(true);
      expect(r.moved).toBe(false);
      expect(r.editCount).toBe(3); // entry 两处 + util require
      expect(r.references.map((x) => x.toSource)).toEqual(['./bar', './bar', './bar']);
      // 源与引用都未被改动
      expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(true);
      expect(existsSync(path.join(dir, 'src/bar.ts'))).toBe(false);
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './foo'");
      expect(readFileSync(path.join(dir, 'src/util.ts'), 'utf-8')).toContain("require('./foo')");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renameFile - 真实重命名', () => {
  it('批量改写引用 + 迁移文件 + 内部相对导入重锚定', async () => {
    const dir = mkProj({
      // foo 内部相对导入 ./helper → 移动前后都应指向 src/helper
      'src/foo.ts': "export { h } from './helper';\nexport function a() { return 1; }\n",
      'src/helper.ts': 'export const h = 1;\n',
      'src/entry.ts': "import { a } from './foo';\nimport { y } from './other';\n",
      'src/util.ts': "const m = require('./foo');\n",
      'lib/other.ts': "export const y = 2;\n" + "import { a } from '../src/foo';\n",
      'src/unrelated.ts': "import { z } from './helper';\n",
      'src/other.ts': 'export const y = 2;\n',
    });
    try {
      // 目录间移动：src/foo.ts → sub/bar.ts
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'sub/bar.ts' });
      expect(r.ok).toBe(true);
      expect(r.moved).toBe(true);
      expect(r.editCount).toBe(3); // entry + util + lib/other
      // 源消失，目标出现
      expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(false);
      expect(existsSync(path.join(dir, 'sub/bar.ts'))).toBe(true);
      // entry 已改
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from '../sub/bar'");
      // util 已改
      expect(readFileSync(path.join(dir, 'src/util.ts'), 'utf-8')).toContain("require('../sub/bar')");
      // lib/other 已改（lib/ 上到根再进 sub → ../sub/bar）
      expect(readFileSync(path.join(dir, 'lib/other.ts'), 'utf-8')).toContain("from '../sub/bar'");
      // 无关文件未动
      expect(readFileSync(path.join(dir, 'src/unrelated.ts'), 'utf-8')).toContain("from './helper'");
      // 被移动文件自身的内部导入已重锚定：从 sub/ 指向 ../src/helper
      expect(readFileSync(path.join(dir, 'sub/bar.ts'), 'utf-8')).toContain("from '../src/helper'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('扩展名引用照常替换且保留扩展名风格', async () => {
    const dir = mkProj({
      'src/foo.ts': FOO,
      'src/entry.ts': "import { a } from './foo.js';\n", // NodeNext：.js 引 .ts
      'src/other.ts': 'export const y = 2;\n',
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'src/bar.ts' });
      expect(r.editCount).toBe(1);
      expect(r.references[0].toSource).toBe('./bar.js');
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './bar.js'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('目录桶(index.ts)移动：引用改写 + 语义变化提醒', async () => {
    const dir = mkProj({
      'src/idx/index.ts': FOO,
      'src/entry.ts': "import { a } from './idx';\n", // 桶引用
      'src/other.ts': 'export const y = 2;\n',
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/idx/index.ts', to: 'src/idx/gate.ts' });
      expect(r.ok).toBe(true);
      expect(r.editCount).toBe(1);
      expect(r.references[0].toSource).toBe('./idx/gate'); // 不再指向桶
      expect(r.pending.some((p) => p.includes('目录桶'))).toBe(true);
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './idx/gate'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renameFile - 原子阻断', () => {
  it('目标已存在 → 阻断，无任何落盘', async () => {
    const dir = mkProj({
      'src/foo.ts': FOO,
      'src/bar.ts': 'export const z = 1;\n', // 目标占用
      'src/entry.ts': "import { a } from './foo';\n",
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'src/bar.ts' });
      expect(r.ok).toBe(false);
      expect(r.blocked).toBeDefined();
      expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(true);
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './foo'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('源缺失 → 阻断', async () => {
    const dir = mkProj({ 'src/entry.ts': "import { a } from './foo';\n" });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/missing.ts', to: 'src/gone.ts' });
      expect(r.ok).toBe(false);
      expect((r.blocked || []).join(' ')).toContain('源文件不存在');
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});