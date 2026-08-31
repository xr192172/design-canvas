/**
 * Observe 多语言契约 · TypeScript 接入试点
 *
 * 统一导出 TS 探针端口（ProbeCapture）与判定哨兵（Comparator），作为
 * 「跨语言契约」的 TS 侧第一落点。验证路径：
 *
 *   TS 探针埋点 emit → events.jsonl ─┐
 *                                      ├→ TS 哨兵 Comparator 判定（本包）
 *   dsl.json（权威真相源，Go 定稿）──┘
 *
 * 同一份 events.jsonl + dsl.json 也可喂给 Go 装配层（observe-dsl actual/diff/loop）
 * 判定——这正是「语言无关契约」要证明的：判定逻辑不绑定探针语言。
 */

export { TSProbeCapture, loadTSEvents } from './probe.js';
export { setGlobalProbeSink, captureProbe } from './probe.js';
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
export { enableObserveFromEnv } from './run_sentinel.js';
// v2 分级采集 runtime（对齐 go-observe/probe：tiered.go/trace.go/export.go）
export {
  Tiered,
  setGlobalTiered,
  getGlobalTiered,
  isCatchProbe,
  DEFAULT_RING_BUDGET_MB,
} from './tiered.js';
export type {
  TieredOptions,
  FullSink,
  CountersSnapshot,
  HistogramSnapshot,
  RingStats,
} from './tiered.js';
export { withScope, enterScope, currentScope, currentTraceId, newTraceId } from './trace.js';
export type { Scope, ScopeFields } from './trace.js';
export {
  ExportGate,
  exportIncident,
  splitEvents,
  DEFAULT_EXPORT_PER_MIN,
  DEFAULT_MAX_INCIDENTS,
} from './export_incident.js';
export type { IncidentHeader } from './export_incident.js';