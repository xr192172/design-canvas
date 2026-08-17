/**
 * design-canvas 符号缓存 schema（v2）
 *
 * 以 vendor/codegraph/src/db/schema.sql 为底裁剪改造：
 *   - 保留：nodes / edges / files / unresolved_refs / schema_versions / project_metadata
 *   - 保留：FTS5 全文索引 + 三触发器（ai/ad/au）——索引可随时 rebuild，
 *     但 docstring/signature 等被索引列必须第一天占住（后补列 = 全量重跑提取）
 *   - 改造：分词器 unicode61 → trigram。unicode61 把整段中文当一个 token
 *     （中文搜索全废）且不拆 camelCase；trigram 中文子串 + 标识符子串通吃，
 *     千级文件规模索引体积可接受
 *   - 暂缓：name_segment_vocab（序号 8 语义搜索再加；它是派生物化表，随时可重建）
 *   - v2：+imports 表（原始 import 记录，import_project 缓存路径的数据源）
 *   - v3：nodes.sym_hash（符号 span 归一化 hash）+ symbol_diffs 表（sync 时新旧对比，
 *     记录每个文件"真正改动了哪些符号"——符号级影响分析的数据源）
 *   - v4：files.norm_hash + symbol_diffs.norm_from/norm_to（文件级归一化全文 hash）。
 *     符号提取不含顶层 const/赋值表达式——常量值变更（FLAG=true→false）符号级零差异，
 *     曾被误判"无实质变更"漏掉 import 层波及。norm_hash 补第二道判定：符号无差异
 *     且全文归一化无差异才是纯注释/格式；norm 变了 → 符号外实质变更，按文件级波及
 *
 * 节点 id 约定：
 *   - 文件节点：id = 相对项目根的 posix 路径（如 "src/tools/serve.ts"），kind='file'
 *   - 符号节点：id = "<file>#<qualified_name>"（文件内重名时追加 ":L<start_line>"）
 *
 * 生命周期约定（symbols.ts 依赖，勿破坏）：
 *   - 文件节点【只 UPSERT 不 DELETE】（INSERT OR IGNORE 建桩 / ON CONFLICT 更新），
 *     保证指向它的 import 边不因重同步被 ON DELETE CASCADE 带走；
 *     仅当文件从项目删除时才经 removeFile 删除（此时级联清边是期望行为）
 *   - 符号节点：按 file_path 整批删除重插（其上的调用边由序号 3 重新推导，级联可接受）
 *   - import 边：按 source 文件整批删除重插（出边跟随源文件同步）
 */

export const SCHEMA_SQL = `
-- schema 版本追踪（迁移机制从第一版就占位）
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- 节点：文件节点 + 符号节点（函数/类/接口/类型/方法）
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    parent TEXT,
    signature TEXT,
    docstring TEXT,          -- 预留：kernel 暂未提取，列先占住
    sym_hash TEXT,           -- v3：符号 span 归一化 hash（去注释/空白）——符号级 diff 依据
    updated_at INTEGER NOT NULL
);

-- 边：节点间关系（import / call / contains ...）
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    line INTEGER,
    col INTEGER,
    metadata TEXT,           -- JSON object
    provenance TEXT DEFAULT NULL,  -- 预留：序号 3 合成边标记
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- 文件：索引状态与内容 hash（增量跳过的依据）
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT,             -- JSON array
    norm_hash TEXT           -- v4：全文归一化 hash（剔注释行+去空白）——符号外变更判定依据
);

-- 原始 import 记录（v2）：import_project 缓存读取路径的数据源。
-- edges 表只存【已解析的相对导入】边；Go 包路径 / Python 点分模块的原始
-- source 串只留在这里，缺了它缓存路径会静默丢包导入依赖边。
-- 生命周期：随 syncFile 按 file_path 整批重插；removeFile 时清除。
-- 故意不挂 FK：files 行用 INSERT OR REPLACE 重写（REPLACE = DELETE+INSERT），
-- ON DELETE CASCADE 会在同事务内把刚写入的 imports 带走。
CREATE TABLE IF NOT EXISTS imports (
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    source TEXT NOT NULL,
    kind TEXT NOT NULL       -- 'relative' | 'package'（与 ts_kernel ParsedImport.kind 一致）
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_path);

-- 符号级变更记录（v3）：syncFile 重插符号前对比新旧 sym_hash，把"这个文件真正
-- 改动了哪些符号"落成一行（按 file_path 最新一份，链式合并——同一文件连续多次
-- 编辑未消费时累积成 vA→vNow 的净差异）。diffImpact 据此把波及源从"整文件所有
-- 符号"收敛到"真正改动的符号"，改注释/格式不再虚报波及。
-- 首次导入不写行（无旧版可比），diffImpact 对该文件回退文件级。
CREATE TABLE IF NOT EXISTS symbol_diffs (
    file_path TEXT PRIMARY KEY,
    from_hash TEXT NOT NULL,       -- 对比起点文件 content_hash
    to_hash TEXT NOT NULL,         -- 对比终点文件 content_hash（= 当前 files.content_hash）
    added TEXT NOT NULL,           -- JSON array：新增符号 qualified_name
    removed TEXT NOT NULL,         -- JSON array：删除符号 qualified_name
    changed TEXT NOT NULL,         -- JSON array：实质变更符号 qualified_name（span hash 变）
    norm_from TEXT NOT NULL DEFAULT '',  -- v4：起点全文归一化 hash（''=未知，保守视为已变）
    norm_to TEXT NOT NULL DEFAULT '',    -- v4：终点全文归一化 hash；norm_from≠norm_to = 符号外实质变更
    updated_at INTEGER NOT NULL
);

-- 未决引用：序号 3 调用边提取的解析暂存（先占位，生命周期见 CodeGraph 同名表注释）
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT,
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'pending',
    name_tail TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);

-- FTS5 全文索引（trigram：中文子串 + camelCase 子串）+ 触发器同步
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

-- 边身份唯一：(source,target,kind,line,col)；IFNULL 折叠 NULL，否则 INSERT OR IGNORE
-- 对 NULL 不生效会产生重复边（CodeGraph #1034 踩过的坑，直接继承修复）
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_identity
  ON edges(source, target, kind, IFNULL(line, -1), IFNULL(col, -1));

CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_status ON unresolved_refs(status);
CREATE INDEX IF NOT EXISTS idx_unresolved_failed_tail ON unresolved_refs(name_tail) WHERE status = 'failed';

-- 项目级元数据（索引器版本、最近全量时间等）
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
`;
