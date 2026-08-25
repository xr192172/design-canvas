/**
 * registry_extract —— MCP 工具注册表提取器（功能清单的确定性真相层）
 *
 * 用户定调（2026-08-25）：解剖槽位是先验拍脑袋，真正的"功能清单"是 MCP 工具
 * 注册表——对外承诺的权威能力面（31 个工具），且注册描述本来就是人话。
 * 文件考古回答"怎么实现的"，工具注册表回答"能干什么"——功能中心应从工具出发。
 *
 * 本模块纯确定性（零 LLM）：
 *   - 解析 server_registry.ts 的 TOOL_DEFS：name / title / description
 *     （description 是多段单引号串拼接，抓引号串重组）
 *   - 解析文件顶部相对 import：symbol → 模块映射
 *   - 每个工具条目块 + 命名 handler 的定义体里扫描 import 符号 →
 *     "工具触达哪些实现模块"的确定性连线（后续映射到积木簇）
 *
 * 不做猜测：模块匹配不到积木文件时如实上报（unmatched），不硬塞。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface RegistryTool {
  name: string;
  title: string;
  /** 完整注册描述（人话，原样） */
  description: string;
  /** 描述首句（卡片用短版） */
  summarySource: string;
  /** 工具条目+handler 定义体里命中的实现模块（相对 source_root，无扩展名，如 'tools/brickify_cli'） */
  implModules: string[];
}

export interface RegistryExtractResult {
  tools: RegistryTool[];
  /** 解析到的相对 import 总数（symbol 条目数） */
  importSymbols: number;
  /** 源文件路径 */
  source: string;
}

/** 抓 description: 到 inputSchema: 之间的所有单引号串并拼接。 */
function extractDescription(block: string): string {
  const m = block.match(/description:\s*([\s\S]*?),\s*(?:inputSchema|handler)/);
  if (!m) return '';
  const parts = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  return parts.join('');
}

/** 相对具名 import：symbol → 模块（如 'tools/brickify_cli'）。含多行 import。 */
function extractImportMap(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(\.[^']+)'/g;
  for (const m of src.matchAll(re)) {
    const symbols = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    const mod = m[2].replace(/^\.\//, '').replace(/\.js$/, '');
    for (const s of symbols) map.set(s, mod);
  }
  return map;
}

/** 命名 handler 定义体：`const X = ...` 到下一个顶层 const 声明。 */
function handlerDefBody(src: string, handlerName: string): string {
  const startRe = new RegExp(`const ${handlerName}\\s*=`);
  const sm = src.match(startRe);
  if (!sm) return '';
  const start = sm.index! + sm[0].length;
  // 到下一个 `const <ident> =`（顶层换行起）或 5000 字符截断
  const rest = src.slice(start);
  const next = rest.match(/\nconst [A-Za-z_$][\w$]*\s*=/);
  return rest.slice(0, next ? next.index! : Math.min(rest.length, 5000));
}

/** 从 server_registry.ts 源码提取工具清单 + 实现模块连线。 */
export function extractRegistryTools(src: string): RegistryExtractResult {
  const importMap = extractImportMap(src);
  const symbols = [...importMap.keys()];

  // 条目切分：每个 name: 'xxx' 起，到下一个 name: 'xxx' 或文件尾
  const nameMatches = [...src.matchAll(/^ {4}name: '([a-z_]+)',?$/gm)];
  const tools: RegistryTool[] = [];

  for (let i = 0; i < nameMatches.length; i++) {
    const name = nameMatches[i][1];
    const start = nameMatches[i].index!;
    const end = i + 1 < nameMatches.length ? nameMatches[i + 1].index! : src.length;
    const block = src.slice(start, end);

    const titleM = block.match(/title:\s*'((?:[^'\\]|\\.)*)'/);
    const description = extractDescription(block);
    const summarySource = description.split(/[。；;]/)[0] || '';

    // 扫描范围：条目块 + 命名 handler 定义体
    let scanText = block;
    const handlerM = block.match(/handler:\s*([A-Za-z_$][\w$]*)/);
    if (handlerM && !importMap.has(handlerM[1])) {
      scanText += '\n' + handlerDefBody(src, handlerM[1]);
    }

    // 命中的实现模块（去重，保持顺序）
    const hits: string[] = [];
    for (const sym of symbols) {
      if (hits.includes(importMap.get(sym)!)) continue;
      const re = new RegExp(`\\b${sym.replace(/[$]/g, '\\$&')}\\(`);
      if (re.test(scanText)) hits.push(importMap.get(sym)!);
    }

    tools.push({
      name,
      title: titleM ? titleM[1] : '',
      description,
      summarySource,
      implModules: hits,
    });
  }

  return { tools, importSymbols: symbols.length, source: 'inline' };
}

/** 便捷入口：从文件读源码提取。 */
export function extractRegistryToolsFromFile(
  registryFile: string,
): RegistryExtractResult {
  const src = fs.readFileSync(path.resolve(registryFile), 'utf-8');
  const r = extractRegistryTools(src);
  return { ...r, source: path.resolve(registryFile) };
}
