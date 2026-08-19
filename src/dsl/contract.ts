/**
 * 积木契约类型（Brick Harvest Phase 2）
 *
 * 设计依据：docs/plans/2026-08-19-cross-project-brick-harvest.md Phase 2.5 草案。
 * 三条主线映射：
 *   - role：业务/功能二分（依赖方向图算法判定，LLM 兜底）
 *   - shapes：数据形状（复用判定单元——形状匹配 = 可复用）
 *   - effects：时空可组合性验收单元（空间=reversible 清单；时间=emits 事件流）
 *
 * 提取来源纪律：结构化字段（shapes/effects）只接受 AST 与 camera 两个可信源；
 * LLM 结论只进 role.reasons / notes——LLM 不产生事实。
 */

/** 形状字段 */
export interface ShapeField {
  name: string;
  /** 归一化类型串（"string"、"*ContextGraph"、"(int, error)"） */
  type: string;
  required?: boolean;
}

/** 数据形状（结构化类型匹配的判定单元） */
export interface ShapeSchema {
  /** 形状名，如 "ContextGraph"、"HubClient" */
  name: string;
  kind: 'struct' | 'interface' | 'type' | 'class';
  /** Go interface 的"字段"是方法签名（name=方法名，type=完整签名） */
  fields: ShapeField[];
  /** 提取来源：ast=符号索引+源码解析 / runtime=camera 观测 / llm=推断（当前仅 ast） */
  origin: 'ast' | 'runtime' | 'llm';
  notes?: string;
}

/** effect 目标（拔积木时需回收的东西） */
export interface EffectTarget {
  /** 全局名/单例名/文件路径/env key */
  target: string;
  op: 'write' | 'append' | 'delete' | 'acquire' | 'release';
  /** 回收方式（拔积木时怎么撤销）；缺省 = 不可逆，匹配时标红 */
  reversible?: string;
  /**
   * 来源标记：ast=静态扫描候选（camera 观测前是"疑似"，可能有误报）；
   * runtime=camera 实测确认（观测窗口内真实发生过）。
   * 升格规则：camera 观测到同 target 的写 → 候选转正；观测到候选外的 → 契约不完整告警。
   */
  origin?: 'ast' | 'runtime';
}

/** 文件角色判定（业务/功能二分，DDD 核心域 vs 支撑域） */
export interface BrickRole {
  class: 'business' | 'functional' | 'hybrid';
  /** 判定依据：graph=依赖方向算法 / runtime=camera 证据 / llm=语义 / mixed */
  basis: 'graph' | 'runtime' | 'llm' | 'mixed';
  /** 0-1；< 0.7 时 Phase 3 检索降权。静态判定（无 runtime 证据）封顶 0.7 */
  confidence: number;
  /** 人话依据（如"依赖箭头全部指向 util 层"、"cmd 入口"） */
  reasons?: string[];
}

/** 文件级积木契约（挂 SemanticFile.contract） */
export interface BrickContract {
  schema_version: 1;
  role: BrickRole;
  /** 本文件暴露/消费的数据形状 */
  shapes: {
    exposes: ShapeSchema[];
    consumes: ShapeSchema[];
  };
  /** effects 清单（空间可组合性验收单元） */
  effects: {
    /** 写哪些外部状态（全局 var/单例字段/文件系统）——静态提取范围外，camera 补 */
    writes: EffectTarget[];
    /** 占用哪些资源（端口/goroutine/连接池/句柄）——camera 补 */
    holds: EffectTarget[];
    /** 发出哪些事件（时间可组合性通道）——camera 补 */
    emits: string[];
    /** 读哪些配置项/env（积木"出厂环境要求"，AST 提取） */
    reads_config: string[];
  };
  /** 运行证据（camera 事件流累积；静态提取阶段为空） */
  runtime?: {
    /** 观测窗口内调用次数（0 = 纯静态判定，confidence 上限 0.7） */
    call_count: number;
    /** 实测高频调用方（校验静态依赖图，发现图上看不到的隐式调用） */
    top_callers: string[];
    /** 实测读过的 config key / 写过的 target——校验 effects 清单真实性 */
    observed_targets: string[];
    last_seen?: string;
  };
  /** 外来积木溯源（本项目内为空） */
  provenance?: {
    source_project?: string;
    commit?: string;
    harvested_at?: string;
  };
}
