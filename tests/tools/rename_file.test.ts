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

describe('renameFile - Python 相对导入（同构复用，不做语言专属轮子）', () => {
  it('跨目录移动 .py：改写 from .x 引用 + 自身相对导入重锚定', async () => {
    const dir = mkProj({
      'src/foo.py': 'from .helper import h\ndef a():\n    return 1\n',
      'src/helper.py': 'h = 1\n',
      'src/entry.py': 'from .foo import a\n',
      'src/other.py': 'x = 2\n',
      'lib/consumer.py': 'from ..src.foo import a\n',
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.py', to: 'sub/bar.py' });
      expect(r.ok).toBe(true);
      expect(r.moved).toBe(true);
      expect(existsSync(path.join(dir, 'src/foo.py'))).toBe(false);
      expect(existsSync(path.join(dir, 'sub/bar.py'))).toBe(true);
      // entry 同目录 src/ → 上到根再进 sub → ..sub.bar
      expect(readFileSync(path.join(dir, 'src/entry.py'), 'utf-8')).toContain('from ..sub.bar import a');
      // lib/consumer 从 lib 上到根再进 sub → ..sub.bar
      expect(readFileSync(path.join(dir, 'lib/consumer.py'), 'utf-8')).toContain('from ..sub.bar import a');
      // 被移动文件自身 from .helper → 从 sub 上到根再进 src → ..src.helper
      expect(readFileSync(path.join(dir, 'sub/bar.py'), 'utf-8')).toContain('from ..src.helper import h');
      // 无关文件未动
      expect(readFileSync(path.join(dir, 'src/other.py'), 'utf-8')).toBe('x = 2\n');
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同目录改名：from .foo → from .bar', async () => {
    const dir = mkProj({
      'src/foo.py': 'def a():\n    return 1\n',
      'src/entry.py': 'from .foo import a\n',
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.py', to: 'src/bar.py' });
      expect(r.ok).toBe(true);
      expect(r.moved).toBe(true);
      expect(r.references[0].toSource).toBe('.bar');
      expect(readFileSync(path.join(dir, 'src/entry.py'), 'utf-8')).toContain('from .bar import a');
      expect(existsSync(path.join(dir, 'src/bar.py'))).toBe(true);
      expect(existsSync(path.join(dir, 'src/foo.py'))).toBe(false);
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renameFile - 原子化执行修复（回归保障）', () => {
  // 修复说明：原实现第 3 步先 fs.renameSync(from→to)，再遍历改写引用、重索引。
  // 任何中途异常（磁盘满/权限/IO/索引写失败）都会导致「源文件已走、引用仍指向旧路径、
  // 索引悬空」——用户无从回退。修复后顺序：copy → 改写引用 → 删源 + 重索引，
  // 失败时拷贝被 catch 分支清理，源文件仍在原位置，调用方看到 ok=false。
  //
  // 关键断言：验证成功路径的最终状态正确，并补充一个"前置文件不存在"的回归用例。

  it('成功路径：源文件已删除、目标已创建且内容正确、importer 引用已改写', async () => {
    const dir = mkProj({
      'src/foo.ts': FOO,
      'src/entry.ts': "import { a } from './foo';\n",
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'src/bar.ts' });
      expect(r.ok).toBe(true);
      expect(r.moved).toBe(true);
      expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(false);
      expect(existsSync(path.join(dir, 'src/bar.ts'))).toBe(true);
      expect(readFileSync(path.join(dir, 'src/bar.ts'), 'utf-8')).toBe(FOO);
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from './bar'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('前置检查：源文件不存在时提前阻断，不走 copy/unlink 路径（回归原子保护）', async () => {
    const dir = mkProj({
      'src/entry.ts': "import { a } from './foo';\n",
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/missing.ts', to: 'src/gone.ts' });
      expect(r.ok).toBe(false);
      expect(r.moved).toBe(false);
      // 关键：目标路径不应存在（修复前若已走到 copy 路径，可能留下残留拷贝）
      expect(existsSync(path.join(dir, 'src/gone.ts'))).toBe(false);
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('跨目录移动：源文件已被正确清理，目标位于新目录，importer 与自引用均正确', async () => {
    const dir = mkProj({
      'src/foo.ts': "export { h } from './helper';\nexport function a() { return 1; }\n",
      'src/helper.ts': 'export const h = 1;\n',
      'src/entry.ts': "import { a } from './foo';\n",
    });
    try {
      const r = await renameFile({ project_dir: dir, from: 'src/foo.ts', to: 'sub/bar.ts' });
      expect(r.ok).toBe(true);
      expect(r.moved).toBe(true);
      // 源文件必须已删除（修复后此断言由 unlinkSync 在全成功后执行保障）
      expect(existsSync(path.join(dir, 'src/foo.ts'))).toBe(false);
      // 目标已创建
      expect(existsSync(path.join(dir, 'sub/bar.ts'))).toBe(true);
      // importer 改写为新路径
      expect(readFileSync(path.join(dir, 'src/entry.ts'), 'utf-8')).toContain("from '../sub/bar'");
      // 被移动文件自身的相对导入按新位置重锚定：从 sub/ 指向 ../src/helper
      expect(readFileSync(path.join(dir, 'sub/bar.ts'), 'utf-8')).toContain("from '../src/helper'");
    } finally {
      closeProjectCacheDb(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renameFile - 原子阻断（前置检查仍保持）', () => {
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