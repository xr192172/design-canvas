/**
 * capability_map —— 能力线导航（方案 A：工具名前缀 + instructions 分层）
 *
 * 为什么需要：MCP 工具集扁平广播，客户端不做两级 UI。40+ 工具一次性铺给 agent，
 * 选择噪音大、易幻觉选错。与其把全部工具塞进一个 mega 入口（schema 膨胀反噬），
 * 不如给一个**纯只读的能力线地图**：agent 不确定用哪个工具前，先调它分层定位，
 * 再进入具体工具；高频工具仍直接可用、无需先经导航。
 *
 * 本模块做三件事：
 *   1. 契约：一条能力线 = { id, label, tools, direct }（direct=true 表示可绕过导航直接调用）。
 *   2. 目录：49 个工具按 6 线归档（design / refactor / observe / harvest / cross / meta）。
 *   3. 查询：无参返回全景；传 lane 只返回该线。
 *
 * 纯数据 + 纯函数：零副作用、无 IO。testable。
 */

export const LANE_IDS = ['design', 'refactor', 'observe', 'harvest', 'cross', 'meta'] as const;
export type LaneId = (typeof LANE_IDS)[number];

export interface LaneTool {
  /** 工具注册名（与 server_registry 一致） */
  name: string;
  /** 何时用它（agent 据此判断该线内的工具选择） */
  when: string;
}

export interface Lane {
  id: LaneId;
  /** 人类可读名（中文，展示用） */
  label: string;
  /** 一句话说明这条线在干什么 */
  desc: string;
  /** 线内工具（全局唯一；同一工具不跨线复用） */
  tools: LaneTool[];
  /** 高频工具：可绕过 capability_map 直接调用 */
  direct: string[];
}

/**
 * 能力线目录（静态事实，改动工具名/新增工具时同步此处。
 * 检索性 read-only，注册仍走 server_registry；此处仅归档导航信息）。
 */
export const LANES: Lane[] = [
  {
    id: 'design',
    label: '设计 / 活文档',
    desc: 'DSL 读写、feature 生命周期、渲染与一致性。',
    direct: ['get_dsl', 'edit_dsl'],
    tools: [
      { name: 'get_dsl', when: '统一只读入口，query 参数查 DSL/features/decisions/simulation_state' },
      { name: 'edit_dsl', when: '统一写入口，operations 批量增删改节点/边/文件/API/binding/status' },
      { name: 'manage_feature', when: 'feature 生命周期：create/clone/template/list/delete' },
      { name: 'render_design', when: '渲染并保存设计图（完整 DSL 模式产物）' },
      { name: 'render_brickwork', when: '渲染积木墙视图' },
      { name: 'scaffold', when: '从设计图 semantic 层生成代码骨架（签名+TODO）' },
      { name: 'backfill_scaffold', when: '写完代码后回填实际 API 签名到 DSL' },
      { name: 'consistency_check', when: '设计 DSL 与代码语义一致性体检' },
      { name: 'detect_drift', when: '检测 DSL 与代码语义漂移' },
      { name: 'import_project', when: '扫描代码项目生成 DSL（文件节点+调用边+符号语义层）' },
    ],
  },
  {
    id: 'refactor',
    label: '重构 / 改名',
    desc: '确定性改造：符号改名、文件移动、引用联动、影响面。',
    direct: ['rename_symbols', 'rename_files', 'find_references'],
    tools: [
      { name: 'rename_symbols', when: '符号改名（跨文件联动，dry_run 预览后落盘）' },
      { name: 'rename_files', when: '批量文件改名（dry_run 计算影响面，原子阻断）' },
      { name: 'rename_many', when: '批量符号改名' },
      { name: 'edit_code', when: '符号级替换（文件+函数+新函数体，AST 定位）' },
      { name: 'find_references', when: '查某符号的引用点/外部导入者（影响面前置）' },
      { name: 'impact_analysis', when: '计算一次改动的变更点/风险面' },
      { name: 'remove_dead_imports', when: '清理未使用 import' },
      { name: 'refactor_pipeline', when: '整条重构流水线（预览→执行→校验闭环）' },
      { name: 'suggest_renames', when: '生成改名建议（就近相似名/命名规范）' },
      { name: 'find_similar_names', when: '找相似命名（撞名/歧义排查）' },
      { name: 'refactor_judge', when: '重构后裁判：校验是否符合契约/无回归' },
      { name: 'diff_views', when: '多视图/多版本差异对比' },
    ],
  },
  {
    id: 'observe',
    label: '观测 / 验证',
    desc: '运行时插桩、行为基线、测试与契约对账（执行类，按需触发）。',
    direct: [],
    tools: [
      { name: 'observe_log', when: '读运行日志/观测产物' },
      { name: 'observe_judge', when: '对观测结果做判定' },
      { name: 'observe_instrument', when: '源码插桩探针（dry_run 可预览）' },
      { name: 'narrate_step', when: '把某一步观测过程叙述成可读记录' },
      { name: 'behavior_baseline', when: '编译语言行为基线（跑函数用例出返回值）' },
      { name: 'run_tests', when: '运行测试并汇总结果' },
      { name: 'reconcile_chain', when: '沿效应链逐级对账契约' },
      { name: 'reconcile_effects', when: '对账函数/模块的实际效应与契约' },
    ],
  },
  {
    id: 'harvest',
    label: '契约 / 闭包采集',
    desc: '从文档/git/注释/闭包采集决策卡与契约，出箱与积木配方。',
    direct: [],
    tools: [
      { name: 'harvest_decisions', when: '从 docs/git log/注释粗提决策卡候选' },
      { name: 'harvest_closure', when: '扫描闭包出产入盒三件套' },
      { name: 'harvest_from_url', when: '从 URL 采集决策/契约' },
      { name: 'extract_contracts', when: '从代码提取契约（多语言 AST）' },
      { name: 'sync_contracts', when: '以 server_registry zod schema 回填 DSL expected_apis' },
      { name: 'reconcile_brick', when: '对账单个积木与契约' },
      { name: 'search_bricks', when: '检索积木配方' },
      { name: 'assemble_bricks', when: '组装多个积木成新积木' },
      { name: 'slim_brick', when: '给积木瘦身（收窄职责）' },
    ],
  },
  {
    id: 'cross',
    label: '跨仓 / 杂交 / 健康',
    desc: '重量级分析：跨仓符号索引、仓库杂交预检、代码健康度。',
    direct: [],
    tools: [
      { name: 'cross_repo_symbol_index', when: '跨仓库符号索引建立/反查' },
      { name: 'hybrid_precheck', when: '仓库杂交前预检（依赖/符号连通性）' },
      { name: 'code_health', when: '代码健康度扫描（含 unused_import 多语言）' },
    ],
  },
  {
    id: 'meta',
    label: '元信息 / 探索',
    desc: '代码理解入口、诊断、画布笔记、归档与网关说明。',
    direct: ['explore_code'],
    tools: [
      { name: 'explore_code', when: '代码理解统一入口（search/check_monolith/run_simulation/watch）' },
      { name: 'diagnose', when: '诊断能力缺口（多语言矩阵）' },
      { name: 'canvas_notes', when: '画布人审标注的读取/渲染' },
      { name: 'archive_node', when: '下线库归档 + 合并记录' },
      { name: 'list_archive', when: '列下线库归档条目' },
      { name: 'gateway_provider', when: 'LLM 网关供应商/Key 池说明与状态' },
      { name: 'read_project_docs', when: '读项目文档（README/活文档）' },
    ],
  },
];

const laneIndex = new Map(LANE_IDS.map((id) => [id, LANES.find((l) => l.id === id)!]));

/** 取某能力线（未知 id 返回 undefined） */
export function getLane(id: string): Lane | undefined {
  return laneIndex.get(id as LaneId);
}

/** 校验：工具名全局唯一、不跨线重复（防目录漂移） */
export function validateLanes(): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  for (const lane of LANES) {
    for (const t of lane.tools) {
      if (seen.has(t.name)) {
        errors.push(`工具 ${t.name} 同时属于 ${seen.get(t.name)} 与 ${lane.id}`);
      }
      seen.set(t.name, lane.id);
    }
    const badDirect = lane.direct.filter((d) => !lane.tools.some((t) => t.name === d));
    if (badDirect.length) errors.push(`线 ${lane.id} 的 direct 引用不存在于线内：${badDirect.join(',')}`);
  }
  return errors;
}

/** 渲染一条能力线成文本（laneIds=空 表示全部） */
export function renderLaneText(laneIds: readonly LaneId[]): string {
  const ids = laneIds.length ? laneIds : (LANE_IDS as readonly LaneId[]);
  const lines: string[] = [];
  for (const id of ids) {
    const lane = laneIndex.get(id);
    if (!lane) continue;
    lines.push(`\n◆ ${lane.id} · ${lane.label} —— ${lane.desc}`);
    lines.push(`  直接可用（无需导航）：${lane.direct.length ? lane.direct.join(', ') : '（无）'}`);
    for (const t of lane.tools) {
      const mark = lane.direct.includes(t.name) ? '·' : ' ';
      lines.push(`    ${mark} ${t.name} —— ${t.when}`);
    }
  }
  return lines.join('\n');
}

export interface CapabilityMapInput {
  lane?: LaneId;
}

/** MCP 工具 handler：只读导航，无副作用 */
export async function capabilityMapHandler(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const lane = args.lane as LaneId | undefined;
  const header =
    'design-canvas 能力线导航：先看线再看工具，高频工具可绕过本导航直接调用。' +
    '\n前缀语义：observe_=观测、harvest_=采集、reconcile_=对账、rename_=改名、edit_=修改、render_=渲染。';
  if (lane) {
    const l = getLane(lane);
    if (!l) {
      return { text: `未知能力线 "${lane}"。可选：${LANE_IDS.join(' / ')}。`, isError: true };
    }
    return { text: `${header}${renderLaneText([lane])}`.trim() };
  }
  return { text: `${header}${renderLaneText([])}`.trim() };
}