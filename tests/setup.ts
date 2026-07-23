/**
 * Vitest 全局 setup：把 DSL 数据目录指向临时目录
 *
 * 背景：storage.ts / render_dsl.ts 的默认持久化路径基于 process.cwd()，
 * 测试里调用 saveDSL / renderDsl 会覆盖项目根目录的活态 design-canvas.json
 * （曾发生 design-canvas.json 被测试 feature "no_status" 覆盖的事故）。
 *
 * 这里通过 DESIGN_CANVAS_HOME 把数据主目录重定向到临时目录，
 * 生产行为不变（未设置 env 时仍用 process.cwd()）。
 *
 * 注意：pool 为 singleFork 串行，各测试文件共享同一进程；
 * afterAll 删除目录后，下个测试文件的 saveDSL 会重新 mkdir，无影响。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'design-canvas-test-'));
process.env.DESIGN_CANVAS_HOME = tmpHome;

afterAll(() => {
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // Windows 偶发文件占用导致清理失败，临时目录留给 OS 清理即可
  }
});
