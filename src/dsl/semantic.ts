/**
 * 语义层类型：文件/API/模板/scaffold 配置
 */

import type { DiagramStatus } from './geometry.js';
import type { BrickContract } from './contract.js';

/** 预期 API */
export interface ExpectedApi {
  /** 函数签名，如 "User.Login() (token string, err error)" */
  signature: string;
  /** 函数起始行号（import_project 扫描时填充，LLM 拿到后直接 read 定位） */
  line?: number;
  /** 函数结束行号（含闭合括号，为 LLM 提供完整函数范围） */
  end_line?: number;
  notes?: string;
  /** notes 英文版（i18n：API 说明切换英文时用） */
  notes_en?: string;
}

/** 符号条目：常量/类型/变量/类/接口/结构体声明（非函数方法类，用于行号定位） */
export interface Symbol {
  /** 符号名，如 "MaxRetries"、"UserService" */
  name: string;
  /** 符号类型 */
  kind: 'const' | 'type' | 'var' | 'struct' | 'interface' | 'class' | 'function' | 'method';
  /** 起始行号 */
  line: number;
  /** 结束行号（含闭合括号，为 LLM 提供完整函数/类型范围） */
  end_line?: number;
  /** 签名（声明文本），如 "interface UserService"、"MAX_RETRIES = 3" */
  signature?: string;
}

/** 语义层文件 */
export interface SemanticFile {
  /** 与 geometry.nodes.id 对应 */
  id: string;
  /** 目标文件相对路径 */
  path: string;
  /** 职责描述 */
  responsibility: string;
  /** 职责描述英文版（i18n） */
  responsibility_en?: string;
  expected_apis?: ExpectedApi[];
  /** 预期依赖路径列表 */
  expected_deps?: string[];
  /** 预期行为描述 */
  expected_behavior?: string;
  /** 文件实现状态：draft=待实现, in_progress=实现中, done=已完成 */
  status?: DiagramStatus;
  /** 从实际代码中解析出的已实现 API（代码回填时自动填充） */
  actual_apis?: ExpectedApi[];
  /** 符号表：常量/类型/变量/类/接口/结构体声明（非函数方法类），含行号，供 LLM 定位代码 */
  symbols?: Symbol[];
  /** 文件行数（import_project 扫描时填充，供单文件化预警/星图 tooltip 从 DSL 读取） */
  lines?: number;
  /** 架构层 id（序号5：architecture-analyzer 按路径启发式推断，如 api/service/data/ui） */
  layer?: string;
  /** 积木契约（Phase 2 契约提取填充；缺省 = 契约未提取） */
  contract?: BrickContract;
}

/** 代码模板配置 */
export interface CodeTemplate {
  /** 模板 ID */
  id: string;
  /** 模板名称 */
  name: string;
  /** 目标语言：go/ts/py/js/vue/react */
  lang: string;
  /** 模板内容（支持占位符：{{package}}, {{imports}}, {{apis}}, {{behavior}}, {{node_id}}, {{node_label}}） */
  template: string;
  /** 文件扩展名 */
  ext: string;
}

/** scaffold 配置 */
export interface ScaffoldConfig {
  /** 自定义模板列表 */
  templates?: CodeTemplate[];
  /** 是否生成注释标记（默认 true） */
  markers?: boolean;
  /** 是否从节点内容生成 UI 骨架（默认 false） */
  generate_ui_skeleton?: boolean;
  /** UI 骨架类型：vue/react/html */
  ui_framework?: 'vue' | 'react' | 'html';
}

/** 语义层 */
export interface Semantic {
  files: SemanticFile[];
  /** 不变式规则（自然语言 + 可选代码引用），design_check 会验证 */
  multi_file_invariants?: string[];
  expected_global_behavior?: string[];
  /** scaffold 代码生成配置 */
  scaffold?: ScaffoldConfig;
}