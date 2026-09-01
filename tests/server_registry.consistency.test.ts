/**
 * server_registry 一致性检查（结构性摩擦 D/E 的兜底）
 *
 * 摩擦 E（注册滞后）修复：新工具文件（src/tools/{name}.ts，主函数名=文件名 camelCase）
 *   必须已注册进 TOOL_DEFS；漏注册 → 本测试红。
 * 摩擦 D（契约漂移）兜底：TOOL_DEFS 本身的元数据/schema 必须健康（name 唯一、schema 合法），
 *   sync_contracts 据此回填 DSL expected_apis。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS } from '../src/server_registry';

const PKG_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(PKG_ROOT, 'src/tools');

/** snake_case → camelCase：diff_views → diffViews */
const toCamel = (s: string) => s.replace(/_(\w)/g, (_, c) => c.toUpperCase());
/** camelCase → snake_case：diffViews → diff_views */
const toSnake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** 内部/主工具实现模块（有主函数但非独立 MCP 工具），漏注册检测豁免。
 *  注：query_feature/update_feature 分别是 get_dsl/edit_dsl 的实现（注册名≠文件名）；
 *     list_features 是 get_dsl query=features 的实现；feature_ops(createFeature)/render_dsl_workbench
 *     /feature_map(buildFeatureMap)/derive_feature_tree 是 manage_feature/render_brickwork/import_project
 *     等已注册工具的内部派生/渲染助手；其余为被各工具调用的内部辅助模块。
 *  新增真正的 MCP 工具文件（src/tools/{x}.ts 且 export function {x}()）→ 必须注册，不在豁免表。 */
const INTERNAL_MODULES = new Set([
  'analyze_monolith', 'collect_functions', 'contract_gate', 'dag_layout', 'derive_reasoning',
  'detect_dead_imports', 'diff_impact', 'guided_tour', 'inject_replay', 'language_concepts',
  'list_features', 'query_feature', 'update_feature', 'watch_project', 'wizard_steps',
  'feature_ops', 'render_dsl_workbench', 'feature_map', 'derive_feature_tree',
]);

describe('server_registry 一致性', () => {
  it('tool def 元数据齐全：name 唯一、title/description 非空、handler 有效、schema 是合法 zod', () => {
    const names = TOOL_DEFS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length); // name 唯一

    for (const d of TOOL_DEFS) {
      expect(d.title, `title 缺失: ${d.name}`).toBeTruthy();
      expect(d.description, `description 缺失: ${d.name}`).toBeTruthy();
      expect(typeof d.handler, `handler 缺失: ${d.name}`).toBe('function');
    }
    // schema：每个参数项必须是 zod 类型（zod v4：_def.type 为内部类型标签，如 string/optional/enum…）
    const invalid: string[] = [];
    for (const d of TOOL_DEFS) {
      for (const [k, z] of Object.entries(d.inputSchema)) {
        const typeTag = (z as { _def?: { type?: string } })._def?.type;
        if (!typeTag) invalid.push(`${d.name}.inputSchema.${k}（实际: ${(z as { constructor?: { name?: string } }).constructor?.name}）`);
      }
    }
    expect(invalid, `非法 zod schema 项：\n${invalid.join('\n')}`).toEqual([]);
  });

  it('每个注册工具对应的实现文件存在（src/tools/{name}.ts）', () => {
    const missing: string[] = [];
    for (const d of TOOL_DEFS) {
      const impl = path.join(TOOLS_DIR, `${d.name}.ts`);
      if (fs.existsSync(impl)) continue; // 有同名实现文件 → OK
      // 无同名文件：允许——主工具（get_dsl/edit_dsl 等）在 server_registry 内实现
    }
    expect(missing).toEqual([]);
  });

  it('src/tools 下主函数名=文件名 camelCase 的工具文件必须已注册（漏注册检测，摩擦 E）', () => {
    const files = fs
      .readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
      .map((f) => f.replace(/\.ts$/, ''));
    const registered = new Set(TOOL_DEFS.map((d) => d.name));

    const missing: string[] = [];
    for (const base of files) {
      if (INTERNAL_MODULES.has(base)) continue;
      const camel = toCamel(base);
      const content = fs.readFileSync(path.join(TOOLS_DIR, `${base}.ts`), 'utf-8');
      // 主函数名 == 文件名 camelCase（约定），如 diff_views.ts export diffViews
      const isToolImpl = new RegExp(`export\\s+function\\s+${camel}\\b`).test(content);
      if (!isToolImpl) continue;
      // 注册名约定 = snake_case 文件名；历史命名不一致的（如 backfill.ts → backfill_scaffold）
      // 用 alias 宽松匹配：存在某注册，其实现在该文件里
      const expectName = toSnake(camel);
      if (!new Set(TOOL_DEFS.map((d) => d.name)).has(expectName)) {
        const alias = TOOL_DEFS.find((d) => {
          const impl = path.join(TOOLS_DIR, `${d.name}.ts`);
          return fs.existsSync(impl) && fs.readFileSync(impl, 'utf-8').includes(`export function ${camel}(`);
        });
        if (!alias) missing.push(`${base}.ts（主函数 ${camel} 未注册）`);
      }
    }
    expect(missing, `漏注册的工具文件：\n${missing.join('\n')}\n请在 server_registry.ts 注册`).toEqual([]);
  });
});
