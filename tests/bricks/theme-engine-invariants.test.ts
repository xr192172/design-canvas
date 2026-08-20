/**
 * ua_theme_engine 积木不变量验收 —— Phase 2.8「验收判据可执行」首例
 *
 * 4 条 llm-proposed 断言 → 在盒中快照上真实执行 → 通过即转 test-verified
 * （manifest.json 的 invariants[].source: 'llm-proposed' → 'test-verified'）。
 *
 * 积木盒是本地注册表（.gitignore 内）：无盒环境（CI/他机）skip，本地有盒才跑。
 * 属性测试不引 fast-check 依赖：固定种子 xorshift 生成确定性输入序列，跨运行可复现。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const brickDir = path.resolve(
  __dirname,
  '../../.design-canvas/bricks/ua_theme_engine/files/understand-anything-plugin/packages/dashboard/src/themes',
);
const hasBrick = fs.existsSync(path.join(brickDir, 'theme-engine.ts'));

// ── 固定种子 xorshift：确定性伪随机 ──────────────────────────
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= (s << 13) >>> 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0;
    return s >>> 0;
  };
}
const rand = makeRng(20260820);
/** 100 个确定性随机 hex + 8 个边界值 */
const HEXES: string[] = [
  '000000', 'ffffff', 'ff0000', '00ff00', '0000ff',
  '7f7f7f', '123456', 'abcdef',
  ...Array.from({ length: 100 }, () => (rand() & 0xffffff).toString(16).padStart(6, '0')),
];

/** 源码 deriveFromAccent 写入的 17 个派生 token（含 4 个 --color- 前缀） */
const DERIVED_KEYS = [
  '--color-border-subtle', '--color-border-medium',
  '--glass-bg', '--glass-bg-heavy', '--glass-border', '--glass-border-heavy',
  '--scrollbar-thumb', '--scrollbar-thumb-hover',
  '--glow-accent', '--glow-accent-strong', '--glow-accent-pulse',
  '--color-edge', '--color-edge-dim', '--color-edge-dot',
  '--color-accent-overlay-bg', '--color-accent-overlay-border',
  '--kbd-bg',
];

// ── document stub：收集 setProperty / setAttribute ──────────
let props: Map<string, string>;
let attrs: Map<string, string>;
const origDocument = (globalThis as { document?: unknown }).document;

function stubDocument(): void {
  props = new Map();
  attrs = new Map();
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      style: { setProperty: (k: string, v: string) => props.set(k, v) },
      setAttribute: (k: string, v: string) => attrs.set(k, v),
    },
  };
}

describe.skipIf(!hasBrick)('ua_theme_engine 不变量（盒快照可执行验收）', () => {
  let hexToRgb: (hex: string) => string;
  let applyTheme: (config: {
    presetId: string;
    accentId: string;
    headingFont?: string;
  }) => void;
  let presetColorCount: number;

  beforeAll(async () => {
    const engine = await import(path.join(brickDir, 'theme-engine.ts'));
    const presets = await import(path.join(brickDir, 'presets.ts'));
    hexToRgb = engine.hexToRgb;
    applyTheme = engine.applyTheme;
    presetColorCount = Object.keys(presets.PRESETS[0].colors).length;
  });

  afterAll(() => {
    if (origDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = origDocument;
  });

  it('hex-parse-validity：任意合法 6 位 hex → "r, g, b"，分量落在 0-255', () => {
    for (const h of HEXES) {
      const out = hexToRgb(h);
      const n = parseInt(h, 16);
      // 与位移拆解手算严格一致
      expect(out).toBe(`${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`);
      // 三分量均在 0-255
      for (const part of out.split(', ').map(Number)) {
        expect(part).toBeGreaterThanOrEqual(0);
        expect(part).toBeLessThanOrEqual(255);
      }
    }
  });

  it('derivation-purity + token-completeness：同输入两次 apply，四组 token 齐全', () => {
    stubDocument();
    applyTheme({ presetId: 'dark-gold', accentId: 'gold' });
    const first = new Map(props);

    // ① preset 基色全量 + ② 3 个 accent token + 17 派生中 7 个 --color- 前缀
    //（初版断言"基色+3"被本测试纠正：派生 token 里 border×2 + edge×3 + overlay×2
    //  共 7 个带 --color- 前缀——LLM 提议的计数不可信，执行才算数）
    const colorKeys = [...first.keys()].filter((k) => k.startsWith('--color-'));
    expect(colorKeys.length).toBe(presetColorCount + 3 + 7);
    expect(first.get('--color-accent')).toBeTruthy();
    expect(first.get('--color-accent-dim')).toBeTruthy();
    expect(first.get('--color-accent-bright')).toBeTruthy();

    // ③ 17 个派生 token 一个不少
    for (const k of DERIVED_KEYS) expect(first.has(k)).toBe(true);

    // ④ --font-heading（缺省 serif）
    expect(first.get('--font-heading')).toBe('var(--font-serif)');

    // 总量 = 基色 + 3 accent + 17 派生 + 1 字体
    expect(first.size).toBe(presetColorCount + 3 + 17 + 1);

    // 纯函数性（行为等价）：同输入再 apply 一次，全部终值一致
    applyTheme({ presetId: 'dark-gold', accentId: 'gold' });
    expect([...props.entries()].sort()).toEqual([...first.entries()].sort());

    // data-theme 与 isDark 严格对应
    expect(attrs.get('data-theme')).toBe('dark');
  });

  it('apply-idempotent：light preset 幂等 + data-theme=light + accent 三档色存在', () => {
    stubDocument();
    const cfg = { presetId: 'light-minimal', accentId: 'indigo' };
    applyTheme(cfg);
    const first = new Map(props);

    expect(attrs.get('data-theme')).toBe('light');
    // accent 派生自 indigo 色板（#4a6fa5 的 rgb 前缀出现在派生 token 里）
    expect(first.get('--color-accent')).toBe('#4a6fa5');
    expect(first.get('--color-border-subtle')).toBe('rgba(74, 111, 165, 0.1)'); // light 档 alpha

    // 幂等
    applyTheme(cfg);
    expect([...props.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it('heading-font 三档映射 + 未知值回退 serif', () => {
    stubDocument();
    applyTheme({ presetId: 'dark-gold', accentId: 'gold', headingFont: 'mono' });
    expect(props.get('--font-heading')).toBe('var(--font-mono)');
    applyTheme({ presetId: 'dark-gold', accentId: 'gold', headingFont: 'sans' });
    expect(props.get('--font-heading')).toBe('var(--font-sans)');
    // fontMap 之外的值回退 serif（?? 的回退语义）
    applyTheme({ presetId: 'dark-gold', accentId: 'gold', headingFont: 'comic-sans' } as never);
    expect(props.get('--font-heading')).toBe('var(--font-serif)');
  });
});
