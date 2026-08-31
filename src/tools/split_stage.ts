/**
 * split_stage —— 拆分执行器（signal_review 的最后一棒）
 *
 * 承接 signal_review（LLM 复核）的**采纳信号**，把复核判"值得独立成积木"的概念簇，
 * 真正按簇切出独立文件。它不做信号检测（那是 brickify 的 detectMixedFiles）、
 * 不做语义判据（那是 signal_review 的 reviewSignals），只做一件事：**执行拆**。
 *
 * 复用（不重复造轮子）：
 *   - derive_split.splitOnce：新文件生成 + import 接线 + 编译/测试级验收 + 失败自动回滚
 *     （tree-sitter AST 解析、Go 未用 import 裁剪、py_compile/tsc/go build 验收全在它内部）。
 *   - 本模块只做"把复核结果 → 执行计划"的编排：把已采纳簇的符号名映射给 derive_split，
 *     并按申领的 feature 名生成新文件名，聚合出一次可读报告。
 *
 * 与 refactor_pipeline 的关系：
 *   - refactor_pipeline 处理**行级**减肥（dead_imports / dead_statements），每个执行器
 *     compute→apply→一次性改后验证→绿点回滚。
 *   - 本桩是**积木级**重构（brickify / signal_review / split 系的收口），derive_split 已内建
 *     写盘 + 编译/测试验收 + 回滚，若再塞进管线会双重验证（管线头注明明令避免）。
 *     故本桩独立执行，但产出与 StageResult 对齐的 outcome 词表（split / rolled_back / no_change / no_symbols），
 *     便于后续整条"重构产线"统一汇总。
 *
 * 安全默认：dry_run=true 只出草稿，不进 git；确认后再 dry_run=false 落盘由编译/测试验收闭环兜底。
 */

import path from 'node:path';
import type { MixedFileSignal } from './brickify.js';
import type { SignalReview } from './signal_review.js';
import { deriveSplit, type DeriveSplitResult } from './derive_split.js';

// ─────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────

/** 单个文件的拆分执行计划（由复核采纳信号推导） */
export interface SplitStagePlan {
  /** 相对 project_dir 的目标文件，如 observe/export_incident.ts */
  file: string;
  /** 采纳簇申领的积木/功能名（新文件命名依据，缺省回退默认 __split） */
  feature: string;
  /** 采纳簇内的符号名（要抽到新文件的顶层符号） */
  symbols: string[];
}

export interface SplitStageOptions {
  project_dir: string;
  /** 源码子目录（如 'src'）：报告/采纳信号的 file 相对该目录，且 project_dir 仍是编译检测根。
   *  缺省 = 信号的 file 直接相对 project_dir。 */
  source_root?: string;
  /** 拆分执行计划（缺省由 signals + review 自动推导） */
  plans?: SplitStagePlan[];
  /** 已扫描信号（collectAdoptedPlans 需要）；plans 已给时可不传 */
  signals?: MixedFileSignal[];
  /** 复核结论（collectAdoptedPlans 需要）；plans 已给时可不传 */
  reviews?: SignalReview[];
  /** true=只出草稿不落盘（默认） */
  dry_run?: boolean;
  /** 编译级验收（默认 = !dry_run） */
  verify_compile?: boolean;
  /** 测试级验收（默认 = verify_compile） */
  verify_test?: boolean;
  /** 是否让原文件对被抽取符号保留再导出（外部跨文件消费者存在时开） */
  re_export_extracted?: boolean;
  /** 单簇符号数护栏：超过不切（防误拆巨型工具簇） */
  max_symbols?: number;
}

export type SplitOutcome = 'split' | 'rolled_back' | 'no_symbols' | 'no_change' | 'skipped';

export interface SplitStageItem {
  file: string;
  feature: string;
  new_file: string;
  /** 与 refactor_pipeline.StageResult.outcome 对齐的词表 */
  status: SplitOutcome;
  symbol_count: number;
  note: string;
  /** derive_split 的一次拆分详情（含接线/裁剪/验收证据），供人审 */
  derivation?: DeriveSplitResult;
}

export interface SplitStageResult {
  ok: boolean;
  dry_run: boolean;
  total_plans: number;
  total_splits: number;
  /** 已拆 (=split) 的数量 */
  applied: number;
  items: SplitStageItem[];
  message: string;
}

// ─────────────────────────────────────────────
// 复核采纳信号 → 执行计划（纯函数）
// ─────────────────────────────────────────────

/**
 * 把 brickify 信号 + signal_review 复核结论，折叠成拆分执行计划。
 * 对齐规则：对每个信号文件，复核的 ClusterReview 数组与信号的 clusters 数组**按下标一一对应**
 * （signal_review 的 prompt 强制"簇数量与输入一致"且保序），故 review.reviews[i].adopt === true
 * 即对应 signal.clusters[i] 的符号集合，feature 取自 review.reviews[i].feature。
 */
export function collectAdoptedPlans(
  signals: MixedFileSignal[],
  reviews: SignalReview[],
  maxSymbols?: number,
): SplitStagePlan[] {
  const byFile = new Map<string, SignalReview>();
  for (const r of reviews) byFile.set(r.file, r);

  const plans: SplitStagePlan[] = [];
  for (const signal of signals) {
    const review = byFile.get(signal.file);
    if (!review || review.reviews.length !== signal.clusters.length) continue; // 复核失败/未复核 → 跳过
    for (let i = 0; i < review.reviews.length; i++) {
      const cr = review.reviews[i];
      if (!cr.adopt) continue;
      const symbols = signal.clusters[i] ?? [];
      if (maxSymbols && symbols.length > maxSymbols) continue; // 护栏：超大簇不自动切
      plans.push({ file: signal.file, feature: cr.feature || '', symbols });
    }
  }
  return plans;
}

/** 生成新文件名：跟随采纳簇申领的积木名，落到同目录（同包迁移语义） */
function planNewFile(file: string, feature: string): string {
  const dir = path.posix.dirname(file.replace(/\\/g, '/'));
  const ext = path.extname(file);
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const slug = (feature || '').trim() || '';
  if (slug && slug !== base) return path.posix.join(dir, `${slug}${ext}`);
  return path.posix.join(dir, `${base}__split${ext}`);
}

/** 把采纳信号的 file（相对 source_root）解析成 project_dir 相对路径；无 source_root 时原样 */
function resolvePlanFile(opts: SplitStageOptions, srcFile: string): string {
  if (!opts.source_root) return srcFile;
  return path.posix.join(opts.source_root.replace(/[\\/]+$/, ''), srcFile.replace(/\\/g, '/'));
}

// ─────────────────────────────────────────────
// 拆分执行
// ─────────────────────────────────────────────

/** 执行单个拆分批计划；返回一次拆分结果（复用 derive_split 的写盘+验收+回滚） */
async function runOneSplit(opts: SplitStageOptions, plan: SplitStagePlan): Promise<SplitStageItem> {
  const dryRun = opts.dry_run ?? true;
  const targetRel = resolvePlanFile(opts, plan.file);
  const newFile = planNewFile(targetRel, plan.feature);
  const derivation = await deriveSplit({
    project_dir: opts.project_dir,
    target_file: targetRel,
    symbols: plan.symbols,
    new_file: newFile,
    dry_run: dryRun,
    verify_compile: opts.verify_compile,
    verify_test: opts.verify_test,
    re_export_extracted: opts.re_export_extracted,
  });

  const originalOk = derivation.verification?.original_syntax_ok ?? false;
  const newOk = derivation.verification?.new_syntax_ok ?? false;
  const status: SplitOutcome = derivation.rolled_back
    ? 'rolled_back'
    : !originalOk || !newOk
      ? 'no_change'
      : 'split';
  const note =
    status === 'split'
      ? derivation.verification.compile?.ok === false
        ? '已落盘但编译级验收未通过（见 derivation）'
        : dryRun
          ? '草稿已产出（dry-run）'
          : '已拆分并通过验收'
      : status === 'rolled_back'
        ? `验收失败已回滚：${derivation.message.split('\n').pop()?.trim()}`
        : status === 'no_change'
          ? '草稿语法/符号校验未通过，未采纳'
          : derivation.message.split('\n')[0];

  return {
    file: plan.file,
    feature: plan.feature,
    new_file: derivation.new_file,
    status,
    symbol_count: plan.symbols.length,
    note,
    ...(derivation ? { derivation } : {}),
  };
}

/**
 * 拆分执行器：消费采纳信号，按概念簇切出独立文件。汇总成可读报告。
 */
export async function runSplitStage(opts: SplitStageOptions): Promise<SplitStageResult> {
  const dryRun = opts.dry_run ?? true;

  let plans = opts.plans;
  if (!plans || plans.length === 0) {
    if (!opts.signals || !opts.reviews) {
      return {
        ok: false,
        dry_run: dryRun,
        total_plans: 0,
        total_splits: 0,
        applied: 0,
        items: [],
        message: 'split_stage：既无 plans，也未提供 signals+reviews 供推导，无输入。',
      };
    }
    plans = collectAdoptedPlans(opts.signals, opts.reviews, opts.max_symbols);
  }

  const items: SplitStageItem[] = [];
  for (const plan of plans) {
    items.push(await runOneSplit(opts, plan));
  }
  const applied = items.filter((i) => i.status === 'split').length;

  const lines: string[] = [
    `split_stage：${plans.length} 个采纳簇执行拆分（${dryRun ? 'dry-run，未落盘' : '已落盘'}）`,
    `结果：成功拆分 ${applied}/${plans.length}，回滚 ${items.filter((i) => i.status === 'rolled_back').length}，未采纳 ${items.filter((i) => i.status !== 'split' && i.status !== 'rolled_back').length}`,
    '',
  ];
  for (const it of items) {
    lines.push(`  [${it.status.toUpperCase()}] ${it.file} ／ ${it.symbol_count} 符号 → ${it.new_file}：${it.note}`);
  }
  if (!dryRun) lines.push('', '  dry_run=false，已真实落盘；如需回退请用 git restore 拆分涉及的（原+新）文件。');

  return {
    ok: items.every((i) => i.status === 'split' || i.status === 'skipped'),
    dry_run: dryRun,
    total_plans: plans.length,
    total_splits: items.filter((i) => i.status !== 'skipped').length,
    applied,
    items,
    message: lines.join('\n'),
  };
}