/**
 * diagnosis 契约层：诊断工具的输入 / 输出类型定义（积木层外露的"插头"）
 *
 * 定位：从"症状"（报错 / 测试失败 / 行为描述）到"根因 + 证据链 + 影响面 + 修改建议 + 验证方式"。
 * 双引擎：规则层永远先跑（定位 + 证据 + 影响面，纯代码可完成）；
 *         LLM 层可选（把证据转成人话根因与修改建议），无配置自动降级。
 */

export type SymptomType = 'error' | 'test_failure' | 'behavior' | 'auto';

export interface DiagnoseInput {
  /** 被诊断项目的根目录（其下 .design-canvas/cache.db 是符号索引） */
  project_dir: string;
  /** 症状：报错信息 / stack trace / 测试失败输出 / 行为异常描述 */
  symptom: string;
  /** 症状类型，默认 auto（自动识别） */
  symptom_type?: SymptomType;
  /** 可选：用户已知的线索（文件路径 / 函数名），帮助聚焦 */
  anchor?: string;
  /** 调用链追溯深度，默认 3 */
  max_depth?: number;
  /** 是否启用 LLM 增强（默认 true；false=只走规则引擎，无网络调用） */
  use_llm?: boolean;
}

/** 症状解析结果（积木层第一步的确定性产物） */
export interface SymptomParsed {
  /** 识别出的错误类型（TypeError / Cannot find module / panic …，未识别为空） */
  error_type?: string;
  /** 从报错里直接提取的 文件:行 位置 */
  locations: Array<{ file: string; line?: number }>;
  /** 提取的候选符号名（标识符 / 限定名） */
  symbols: string[];
  /** 兜底关键词（去停用词后的分词，供语义检索） */
  keywords: string[];
}

/** 候选定位命中（积木层第二步） */
export interface Candidate {
  symbol: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  kind: string;
  /** 0-1 相似度/相关度 */
  score: number;
  source: 'exact' | 'fts' | 'vector' | 'file' | 'anchor';
}

/** 证据链中的一步 */
export interface EvidenceStep {
  step: number;
  type: 'error_parse' | 'symbol_hit' | 'call_chain' | 'type_ref' | 'import' | 'source' | 'llm' | 'rule';
  text: string;
}

/** 根因结论 */
export interface RootCause {
  /** 相对项目根的 posix 路径 */
  file_path: string;
  line?: number;
  symbol?: string;
  /** error_direct=报错行直接命中 / caller=调用方侧 / callee=被调方侧 / type_ref=类型引用 / inferred=推断 */
  kind: 'error_direct' | 'caller' | 'callee' | 'type_ref' | 'inferred';
  /** 0-1 置信度 */
  confidence: number;
  reasoning: string;
  /** 根因附近的源码片段（限长，喂给 LLM / 展示用） */
  source_snippet?: string;
}

/** 影响面 */
export interface Impact {
  affected_files: Array<{ path: string; reason: string; depth: number; direct: boolean }>;
  affected_symbols: Array<{ name: string; file_path: string; start_line: number; via_edge?: string }>;
  /** 波及符号撞上 DSL 语义层 API（设计契约被变更波及，优先复核） */
  dsl_contract_hits: string[];
}

/** 修改建议 */
export interface FixSuggestion {
  target_file: string;
  target_line?: number;
  action: 'modify' | 'add' | 'remove' | 'verify' | 'inspect';
  description: string;
  rationale: string;
}

/** 验证方式（只给建议，不自动执行） */
export interface Verification {
  type: 'test' | 'typecheck' | 'build' | 'camera' | 'rerun' | 'manual';
  command_hint: string;
}

export interface DiagnoseOutput {
  summary: string;
  /** 本次实际采用的引擎 */
  engine: 'rule' | 'llm' | 'hybrid';
  symptom_parsed: SymptomParsed;
  candidates: Candidate[];
  root_cause?: RootCause;
  evidence_chain: EvidenceStep[];
  impact: Impact;
  fix_suggestions: FixSuggestion[];
  verification: Verification[];
  /** 诚实边界：哪些是推测、哪些没查到 */
  limitations: string[];
}
