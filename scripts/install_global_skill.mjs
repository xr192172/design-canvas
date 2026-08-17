// install_global_skill.mjs — 把 live-doc-sentinel skill 安装到 TRAE 全局 skills 目录。
// 用法：node scripts/install_global_skill.mjs
// 源：docs/skills/live-doc-sentinel/SKILL.md（本仓库维护副本）
// 全局目录：~/.trae-cn/skills/<skill>/（跨项目对所有开发窗口生效）
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(__dirname, '..', 'docs', 'skills', 'live-doc-sentinel', 'SKILL.md');
const destDir = path.join(os.homedir(), '.trae-cn', 'skills', 'live-doc-sentinel');
const dest = path.join(destDir, 'SKILL.md');

if (!existsSync(src)) {
  console.error(`[install-global-skill] 找不到源文件: ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[install-global-skill] 已安装到全局: ${dest}`);
console.log('[install-global-skill] 重启/重载 TRAE 后，所有开发窗口都可加载 live-doc-sentinel');
