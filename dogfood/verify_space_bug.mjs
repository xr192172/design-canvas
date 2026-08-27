// 验证：file:// URL 含空格时 git clone 是否失败（harvest_from_url 的潜在 bug）
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'space-test ')); // 含空格目录
const repo = path.join(base, 'repo');
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
execSync('git init', { cwd: repo, stdio: 'pipe' });
execSync('git add -A', { cwd: repo, stdio: 'pipe' });
execSync('git -c user.name=t -c user.email=t@t commit -m init', { cwd: repo, stdio: 'pipe' });

// 方式 1：当前实现的 file:// 手动拼接（不编码空格）
const urlRaw = 'file:///' + repo.replace(/\\/g, '/');
console.log('URL(不编码):', urlRaw);
const box1 = path.join(base, 'clone1');
try {
  execSync(`git clone --depth 1 --quiet ${JSON.stringify(urlRaw)} ${JSON.stringify(box1)}`, { stdio: 'pipe' });
  console.log('方式1(裸空格 URL): 克隆成功');
} catch (e) {
  console.log('方式1(裸空格 URL): 克隆失败 ->', String(e.stderr || e.message).trim().slice(0, 200));
}

// 方式 2：正确做法 pathToFileURL 编码空格
const urlEnc = 'file:///' + repo.replace(/\\/g, '/').replace(/ /g, '%20');
console.log('URL(编码):', urlEnc);
const box2 = path.join(base, 'clone2');
try {
  execSync(`git clone --depth 1 --quiet ${JSON.stringify(urlEnc)} ${JSON.stringify(box2)}`, { stdio: 'pipe' });
  console.log('方式2(%20编码): 克隆成功');
} catch (e) {
  console.log('方式2(%20编码): 克隆失败 ->', String(e.stderr || e.message).trim().slice(0, 200));
}

fs.rmSync(base, { recursive: true, force: true });
