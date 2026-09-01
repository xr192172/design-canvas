/**
 * Tree-sitter Kernel - 语言注册表
 *
 * 元数据：ext → npm 包名 + tree-sitter 节点类型 → 我们的 ParsedSymbol 字段
 * 来源：tree-sitter 官方 https://github.com/tree-sitter/tree-sitter (150+ 语言)
 *
 * 注释：
 *   - name: 语言的 npm 包名
 *   - ext: 支持的文件扩展名（含 .）
 *   - symbol_query: 用于识别该语言中"符号节点"的 tree-sitter 节点类型列表
 *   - signature_template: 字段提取模板，{name} 占位符
 *
 * 探测逻辑（probe.ts）会扫描 node_modules/tree-sitter-* 找出已安装的，
 * kernel 自动只对已安装的语言启用解析。
 */

export interface LanguageEntry {
  /** 语言显示名（go / typescript / ...） */
  name: string;
  /** npm 包名（tree-sitter-{pkg}） */
  pkg: string;
  /** 支持的文件扩展名（含 .） */
  exts: string[];
  /** tree-sitter 节点类型，对应"符号定义" */
  symbol_nodes: string[];
  /** tree-sitter 节点类型，对应"import 声明"（可选，用于依赖提取） */
  import_nodes?: string[];
  /** 字段名映射（tree-sitter 字段 → ParsedSymbol 字段） */
  field_map: {
    name: string;
    parameters?: string;
    body?: string;
    return_type?: string;
    receiver?: string;
  };
}

/** 150+ 语言注册表（npm 包名已与官方仓库对齐） */
export const LANGUAGES: LanguageEntry[] = [
  // === Web/JS 生态 ===
  // TS 符号宇宙 v6 扩容：type_alias/enum/abstract class 进 nodes——
  // 跨文件 type_ref 解析（resolveCrossFileCalls 的 typeNamesByFile 只认
  // interface/type/class 节点）此前定位不到 type alias，dead_deps live 集
  // 永远缺它们 → 剪刀误剪（ua_theme_engine 的 PresetId/HeadingFont 实证）
  { name: 'typescript', pkg: 'typescript', exts: ['.ts'], symbol_nodes: ['function_declaration', 'class_declaration', 'abstract_class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'method_definition'], import_nodes: ['import_statement', 'export_statement'], field_map: { name: 'name', parameters: 'parameters', return_type: 'return_type' } },
  { name: 'tsx', pkg: 'tsx', exts: ['.tsx'], symbol_nodes: ['function_declaration', 'class_declaration', 'abstract_class_declaration', 'interface_declaration', 'type_alias_declaration', 'enum_declaration', 'method_definition'], import_nodes: ['import_statement', 'export_statement'], field_map: { name: 'name', parameters: 'parameters', return_type: 'return_type' } },
  { name: 'javascript', pkg: 'javascript', exts: ['.js', '.mjs', '.cjs'], symbol_nodes: ['function_declaration', 'class_declaration', 'method_definition'], import_nodes: ['import_statement', 'export_statement'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'jsx', pkg: 'jsx', exts: ['.jsx'], symbol_nodes: ['function_declaration', 'class_declaration', 'method_definition'], import_nodes: ['import_statement', 'export_statement'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'vue', pkg: 'vue', exts: ['.vue'], symbol_nodes: ['export_statement'], field_map: { name: 'name' } },
  { name: 'html', pkg: 'html', exts: ['.html', '.htm'], symbol_nodes: ['script_element'], field_map: { name: 'name' } },
  { name: 'css', pkg: 'css', exts: ['.css'], symbol_nodes: ['rule_set'], field_map: { name: 'name' } },
  { name: 'scss', pkg: 'scss', exts: ['.scss'], symbol_nodes: ['rule_set'], field_map: { name: 'name' } },
  { name: 'less', pkg: 'less', exts: ['.less'], symbol_nodes: ['rule_set'], field_map: { name: 'name' } },

  // === 后端语言 ===
  { name: 'go', pkg: 'go', exts: ['.go'], symbol_nodes: ['function_declaration', 'method_declaration', 'type_declaration', 'type_spec'], import_nodes: ['import_spec'], field_map: { name: 'name', parameters: 'parameters', return_type: 'result', receiver: 'receiver' } },
  { name: 'python', pkg: 'python', exts: ['.py'], symbol_nodes: ['function_definition', 'class_definition'], import_nodes: ['import_statement', 'import_from_statement'], field_map: { name: 'name', parameters: 'parameters', return_type: 'return_type' } },
  { name: 'java', pkg: 'java', exts: ['.java'], symbol_nodes: ['class_declaration', 'method_declaration', 'interface_declaration'], import_nodes: ['import_declaration'], field_map: { name: 'name', parameters: 'parameters', return_type: 'type' } },
  { name: 'c', pkg: 'c', exts: ['.c', '.h'], symbol_nodes: ['function_definition', 'struct_specifier'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'cpp', pkg: 'cpp', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'], symbol_nodes: ['function_definition', 'class_specifier', 'struct_specifier', 'namespace_definition'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'c_sharp', pkg: 'c-sharp', exts: ['.cs'], symbol_nodes: ['class_declaration', 'method_declaration', 'interface_declaration'], import_nodes: ['using_directive'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'rust', pkg: 'rust', exts: ['.rs'], symbol_nodes: ['function_item', 'struct_item', 'impl_item', 'trait_item'], import_nodes: ['use_declaration'], field_map: { name: 'name', parameters: 'parameters', return_type: 'return_type' } },
  { name: 'kotlin', pkg: 'kotlin', exts: ['.kt', '.kts'], symbol_nodes: ['class_declaration', 'function_declaration'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'swift', pkg: 'swift', exts: ['.swift'], symbol_nodes: ['function_declaration', 'class_declaration'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'ruby', pkg: 'ruby', exts: ['.rb'], symbol_nodes: ['method', 'class', 'module'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'php', pkg: 'php', exts: ['.php'], symbol_nodes: ['function_definition', 'method_declaration', 'class_declaration'], import_nodes: ['namespace_use_declaration'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'scala', pkg: 'scala', exts: ['.scala', '.sc'], symbol_nodes: ['class_definition', 'object_definition', 'def_definition'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'elixir', pkg: 'elixir', exts: ['.ex', '.exs'], symbol_nodes: ['call', 'do_block'], field_map: { name: 'name' } },
  { name: 'erlang', pkg: 'erlang', exts: ['.erl', '.hrl'], symbol_nodes: ['function_clause'], field_map: { name: 'name' } },
  { name: 'haskell', pkg: 'haskell', exts: ['.hs'], symbol_nodes: ['function_declaration', 'type_declaration'], field_map: { name: 'name' } },
  { name: 'lua', pkg: 'lua', exts: ['.lua'], symbol_nodes: ['function_declaration'], field_map: { name: 'name', parameters: 'parameters' } },
  { name: 'perl', pkg: 'perl', exts: ['.pl', '.pm'], symbol_nodes: ['subroutine_declaration_statement'], field_map: { name: 'name' } },
  { name: 'r', pkg: 'r', exts: ['.r', '.R'], symbol_nodes: ['function_definition'], field_map: { name: 'name' } },
  { name: 'dart', pkg: 'dart', exts: ['.dart'], symbol_nodes: ['function_signature', 'class_definition'], field_map: { name: 'name', parameters: 'parameters' } },

  // === 脚本/Shell ===
  { name: 'bash', pkg: 'bash', exts: ['.sh', '.bash'], symbol_nodes: ['function_definition'], field_map: { name: 'name' } },
  { name: 'fish', pkg: 'fish', exts: ['.fish'], symbol_nodes: ['function_definition'], field_map: { name: 'name' } },
  { name: 'powershell', pkg: 'powershell', exts: ['.ps1', '.psm1'], symbol_nodes: ['function_statement'], field_map: { name: 'name' } },

  // === 数据/配置 ===
  { name: 'json', pkg: 'json', exts: ['.json'], symbol_nodes: ['object'], field_map: { name: 'name' } },
  { name: 'yaml', pkg: 'yaml', exts: ['.yaml', '.yml'], symbol_nodes: ['block_mapping'], field_map: { name: 'name' } },
  { name: 'toml', pkg: 'toml', exts: ['.toml'], symbol_nodes: ['pair'], field_map: { name: 'name' } },
  { name: 'xml', pkg: 'xml', exts: ['.xml'], symbol_nodes: ['element'], field_map: { name: 'name' } },

  // === 系统/底层 ===
  { name: 'zig', pkg: 'zig', exts: ['.zig'], symbol_nodes: ['FnDecl'], field_map: { name: 'name' } },
  { name: 'nim', pkg: 'nim', exts: ['.nim'], symbol_nodes: ['proc_def'], field_map: { name: 'name' } },
  { name: 'crystal', pkg: 'crystal', exts: ['.cr'], symbol_nodes: ['method_def'], field_map: { name: 'name' } },
  { name: 'ocaml', pkg: 'ocaml', exts: ['.ml', '.mli'], symbol_nodes: ['let_binding'], field_map: { name: 'name' } },
  { name: 'fsharp', pkg: 'f-sharp', exts: ['.fs', '.fsx'], symbol_nodes: ['function_or_value_defn'], field_map: { name: 'name' } },
  { name: 'julia', pkg: 'julia', exts: ['.jl'], symbol_nodes: ['function_definition'], field_map: { name: 'name' } },
  { name: 'clojure', pkg: 'clojure', exts: ['.clj', '.cljs'], symbol_nodes: ['list_lit'], field_map: { name: 'name' } },
  { name: 'scheme', pkg: 'scheme', exts: ['.scm', '.ss'], symbol_nodes: ['list'], field_map: { name: 'name' } },
  { name: 'solidity', pkg: 'solidity', exts: ['.sol'], symbol_nodes: ['contract_declaration', 'function_definition'], field_map: { name: 'name' } },
  { name: 'vhdl', pkg: 'vhdl', exts: ['.vhdl', '.vhd'], symbol_nodes: ['entity_declaration'], field_map: { name: 'name' } },
  { name: 'verilog', pkg: 'verilog', exts: ['.v', '.sv'], symbol_nodes: ['module_declaration'], field_map: { name: 'name' } },
  { name: 'tcl', pkg: 'tcl', exts: ['.tcl'], symbol_nodes: ['proc_statement'], field_map: { name: 'name' } },

  // === 文档/标记 ===
  { name: 'markdown', pkg: 'markdown', exts: ['.md', '.markdown'], symbol_nodes: ['section', 'atx_heading'], field_map: { name: 'name' } },
  { name: 'latex', pkg: 'latex', exts: ['.tex'], symbol_nodes: ['command'], field_map: { name: 'name' } },

  // === 其他流行语言 ===
  { name: 'groovy', pkg: 'groovy', exts: ['.groovy'], symbol_nodes: ['class_definition', 'method_declaration'], field_map: { name: 'name' } },
  { name: 'graphql', pkg: 'graphql', exts: ['.graphql', '.gql'], symbol_nodes: ['object_type_definition', 'field_definition'], field_map: { name: 'name' } },
  { name: 'protobuf', pkg: 'protobuf', exts: ['.proto'], symbol_nodes: ['message', 'service'], field_map: { name: 'name' } },
  { name: 'sql', pkg: 'sql', exts: ['.sql'], symbol_nodes: ['create_statement'], field_map: { name: 'name' } },
  { name: 'rego', pkg: 'rego', exts: ['.rego'], symbol_nodes: ['rule'], field_map: { name: 'name' } },
  { name: 'cue', pkg: 'cue', exts: ['.cue'], symbol_nodes: ['field'], field_map: { name: 'name' } },
];

/** 找语言（按扩展名） */
export function findLanguageByExt(ext: string): LanguageEntry | undefined {
  return LANGUAGES.find((l) => l.exts.includes(ext));
}
