// impact 夹具 · 底层核心：被 business 直接消费（call + type_ref 双路证据）
export function double(n: number): number {
  return n * 2;
}

export interface Shape {
  sides: number;
}

export function computeSum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}
