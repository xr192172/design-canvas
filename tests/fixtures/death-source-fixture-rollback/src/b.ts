// scope 外活跃消费者：真实使用 legacyGreet，绝不能被删（模拟 --files 局限的盲区）
import { legacyGreet } from './legacy/old';

export const fromB: string = legacyGreet('b');