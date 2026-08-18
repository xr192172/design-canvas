#!/usr/bin/env node
/**
 * ts-instrument — TS 插桩器统一 CLI（camera-conformance 契约入口）。
 *
 * 契约见 camera-conformance/SPEC.md §2：
 *   node ts-instrument.mjs <file|dir> [--probes '<json>'] [--deep] [--dry-run] [--restore]
 * stdout 统一 JSON 报告，exit 0 成功 / 1 失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.resolve(here, '../dist/src/camera/instrument.js')).href);
const { instrumentFile, instrumentProject, restoreInstrumented } = mod;

// ── 参数解析 ──────────────────────────────────────
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--'));
const dryRun = argv.includes('--dry-run');
const restore = argv.includes('--restore');
const enableDeep = argv.includes('--deep');
const probesIdx = argv.indexOf('--probes');
const contractProbes = probesIdx >= 0 ? JSON.parse(argv[probesIdx + 1]) : undefined;

// ── 从注入源码提取探针名：captureProbe('<name>',...) → <name> ──
function probeFromCode(code) {
  const m = /captureProbe\(\s*(['"])([^'"]+)\1/.exec(code ?? '');
  return m ? m[2] : '';
}

function fail(err) {
  console.error(`ts-instrument: ${err.message ?? err}`);
  process.exit(1);
}

try {
  if (!target) fail('用法: ts-instrument.mjs <file|dir> [--probes ...] [--deep] [--dry-run] [--restore]');
  const abs = path.resolve(target);

  // --restore：从 <dir>/.design-canvas/camera-backup 恢复。
  if (restore) {
    const root = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    const restored = restoreInstrumented(root);
    process.stdout.write(JSON.stringify({ files: [], restored: restored.length }) + '\n');
    process.exit(0);
  }

  const opts = {
    write: !dryRun,
    enableDeep,
    contractProbes,
    projectRoot: path.dirname(abs),
    backupRoot: path.dirname(abs),
  };

  const results = fs.statSync(abs).isDirectory()
    ? await instrumentProject(abs, opts)
    : [await instrumentFile(abs, opts)];

  const report = {
    files: results.map((r) => ({
      file: r.file,
      sites: (r.sites ?? []).map((s) => ({
        line: s.line,
        kind: s.kind,
        level: s.level,
        probe: probeFromCode(s.injected),
      })),
      error: r.error ?? null,
    })),
    restored: 0,
  };
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exit(0);
} catch (err) {
  fail(err);
}
