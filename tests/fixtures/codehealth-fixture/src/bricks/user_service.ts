// code_health 夹具 · 积木层：业务逻辑（被胶水消费，正常依赖契约层）
import { User, Order } from '../contracts/models';

export function computeScore(u: User): number {
  return u.id * 10;
}

// 刻意无任何项目内引用 → 未使用导出
export function unusedFn(x: number): number {
  return x + 1;
}

// 刻意堆砌分支 → 圈复杂度超阈值（high_complexity）
export function superComplex(n: number): number {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) acc += i;
    else if (i % 3 === 0) acc -= i;
    else acc += 1;
  }
  for (let j = 0; j < 10; j++) {
    if (j > 5 && j < 8) acc *= 2;
    if (j === 6 || j === 7) acc += j;
  }
  while (acc > 1000) acc -= 100;
  if (acc > 100 && acc < 200) acc = 0;
  if (acc > 200 && acc < 300) acc = 1;
  if (acc > 300 && acc < 400) acc = 2;
  if (acc > 400 && acc < 500) acc = 3;
  if (acc > 500 && acc < 600) acc = 4;
  return acc;
}
