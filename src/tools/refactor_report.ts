/**
 * refactor_report —— 重构结果的机器可读报表（dogfood / agent 审计的"存档层"）
 *
 * 定位：runRefactorPipeline 的 StageResult 是内存态，跑完即散。本模块把它物化成
 * 一份结构化 JSON（ok / 计数 / 改动文件 / 按 outcome 分桶 / 逐 stage / 回滚清单），
 * 供：
 *   - dogfood：落盘 refactor_report.json，事后看"这次清理到底动没动干净、回滚几次"；
 *   - agent：直接读结构喂给下游（评审 / 提交说明 / 排障）。
 *
 * 纯函数：不读盘（buildRefactorReport 只吞 PipelineResult）；writeRefactorReport 才写文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PipelineResult, StageResult } from './refactor_pipeline.js';

export type RefactorStageOutcome = StageResult['outcome'];

export interface RefactorStageReport {
  id: string;
  label: string;
  index: number;
  outcome: RefactorStageOutcome;
  files_changed: number;
  units_removed: number;
  detail?: string;
  /** 契约对账闸门（开启且该步确有落盘时才有） */
  contract?: StageResult['contract'];
}

export interface RefactorReport {
  ok: boolean;
  planned_steps: number;
  total_files_changed: number;
  total_units_removed: number;
  /** 实际改动过的文件（相对 cwd，正斜杠，升序） */
  changed_files: string[];
  /** 按每步最终 outcome 聚合的桶计数 */
  by_outcome: Record<string, number>;
  /** 单独拎出的回滚步骤（改后验证失败 / 静态复核失败）——审计重点关注 */
  rolled_back: RefactorStageReport[];
  stages: RefactorStageReport[];
  generated_at: string;
}

function toStageReport(s: StageResult): RefactorStageReport {
  return {
    id: s.id,
    label: s.label,
    index: s.index,
    outcome: s.outcome,
    files_changed: s.files_changed,
    units_removed: s.units_removed,
    detail: s.detail,
    contract: s.contract,
  };
}

/** 把 PipelineResult 聚合为结构化报表（纯函数，不写盘） */
export function buildRefactorReport(res: PipelineResult): RefactorReport {
  const by_outcome: Record<string, number> = {};
  const stages = res.stages.map(toStageReport);
  for (const s of stages) {
    by_outcome[s.outcome] = (by_outcome[s.outcome] ?? 0) + 1;
  }
  return {
    ok: res.ok,
    planned_steps: res.planned_steps,
    total_files_changed: res.total_files_changed,
    total_units_removed: res.total_units_removed,
    changed_files: res.changed_files ?? [],
    by_outcome,
    rolled_back: stages.filter((s) => s.outcome === 'rolled_back'),
    stages,
    generated_at: new Date().toISOString(),
  };
}

/** 把报表落盘为 JSON（dogfood 存档；目录不存在时创建） */
export function writeRefactorReport(res: PipelineResult, dest: string): string {
  const js = JSON.stringify(buildRefactorReport(res), null, 2);
  const abs = dest.endsWith('.json') ? dest : `${dest}.json`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, js, 'utf-8');
  return abs;
}