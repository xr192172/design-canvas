/**
 * 积木盒动静对账回写（Phase 3R-C，go_logging 首例）
 *
 * 输入：golog-verify 驱动运行产出的 effect 事件 + 积木盒 contracts.json
 * 动作：
 *   ① 命中候选 origin: 'ast' → 'runtime'（write 精确匹配）
 *   ② contract.runtime 填观测字段（call_count/top_callers/last_seen）
 *   ③ manifest.effect_verification 证据档案（重抽保留字段）——
 *      含未观测候选的覆盖缺口分析（机器判不了的由人工标注：
 *      probe_gap=插桩器无此检测点 / not_triggered=观测窗口未覆盖 /
 *      static_only=包级字面量初始化运行时天然无写）
 */
import fs from 'node:fs';
import path from 'node:path';

const brickDir = 'D:/project_develop/design-canvas/.design-canvas/bricks/go_logging';
const eventsFile =
  'D:/project_develop/design-canvas/.design-canvas/tmp/golog-verify/.agent/camera/events-verify.jsonl';

// ── ① 读事件，按文件聚合 ──────────────────────────────
type EffectEvent = { probe: string; time: string; fields: { file: string; kind: string; target: string; op: string } };
const events: EffectEvent[] = [];
for (const line of fs.readFileSync(eventsFile, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const ev = JSON.parse(line);
    if (ev?.fields?.level === 'effect' && ev.fields.file && ev.fields.target) {
      events.push({ probe: ev.probe, time: ev.time, fields: ev.fields });
    }
  } catch {
    /* 坏行容忍 */
  }
}
console.log(`effect 事件 ${events.length} 条`);

const byFile = new Map<string, Map<string, { kind: string; target: string; op: string; count: number }>>();
const probesByFile = new Map<string, Map<string, number>>();
const lastSeenByFile = new Map<string, string>();
for (const ev of events) {
  const f = ev.fields.file;
  if (!byFile.has(f)) byFile.set(f, new Map());
  if (!probesByFile.has(f)) probesByFile.set(f, new Map());
  const key = `${ev.fields.kind}|${ev.fields.target}`;
  const t = byFile.get(f)!.get(key) ?? { kind: ev.fields.kind, target: ev.fields.target, op: ev.fields.op, count: 0 };
  t.count++;
  byFile.get(f)!.set(key, t);
  probesByFile.get(f)!.set(ev.probe, (probesByFile.get(f)!.get(ev.probe) ?? 0) + 1);
  const prev = lastSeenByFile.get(f) ?? '';
  if (ev.time > prev) lastSeenByFile.set(f, ev.time);
}

// ── ② 对账 contracts.json ─────────────────────────────
const contractsPath = path.join(brickDir, 'contracts.json');
const contracts = JSON.parse(fs.readFileSync(contractsPath, 'utf8'));

// 未观测候选的覆盖缺口（人工分析，机器无法自动区分）
const gapNotes: Record<string, string> = {
  'rotate.go|file:filepath.Join': 'not_triggered：100MB 轮转阈值未达（驱动写入量 << 阈值）',
  'rotate.go|file:r.basePath': 'probe_gap：effect 插桩器四类检测点（包级赋值/chan send/go/Listen·sql·Ticker）不含 os.Create 文件句柄 acquire——静态候选有、探针无检测点，工具改进项',
  'rotate.go|goroutine': 'not_triggered：go cleanupExpired 仅在 rotateLocked 内启动，轮转未发生',
  'router.go|routeTable': 'static_only：包级字面量初始化被静态扫描记 write 候选，运行时只读无写——静态候选模式的固有噪声',
};

const report: Array<{
  file: string;
  confirmed: string[];
  unobserved: Array<{ target: string; note: string }>;
}> = [];

for (const [rel, contract] of Object.entries<Record<string, any>>(contracts)) {
  const basename = rel.split('/').pop()!;
  const obs = byFile.get(basename) ?? byFile.get(rel);
  const fx = contract.effects;
  const confirmed: string[] = [];
  const unobserved: Array<{ target: string; note: string }> = [];

  if (obs && fx) {
    for (const { kind, target } of obs.values()) {
      if (kind === 'write') {
        const hit = fx.writes.find((w: any) => w.target === target && w.origin === 'ast');
        if (hit) {
          hit.origin = 'runtime';
          confirmed.push(target);
        }
      }
    }
  }
  if (fx) {
    for (const w of fx.writes) {
      if (w.origin === 'ast') {
        unobserved.push({ target: w.target, note: gapNotes[`${basename}|${w.target}`] ?? 'not_triggered：观测窗口未覆盖' });
      }
    }
    for (const h of fx.holds) {
      if (h.origin === 'ast') {
        unobserved.push({ target: h.target, note: gapNotes[`${basename}|${h.target}`] ?? 'not_triggered：观测窗口未覆盖' });
      }
    }
  }
  // runtime 观测字段（无论命中与否，有观测就记）
  const probes = probesByFile.get(basename) ?? probesByFile.get(rel);
  if (probes) {
    const total = [...probes.values()].reduce((a, b) => a + b, 0);
    const top = [...probes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p, n]) => `${p}×${n}`);
    contract.runtime = {
      call_count: total,
      top_callers: top,
      observed_targets: confirmed,
      last_seen: lastSeenByFile.get(basename) ?? lastSeenByFile.get(rel) ?? '',
    };
  }
  report.push({ file: basename, confirmed, unobserved });
}

fs.writeFileSync(contractsPath, JSON.stringify(contracts, null, 2), 'utf8');

// ── ③ manifest.effect_verification 证据档案 ───────────
const manifestPath = path.join(brickDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const confirmedTotal = report.reduce((a, r) => a + r.confirmed.length, 0);
const unobservedTotal = report.reduce((a, r) => a + r.unobserved.length, 0);

manifest.effect_verification = {
  verified_at: new Date().toISOString(),
  method: 'go-camera instrument --effects 插桩 + golog-verify 驱动（.design-canvas/tmp/golog-verify）',
  events: events.length,
  stats: { confirmed: confirmedTotal, unobserved: unobservedTotal },
  files: report,
  known_blind_spots: [
    'Go init() 先于 main 执行：logging.init 的 3 个 effect 探针点（AGENT_LOG_DEBUG/AGENT_SHELL_VERBOSE 初始写）在 sink 注册前运行，观测不到——驱动侧 sink 初始化时机固有限制',
    'probe_gap 类缺口（见 files[].unobserved[].note）：插桩器检测点覆盖 < 静态候选覆盖',
  ],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

console.log(`\n转正 ${confirmedTotal} / 未观测 ${unobservedTotal}：`);
for (const r of report) {
  console.log(`  ${r.file}: 转正[${r.confirmed.join(', ') || '-'}] 未观测[${r.unobserved.map((u) => u.target).join(', ') || '-'}]`);
  for (const u of r.unobserved) console.log(`    ↳ ${u.target}: ${u.note}`);
}
