/**
 * taxonomy —— 软件解剖学分类法（自顶向下组织项目的"先验骨架"）
 *
 * 用户定调（2026-08-25）：依赖聚类是"考古"（从遗迹反推结构），人看不懂；
 * 要"造城规划"——先定义好一个软件/工具应该有哪些部分（人话槽位），再把积木
 * 归类进去，从上往下逐层下钻（槽位→积木→簇→文件）。
 *
 * 内置默认：处理流水线解剖（pipeline-v1）——任何工具型软件都套得上的 7 槽位，
 * 与 mock「DSL 协作工作台」的 7 节点（文件扫描器→DSL生成器→…→人工审核台）同构：
 *   intake(输入摄取) → parse(解析转换) → compute(核心运算) → store(状态存储)
 *   → render(呈现输出) → observe(观测质检) → review(人机闭环)
 *
 * 设计纪律：槽位是**封闭集合**（LLM 归类只能从中选，防串）；
 * 分类法定义与代码分离，后续可从 JSON 加载自定义分类法。
 */

export interface TaxonomySlot {
  /** 槽位 id（封闭集合成员，归类输出必须精确匹配） */
  id: string;
  /** 人话名称（≤6 字） */
  label: string;
  /** 干什么（给 LLM 的归类判据，含正/反例边界） */
  desc: string;
  /** 降级启发式：路径/积木名关键词（rule 模式归类用） */
  keywords: string[];
}

export interface Taxonomy {
  id: string;
  label: string;
  desc: string;
  slots: TaxonomySlot[];
}

/** 处理流水线解剖（内置默认）。order = slots 数组顺序（泳道自上而下）。 */
export function defaultPipelineTaxonomy(): Taxonomy {
  return {
    id: 'pipeline-v1',
    label: '处理流水线解剖',
    desc: '从上往下按"一个工具软件从输入到人机闭环该有哪些部分"组织——任何工具型项目通用',
    slots: [
      {
        id: 'intake',
        label: '输入摄取',
        desc: '从磁盘/网络/外部系统读取原始材料（文件扫描、爬取、导入）。判据：消费外部资源，产出原始数据；不包括解析。',
        keywords: ['scan', 'crawl', 'intake', 'fetch', 'import', 'ingest', 'read', 'watch'],
      },
      {
        id: 'parse',
        label: '解析转换',
        desc: '把原始材料变成结构化表示（AST 解析、语法分析、DSL 生成/序列化、格式转换）。判据：输入原始文本/数据，输出结构。',
        keywords: ['parse', 'ast', 'token', 'lex', 'syntax', 'dsl', 'serialize', 'convert', 'schema', 'contract'],
      },
      {
        id: 'compute',
        label: '核心运算',
        desc: '领域核心算法与分析（聚类、推理、规划、生成、重构决策）。判据：吃结构吐结论，是项目存在的理由。',
        keywords: ['compute', 'analysis', 'analyze', 'cluster', 'refactor', 'pipeline', 'reason', 'plan', 'agent', 'detect', 'judge', 'gen', 'graph', 'feature'],
      },
      {
        id: 'store',
        label: '状态存储',
        desc: '数据持久化与状态管理（数据库、缓存、会话、配置存取、后台常驻状态）。判据：管数据的存取与生命周期。',
        keywords: ['db', 'database', 'storage', 'store', 'cache', 'persist', 'session', 'daemon', 'state', 'repo', 'migration'],
      },
      {
        id: 'render',
        label: '呈现输出',
        desc: '面向人的可视化与交付物（HTML 渲染、导出、报告、图表、思维导图）。判据：产出给人看的最终形态。',
        keywords: ['render', 'html', 'export', 'report', 'chart', 'mindmap', 'view', 'ui', 'widget', 'canvas', 'output'],
      },
      {
        id: 'observe',
        label: '观测质检',
        desc: '系统自我观测与质量保障（插桩、埋点、日志、监控、测试、一致性校验）。判据：看系统自己跑得对不对。',
        keywords: ['camera', 'instrument', 'trace', 'log', 'monitor', 'test', 'verify', 'check', 'consistency', 'probe', 'signal'],
      },
      {
        id: 'review',
        label: '人机闭环',
        desc: '人工介入与裁决点（审核台、裁决门、告警收件箱、审批）。判据：把拿不定主意的上抛给人。',
        keywords: ['review', 'alert', 'inbox', 'approval', 'audit', 'feedback', 'escalate', 'notify'],
      },
    ],
  };
}

/** 槽位索引（id → slot）。 */
export function slotIndex(t: Taxonomy): Map<string, TaxonomySlot> {
  return new Map(t.slots.map((s) => [s.id, s]));
}
