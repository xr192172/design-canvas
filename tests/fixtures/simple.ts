/**
 * behavior_baseline 金丝雀夹具（TS 版）：纯函数，无 import，顶层无打印。
 *
 * 供 tests/behavior 真跑 node harness 使用；每个函数覆盖一种可被基线对比的行为维度：
 *  - add            返回标量 → 返回值 repr 对比（带类型标注）
 *  - describePerson 返回对象（含默认参/kwargs→尾部 options 对象）→ 结构化 repr 对比
 *  - pickEvens      返回数组 → 数组保留插入序对比
 *  - safeDivide     除零抛异常 → 异常路径对比
 *  - asyncAdd       async 函数 → 自动 await 返回值对比
 *  - makeSet        Set → 按键排序化 repr 对比
 *  - makeMap        Map → 按 key 排序化 repr 对比
 *  - echoOut        console.log 副作用 → stdout 痕迹对比
 */
export function add(a: number, b: number): number {
  return a + b;
}

export function describePerson(name: string, age = 18, tags: string[] = []): Record<string, unknown> {
  return { name, age, tags: [...tags].sort() };
}

export function buildConfig(name: string, opts: { retries?: number; debug?: boolean } = {}): Record<string, unknown> {
  return { name, retries: opts.retries ?? 0, debug: opts.debug ?? false };
}

export function pickEvens(items: number[]): number[] {
  return items.filter((x) => x % 2 === 0);
}

export function safeDivide(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

export async function asyncAdd(a: number, b: number): Promise<number> {
  return a + b;
}

export function makeSet(...items: string[]): Set<string> {
  return new Set(items);
}

export function makeMap(): Map<string, number> {
  return new Map([
    ['b', 2],
    ['a', 1],
  ]);
}

export function echoOut(msg: string): void {
  console.log(`echo:${msg}`);
}
