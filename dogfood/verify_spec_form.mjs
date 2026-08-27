// 验证：生产 Node 环境下不同 specifier 形式加载含空格路径 ESM
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp prod '));
const file = path.join(dir, 'mod.mjs');
fs.writeFileSync(file, 'export const ok = true;\n');

async function tryImport(label, spec) {
  try {
    const m = await import(spec);
    console.log(`  ✓ ${label}: OK ok=${m.ok}`);
  } catch (e) {
    console.log(`  ✗ ${label}: ${String(e.message).slice(0, 100)}`);
  }
}

console.log('file:', file);
await tryImport('posix C:/', file.replace(/\\/g, '/'));
await tryImport('backslash', file);
await tryImport('slashC', '/' + file.replace(/\\/g, '/'));
await tryImport('urlEnc', pathToFileURL(file).href);

// 相对项目内文件（模拟 tests/fixtures/agent_demo.mjs）
const rel = path.resolve('tests/fixtures/agent_demo.mjs');
console.log('\nfixture:', rel);
await tryImport('fixture posix', rel.replace(/\\/g, '/'));
