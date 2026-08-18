/**
 * Camera 插桩器黄金样例（TypeScript）
 * 语义清单见 _reference.md —— 与 sample.go 语义等价。
 */
import fs from 'node:fs';

export function addTwo(a: number, b: number): number {
  return a + b;
}

export function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function log(msg: string): void {
  if (!msg) return;
  process.stdout.write(msg + '\n');
}

export function saveQuiet(path: string, data: string): boolean {
  try {
    fs.writeFileSync(path, data);
    return true;
  } catch {
    return false;
  }
}

export function main(): void {
  log(String(addTwo(1, 2)));
  log(String(clamp(5, 0, 10)));
  saveQuiet('.tmp-camera-sample.txt', 'ok');
}
