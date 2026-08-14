/**
 * Camera 对自身狗食（真实闭环）验证脚本
 *
 * 用 Design Covers 自己的工具套件观测 Design Covers 自身源码：
 *   1. 复制 design-canvas 的 src/ 到临时目录（不污染工作树）。
 *   2. 对临时副本全自动插桩（AST 源码级，instrument 注入 captureProbe）。
 *   3. 用 module.setChildLoader 加载「已插桩」的 storage.js，跑真实 saveDSL 链路。
 *   4. 探针在运行时捕获事件 → 落盘 events.jsonl。
 *   5. 用 camera_log / camera_judge 语义查询、判定这条真实链路的数据流。
 *   6. 输出报告，临时目录清理。
 *
 * 用法（项目根，先构建）：
 *   npx tsc
 *   node scripts/camera_self_dogfood.mjs [--enable-deep]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { instrumentProject } from '../dist/src/camera/instrument.js';
import { TSProbeCapture, setGlobalProbeSink, loadTSEvents } from '../dist/src/camera/probe.js';
import { queryCameraLog } from '../dist/src/camera/log_query.js';
import { normalizeEvents, judgeEvents } from '../dist/src/camera/judge_service.js';

// --enable-deep 开启 deep 级插桩（放大：捕获函数内部数据流动，事件量显著增加）
const enableDeep = process.argv.includes('--enable-deep');

const SRC = path.resolve('src');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-self-'));
const eventsFile = path.join(tmp, 'events.jsonl');

// ── 1) 复制 src/ 到临时副本 ──
const copyDir = path.join(tmp, 'proj');
fs.mkdirSync(copyDir, { recursive: true });
function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.design-canvas') continue;
    const sf = path.join(from, e.name);
    const df = path.join(to, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(df, { recursive: true });
      copyTree(sf, df);
    } else if (e.name.endsWith('.ts')) {
      fs.copyFileSync(sf, df);
    }
  }
}
copyTree(SRC, copyDir);
console.log(`=== 1) 已复制 src/ → ${copyDir}（临时副本，不污染工作树）===`);

// ── 2) 对自身副本全自动插桩 ──
// projectRoot=副本根（fileRel 干净）；probeImport 覆盖指向副本能解析的探针实现
// （先复制编译产物 probe.js 进副本根，插桩后的 import './_cam_probe.js' 可解析）
const probeJs = path.join(copyDir, '_cam_probe.js');
fs.copyFileSync(path.resolve('dist/src/camera/probe.js'), probeJs);
const results = await instrumentProject(copyDir, { projectRoot: copyDir, probeImport: './_cam_probe.js', enableDeep });
let total = 0;
const hit = results.filter((r) => r.sites.length > 0);
for (const r of hit) {
  const deep = r.sites.filter((s) => s.level === 'deep').length;
  total += r.sites.length;
  console.log(`· ${path.relative(copyDir, r.file)}  +${r.sites.length} 探针点${deep ? `（含 deep ×${deep}）` : ''}`);
}
console.log(`=== 2) 全自动插桩${enableDeep ? '（deep 放大）' : ''}：${hit.length}/${results.length} 文件命中，共 ${total} 探针点 ===`);
const storageHit = hit.find((r) => r.file.endsWith('storage.ts'));
if (!storageHit) {
  console.error('✗ 预期 storage.ts 被插桩，但未命中！');
  process.exit(1);
}
console.log(`   真实观测对象：storage.ts（saveDSL/saveLiveFeature 写盘链路）命中 ${storageHit.sites.length} 探针点`);
const sites = storageHit.sites.map((s) => s.kind);
console.log(`   探针种类：${[...new Set(sites)].join(', ')}`);

// ── 3)+4) 加载已插桩 storage.js，跑真实 saveDSL，采集事件 ──
const sink = new TSProbeCapture(eventsFile);
setGlobalProbeSink(sink);
const storageMod = await import(pathToFileURL(path.join(copyDir, 'storage.ts')).href);
const dsl = {
  feature: 'dogfood-self',
  version: 1,
  updated_at: new Date().toISOString(),
  nodes: [],
  edges: [],
};
// 真实写盘链路：saveDSL → saveLiveFeature
storageMod.saveDSL(dsl, 'mcp');
storageMod.saveLiveFeature(dsl);
setGlobalProbeSink(null);

const { events } = loadTSEvents(eventsFile);
console.log(`\n=== 3+4) 真实 saveDSL 链路运行，采集到 ${events.length} 条事件 ===`);
for (const ev of events) {
  console.log(`· ${ev.probe}  ${JSON.stringify(ev.fields)}`);
}

// ── 5) camera_log 语义：按文件过滤 + 判定 ──
console.log(`\n=== 5) camera_log：按文件过滤查询 storage.ts 链路 ===`);
const logR = queryCameraLog(eventsFile, { files: ['storage.ts'], all: true });
console.log(`   命中 ${logR.entries.length} 条（均来自 storage.ts）`);
for (const e of logR.entries) {
  console.log(`   ${e.result === 'deviation' ? '✗' : '✓'} [${e.result}] ${e.probe} rule=${e.rule}`);
}

console.log(`\n=== 6) camera_judge：对采集事件判定偏差 ===`);
const { events: norm, error } = normalizeEvents(events);
if (error) {
  console.error(`   ✗ 判定入参校验失败: ${error}`);
} else {
  const report = judgeEvents(norm);
  console.log(`   判定汇总：total=${report.total}  ok=${report.ok}  deviation=${report.deviation}`);
  for (const e of report.entries) {
    if (e.verdict.result === 'deviation') {
      console.log(`   ✗ rule=${e.verdict.rule} probe=${e.probe}  ${e.verdict.reason}`);
    }
  }
}

// ── 6) 清理临时副本 ──
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n=== 完成：临时副本已清理，工作树保持干净 ===`);