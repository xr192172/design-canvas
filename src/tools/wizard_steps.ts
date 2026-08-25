/**
 * wizard_steps —— 新功能向导七步定义（用户三层组织模型的可执行化）
 *
 * 用户定调（2026-08-25）：新加功能 = "自己新写核心功能，再在外面套契约层，
 * 再接入胶水层"（积木→契约→胶水），最后自主反馈到 DSL，闭环完成。
 * 本模块把这条链定义成七步向导，每步背后都是**已存在的真实工具**（MCP 注册表
 * 里逐个核对过），前端先行、调用后补。
 *
 * 七步（对应 mock 工作台的七节点视觉）：
 *   1 定义功能(flow) → 2 实现核心(brick) → 3 外露契约(contract) → 4 胶水接线(glue)
 *   → 5 采集回填(flow) → 6 DSL登记(store) → 7 验证闭环(review)
 *
 * 忠实纪律：tool.name 必须是注册表里真实存在的功能名；kind 如实标注入口形态；
 * 人要做的步骤标 'human'，不假装全自动。
 */

export type WizardRole = 'brick' | 'contract' | 'glue' | 'flow' | 'store' | 'review';

export interface WizardTool {
  /** 功能名（统一功能注册面里的真实名字） */
  name: string;
  kind: 'mcp' | 'cli' | 'human';
  /** 这一步用这个工具干什么（一句话） */
  note: string;
}

export interface WizardStep {
  id: string;
  no: number;
  /** 人话标题（≤6字） */
  label: string;
  /** 干什么（给用户看） */
  desc: string;
  role: WizardRole;
  tools: WizardTool[];
  input: string;
  output: string;
  /** 完成标志（验收判据） */
  doneWhen: string;
}

/** 向导步骤清单（确定性定义，工具名与注册表核对）。 */
export function wizardSteps(): WizardStep[] {
  return [
    {
      id: 'define',
      no: 1,
      label: '定义功能',
      desc: '用一句话说清新功能干什么、放进哪个积木。向导据此生成三层骨架（积木/契约/胶水三套文件占位）。',
      role: 'flow',
      tools: [
        { name: 'scaffold', kind: 'mcp', note: '从 DSL 生成模块骨架——积木/契约/胶水三层文件占位' },
        { name: 'edit_dsl', kind: 'mcp', note: '把新功能节点和边先登记进设计（草稿态）' },
      ],
      input: '功能名 + 一句话描述 + 目标积木',
      output: '三层骨架文件 + DSL 草稿节点',
      doneWhen: '骨架文件落盘，DSL 里能看到 draft 状态的新功能节点',
    },
    {
      id: 'core',
      no: 2,
      label: '实现核心',
      desc: '积木层：只写业务逻辑，不碰入口、不外露类型。像雕一块能独立存在的积木。',
      role: 'brick',
      tools: [
        { name: 'edit_code', kind: 'mcp', note: 'LLM 在骨架的积木层文件里写核心实现' },
      ],
      input: '骨架积木层文件 + 需求描述',
      output: '可独立测试的核心函数/模块',
      doneWhen: '核心逻辑有单测且通过，不依赖任何入口文件',
    },
    {
      id: 'contract',
      no: 3,
      label: '外露契约',
      desc: '契约层：把核心的类型/接口抽成"插头"——别的积木只认插头不认内脏。',
      role: 'contract',
      tools: [
        { name: 'extract_contracts', kind: 'mcp', note: '从核心实现抽取类型/接口成契约文件' },
      ],
      input: '核心实现代码',
      output: '契约文件（类型/接口/DTO）',
      doneWhen: '外部引用只 import 契约文件，不 import 实现内部',
    },
    {
      id: 'glue',
      no: 4,
      label: '胶水接线',
      desc: '胶水层：注册路由/入口/工具表——把积木接进系统，功能从此可达。',
      role: 'glue',
      tools: [
        { name: 'edit_code', kind: 'mcp', note: '在胶水层文件里接线（注册/路由/装配）' },
        { name: 'human', kind: 'human', note: '接线方案需要人拍板（放哪个入口、什么参数）' },
      ],
      input: '契约插头 + 系统接线图',
      output: '功能可被调用（MCP/CLI/路由至少一种形态）',
      doneWhen: '从入口能调通新功能，返回符合契约的结果',
    },
    {
      id: 'harvest',
      no: 5,
      label: '采集回填',
      desc: '把实际写的代码采回设计——expected_apis 对齐 actual，设计不再是空想。',
      role: 'flow',
      tools: [
        { name: 'harvest_closure', kind: 'mcp', note: '采集实现闭包（种子→依赖→外部）回设计' },
        { name: 'backfill_scaffold', kind: 'mcp', note: '回填骨架：设计里的占位长成真文件' },
      ],
      input: '新写的代码',
      output: '设计的 expected_apis = 实际 actual_apis',
      doneWhen: '一致性检查不再报"设计与实现不符"',
    },
    {
      id: 'register',
      no: 6,
      label: 'DSL 登记',
      desc: '功能正式进 DSL：节点定稿、依赖边落库、决策卡记录"为什么这么做"。',
      role: 'store',
      tools: [
        { name: 'edit_dsl', kind: 'mcp', note: 'draft 节点转正式，写边和决策卡' },
      ],
      input: '对齐后的设计',
      output: 'DSL 里的正式功能节点 + 依赖边 + 决策卡',
      doneWhen: '功能地图/解剖图重新生成后自动多出这个功能',
    },
    {
      id: 'verify',
      no: 7,
      label: '验证闭环',
      desc: '插桩自测 + 一致性 + LLM 审——拿不准的上抛给人，闭环收口。',
      role: 'review',
      tools: [
        { name: 'camera_instrument', kind: 'mcp', note: '给新代码插桩，跑一遍留证据' },
        { name: 'consistency_check', kind: 'mcp', note: '设计 vs 实现一致性校验' },
        { name: 'refactor_judge', kind: 'mcp', note: 'LLM 裁决门：拿不准的问题上抛人审（双入口）' },
      ],
      input: '登记后的 DSL + 代码',
      output: '绿点通过，或人审收件箱里的问题清单',
      doneWhen: 'camera 判通过 + 无一致性红项 + 无未决上抛',
    },
  ];
}

export const ROLE_LABEL: Record<WizardRole, string> = {
  brick: '积木',
  contract: '契约',
  glue: '胶水',
  flow: '流程',
  store: '登记',
  review: '闭环',
};
