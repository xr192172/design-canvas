/**
 * capability_cli —— 能力矩阵自检 CLI（缺口清单）
 *
 * 用法：
 *   node dist/src/tools/capability_cli.js [--installed] [--json <out.json>]
 *
 * 语义：
 *   - 默认对所有语言做全量缺口审计（audit 直出，无需安装）。
 *   - --installed：只对"已安装的 tree-sitter 语言包"审计（贴近实际能跑的语言）。
 *   - 输出：报告可直接给 LLM 做"补哪个功能、补哪门语言"的决策输入。
 *   - 这是可接入 doctor / mindmap 的确定性数据源（纯计算），不改任何代码。
 */

import fs from 'node:fs';
import path from 'node:path';
import { probeInstalledLanguages } from './ts_kernel/probe.js';
import {
  allCapabilities,
  diagnoseCapabilities,
  diagnoseCapabilitiesByEntries,
  aggregateGaps,
  renderAuditText,
  languageCatalog,
} from './capability_matrix.js';
import './register_capabilities.js'; // 触发默认登记（side-effect import，确保矩阵被填充）

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);

function main(): void {
  // 确保有功能被登记（哪怕将来 register_capabilities 没被构建进来也兜底报个空矩阵）
  if (allCapabilities().length === 0) {
    console.warn('[capability] 尚无功能登记——请先 import register_capabilities 或调用 declareCapability');
  }

  const useInstalled = has('--installed');
  const langNames = useInstalled
    ? diagnoseCapabilitiesByEntries(probeInstalledLanguages())
    : diagnoseCapabilities(languageCatalog().map((l) => l.name));

  const lines: string[] = [];
  lines.push(useInstalled ? `审计范围：已安装语言（${probeInstalledLanguages().length} 门）` : `审计范围：语言名单全量（${languageCatalog().length} 门）`);
  lines.push(renderAuditText(langNames));

  // 缺口汇总：功能 → 需补的语言
  const gaps = aggregateGaps(langNames);
  const totalNeed = Object.values(gaps).reduce((a, b) => a + b.length, 0);
  lines.push('');
  lines.push(totalNeed === 0 ? '✅ 无缺口：所有功能对该语言名单均为 AST 全量' : `🔧 缺口总计 ${totalNeed} 个「功能×语言」对`);
  for (const [id, langs] of Object.entries(gaps)) {
    lines.push(`  - ${id}: ${langs.join(', ')}`);
  }

  // 全量功能名单（未登记者不会被 audit 捕获——这本身也是"该接契约却有功能漏网"的入口）
  lines.push('');
  lines.push(`功能名单（已登记 ${allCapabilities().length} 项）：`);
  for (const c of allCapabilities()) lines.push(`  - ${c.id}（${c.label}）`);

  const text = lines.join('\n');
  console.log(text);

  const jsonOut = readArg('--json');
  if (jsonOut) {
    const data = {
      scope: useInstalled ? 'installed' : 'all',
      langCount: useInstalled ? probeInstalledLanguages().length : languageCatalog().length,
      gaps,
      totalNeed,
      capabilities: allCapabilities().map((c) => ({
        id: c.id,
        label: c.label,
        default: c.default,
        overrides: c.overrides,
      })),
    };
    const abs = path.resolve(jsonOut);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n[capability] JSON → ${abs}`);
  }
}

main();