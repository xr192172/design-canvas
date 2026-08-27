/**
 * capability_matrix —— 「功能×语言×支持度」能力矩阵测试
 *
 * 覆盖：
 *   - 语言名单复用 LANGUAGES（不重复登记）
 *   - declareCapability / levelFor：overrides 优先于 default
 *   - audit 缺口：regex_fallback / unimplemented 计 needWork；full_ast 不算
 *   - 登记点名未知语言 → unknownLangs 标记笔误
 *   - aggregateGaps 仅收 needWork 语言
 *   - 默认登记 register_capabilities 后，关键功能契约存在且支持度正确
 */
import { describe, it, expect } from 'vitest';
import {
  declareCapability,
  getCapability,
  allCapabilities,
  levelFor,
  diagnoseCapabilities,
  aggregateGaps,
  _resetRegistry,
} from '../../src/tools/capability_matrix';
import { LANGUAGES } from '../../src/tools/ts_kernel/languages';

describe('capability_matrix', () => {
  it('语言名单复用 ts_kernel 的 LANGUAGES（>50 门）', () => {
    expect(LANGUAGES.length).toBeGreaterThan(50);
    const langs = new Set(LANGUAGES.map((l) => l.name));
    expect(langs.has('go')).toBe(true);
    expect(langs.has('typescript')).toBe(true);
    expect(langs.has('python')).toBe(true);
  });

  it('declareCapability / levelFor：overrides 优先于 default', () => {
    const id = 'test_feat_' + Date.now();
    declareCapability({
      id,
      label: '测试',
      desc: 'x',
      default: 'regex_fallback',
      overrides: { go: 'full_ast', python: 'full_ast' },
    });
    expect(getCapability(id)).toBeDefined();
    const c = getCapability(id)!;
    expect(levelFor(c, 'go')).toBe('full_ast');
    expect(levelFor(c, 'python')).toBe('full_ast');
    // 未点名的语言（如 java）取 default
    expect(levelFor(c, 'java')).toBe('regex_fallback');
  });

  it('audit 缺口：needWork（regex_fallback/unimplemented）计缺口，full_ast 不计', () => {
    const id = 'audit_feat_' + Date.now();
    declareCapability({
      id,
      label: '审计',
      desc: 'x',
      default: 'full_ast',
      overrides: { go: 'partial_ast', python: 'regex_fallback', java: 'full_ast' },
    });
    const rows = diagnoseCapabilities(['go', 'python', 'java']);
    const row = rows.find((r) => r.decl.id === id)!;
    const cell = (lang: string) => row.cells.find((c) => c.lang === lang)!;
    expect(cell('go').level).toBe('partial_ast');
    expect(cell('python').level).toBe('regex_fallback');
    expect(cell('java').level).toBe('full_ast');
    // go(partial_ast) 与 python(regex_fallback) 都是缺口；java(full_ast) 不是
    expect(row.gaps.some((g) => g.lang === 'go')).toBe(true);
    expect(row.gaps.some((g) => g.lang === 'python')).toBe(true);
    expect(row.gaps.some((g) => g.lang === 'java')).toBe(false);
  });

  it('登记点名未知语言 → unknownLangs 标记笔误', () => {
    const id = 'unk_feat_' + Date.now();
    declareCapability({
      id,
      label: '未知语言',
      desc: 'x',
      default: 'unimplemented',
      overrides: { not_a_lang: 'full_ast' },
    });
    const rows = diagnoseCapabilities(['go']);
    const row = rows.find((r) => r.decl.id === id)!;
    expect(row.unknownLangs).toContain('not_a_lang');
  });

  it('aggregateGaps：仅收 needWork 语言', () => {
    const id = 'agg_feat_' + Date.now();
    declareCapability({
      id,
      label: '聚合',
      desc: 'x',
      default: 'full_ast',
      overrides: { go: 'regex_fallback', python: 'unimplemented', java: 'full_ast' },
    });
    const rows = diagnoseCapabilities(['go', 'python', 'java']);
    const gaps = aggregateGaps(rows);
    expect(gaps[id]).toEqual(['go', 'python']); // java full_ast 不列
  });

  it('默认登记：关键功能契约存在且支持度正确', async () => {
    _resetRegistry();
    await import('../../src/tools/register_capabilities');
    const ids = allCapabilities().map((c) => c.id);
    for (const expectId of [
      'ast_parse_skeleton',
      'package_migration',
      'rename_symbol',
      'contract_gate',
      'extract_contracts',
      'version_upgrade_detection',
      'static_gate',
      'dynamic_gate',
    ]) {
      expect(ids).toContain(expectId);
    }
    const rows = diagnoseCapabilities(['go', 'python', 'java', 'typescript', 'javascript', 'tsx']);
    const pm = rows.find((r) => r.decl.id === 'package_migration')!;
    expect(pm.cells.find((c) => c.lang === 'go')!.level).toBe('full_ast');
    expect(pm.cells.find((c) => c.lang === 'typescript')!.level).toBe('full_ast');
    expect(pm.cells.find((c) => c.lang === 'python')!.level).toBe('full_ast');
    expect(pm.cells.find((c) => c.lang === 'java')!.level).toBe('regex_fallback'); // 未点名语言 → default
    expect(pm.gaps.some((g) => g.lang === 'java')).toBe(true);
    // contract_gate / extract_contracts：js 家族已补齐（低垂果实），python 仍缺口
    const cg = rows.find((r) => r.decl.id === 'contract_gate')!;
    expect(cg.cells.find((c) => c.lang === 'javascript')!.level).toBe('full_ast');
    expect(cg.gaps.some((g) => g.lang === 'python')).toBe(true);
    const ec = rows.find((r) => r.decl.id === 'extract_contracts')!;
    expect(ec.cells.find((c) => c.lang === 'javascript')!.level).toBe('full_ast');
    // version_upgrade 线：检测四语言齐备；静态/动态闸暴露缺口
    const det = rows.find((r) => r.decl.id === 'version_upgrade_detection')!;
    expect(det.cells.find((c) => c.lang === 'java')!.level).toBe('full_ast');
    expect(det.cells.find((c) => c.lang === 'go')!.level).toBe('full_ast');
    expect(det.cells.find((c) => c.lang === 'python')!.level).toBe('full_ast');
    expect(det.cells.find((c) => c.lang === 'javascript')!.level).toBe('full_ast'); // node 适配器
    expect(det.gaps).toHaveLength(0);
    const sg = rows.find((r) => r.decl.id === 'static_gate')!;
    expect(sg.cells.find((c) => c.lang === 'python')!.level).toBe('full_ast');
    expect(sg.cells.find((c) => c.lang === 'java')!.level).toBe('full_ast');
    expect(sg.cells.find((c) => c.lang === 'go')!.level).toBe('partial_ast');
    expect(sg.cells.find((c) => c.lang === 'javascript')!.level).toBe('partial_ast');
    expect(sg.gaps.some((g) => g.lang === 'go')).toBe(true);
    const dg = rows.find((r) => r.decl.id === 'dynamic_gate')!;
    expect(dg.cells.find((c) => c.lang === 'python')!.level).toBe('full_ast');
    expect(dg.cells.find((c) => c.lang === 'java')!.level).toBe('partial_ast');
    expect(dg.cells.find((c) => c.lang === 'go')!.level).toBe('unimplemented');
    expect(dg.cells.find((c) => c.lang === 'javascript')!.level).toBe('unimplemented');
    expect(dg.cells.find((c) => c.lang === 'typescript')!.level).toBe('unimplemented');
    // 缺口 = 未全量的语言：go/js 家族（unimplemented）+ java（partial）
    expect(dg.gaps.map((g) => g.lang).sort()).toEqual(['go', 'java', 'javascript', 'tsx', 'typescript']);
    _resetRegistry();
  });

  it('默认登记的覆盖语言全命中 LANGUAGES（无笔误）', async () => {
    _resetRegistry();
    await import('../../src/tools/register_capabilities');
    const known = new Set(LANGUAGES.map((l) => l.name));
    for (const c of allCapabilities()) {
      for (const entry of Object.keys(c.overrides ?? {})) {
        expect(known.has(entry)).toBe(true);
      }
    }
    _resetRegistry();
  });
});