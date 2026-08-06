// semantic_search 冒烟验证 S1：对 design-canvas 自身符号库做语义搜索
// 用法：npm run build && node scripts/semantic_search_smoke.mjs
// embedding 配置：优先 EMBEDDING_* 环境变量，其次 config.json 的 embedding 段。
//   （硅基流动 BAAI/bge-m3，见 d:\project_develop\ai-base\agent-shell\.env 的 AGENTSHELL_EMBEDDING_*）
import path from 'node:path';
import { importProject } from '../dist/src/tools/import_project.js';
import { semanticSearch, embeddingCacheStats } from '../dist/src/tools/semantic_search.js';
import { openDb, closeAllProjectCacheDbs } from '../dist/src/db/db.js';

const ROOT = process.cwd();
const CACHE = path.join(ROOT, '.design-canvas', 'cache.db');

// 1. 确保符号缓存存在（空则建）
const db0 = openDb(CACHE);
const n = db0.prepare("SELECT COUNT(*) c FROM nodes WHERE kind != 'file'").get().c;
db0.close();
if (n === 0) {
  const imp = await importProject({ project_dir: ROOT, feature: 'smoke_sem', cache_db: openDb(CACHE) });
  console.log(`[build-cache] files=${imp.files_parsed} symbols=${imp.symbols_found} dep_edges=${imp.dep_edges}`);
} else {
  console.log(`[cache] 已有 ${n} 个符号，直接复用`);
}

// 2. 语义搜索若干问题（验证「抽象语义描述 → 具体符号」的检索能力）
const questions = [
  '审批一个设计变更',
  '数据库查询与读写缓存',
  '把 DSL 渲染成 HTML',
  '解析源代码提取符号',
  '撤销一个审批',
  '保存设计图到磁盘',
];

for (const q of questions) {
  console.log(`\n########## 查询：${q} ##########`);
  const r = await semanticSearch({ project_dir: ROOT, query: q, limit: 6 });
  console.log(`[provider] ${r.provider}  索引=${r.indexed}  消息=${r.message}`);
  for (const h of r.hits) {
    console.log(`  ${h.score.toFixed(3)}  ${h.file_path}  ${h.qualified_name}  (${h.kind})`);
  }
}

// 3. 缓存复用验证：符号向量已全量入缓存，重复搜索相同查询应只多 1 次 API 调用（query 侧）
const before = embeddingCacheStats();
await semanticSearch({ project_dir: ROOT, query: questions[0], limit: 6 });
await semanticSearch({ project_dir: ROOT, query: questions[0], limit: 6 });
const after = embeddingCacheStats();
console.log(`\n[cache] 缓存条数=${after.cache_size} 命中=${after.cache_hits} API调用=${after.api_calls}`);
console.log(`[cache] 两次重复查询新增 API 调用 = ${after.api_calls - before.api_calls}（应为 0，符号+query 均已缓存）`);

closeAllProjectCacheDbs();