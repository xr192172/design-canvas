/**
 * collect_functions —— 统一功能注册面（MCP 工具 + CLI 命令合并）
 *
 * 用户定调：功能有 MCP 独占 / CLI 独占 / 双入口三种暴露形态。闭环（新功能 →
 * 模块 → DSL）的第一块基石是**完整且分形态的功能清单**——少了任何一半，
 * "这个项目能干什么"就是残缺的。
 *
 * 合并规则（确定性）：
 *   - CLI 名去 _cli 后缀 = MCP 工具名 → 合并为双入口（both）
 *   - 其余各自独立（mcp_only / cli_only）
 *
 * 每个功能条目带：暴露形态徽章 + 两边各自的描述/参数 + 合并后的实现模块连线。
 */

import type { RegistryTool } from './registry_extract.js';
import type { CliCommand } from './cli_extract.js';

export type EntryKind = 'mcp_only' | 'cli_only' | 'both';

export interface FunctionEntry {
  /** 规范名（MCP 名或 CLI 名） */
  name: string;
  kind: EntryKind;
  /** MCP 侧信息（有则填） */
  mcp?: { title: string; description: string };
  /** CLI 侧信息（有则填） */
  cli?: { file: string; desc: string; usage: string };
  /** 描述（双入口取 MCP 的，CLI 独占用 CLI 头注释） */
  desc: string;
  /** 首句（卡片短版） */
  summarySource: string;
  /** 合并的实现模块（去重） */
  implModules: string[];
}

export interface FunctionRegistry {
  entries: FunctionEntry[];
  meta: { mcp: number; cli: number; both: number; mcp_only: number; cli_only: number };
}

/** MCP 工具 + CLI 命令 → 统一功能条目（确定性合并）。 */
export function collectFunctions(tools: RegistryTool[], commands: CliCommand[]): FunctionRegistry {
  const mcpByName = new Map(tools.map((t) => [t.name, t]));
  const cliByName = new Map(commands.map((c) => [c.name, c]));
  const names = [...new Set([...mcpByName.keys(), ...cliByName.keys()])].sort();

  const entries: FunctionEntry[] = [];
  for (const name of names) {
    const mcp = mcpByName.get(name);
    const cli = cliByName.get(name);
    const kind: EntryKind = mcp && cli ? 'both' : mcp ? 'mcp_only' : 'cli_only';
    const desc = mcp?.description ?? cli?.desc ?? '';
    const implModules = [...new Set([...(mcp?.implModules ?? []), ...(cli?.implModules ?? [])])];
    entries.push({
      name,
      kind,
      mcp: mcp ? { title: mcp.title, description: mcp.description } : undefined,
      cli: cli ? { file: cli.file, desc: cli.desc, usage: cli.usage } : undefined,
      desc,
      summarySource: (desc.split(/[。；;]/)[0] || '').trim(),
      implModules,
    });
  }

  return {
    entries,
    meta: {
      mcp: tools.length,
      cli: commands.length,
      both: entries.filter((e) => e.kind === 'both').length,
      mcp_only: entries.filter((e) => e.kind === 'mcp_only').length,
      cli_only: entries.filter((e) => e.kind === 'cli_only').length,
    },
  };
}
