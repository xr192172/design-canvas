/**
 * capability_map —— 能力线导航（目录由工具注册表自动派生，人工只维护「归属标注」）
 *
 * 为什么需要：MCP 工具集扁平广播，客户端不做两级 UI。60 个工具一次性铺给 agent，
 * 选择噪音大、易幻觉选错。与其把全部工具塞进一个 mega 入口（schema 膨胀反噬），
 * 不如给一个**纯只读的能力线地图**：agent 不确定用哪个工具前，先调它分层定位，
 * 再进入具体工具；高频工具仍直接可用、无需先经导航。
 *
 * ★ 单一真相源（2026-09-14 改造，此前是手工同步的静态表 → 必然漂移）：
 *   - 工具集合 = server_registry 的 TOOL_DEFS（真实注册，唯一权威）；本模块**不自己维护工具清单**。
 *   - 归属标注 = 本文件的 LANE_OF（工具 → 线，可选 when 覆盖）+ LANE_META（线元信息）。
 *   - when 缺省由注册描述**自动摘要**（首句，≤60 字）→ 新增工具只要写一行 lane 归属即可露面。
 *
 * 漂移防护（三重，均为"看得见"而非静默）：
 *   1. 已注册但没归属的工具 → 输出单列「未归线」段，导航仍能看见它（不再静默消失）；
 *   2. LANE_OF 写了但注册表没有 → validateLanes 报「陈旧标注」；
 *   3. tests/server_registry.lanes + tests/tools/capability_map 对**真实 TOOL_DEFS** 断言
 *      （旧测试自带一份手抄的 55 工具清单，等于第三份副本，已删）。
 *
 * 装配：server_registry 用 makeCapabilityMapHandler(() => TOOL_DEFS) 注入目录
 *   —— 本模块**不 import 注册表**，避免 server_registry ⇄ capability_map 循环 import。
 *
 * 纯数据 + 纯函数（目录取自入参，无 IO）：testable。
 */

export const LANE_IDS = ['design', 'refactor', 'observe', 'harvest', 'cross', 'meta'] as const;
export type LaneId = (typeof LANE_IDS)[number];

/** 工具目录项：注册表里能拿到的元信息（只取派生日录需要的字段） */
export interface ToolCatalogEntry {
  name: string;
  title?: string;
  description?: string;
}

export interface LaneTool {
  /** 工具注册名（与 server_registry TOOL_DEFS 一致） */
  name: string;
  /** 何时用它（agent 据此判断该线内的工具选择） */
  when: string;
  /** when 来源：curated=人工撰写 / derived=注册描述自动摘要（待补） */
  whenSource: 'curated' | 'derived';
}

export interface Lane {
  id: LaneId;
  /** 人类可读名（中文，展示用） */
  label: string;
  /** 一句话说明这条线在干什么 */
  desc: string;
  /** 线内工具（由注册表派生；同一工具不跨线复用） */
  tools: LaneTool[];
  /** 高频工具：可绕过 capability_map 直接调用 */
  direct: string[];
}

/** 工具 → 线归属标注（★ 人工唯一入口）。when 省略 = 由注册描述自动摘要。 */
export interface LaneAssign {
  lane: LaneId;
  /** 需要人工语义时才写（导航价值高于注册描述时） */
  when?: string;
}

/** 线元信息（静态：线 id / 展示名 / 说明 / 直接可用白名单）。 */
export const LANE_META: ReadonlyArray<Omit<Lane, 'tools'>> = [
  {
    id: 'design',
    label: '设计 / 活文档',
    desc: 'DSL 读写、feature 生命周期、渲染与一致性。',
    direct: ['get_dsl', 'edit_dsl'],
  },
  {
    id: 'refactor',
    label: '重构 / 改名',
    desc: '确定性改造：符号改名、文件移动、引用联动、影响面。',
    direct: ['rename_symbols', 'rename_files', 'find_references'],
  },
  {
    id: 'observe',
    label: '观测 / 验证',
    desc: '运行时插桩、行为基线、测试与契约对账（执行类，按需触发）。',
    direct: [],
  },
  {
    id: 'harvest',
    label: '契约 / 闭包采集',
    desc: '从文档/git/注释/闭包采集决策卡与契约，出箱与积木配方。',
    direct: [],
  },
  {
    id: 'cross',
    label: '跨仓 / 杂交 / 健康',
    desc: '重量级分析：跨仓符号索引、仓库杂交预检、代码健康度、跨语言翻译（Go→TS）。',
    direct: [],
  },
  {
    id: 'meta',
    label: '元信息 / 探索',
    desc: '代码理解入口、诊断、画布笔记、归档与网关说明。',
    direct: ['explore_code'],
  },
];

/**
 * ★ 工具归属标注（人工唯一需要维护的地方）。
 *   新增工具：在 server_registry 注册后，在下面加一行 `{ lane: '...' }` 即可；
 *   忘了加不会静默丢失 —— 会在 capability_map 输出的「未归线」段出现，且测试红。
 */
export const LANE_OF: Readonly<Record<string, LaneAssign>> = {
  // ── design · 设计 / 活文档 ──
  get_dsl: { lane: 'design', when: '统一只读入口，query 参数查 DSL/features/decisions/simulation_state' },
  edit_dsl: { lane: 'design', when: '统一写入口，operations 批量增删改节点/边/文件/API/binding/status' },
  manage_feature: { lane: 'design', when: 'feature 生命周期：create/clone/template/list/delete' },
  render_design: { lane: 'design', when: '渲染并保存设计图（完整 DSL 模式产物）' },
  render_brickwork: { lane: 'design', when: '渲染积木墙视图' },
  scaffold: { lane: 'design', when: '从设计图 semantic 层生成代码骨架（签名+TODO）' },
  backfill_scaffold: { lane: 'design', when: '写完代码后回填实际 API 签名到 DSL' },
  consistency_check: { lane: 'design', when: '设计 DSL 与代码语义一致性体检' },
  detect_drift: { lane: 'design', when: '检测 DSL 与代码语义漂移' },
  import_project: { lane: 'design', when: '扫描代码项目生成 DSL（文件节点+调用边+符号语义层）' },
  set_design_intent: { lane: 'design', when: '写设计意图到 overlay：goals（结构化目标/方向）+ edge_intents（A 为何依赖 B / 边界归属），LLM 开发时的意图写入口' },
  propose_design_intent: { lane: 'design', when: 'LLM 代拟「设计意图(why)改写」审批卡：propose 只算 diff 不写盘，人在工作台 approve 后才落 DSL' },
  // ── refactor · 重构 / 改名 ──
  rename_symbols: { lane: 'refactor', when: '符号改名（跨文件联动，dry_run 预览后落盘）' },
  rename_files: { lane: 'refactor', when: '批量文件改名（dry_run 计算影响面，原子阻断）' },
  rename_many: { lane: 'refactor', when: '批量符号改名' },
  move_symbol: { lane: 'refactor', when: '跨文件移动模块级符号（自动重定向 importer 的 import 源，只改 source 不动使用点）' },
  edit_code: { lane: 'refactor', when: '符号级替换（文件+函数+新函数体，AST 定位）' },
  find_references: { lane: 'refactor', when: '查某符号的引用点/外部导入者（影响面前置）' },
  impact_analysis: { lane: 'refactor', when: '计算一次改动的变更点/风险面' },
  remove_dead_imports: { lane: 'refactor', when: '清理未使用 import' },
  refactor_pipeline: { lane: 'refactor', when: '整条重构流水线（预览→执行→校验闭环）' },
  annotate_functions: { lane: 'refactor', when: '函数语义注释（TS/JS + Go）：扫覆盖→缺失用 LLM 补→@fnhash body 指纹同步过期；可配进 refactor_pipeline 的 function_annotation 步' },
  suggest_renames: { lane: 'refactor', when: '生成改名建议（就近相似名/命名规范）；混淆/压缩代码的短名还原可读也走这里——建议先由格式化梳理结构，再经 rename_symbols 应用，意图复原留人/LLM' },
  find_similar_names: { lane: 'refactor', when: '找相似命名（撞名/歧义排查）' },
  refactor_judge: { lane: 'refactor', when: '重构后裁判：校验是否符合契约/无回归' },
  diff_views: { lane: 'refactor', when: '多视图/多版本差异对比' },
  // ── observe · 观测 / 验证 ──
  observe_log: { lane: 'observe', when: '读运行日志/观测产物' },
  observe_judge: { lane: 'observe', when: '对观测结果做判定' },
  observe_instrument: { lane: 'observe', when: '源码插桩探针（dry_run 可预览）' },
  observe_trace: { lane: 'observe', when: '读录制调用链回放：从 events.jsonl 重建结构化调用树（纯后端，LLM 分析用）' },
  feature_line: { lane: 'observe', when: '功能线：每个功能搭一条主链（功能→入口→调用节点），供沿线单步运行/投大屏点位' },
  narrate_step: { lane: 'observe', when: '把某一步观测过程叙述成可读记录' },
  behavior_baseline: { lane: 'observe', when: '编译语言行为基线（跑函数用例出返回值）' },
  run_tests: { lane: 'observe', when: '运行测试并汇总结果' },
  reconcile_chain: { lane: 'observe', when: '沿效应链逐级对账契约' },
  reconcile_effects: { lane: 'observe', when: '对账函数/模块的实际效应与契约' },
  memory_targets: { lane: 'observe', when: '列出本机带 --inspect 的 node 进程（含 DSH gen），供 memory_observe 选 target' },
  memory_observe: { lane: 'observe', when: '外部进程内存观测（CDP 外连，不插目标进程）：status/baseline/track/gc，定位 JS 堆 vs native 泄漏方向' },
  // ── harvest · 契约 / 闭包采集 ──
  harvest_decisions: { lane: 'harvest', when: '从 docs/git log/注释粗提决策卡候选' },
  harvest_closure: { lane: 'harvest', when: '扫描闭包出产入盒三件套' },
  harvest_from_url: { lane: 'harvest', when: '从 URL 采集决策/契约' },
  extract_contracts: { lane: 'harvest', when: '从代码提取契约（多语言 AST）' },
  sync_contracts: { lane: 'harvest', when: '以 server_registry zod schema 回填 DSL expected_apis' },
  reconcile_brick: { lane: 'harvest', when: '对账单个积木与契约' },
  search_bricks: { lane: 'harvest', when: '检索积木配方' },
  assemble_bricks: { lane: 'harvest', when: '组装多个积木成新积木' },
  slim_brick: { lane: 'harvest', when: '给积木瘦身（收窄职责）' },
  // ── cross · 跨仓 / 杂交 / 健康 ──
  cross_repo_symbol_index: { lane: 'cross', when: '跨仓库符号索引建立/反查' },
  hybrid_precheck: { lane: 'cross', when: '仓库杂交前预检（依赖/符号连通性）' },
  code_health: { lane: 'cross', when: '代码健康度扫描（含 unused_import 多语言）' },
  translate_go_ts: { lane: 'cross', when: '跨语言翻译：Go→TS 半自动（机械骨架+验证闸；fill 用 LLM 逐孔填；verify 跑行为对拍）' },
  go_originals: { lane: 'cross', when: '读 Go 源文件顶层符号原文（ground truth）：翻译/评审时对照 Go 原文，不对着 TS 壳猜' },
  // ── meta · 元信息 / 探索 ──
  explore_code: { lane: 'meta', when: '代码理解统一入口（search/check_monolith/run_simulation/watch）' },
  diagnose: { lane: 'meta', when: '诊断能力缺口（多语言矩阵）' },
  canvas_notes: { lane: 'meta', when: '画布人审标注的读取/渲染' },
  archive_node: { lane: 'meta', when: '下线库归档 + 合并记录' },
  list_archive: { lane: 'meta', when: '列下线库归档条目' },
  gateway_provider: { lane: 'meta', when: 'LLM 网关供应商/Key 池说明与状态' },
  read_project_docs: { lane: 'meta', when: '读项目文档（README/活文档）' },
  capability_map: { lane: 'meta', when: '本工具：能力线导航（目录由注册表 TOOL_DEFS 自动派生）' },
};

// ─────────────────────────────────────────────────────────────
// 派生（纯函数）
// ─────────────────────────────────────────────────────────────

export interface BuiltLanes {
  lanes: Lane[];
  /** 已注册但没归属的工具（导航可见，测试红） */
  unassigned: ToolCatalogEntry[];
  /** LANE_OF 有、注册表没有的工具（陈旧标注） */
  stale: string[];
}

/**
 * 由注册目录派生能力线。**迭代顺序 = 注册表顺序**（不再人工排序，消除第二处手抄）。
 * when 缺省走 describeForNav（注册描述首句）。
 * @param assign 归属标注表（默认 LANE_OF；测试可注入自定义表以验证派生路径）
 */
export function buildLanes(
  catalog: readonly ToolCatalogEntry[],
  assign: Readonly<Record<string, LaneAssign>> = LANE_OF,
): BuiltLanes {
  const lanes: Lane[] = LANE_META.map((m) => ({ ...m, tools: [] }));
  const byId = new Map(lanes.map((l) => [l.id as string, l]));
  const unassigned: ToolCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const t of catalog) {
    if (!t?.name || seen.has(t.name)) continue;
    seen.add(t.name);
    const a = assign[t.name];
    if (!a) {
      unassigned.push(t);
      continue;
    }
    const lane = byId.get(a.lane);
    if (!lane) {
      unassigned.push(t);
      continue;
    }
    lane.tools.push({
      name: t.name,
      when: a.when ?? describeForNav(t),
      whenSource: a.when ? 'curated' : 'derived',
    });
  }

  const stale = Object.keys(assign).filter((n) => !seen.has(n)).sort();
  return { lanes, unassigned, stale };
}

/** 导航用短描述：注册描述首句（截 60 字），空则退回标题/工具名。 */
export function describeForNav(t: ToolCatalogEntry, max = 60): string {
  const raw = (t.description ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return t.title?.trim() || t.name;
  const m = raw.match(/^[\s\S]*?[。.；;]/);
  let s = (m ? m[0] : raw).trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/** 校验（对真实注册表断言用）：返回错误列表，空 = 目录与注册表一致。 */
export function validateLanes(
  catalog: readonly ToolCatalogEntry[],
  assign: Readonly<Record<string, LaneAssign>> = LANE_OF,
): string[] {
  const errors: string[] = [];
  const { lanes, unassigned, stale } = buildLanes(catalog, assign);

  for (const t of unassigned) {
    errors.push(`已注册但未归线：${t.name}（在 capability_map 的 LANE_OF 里补一条归属）`);
  }
  if (stale.length) {
    errors.push(`LANE_OF 里的陈旧标注（注册表已无此工具）：${stale.join(', ')}`);
  }
  for (const lane of lanes) {
    const names = new Set(lane.tools.map((t) => t.name));
    const bad = lane.direct.filter((d) => !names.has(d));
    if (bad.length) errors.push(`线 ${lane.id} 的 direct 引用了线外/不存在的工具：${bad.join(', ')}`);
  }
  return errors;
}

/** 维护视图（不进 agent 输出）：哪些 when 还是自动摘要、哪些没归线。 */
export function laneMaintenanceReport(
  catalog: readonly ToolCatalogEntry[],
  assign: Readonly<Record<string, LaneAssign>> = LANE_OF,
): {
  derived: string[];
  curated: number;
  unassigned: string[];
  stale: string[];
} {
  const { lanes, unassigned, stale } = buildLanes(catalog, assign);
  const derived: string[] = [];
  let curated = 0;
  for (const lane of lanes) {
    for (const t of lane.tools) {
      if (t.whenSource === 'derived') derived.push(t.name);
      else curated += 1;
    }
  }
  return { derived, curated, unassigned: unassigned.map((t) => t.name), stale };
}

// ─────────────────────────────────────────────────────────────
// 渲染
// ─────────────────────────────────────────────────────────────

/** 渲染若干能力线成文本（laneIds=空 表示全部） */
export function renderLaneText(lanes: readonly Lane[], laneIds: readonly LaneId[] = []): string {
  const want = new Set(laneIds.length ? laneIds : (LANE_IDS as readonly LaneId[]));
  const lines: string[] = [];
  for (const lane of lanes) {
    if (!want.has(lane.id)) continue;
    lines.push(`\n◆ ${lane.id} · ${lane.label} —— ${lane.desc}`);
    lines.push(`  直接可用（无需导航）：${lane.direct.length ? lane.direct.join(', ') : '（无）'}`);
    for (const t of lane.tools) {
      const mark = lane.direct.includes(t.name) ? '·' : ' ';
      lines.push(`    ${mark} ${t.name} —— ${t.when}`);
    }
  }
  return lines.join('\n');
}

/** 未归线工具段：宁可在导航里显式暴露，也不静默消失（旧版就是这样漏掉 4 个工具的）。 */
export function renderUnassigned(unassigned: readonly ToolCatalogEntry[]): string {
  if (!unassigned.length) return '';
  const lines = [`\n⚠ 未归线工具（${unassigned.length}）—— 尚未纳入任何能力线，按需直接调用：`];
  for (const t of unassigned) lines.push(`      ${t.name} —— ${describeForNav(t)}`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// MCP handler
// ─────────────────────────────────────────────────────────────

export interface CapabilityMapInput {
  lane?: LaneId;
}

/**
 * handler 工厂：目录由 server_registry 注入（避免循环 import）。
 * @param getCatalog 取真实注册目录（如 () => TOOL_DEFS）
 */
export function makeCapabilityMapHandler(getCatalog: () => readonly ToolCatalogEntry[]) {
  return async function capabilityMapHandler(
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }> {
    const { lanes, unassigned } = buildLanes(getCatalog());
    const lane = args.lane as LaneId | undefined;
    const toolCount = lanes.reduce((n, l) => n + l.tools.length, 0) + unassigned.length;
    const header =
      `design-canvas 能力线导航：先看线再看工具，高频工具可绕过本导航直接调用。` +
      `\n目录由工具注册表自动派生（${toolCount} 工具 / ${LANE_IDS.length} 线），与注册表同源、不会脱节。` +
      `\n前缀语义：observe_=观测、harvest_=采集、reconcile_=对账、rename_=改名、edit_=修改、render_=渲染。`;

    if (lane) {
      if (!LANE_IDS.includes(lane)) {
        return { text: `未知能力线 "${lane}"。可选：${LANE_IDS.join(' / ')}。`, isError: true };
      }
      return { text: `${header}${renderLaneText(lanes, [lane])}`.trim() };
    }
    return { text: `${header}${renderLaneText(lanes)}${renderUnassigned(unassigned)}`.trim() };
  };
}
