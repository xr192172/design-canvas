// code_health 夹具 · 契约层违规：契约层反向依赖积木层（分层违规）
// 同时自身无消费者 → 孤儿文件
import { computeScore } from '../bricks/user_service';

export interface ScoreBand {
  min: number;
  label: string;
}

export function describeBand(score: number): string {
  return score >= 80 ? 'excellent' : 'ok';
}

export function bandOf(u: { id: number }): string {
  return describeBand(computeScore(u));
}
