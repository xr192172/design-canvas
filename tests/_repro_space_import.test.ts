// 最小复现：vitest 下不同 specifier 形式加载含空格路径模块
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

async function tryImport(label: string, spec: string) {
  try {
    const m = (await import(spec)) as { ok?: boolean };
    console.log(`  ✓ ${label}: OK ok=${m.ok}`);
    return true;
  } catch (e) {
    console.log(`  ✗ ${label}: ${String((e as Error).message).slice(0, 90)}`);
    return false;
  }
}

describe('space path specifier forms', () => {
  it('对比多种 specifier 形式', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp import '));
    const file = path.join(dir, 'mod.mjs');
    fs.writeFileSync(file, 'export const ok = true;\n');
    const urlEnc = pathToFileURL(file).href; // file:///C:/...%20...
    const posix = file.replace(/\\/g, '/'); // C:/.../sp import .../mod.mjs
    const slashC = '/' + posix; // /C:/.../sp import .../mod.mjs
    const back = file; // C:\...\sp import ...\mod.mjs
    console.log('dir:', dir);
    console.log('file:', file);
    console.log('urlEnc:', urlEnc);
    console.log('posix:', posix);
    console.log('slashC:', slashC);

    await tryImport('urlEnc(file:///%20)', urlEnc);
    await tryImport('posix C:/', posix);
    await tryImport('slashC /C:/', slashC);
    await tryImport('backslash', back);
  });
});
