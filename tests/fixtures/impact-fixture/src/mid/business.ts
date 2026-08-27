// impact 夹具 · 中间层：消费 core，被 top 消费（既是消费者也是提供者）
import { double, Shape } from '../core/math';
import { log } from '../core/logger';

export function scale(s: Shape, factor: number): number {
  log(`scaling by ${factor}`);
  return double(s.sides) * factor;
}

export function perimeter(s: Shape): number {
  return double(s.sides);
}
