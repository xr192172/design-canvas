/**
 * go_instrument 测试：Go 工程识别 + 报告统计（不依赖外部 Go 工程/不走 go 命令）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isGoProject, goReportSummary, goObserveDir, checkGoObserveDeps, ensureGoObserveIntegration, type GoInstrumentOut } from '../../src/observe/go_instrument';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goinstr_')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const mk = (rel: string, content = '') => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, 'utf-8'); return p; };

describe('go_instrument - Go 工程识别', () => {
  it('含 go.mod + .go 文件 → 是 Go 工程', () => {
    mk('go.mod', 'module m\n');
    mk('main.go', 'package main\nfunc main() {}\n');
    expect(isGoProject(tmp)).toBe(true);
  });

  it('只有 go.mod 无 .go → false', () => {
    mk('go.mod', 'module m\n');
    expect(isGoProject(tmp)).toBe(false);
  });

  it('ts 工程（无 go.mod）→ false', () => {
    mk('a.ts', 'export const x = 1;\n');
    expect(isGoProject(tmp)).toBe(false);
  });

  it('排除 .design-canvas/.git/node_modules 下的 .go', () => {
    mk('go.mod', 'module m\n');
    mk('.git/objects/x.go', 'package x\n');
    mk('node_modules/pkg.go', 'package p\n');
    mk('.design-canvas/cache/go.go', 'package c\n');
    expect(isGoProject(tmp)).toBe(false);
  });

  it('goReportSummary 统计：探针文件 / 跳过 / 失败 / 总点数', () => {
    const rep: GoInstrumentOut = {
      restored: 0,
      files: [
        { file: 'a.go', sites: [{ line: 1, kind: 'enter', level: 'core', probe: 'a.f.enter' }, { line: 2, kind: 'exit', level: 'core', probe: 'a.f.exit' }] },
        { file: 'b.go', sites: [] },
        { file: 'c.go', sites: [], error: 'parse failed' },
      ],
    };
    const s = goReportSummary(rep);
    expect(s.instrumented).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.errors).toBe(1);
    expect(s.totalSites).toBe(2);
  });

  it('goObserveDir：向上定位到含 go.mod 的 go-observe 目录', () => {
    const dir = goObserveDir();
    expect(path.basename(dir)).toBe('go-observe');
    expect(fs.existsSync(path.join(dir, 'go.mod'))).toBe(true);
  });
});

describe('go_instrument - 被测工程接 go-observe', () => {
  it('go.mod 无 go-observe → 需补 require+replace，dry-run 给出建议行', () => {
    mk('go.mod', 'module m\n\ngo 1.26\n');
    const check = checkGoObserveDeps(tmp);
    expect(check.needs_require).toBe(true);
    expect(check.needs_replace).toBe(true);
    expect(check.require_line).toContain('require go-observe');
    expect(check.replace_line).toContain('replace go-observe =>');
    // dry-run：不写盘
    const dry = ensureGoObserveIntegration(tmp, undefined, false);
    expect(dry.changed).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'go.mod'), 'utf-8')).not.toContain('go-observe =>');
  });

  it('已有 require+replace（endure 写盘）→ 无需补', () => {
    mk('go.mod', 'module m\n\nrequire go-observe v0.0.0\n\nreplace go-observe => C:/go-observe\n');
    const check = checkGoObserveDeps(tmp);
    expect(check.needs_require).toBe(false);
    expect(check.needs_replace).toBe(false);
  });

  it('ensure 实际写盘 → 追加 require/replace 到 go.mod', () => {
    mk('go.mod', 'module m\n');
    const r = ensureGoObserveIntegration(tmp, 'C:/go-observe', true);
    expect(r.changed).toBe(true);
    const src = fs.readFileSync(path.join(tmp, 'go.mod'), 'utf-8');
    expect(src).toContain('require go-observe v0.0.0');
    expect(src).toContain('replace go-observe => "C:/go-observe"');
  });
});