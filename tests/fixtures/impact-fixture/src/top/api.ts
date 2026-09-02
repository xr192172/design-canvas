// impact 夹具 · 顶层：只消费 mid（验证传递影响 depth=2）
import { scale } from '../mid/business';

export function handle(factor: number): number {
  return scale({ sides: 4 }, factor);
}
