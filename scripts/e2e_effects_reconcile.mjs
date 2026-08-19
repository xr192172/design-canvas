/**
 * e2e_effects_reconcile — Phase 2c 动静对账端到端验证脚本
 *
 * 链路：临时 Go 项目 → import_project → extract_contracts（静态候选）
 *   → instrument --effects（真插桩）→ go run（真实运行产事件）
 *   → reconcile_effects（动静对账）→ 校验 origin 升格
 *
 * 用法：node --no-warnings scripts/e2e_effects_reconcile.mjs
 * 前置：npm run build（dist 最新）+ go build -o build/instrument.exe ./cmd/instrument
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (p) => `file://${path.join(here, '..', 'dist', 'src', p).replace(/\\/g, '/')}`;

const { openDb } = await import(dist('db/db.js'));
const { importProject } = await import(dist('tools/import_project.js'));
const { extractContracts } = await import(dist('tools/extract_contracts.js'));
const { reconcileEffects } = await import(dist('tools/reconcile_effects.js'));
const { saveDSL, getDSL } = await import(dist('storage.js'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-fx-'));
console.log('项目:', root);

// 1. 临时 Go 项目（go.mod replace 指向 go-camera；main 初始化 sink）
const MAIN_GO = `package main

import (
	camprobe "go-camera/probe"
)

var (
	Count     int
	ErrClosed error
)

func work(done chan int) {
	Count = 1
	Count++
	ErrClosed = nil
	local := 3
	local++
	_ = local
	done <- 1
}

func main() {
	sink, err := camprobe.NewSink(".agent/camera/events.jsonl")
	if err != nil {
		panic(err)
	}
	camprobe.SetGlobalSink(sink)
	done := make(chan int, 1)
	work(done)
	<-done
	sink.Close()
}
`;
fs.writeFileSync(path.join(root, 'go.mod'), `module fxdemo\n\ngo 1.21\n\nrequire go-camera v0.0.0\n\nreplace go-camera => ${path.join(here, '..', 'go-camera').replace(/\\/g, '/')}\n`);
fs.writeFileSync(path.join(root, 'main.go'), MAIN_GO);

// 2. import_project + 契约 DSL
const db = openDb(path.join(root, '.design-canvas', 'cache.db'));
await importProject({ project_dir: root, cache_db: db });
db.close();

saveDSL({
  feature: 'f_e2e_fx',
  title: 'e2e effects',
  geometry: { nodes: [], edges: [] },
  semantic: { files: [{ id: 'm1', path: 'main.go', responsibility: '入口+工作' }] },
});
const ec = extractContracts({ project_dir: root, feature: 'f_e2e_fx' });
console.log('\n=== extract_contracts（静态候选）===');
console.log(ec.message);
const c0 = getDSL('f_e2e_fx').semantic.files[0].contract;
console.log('main.go 候选:', JSON.stringify({
  writes: c0.effects.writes,
  holds: c0.effects.holds,
  emits: c0.effects.emits,
}));

// 3. 真插桩（--effects 探索模式）
const instr = path.join(here, '..', 'go-camera', 'build', 'instrument.exe');
const rep = JSON.parse(execSync(`"${instr}" "${root}" --effects`, { encoding: 'utf-8' }));
const sites = rep.files.flatMap((f) => f.sites);
console.log(`\n=== instrument --effects：${sites.filter((s) => s.level === 'effect').length} 个 effect 探针 / 共 ${sites.length} 个 ===`);
console.log(sites.filter((s) => s.level === 'effect').map((s) => `${s.probe} @L${s.line}`).join('\n'));

// 4. 运行
console.log('\n=== go run（真实运行）===');
execSync('go mod tidy', { cwd: root, stdio: 'pipe' });
execSync('go run .', { cwd: root, stdio: 'pipe' });
const evLines = fs.readFileSync(path.join(root, '.agent', 'camera', 'events.jsonl'), 'utf-8').trim().split('\n');
const fxEvents = evLines.map((l) => JSON.parse(l)).filter((e) => e.fields?.level === 'effect');
console.log(`events.jsonl ${evLines.length} 行，其中 effect ${fxEvents.length} 条:`);
for (const e of fxEvents) console.log(`  ${e.probe} → ${e.fields.kind} ${e.fields.target}`);

// 5. 对账
const r = await reconcileEffects({ project_dir: root, feature: 'f_e2e_fx' });
console.log('\n=== reconcile_effects（动静对账）===');
console.log(r.message);
console.log('incomplete:', JSON.stringify(r.incomplete));
const c1 = getDSL('f_e2e_fx').semantic.files[0].contract;
console.log('对账后契约:', JSON.stringify({
  writes: c1.effects.writes,
  holds: c1.effects.holds,
  emits: c1.effects.emits,
  runtime: c1.runtime,
}));

// 6. 机械校验
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else { console.log('PASS:', msg); } };
assert(c1.effects.writes.find((w) => w.target === 'Count')?.origin === 'runtime', 'Count 候选 → runtime（转正）');
assert(c1.effects.writes.find((w) => w.target === 'ErrClosed')?.origin === 'runtime', 'ErrClosed 候选 → runtime（转正）');
assert(c1.effects.emits.includes('chan:done'), 'emits 含 chan:done（静态 chan send 候选）');
assert((c1.runtime?.call_count ?? 0) >= 3, `runtime.call_count ≥ 3（实际 ${c1.runtime?.call_count}）`);
assert(!c1.effects.writes.some((w) => w.target === 'local'), '局部变量 local 不进契约');

try {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  console.log('\n清理完成');
} catch {
  // Windows 下 SQLite 句柄释放有延迟，清理失败不影响验证结论
  console.log(`\n清理跳过（句柄占用，临时目录稍后可手动删）: ${root}`);
}
