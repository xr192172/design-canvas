/**
 * search_bricks 积木货架测试（Brick Harvest Phase 4）
 *
 * 覆盖：
 *   - 浏览模式：全积木概况 + 语言推断（扩展名投票）
 *   - 检索模式：打分排序（name > shape > field > description）+ matched 明细
 *   - 过滤：language / verified / has_invariants / zero_third_party
 *   - 详情模式：contracts.json 实算 writes/holds + effects_detail + contracts 原文
 *   - 异常：盒不存在 / name 不在盒（列出现有）
 *   - description 槽位输出（重抽保留字段）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { searchBricks } from '../../src/tools/search_bricks.js';

interface Fixture {
  boxDir: string;
  brick: (name: string, opts: { lang: 'go' | 'ts'; manifest?: Record<string, unknown>; contracts?: Record<string, unknown> }) => void;
}

function setupBox(): Fixture {
  const boxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-box-'));
  const brick = (
    name: string,
    opts: {
      lang: 'go' | 'ts';
      manifest?: Record<string, unknown>;
      contracts?: Record<string, unknown>;
    },
  ) => {
    const dir = path.join(boxDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const files = opts.lang === 'go' ? ['internal/a.go', 'internal/b.go'] : ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    const base: Record<string, unknown> = {
      name,
      schema_version: 1,
      seed_files: files.slice(0, 1),
      closure: {
        internal: files,
        external:
          opts.lang === 'go'
            ? [{ source: 'os', class: 'stdlib' }]
            : [
                { source: 'node:fs', class: 'stdlib' },
                { source: 'zod', class: 'third_party' },
              ],
      },
      aggregate: {
        exposes: [
          {
            name: 'ThemePreset',
            kind: 'interface',
            fields: [{ name: 'accentColor', type: 'string', required: true }],
            origin: 'ast',
          },
        ],
        consumes: [],
        emits: [],
        reads_config: [],
        irreversible_effects: 2,
      },
      provenance: { source_project: 'D:/proj/vendor/X', commit: 'abc1234', harvested_at: '2026-08-20T00:00:00Z' },
      ...(opts.manifest ?? {}),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(base, null, 2), 'utf8');
    if (opts.contracts) {
      fs.writeFileSync(path.join(dir, 'contracts.json'), JSON.stringify(opts.contracts, null, 2), 'utf8');
    }
  };
  return { boxDir, brick };
}

describe('searchBricks', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setupBox();
    // go_logging：已验证 + 有不变量（exposes 专属 shape，避免与 ua_theme_engine 撞）
    f.brick('go_logging', {
      lang: 'go',
      manifest: {
        description: '分级日志四件套：文件轮转 + 会话路由',
        aggregate: {
          exposes: [
            {
              name: 'FileLogger',
              kind: 'struct',
              fields: [{ name: 'basePath', type: 'string', required: true }],
              origin: 'ast',
            },
          ],
          consumes: [],
          emits: [],
          reads_config: [],
          irreversible_effects: 3,
        },
        effect_verification: {
          verified_at: '2026-08-20T10:00:00Z',
          method: 'test',
          events: 100,
          stats: { confirmed: 7, unobserved: 3 },
          files: [],
        },
        acceptance: {
          invariants: [
            { name: 'rotate', assertion: 'x', source: 'test-verified', ref: 't.go' },
            { name: 'p2', assertion: 'y', source: 'llm-proposed' },
          ],
        },
      },
      contracts: {
        'internal/logging/logging.go': {
          effects: {
            writes: [{ target: 'globalFileLogger', op: 'write', origin: 'runtime' }],
            holds: [{ target: 'file:r.basePath', op: 'acquire', origin: 'runtime' }],
            emits: [],
          },
        },
      },
    });
    // ua_theme_engine：TS + 三方依赖 + 未验证
    f.brick('ua_theme_engine', {
      lang: 'ts',
      manifest: { description: '主题引擎：preset 切换 + accent 色板' },
    });
    // 空壳目录（非积木）：应被跳过
    fs.mkdirSync(path.join(f.boxDir, 'not-a-brick'), { recursive: true });
  });

  it('浏览模式：全积木概况 + 语言推断 + 跳过非积木目录', async () => {
    const r = await searchBricks({ box_dir: f.boxDir });
    expect(r.mode).toBe('browse');
    expect(r.total_bricks).toBe(2);
    const names = r.entries.map((e) => e.name).sort();
    expect(names).toEqual(['go_logging', 'ua_theme_engine']);
    const go = r.entries.find((e) => e.name === 'go_logging')!;
    expect(go.language).toBe('go');
    expect(go.files).toBe(2);
    expect(go.third_party).toBe(0);
    expect(go.verified).toBe(true);
    expect(go.confirmed_effects).toBe(7);
    expect(go.invariants).toBe(2);
    expect(go.invariant_sources).toEqual({ 'test-verified': 1, 'llm-proposed': 1 });
    expect(go.description).toContain('日志');
    const ts = r.entries.find((e) => e.name === 'ua_theme_engine')!;
    expect(ts.language).toBe('typescript');
    expect(ts.files).toBe(3);
    expect(ts.third_party).toBe(1);
    expect(ts.verified).toBe(false);
    // 列表模式 effects：irreversible/emits 恒有，writes/holds 不虚构
    expect(ts.effects.irreversible).toBe(2);
    expect(ts.effects.writes).toBeUndefined();
  });

  it('检索模式：shape 名命中 > description 命中，带 matched 明细', async () => {
    const r = await searchBricks({ box_dir: f.boxDir, query: 'ThemePreset' });
    expect(r.mode).toBe('search');
    expect(r.entries[0].name).toBe('ua_theme_engine');
    expect(r.entries[0].matched).toContain('shape:ThemePreset');
    expect(r.entries[0].score).toBeGreaterThanOrEqual(50);

    // 字段名命中
    const r2 = await searchBricks({ box_dir: f.boxDir, query: 'accentColor' });
    expect(r2.entries[0].matched).toContain('field:ThemePreset.accentColor');

    // description 命中（低权重但能搜到）
    const r3 = await searchBricks({ box_dir: f.boxDir, query: '轮转' });
    expect(r3.entries[0].name).toBe('go_logging');
    expect(r3.entries[0].matched).toContain('description');

    // 无命中
    const r4 = await searchBricks({ box_dir: f.boxDir, query: '不存在的关键词' });
    expect(r4.entries).toHaveLength(0);
  });

  it('过滤：language / verified / has_invariants / zero_third_party', async () => {
    expect((await searchBricks({ box_dir: f.boxDir, language: 'go' })).entries.map((e) => e.name)).toEqual(['go_logging']);
    expect((await searchBricks({ box_dir: f.boxDir, language: 'typescript' })).entries.map((e) => e.name)).toEqual(['ua_theme_engine']);
    expect((await searchBricks({ box_dir: f.boxDir, verified: true })).entries.map((e) => e.name)).toEqual(['go_logging']);
    expect((await searchBricks({ box_dir: f.boxDir, has_invariants: true })).entries.map((e) => e.name)).toEqual(['go_logging']);
    expect((await searchBricks({ box_dir: f.boxDir, zero_third_party: true })).entries.map((e) => e.name)).toEqual(['go_logging']);
    // 组合过滤空结果
    const none = await searchBricks({ box_dir: f.boxDir, language: 'go', verified: false });
    expect(none.entries).toHaveLength(0);
  });

  it('详情模式：contracts.json 实算 writes/holds + effects_detail + contracts 原文', async () => {
    const r = await searchBricks({ box_dir: f.boxDir, name: 'go_logging' });
    expect(r.mode).toBe('detail');
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e.effects.writes).toBe(1);
    expect(e.effects.holds).toBe(1);
    expect(e.effects.irreversible).toBe(3);
    expect(e.brick_dir).toBe(path.join(f.boxDir, 'go_logging'));
    expect(r.effects_detail?.['internal/logging/logging.go']).toBeDefined();
    expect((r.contracts as Record<string, unknown>)['internal/logging/logging.go']).toBeDefined();
    expect(r.message).toContain('observe 已验证');
    expect(r.message).toContain('不变量 2 条');
  });

  it('死依赖候选透出：列表计数 + 详情档案（slim_candidates 原文）', async () => {
    f.brick('dirty_demo', {
      lang: 'go',
      manifest: {
        slim_candidates: {
          computed_at: '2026-08-20T00:00:00Z',
          live_symbols: 12,
          total_symbols: 40,
          dead_third_party: [
            { source: 'github.com/unused/deadlib', files: ['internal/x.go'], reason: 'unreachable_only' },
            { source: 'gopkg.in/ghost.v2', files: ['internal/y.go'], reason: 'no_reference' },
          ],
          limitations: ['静态可达性看不见反射…'],
        },
      },
    });
    // 列表/检索模式：计数透出
    const list = await searchBricks({ box_dir: f.boxDir });
    const entry = list.entries.find((e) => e.name === 'dirty_demo')!;
    expect(entry.dead_third_party).toBe(2);
    // 详情模式：计数 + slim_candidates 档案原文 + message 提示
    const detail = await searchBricks({ box_dir: f.boxDir, name: 'dirty_demo' });
    expect(detail.entries[0].dead_third_party).toBe(2);
    expect(detail.slim_candidates?.dead_third_party).toHaveLength(2);
    expect(detail.slim_candidates?.dead_third_party[0].source).toBe('github.com/unused/deadlib');
    expect(detail.message).toContain('死依赖候选 2/');
    // 无档案积木：计数缺省
    const clean = list.entries.find((e) => e.name === 'go_logging')!;
    expect(clean.dead_third_party).toBeUndefined();
  });

  it('异常：盒不存在 / name 不在盒', async () => {
    await expect(searchBricks({ box_dir: 'D:/definitely/not/exist' })).rejects.toThrow('积木盒不存在');
    await expect(searchBricks({ box_dir: f.boxDir, name: 'ghost' })).rejects.toThrow('ghost');
  });
});
