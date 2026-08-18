#!/usr/bin/env node
/**
 * verify.mjs — camera 插桩器一致性验收 runner（SPEC §4）。
 *
 * 用法：
 *   node camera-conformance/verify.mjs [--lang ts|go] [--regen]
 *
 * 三步断言（全绿 = 接入成功）：
 *   1. 静态：dry-run 探针清单（probe/kind/level 三元组集合）与 expected-probes.<lang>.json 精确一致
 *   2. 幂等：同一文件写盘插桩两次，第二次 sites 为空
 *   3. 还原：--restore 后文件与原件逐字节一致
 *
 * expected-probes.<lang>.json 首次由参考实现真实输出固化（--regen 强制重生成）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..'); // design-canvas
const argv = process.argv.slice(2);
const langOnly = argv.includes('--lang') ? argv[argv.indexOf('--lang') + 1] : null;
const regen = argv.includes('--regen');

const LANGS = {
  ts: {
    sample: 'sample.ts',
    expected: 'expected-probes.ts.json',
    run: (file, args) =>
      execFileSync('node', [path.join(here, 'ts-instrument.mjs'), file, ...args], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }),
  },
  go: {
    sample: 'sample.go',
    expected: 'expected-probes.go.json',
    run: (file, args) =>
      execFileSync('go', ['run', './cmd/instrument', file, ...args], {
        cwd: path.join(root, 'go-camera'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      }),
  },
};

const key = (s) => `${s.probe}|${s.kind}|${s.level}`;
const norm = (report) => {
  const set = new Set();
  for (const f of report.files ?? []) for (const s of f.sites ?? []) set.add(key(s));
  return [...set].sort();
};

let failed = 0;
for (const [lang, cfg] of Object.entries(LANGS)) {
  if (langOnly && lang !== langOnly) continue;
  console.log(`\n=== [${lang}] ===`);
  const sampleSrc = fs.readFileSync(path.join(here, 'samples', cfg.sample));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `camera-conf-${lang}-`));
  const tmpSample = path.join(tmp, cfg.sample);
  fs.copyFileSync(path.join(here, 'samples', cfg.sample), tmpSample);
  const expPath = path.join(here, 'samples', cfg.expected);

  const check = (name, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `：${detail}`}`);
    if (!ok) failed++;
  };

  // ── 1. 静态断言：dry-run 清单 vs expected ──
  const dry = JSON.parse(cfg.run(tmpSample, ['--dry-run']));
  const got = norm(dry);
  if (!fs.existsSync(expPath) || regen) {
    fs.writeFileSync(expPath, JSON.stringify(got, null, 2) + '\n');
    console.log(`  GENERATED  ${cfg.expected}（${got.length} 探针点，首次固化）`);
  } else {
    const want = JSON.parse(fs.readFileSync(expPath, 'utf8'));
    const missing = want.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !want.includes(k));
    check('静态清单一致', missing.length === 0 && extra.length === 0,
      `缺失[${missing.join(', ')}] 多出[${extra.join(', ')}]`);
  }

  // ── 2. 幂等断言：写盘两次，第二次 sites 为空 ──
  try {
    JSON.parse(cfg.run(tmpSample, []));
    const second = JSON.parse(cfg.run(tmpSample, []));
    const sites = (second.files ?? []).reduce((n, f) => n + (f.sites?.length ?? 0), 0);
    check('幂等（二次插桩零新增）', sites === 0, `第二次新增 ${sites} 个探针点`);
  } catch (e) {
    check('幂等（二次插桩零新增）', false, e.message);
  }

  // ── 3. 还原断言：restore 后逐字节一致 ──
  try {
    const res = JSON.parse(cfg.run(tmpSample, ['--restore']));
    const same = fs.readFileSync(tmpSample).equals(sampleSrc);
    check('还原逐字节一致', res.restored >= 1 && same,
      `restored=${res.restored} 内容一致=${same}`);
  } catch (e) {
    check('还原逐字节一致', false, e.message);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nALL GREEN' : `\n${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
