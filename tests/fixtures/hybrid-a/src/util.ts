// hybrid-a 夹具 · 仅在 A：迁移到 B 的安全候选（求差 aOnly）
export function sum(nums: number[]): number {
  return nums.reduce((x, y) => x + y, 0);
}

export interface Point {
  x: number;
  y: number;
}
