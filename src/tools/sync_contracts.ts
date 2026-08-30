/**
 * sync_contracts：以 server_registry 的 zod schema 为唯一事实源，回填 DSL 的 expected_apis。
 *
 * 修复结构性摩擦 D（三份契约漂移：DSL expected_apis / server_registry zod / TS 类型）：
 *   - zod schema（MCP 契约）是唯一源
 *   - 本工具把每个已注册工具的输入契约生成签名 + notes，回填到 DSL semantic.files 的 expected_apis
 *   - 改了 schema 后跑一次 → DSL 契约自动跟上，不再手工对齐
 *
 * 默认（include_all=false）：只更新 DSL 中已存在且 path 匹配 src/tools/{name}.ts 的文件，
 *   不新增节点（契约文件属于文档性质，不在架构图里）。
 * include_all=true：为 DSL 中缺失的工具文件补全契约文件节点（连同 geometry 节点），
 *   用于"新工具接入"时让 DSL 契约一次到位。
 *
 * 语义边界：本工具只回填"签名 + notes（机器生成标记）"；设计侧的决策卡/notes 意图由 LLM 维护。
 * 循环依赖说明：TOOL_DEFS 由 server_registry 导出，本模块仅在函数执行期读取（handler 调用时），
 *   不在模块加载期求值，ESM 循环 import 安全。
 */
import { TOOL_DEFS } from '../server_registry.js';
import { getDSL, saveDSL } from '../storage.js';
import type { DesignDSL } from '../dsl/types.js';

export interface SyncContractsInput {
  /** feature 名（已存在的 DSL feature） */
  feature: string;
  /** 为 DSL 中缺失的工具文件补全契约节点（默认 false：只更新已存在的） */
  include_all?: boolean;
}

export interface SyncContractsResult {
  message: string;
  feature: string;
  added_files: string[];
  updated_files: string[];
  unchanged: number;
}

/** zod v4 内部类型标签（_def.type）→ TS 类型 */
function zodToTs(z: unknown): string {
  const d = (z as { _def?: { type?: string; element?: unknown; valueType?: unknown; entries?: Record<string, unknown>; values?: unknown; options?: unknown[]; innerType?: unknown } } | undefined)?._def;
  switch (d?.type) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'date': return 'Date';
    case 'array': return `${zodToTs(d.element)}[]`;
    case 'record': return `Record<string, ${zodToTs(d.valueType)}>`;
    case 'enum': return `'${Object.keys(d.entries ?? {}).join("' | '")}'`;
    case 'literal': return `'${String(d.values)}'`;
    case 'union': return (d.options ?? []).map(zodToTs).join(' | ') || 'unknown';
    case 'optional':
    case 'default':
    case 'nullable':
      return zodToTs(d.innerType);
    default:
      return 'unknown';
  }
}

function isOptional(z: unknown): boolean {
  const t = (z as { _def?: { type?: string } } | undefined)?._def?.type;
  return t === 'optional' || t === 'default' || t === 'nullable';
}

export function syncContracts(input: SyncContractsInput): SyncContractsResult {
  const dsl = getDSL(input.feature);
  if (!dsl) throw new Error(`feature ${input.feature} 不存在，请先写 DSL 或 import_project`);
  const includeAll = input.include_all ?? false;

  // 自身不写自己（sync_contracts 的契约由 server_registry 的注册本身保证）
  const tools = TOOL_DEFS.filter((t) => t.name !== 'sync_contracts');
  const files = dsl.semantic?.files ?? [];
  const added: string[] = [];
  const updated: string[] = [];
  let unchanged = 0;

  for (const t of tools) {
    const filePath = `src/tools/${t.name}.ts`;
    const params = Object.entries(t.inputSchema)
      .map(([k, z]) => `${k}${isOptional(z) ? '?' : ''}: ${zodToTs(z)}`)
      .join('; ');
    const signature = `${t.name}({ ${params} })`;
    const notes = `MCP 工具契约（sync_contracts 自动回填，事实源=server_registry zod schema；LLM review 后保留/修改）`;

    const existing = files.find((f) => f.path === filePath);
    if (existing) {
      const has = existing.expected_apis?.some((a) => a.signature === signature);
      if (has) {
        unchanged++;
        continue;
      }
      existing.expected_apis = [...(existing.expected_apis ?? []), { signature, notes }];
      updated.push(filePath);
    } else if (includeAll) {
      files.push({
        id: `f_sync_contracts_${t.name}`,
        path: filePath,
        responsibility: `工具契约（sync_contracts 生成）：${t.title}`,
        expected_apis: [{ signature, notes }],
      });
      added.push(filePath);
    }
  }

  let next: DesignDSL = { ...dsl, semantic: { ...(dsl.semantic ?? {}), files } };

  // include_all 时补 geometry 节点（file.id ↔ node.id 对齐），避免契约文件悬空
  if (includeAll && added.length > 0) {
    const nodes = [...(next.geometry?.nodes ?? [])];
    for (const f of files) {
      if (!nodes.some((n) => n.id === f.id)) {
        nodes.push({ id: f.id, x: 0, y: 0, width: 200, height: 60, label: f.path });
      }
    }
    next = { ...next, geometry: { ...(next.geometry ?? { layout: 'free', width: 800, height: 400 }), nodes } };
  }

  saveDSL(next);

  const msg =
    `sync_contracts [${input.feature}]：工具契约与 server_registry 对齐完成。` +
    `新增 ${added.length} 个契约文件（${added.join(', ') || '无'}），` +
    `更新 ${updated.length} 个（${updated.join(', ') || '无'}），未变 ${unchanged}。` +
    (includeAll ? '' : '（未传 include_all，未补全新文件节点；如需让新工具一次到位可传 include_all=true）');
  return { message: msg, feature: input.feature, added_files: added, updated_files: updated, unchanged };
}
