// hybrid-a 夹具 · merge：与 hybrid-b/core.ts 同名不同签 → 真冲突
export function merge(a: number[], b: number[]): number[] {
  return a.concat(b);
}
