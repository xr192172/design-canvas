/**
 * arg_suggest —— 参数纠错（"Did you mean?"）
 *
 * 出处：Serena 的 **Smart Errors**（对参数名/枚举值做 Levenshtein，给候选）。
 * 为什么需要（dogfood 观察）：
 *   MCP 工具的参数写错时，zod object 默认**丢弃**未知键 —— 于是模型看到的是
 *   "结果莫名其妙"（比如把 projectRoot 传成 project_dir 的同义写法，工具按缺省值跑了），
 *   而不是一条可行动的纠正。给一条编辑距离建议，重试一次就能成。
 *
 * 纪律：
 *   - **只提示、不阻断**（未知键本来合法：explore_code 的 `args` 就是自由 record）。
 *   - **只在"够像"时提示**（距离阈值），否则静默 —— 宁可不提示，也不要噪音。
 *
 * 纯函数、零依赖（自己实现 Levenshtein）。
 */

/** 编辑距离（经典 DP，O(m·n)；参数名都短，够用） */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

export interface SuggestOptions {
  /** 最多给几个候选（默认 3） */
  max?: number;
  /** 距离上限（缺省按输入长度自适应：短名更严，长名更松） */
  maxDistance?: number;
}

/** 归一化：大小写、下划线、连字符都不算差异（project_dir ≈ projectDir ≈ project-dir） */
function normalize(s: string): string {
  return s.replace(/[_\-\s]/g, '').toLowerCase();
}

/**
 * 给一个（写错的）名字找最像的候选。
 * 归一化后相同 = 距离 0（`projectDir` → `project_dir` 这种最常见的错法会被一次命中）。
 */
export function suggestNames(input: string, candidates: readonly string[], opts: SuggestOptions = {}): string[] {
  const max = opts.max ?? 3;
  const ni = normalize(input);
  const limit = opts.maxDistance ?? Math.max(2, Math.floor(ni.length / 3));
  return candidates
    .map((c) => {
      const nc = normalize(c);
      // 归一化后完全一致 → 视为 0 距离（推荐首位）；否则比归一化串的编辑距离
      const d = nc === ni ? 0 : levenshtein(ni, nc);
      return { c, d };
    })
    .filter((x) => x.d <= limit)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .slice(0, max)
    .map((x) => x.c);
}

/**
 * 未知参数提示（返回人类可读行；空数组 = 没什么好说的，调用方什么也不加）。
 * @param args 实际收到的参数
 * @param known 该工具声明的参数名
 */
export function unknownArgHints(
  args: Record<string, unknown>,
  known: readonly string[],
  opts: SuggestOptions = {},
): string[] {
  const knownSet = new Set(known);
  const hints: string[] = [];
  for (const key of Object.keys(args ?? {})) {
    if (knownSet.has(key)) continue;
    const near = suggestNames(key, known, opts);
    if (near.length) hints.push(`未知参数 \`${key}\` —— 是否想传 \`${near[0]}\`？`);
    // 够不像 → 静默（未知键可能是有意为之，别制造噪音）
  }
  return hints;
}

/** 把提示渲染成一段可追加到工具输出末尾的文本（无提示返回空串） */
export function renderArgHints(hints: readonly string[], known: readonly string[]): string {
  if (!hints.length) return '';
  return `\n\n⚠ ${hints.join('\n⚠ ')}\n（本工具参数：${known.join(' / ')}）`;
}
