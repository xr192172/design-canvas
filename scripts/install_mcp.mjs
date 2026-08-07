#!/usr/bin/env node
/**
 * design-canvas MCP 分发安装器（路线图序号 12：多平台插件分发）
 *
 * 自动为各主流 MCP client 写入 design-canvas 的 MCP server 配置，
 * 免去手工编辑 JSON/TOML 的繁琐与格式错误。
 *
 * 用法（在 design-canvas 根目录）：
 *   node scripts/install_mcp.mjs                 # 写入全部已安装 client 的配置
 *   node scripts/install_mcp.mjs --list          # 列出各平台配置路径与写入状态（不写）
 *   node scripts/install_mcp.mjs --dry-run       # 打印将写入的内容（不写）
 *   node scripts/install_mcp.mjs --check         # 只检查各平台是否存在/已配置（不写）
 *   node scripts/install_mcp.mjs --target claude # 只写入指定平台
 *   node scripts/install_mcp.mjs --server <path> # 覆盖 server 入口（默认 <root>/dist/src/server.js）
 *
 * 平台支持：
 *   claude   ~/.claude.json                     (Claude Code / Claude Desktop 共用 user 级)
 *   cursor   ~/.cursor/mcp.json                 (Cursor 用户级)
 *   vscode   .vscode/mcp.json                   (VS Code workspace 级，相对项目根)
 *   codex    ~/.codex/config.toml               (Codex CLI，TOML 格式)
 *   copilot  ~/.github/copilot-mcp.json         (GitHub Copilot 用户级)
 *   gemini   ~/.gemini/settings.json            (Gemini CLI)
 *   windsurf ~/.codeium/windsurf/mcp_config.json(Windsurf 用户级)
 *   cline    ~/.cline/mcp_settings.json         (Cline 扩展)
 *
 * 安全：所有写入前备份原文件为 <file>.design-canvas.bak；合并时保留已有其他 server。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 定位项目根（脚本在 <root>/scripts/ 下） ──
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SERVER = path.join(ROOT, 'dist', 'src', 'server.js');

// ── 命令行参数 ──
const args = process.argv.slice(2);
const parg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const LIST = args.includes('--list');
const DRY = args.includes('--dry-run');
const CHECK = args.includes('--check');
const TARGET = parg('--target');
const SERVER = parg('--server') ?? DEFAULT_SERVER;

// ── 平台定义 ──
// 每个平台：name=显示名, configPath=配置文件绝对路径, kind=json|toml,
//           keyPath=server 列表所在的对象路径（点分），serverKey=server 名
const HOME = os.homedir();

/** 生成 JSON 型配置的写入块（保持已有 server） */
function jsonPatch(existing, keyPath, serverKey, serverValue) {
  const root = existing && typeof existing === 'object' ? existing : {};
  const segs = (keyPath || '').split('.').filter(Boolean);
  let cur = root;
  for (const s of segs) {
    if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {};
    cur = cur[s];
  }
  if (typeof cur[serverKey] !== 'object' || cur[serverKey] === null) cur[serverKey] = {};
  cur[serverKey] = { ...cur[serverKey], ...serverValue };
  return root;
}

/** 生成 TOML 型配置片段（Codex：[[mcp_servers]] 数组风格） */
function tomlBlock(serverKey, serverValue) {
  const esc = (s) => JSON.stringify(String(s));
  return (
    `[[mcp_servers]]\n` +
    `name = ${esc(serverKey)}\n` +
    `command = ${esc(serverValue.command)}\n` +
    `args = ${JSON.stringify(serverValue.args)}`
  );
}

/** TOML 已有 [[mcp_servers]] 块时，剔除同名 server 再加新块 */
function patchToml(content, serverKey, serverValue) {
  const block = tomlBlock(serverKey, serverValue);
  const re = /\[\[mcp_servers\]\][\s\S]*?(?=\[\[mcp_servers\]\]|$)/g;
  const kept = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!m[0].includes(`name = ${JSON.stringify(serverKey)}`)) kept.push(m[0]);
  }
  const head = content.replace(re, '').replace(/\s+$/, '\n');
  return `${head}\n${kept.join('\n')}\n${block}\n`;
}

const PLATFORMS = [
  {
    name: 'claude',
    label: 'Claude Code / Desktop',
    configPath: path.join(HOME, '.claude.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
  {
    name: 'cursor',
    label: 'Cursor',
    configPath: path.join(HOME, '.cursor', 'mcp.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
  {
    name: 'vscode',
    label: 'VS Code',
    configPath: path.join(ROOT, '.vscode', 'mcp.json'),
    kind: 'json',
    keyPath: 'servers',
    serverKey: 'design-canvas',
  },
  {
    name: 'codex',
    label: 'Codex CLI',
    configPath: path.join(HOME, '.codex', 'config.toml'),
    kind: 'toml',
    keyPath: '',
    serverKey: 'design-canvas',
  },
  {
    name: 'copilot',
    label: 'GitHub Copilot',
    configPath: path.join(HOME, '.github', 'copilot-mcp.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
  {
    name: 'gemini',
    label: 'Gemini CLI',
    configPath: path.join(HOME, '.gemini', 'settings.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
  {
    name: 'windsurf',
    label: 'Windsurf',
    configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
  {
    name: 'cline',
    label: 'Cline',
    configPath: path.join(HOME, '.cline', 'mcp_settings.json'),
    kind: 'json',
    keyPath: 'mcpServers',
    serverKey: 'design-canvas',
  },
];

const serverValue = {
  command: process.execPath || 'node',
  args: [SERVER],
};

// ── 通用写入 ──
function writeConfig(p, outText) {
  const dir = path.dirname(p.configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(p.configPath)) {
    fs.copyFileSync(p.configPath, `${p.configPath}.design-canvas.bak`);
  }
  fs.writeFileSync(p.configPath, outText, 'utf-8');
}

function present(v) {
  const s = v;
  if (typeof s === 'string') return s.length > 0;
  return s != null;
}

function buildOutput(p, existingText) {
  if (p.kind === 'toml') {
    return patchToml(existingText ?? '', p.serverKey, serverValue);
  }
  let parsed = null;
  const raw = (existingText ?? '').replace(/^\uFEFF/, ''); // 容忍 UTF-8 BOM（Windows 常见）
  if (present(raw)) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null; // 损坏的 JSON 按空重建（原文件已备份）
    }
  }
  const patched = jsonPatch(parsed, p.keyPath, p.serverKey, serverValue);
  return JSON.stringify(patched, null, 2) + '\n';
}

function statusOf(p) {
  const exists = fs.existsSync(p.configPath);
  if (!exists) return { state: 'missing', text: '' };
  try {
    const textRaw = fs.readFileSync(p.configPath, 'utf-8');
    const text = textRaw.replace(/^\uFEFF/, ''); // 容忍 UTF-8 BOM
    if (p.kind === 'toml') {
      return { state: text.includes(`name = ${JSON.stringify(p.serverKey)}`) ? 'configured' : 'present', text };
    }
    const parsed = JSON.parse(text);
    const segs = (p.keyPath || '').split('.').filter(Boolean);
    let cur = parsed;
    for (const s of segs) cur = cur?.[s];
    return { state: cur?.[p.serverKey] ? 'configured' : 'present', text };
  } catch {
    return { state: 'corrupt', text: '' };
  }
}

// ── 主流程 ──
const targets = TARGET
  ? PLATFORMS.filter((p) => p.name === TARGET)
  : PLATFORMS;
if (TARGET && targets.length === 0) {
  console.error(`未知平台 "${TARGET}"。可用：${PLATFORMS.map((p) => p.name).join(', ')}`);
  process.exit(1);
}

console.log(`design-canvas MCP 分发（server: ${SERVER}）\n`);

let written = 0;
let configured = 0;
for (const p of targets) {
  const st = statusOf(p);
  const already = st.state === 'configured';
  if (already) configured++;

  if (LIST || CHECK) {
    const mark = already ? '✓' : st.state === 'present' ? '•' : st.state === 'corrupt' ? '⚠' : '·';
    console.log(`  ${mark} ${p.label.padEnd(22)} ${p.configPath}`);
    continue;
  }

  if (already) {
    console.log(`  · ${p.label.padEnd(22)} 已配置，跳过`);
    continue;
  }

  const out = buildOutput(p, st.text);
  if (DRY) {
    console.log(`  · ${p.label.padEnd(22)} [dry-run] 将写入 ${p.configPath}`);
    continue;
  }

  writeConfig(p, out);
  written++;
  console.log(`  ✓ ${p.label.padEnd(22)} 已写入 ${p.configPath}`);
}

console.log('');
if (LIST || CHECK) {
  console.log(`共 ${targets.length} 个平台，${configured} 个已配置${CHECK ? '（未写任何文件）' : ''}`);
} else if (DRY) {
  console.log(`dry-run 完成：将写入 ${written} 个平台（未改动任何文件）`);
} else {
  console.log(`完成：写入 ${written} 个，跳过 ${configured} 个已配置`);
  if (written > 0) {
    console.log('提示：原配置文件已备份为 <file>.design-canvas.bak；重启对应 client 生效。');
  }
}