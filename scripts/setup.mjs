#!/usr/bin/env node
/**
 * design-canvas 一键就绪器（dc setup / dc doctor）——「拿到包 → 能对账」的环境闭环
 *
 * 定位：把已存在但彼此断开的环节合成一条命令。复用既有 CLI，不重造：
 *   - MCP 安装      → 复用 scripts/install_mcp.mjs（写 9 个 client 配置）
 *   - TS 静态插桩   → 复用 dist/src/camera/instrument_cli.js（幂等，--uninstrument 还原）
 *   - skill 安装    → 本脚本新增：把 .trae/skills/ 拷进目标 agent skills 目录
 *   - 事件目录规约   → 本脚本新增：确保 <target>/.design-canvas/camera + .agent/camera 存在
 *                   （这两处正是 chain_recon.discoverEventFiles 自动发现的两个事件源）
 *   - 跑一轮出事件  → 本脚本新增：带 CAMERA_EVENTS_FILE sink 跑用户给的命令，产出真事件
 *   - 体检报告      → 本脚本新增：doctor 逐项检测就绪度，给可执行提示，不静默
 *
 * 用法（design-canvas 根）：
 *   node scripts/setup.mjs <target>                # 全量就绪：依赖目标项目就绪（装 MCP+skill+目录）
 *   node scripts/setup.mjs <target> --instrument   # 同时静态插桩目标项目（可反复，幂等）
 *   node scripts/setup.mjs <target> --run "<cmd>"  # 插桩/就绪后跑一轮目标入口，产真事件
 *   node scripts/setup.mjs <target> --doctor       # 只读体检就绪度，不改任何东西
 *   node scripts/setup.mjs <target> --uninstrument # 还原目标项目静态插桩
 *   node scripts/setup.mjs --help
 *
 * 目标项目：
 *   要拿 design-canvas 对账的那个项目（其 .agent/camera / .design-canvas/camera 是事件源）。
 *   默认当前目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = path.join(ROOT, '.trae', 'skills');
const INSTALL_MCP = path.join(ROOT, 'scripts', 'install_mcp.mjs');
const INSTRUMENT_CLI = path.join(ROOT, 'dist', 'src', 'camera', 'instrument_cli.js');
const DEFAULT_AGENT_SKILLS = path.join(ROOT, '..', 'ai-config', 'skills'); // 本地 agent 的 skills 目录
const EVENT_DIRS_TPL = ['.design-canvas/camera', '.agent/camera'];

// ── 参数解析 ──
const args = process.argv.slice(2);
const parg = (name) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };
const flag = (name) => args.includes(name);

function usage() {
  console.log(`design-canvas 一键就绪器（dc setup / dc doctor）
用法:
  node scripts/setup.mjs <target> [选项]
  <target>   被观测项目目录（默认当前目录）

选项:
  --doctor         只读体检就绪度，不改任何文件
  --instrument     对目标项目静态插桩（幂等，可反复跑）
  --uninstrument   还原目标项目的静态插桩
  --run "<cmd>"    就绪后带事件 sink 跑一轮目标入口，产出真事件到约定目录
  --mcp <list>     写 MCP 配置的平台逗号列表（默认全部；--no-mcp 跳过）
  --no-mcp         不写 MCP 配置
  --skill <dir>    把本工具集的 skill 拷进指定 agent skills 目录（默认 ai-config/skills）
  --dry-run        只打印将做的事，不改动
  --help           显示本帮助
`);
}

// 目标项目 = 第一个非「选项值」的裸位置参数
const VALUE_OPTS = new Set(['--run', '--mcp', '--skill']);
let target = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_OPTS.has(a)) { i++; continue; } // 跳过取值，防止把命令值当成目标
  if (a.startsWith('--')) continue;
  if (!target) target = a;
}
const T = target ? path.resolve(target) : process.cwd();

const DOCTOR = flag('--doctor');
const INSTRUMENT = flag('--instrument');
const UNINSTRUMENT = flag('--uninstrument');
const RUN = parg('--run');
const NO_MCP = flag('--no-mcp') || DOCTOR;
const MCP_LIST = parg('--mcp');
const SKILL_DST = parg('--skill') ?? DEFAULT_AGENT_SKILLS;
const DRY = flag('--dry-run');

if (flag('--help')) { usage(); process.exit(0); }
if (!fs.existsSync(T) || !fs.statSync(T).isDirectory()) {
  console.error(`✗ 目标目录不存在或不是目录: ${T}`);
  process.exit(1);
}

// ── 工具方法 ──
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const no = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m•\x1b[0m ${s}`;

function runNode(script, argv, opts = {}) {
  if (DRY) { console.log(`[dry-run] node ${script} ${argv.join(' ')}`); return null; }
  return spawnSync(process.execPath, [script, ...argv], { cwd: ROOT, encoding: 'utf-8', env: { ...process.env, ...opts.env } });
}

// 目标项目事件文件（两个约定目录下 events*.jsonl）汇总
function findEventFiles() {
  const out = [];
  for (const rel of EVENT_DIRS_TPL) {
    const dir = path.join(T, ...rel.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith('events') && name.endsWith('.jsonl')) out.push(path.join(dir, name));
    }
  }
  return out.sort();
}
function countEvents() {
  let total = 0;
  for (const f of findEventFiles()) {
    total += (fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean)).length;
  }
  return total;
}

// ── doctor：只读体检 ──
function runDoctor() {
  console.log(`\ndc doctor · 目标 ${T}\n`);
  let pass = 0, fail = 0;

  // 1) 事件源
  const evFiles = findEventFiles();
  const evTotal = countEvents();
  if (evFiles.length === 0) {
    fail++;
    console.log(no(`事件源：无（<target>/.design-canvas/camera 与 .agent/camera 均无 events*.jsonl）`));
    console.log(dim(`   → chain_recon/trace-exec 面对本项目会一直 not_run。先跑：`));
    console.log(dim(`     node scripts/setup.mjs ${T} --instrument --run "<项目入口命令>"`));
  } else {
    pass++;
    console.log(ok(`事件源：${evFiles.length} 个文件 / ${evTotal} 条事件`));
    for (const f of evFiles) console.log(dim(`     ${path.relative(process.cwd(), f)}`));
  }

  // 2) MCP 配置（复用 install_mcp --check，只看不写）
  {
    const r = runNode(INSTALL_MCP, ['--check']);
    const cfg = (r?.stdout || '').match(/共 \d+ 个平台，(\d+) 个已配置/);
    if (cfg && Number(cfg[1]) > 0) { pass++; console.log(ok(`MCP 配置：${cfg[1]} 个 client 已配置`)); }
    else { fail++; console.log(warn(`MCP 配置：尚未写入任何 client 配置（需跑 dc setup 不带 --no-mcp）`)); }
  }

  // 3) skill 安装
  {
    const srcExist = fs.existsSync(path.join(SKILL_SRC, 'design-canvas-mind', 'SKILL.md'));
    const dstExist = fs.existsSync(path.join(SKILL_DST, 'design-canvas-mind', 'SKILL.md'));
    if (srcExist && dstExist) { pass++; console.log(ok(`skill：已安装到 ${SKILL_DST}`)); }
    else if (srcExist) { fail++; console.log(warn(`skill：项目内有 ${SKILL_SRC}，但未安装到目标 agent（${SKILL_DST}）`)); }
    else { fail++; console.log(no(`skill：项目缺少 ${path.join(SKILL_SRC, 'design-canvas-mind', 'SKILL.md')}`)); }
  }

  // 4) 插桩状态
  {
    const backup = path.join(T, '.design-canvas', 'camera-backup');
    if (fs.existsSync(backup)) { pass++; console.log(ok(`插桩：目标已插桩（备份在 .design-canvas/camera-backup）`)); }
    else { console.log(warn(`插桩：目标未见插桩备份（可 --instrument 加探针，或仅用运行态 sink 经 --run 产事件）`)); }
  }

  // 5) LLM 配置（分镜/语义命名依赖。缺时明示，不静默降级）
  {
    const hasLLM = process.env.DESIGN_CANVAS_LLM || process.env.LLM_API_KEY;
    if (hasLLM) { pass++; console.log(ok(`LLM/Router：已配置 (${hasLLM ? 'env 可见' : ''})`)); }
    else { console.log(warn(`LLM/Router：未检测到 env（DESIGN_CANVAS_LLM/LLM_API_KEY）。分镜/语义命名会停在「需配置 LLM」，这是诚实标注，不是缺失功能`)); }
  }

  console.log(`\n${fail === 0 ? '全部就绪' : `${fail} 项未就绪`}：${pass} 项通过 / ${fail} 项待办。`);
  return fail;
}

// ── 实际就绪（写动作）──
async function runSetup() {
  const actions = [];
  console.log(`\ndc setup · 目标 ${T}\n`);

  // 1) MCP 配置
  if (!NO_MCP) {
    const argv = MCP_LIST ? ['--target', MCP_LIST] : [];
    actions.push(`write MCP config (${MCP_LIST || 'all clients'})`);
    const r = runNode(INSTALL_MCP, argv);
    if (r && r.status !== 0) console.warn(`  ⚠ install_mcp 退出码 ${r.status}\n${r.stderr || ''}`);
    console.log(r?.stdout || '(dry-run)');
  } else if (DOCTOR) {
    actions.push('skip MCP (doctor)');
  }

  // 2) skill 安装（拷 .trae/skills/ → 目标 agent skills 目录）
  {
    const src = SKILL_SRC;
    const dst = path.join(SKILL_DST, 'design-canvas-mind');
    if (fs.existsSync(path.join(src, 'design-canvas-mind', 'SKILL.md'))) {
      actions.push(`copy skill → ${dst}`);
      if (!DRY) {
        fs.mkdirSync(dst, { recursive: true });
        fs.copyFileSync(path.join(src, 'design-canvas-mind', 'SKILL.md'), path.join(dst, 'SKILL.md'));
      }
      console.log(ok(`skill 安装 → ${dst}`));
    } else {
      console.log(warn(`未找到 skill 源 ${path.join(src, 'design-canvas-mind', 'SKILL.md')}`));
    }
  }

  // 3) 事件目录规约（chain_recon 自动发现的这两处）
  for (const rel of EVENT_DIRS_TPL) {
    const dir = path.join(T, ...rel.split('/'));
    if (fs.existsSync(dir)) continue;
    if (DRY) { console.log(`[dry-run] mkdir ${dir}`); continue; }
    fs.mkdirSync(dir, { recursive: true });
    console.log(dim(`事件目录 → ${path.relative(process.cwd(), dir)}`));
  }

  // 4) 静态插桩（幂等；目标为 TS 时）
  if (INSTRUMENT || UNINSTRUMENT) {
    const argv = UNINSTRUMENT ? [T, '--uninstrument'] : [T];
    const label = UNINSTRUMENT ? '还原插桩' : '静态插桩';
    actions.push(label);
    if (!DRY) {
      const r = spawnSync(process.execPath, [INSTRUMENT_CLI, ...argv], { cwd: ROOT, encoding: 'utf-8' });
      console.log((r.stdout || '') + (r.stderr || ''));
    }
  }

  // 5) 跑一轮出真事件（带 CAMERA_EVENTS_FILE sink）
  if (RUN) {
    const evDir = path.join(T, '.agent', 'camera');
    const evFile = path.join(evDir, `events-${Date.now().toString(36)}.jsonl`);
    actions.push(`run "${RUN}" with events sink → ${evFile}`);
    console.log(dim(`事件 sink → ${path.relative(process.cwd(), evFile)}`));
    if (DRY) { console.log(`[dry-run] ${RUN}`); }
    else {
      fs.mkdirSync(evDir, { recursive: true });
      const r = spawnSync(RUN, { shell: true, cwd: T, encoding: 'utf-8', env: { ...process.env, CAMERA_EVENTS_FILE: evFile } });
      console.log((r.stdout || '').slice(-2000));
      if (r.status !== 0 && r.status !== null) console.warn(`  ⚠ 命令退出码 ${r.status}${r.stderr ? '\n' + r.stderr : ''}`);
      const n = fs.existsSync(evFile) ? (fs.readFileSync(evFile, 'utf-8').trim().split('\n').filter(Boolean)).length : 0;
      console.log(n > 0 ? ok(`本轮产出 ${n} 条事件 → ${path.relative(process.cwd(), evFile)}`) : warn(`本轮 0 条事件——目标是否真正触发了探针路径？`));
    }
  }

  // 6) 收尾体检
  if (actions.length) console.log(dim(`\n执行动作：${actions.join(' | ')}`));
  console.log('');
}

const main = () => {
  if (DRY) console.log(dim('dry-run：只打印，不改写文件\n'));
  if (DOCTOR) { const f = runDoctor(); process.exitCode = f > 0 ? 1 : 0; return; }
  runSetup()
    .then(() => { const f = runDoctor(); process.exitCode = f > 0 ? 1 : 0; })
    .catch((e) => { console.error('dc setup:', (e instanceof Error ? e.message : String(e))); process.exitCode = 1; });
};
main();