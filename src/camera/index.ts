/**
 * Camera 多语言契约 · TypeScript 接入试点
 *
 * 统一导出 TS 探针端口（ProbeCapture）与判定哨兵（Comparator），作为
 * 「跨语言契约」的 TS 侧第一落点。验证路径：
 *
 *   TS 探针埋点 emit → events.jsonl ─┐
 *                                      ├→ TS 哨兵 Comparator 判定（本包）
 *   dsl.json（权威真相源，Go 定稿）──┘
 *
 * 同一份 events.jsonl + dsl.json 也可喂给 Go 装配层（camera-dsl actual/diff/loop）
 * 判定——这正是「语言无关契约」要证明的：判定逻辑不绑定探针语言。
 */

export { TSProbeCapture, loadTSEvents } from './probe.js';
export type { TSEvent, ExtraFields } from './probe.js';
export { TSComparator, silentErrorDiscardTS, renderTSDiffReport } from './contract.js';
export type {
  TSDLDecl,
  TSDesignDSLDoc,
  TSDeviation,
  DeviationKind,
  TSDiffReport,
  TSProbeObs,
  RulePredicate,
} from './contract.js';