/**
 * upgrade_cli：版本升级契约差检测 · CLI 入口
 *
 * 用法：
 *   node dist/src/tools/upgrade_cli.js [root] [--json]
 *
 * 能力：
 *   阶段 A：工具链版本盘点 —— 扫描各子项目工具链声明（pom.xml / build.gradle / .nvmrc /
 *           .tool-versions / go.mod / engines），探测本机 java/node/go，输出匹配状态。
 *   阶段 B：语言特性契约差检测 —— 以子项目声明版本为边界，扫描其源码，
 *           报告"用了超过声明版本的语言特性"（= 编译会失败、契约对不上的部分），附行号与重写建议。
 *   阶段 C：废弃/移除 API 检测 —— 报告目标版本已移除/废弃的 API（如 JDK 11 起移除的
 *           JAXB/JAX-WS/JAF 等），附替代方案，属另一类硬性/软性契约差。
 *
 * 只做报告，不做改写——改写由 upgrade_rewrite_cli 的 git 验证回退闭环承载。
 * --json 输出结构化结果（供 LLM/闭环消费）。
 */

import path from 'node:path';
import { runContractScan, type ContractScanResult } from '../version_upgrade/detect.js';
import type { FeatureHit } from '../version_upgrade/features.js';
import type { RemovedHit } from '../version_upgrade/removed.js';

const TOOL_LABEL: Record<string, string> = { java: 'JDK', node: 'Node', go: 'Go' };

function statusBadge(status: string): string {
  switch (status) {
    case 'ok':
      return '✓ 满足';
    case 'missing':
      return '✗ 缺工具';
    default:
      return '! 版本不足';
  }
}

function renderToolchain(scan: ContractScanResult['scan']): string[] {
  const lines: string[] = [];
  lines.push('【1. 工具链版本盘点】');
  if (scan.declarations.length === 0) {
    lines.push('  （未发现工具链声明）');
    return lines;
  }
  lines.push('  子项目            | 工具   | 声明版本    | 本机版本    | 状态');
  lines.push('  ------------------|--------|-------------|-------------|--------');
  for (const m of scan.matches) {
    const proj = m.projectDir === '.' ? '<root>' : m.projectDir;
    lines.push(
      `  ${proj.padEnd(18)}| ${TOOL_LABEL[m.tool].padEnd(6)}| ${m.declaredVersion.padEnd(11)}| ${(m.localVersion ?? '未安装').padEnd(11)}| ${statusBadge(m.status)}`
    );
  }
  const bad = scan.matches.filter((m) => m.status !== 'ok');
  if (bad.length > 0) {
    lines.push('');
    lines.push(`  ⚠ 需关注 ${bad.length} 项：`);
    for (const m of bad) {
      lines.push(`    - ${m.projectDir === '.' ? '<root>' : m.projectDir}: ${TOOL_LABEL[m.tool]} ${m.declaredVersion} → ${m.note}`);
    }
  }
  return lines;
}

function renderFeatures(res: ContractScanResult): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('【2. 语言特性契约差检测】（以子项目声明版本为边界，超标=需重写）');
  if (res.features.length === 0) {
    lines.push('  （所有子项目源码均在声明版本边界内，无超标特性）');
    return lines;
  }
  for (const { declaration: d, boundary, hits } of res.features) {
    const label = TOOL_LABEL[d.tool];
    lines.push('');
    lines.push(`  ▶ ${d.projectDir === '.' ? '<root>' : d.projectDir}（声明 ${label} ${d.declaredVersion}，边界 ${label} ${boundary}）`);
    for (const h of hits) {
      lines.push(`      ${h.file}:${h.line}  ${h.feature}（需 ${label} ${h.since}）`);
      lines.push(`        → ${h.rewrite}：${h.snippet}`);
    }
  }
  return lines;
}

function renderRemoved(res: ContractScanResult): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push('【3. 废弃/移除 API 检测】（目标版本已移除/废弃该 API，= 契约对不上）');
  if (res.removed.length === 0) {
    lines.push('  （所有子项目源码均未使用目标版本已移除/废弃的 API）');
    return lines;
  }
  for (const { declaration: d, hits } of res.removed) {
    const label = TOOL_LABEL[d.tool];
    lines.push('');
    lines.push(`  ▶ ${d.projectDir === '.' ? '<root>' : d.projectDir}（声明 ${label} ${d.declaredVersion}）`);
    for (const h of hits) {
      const badge = h.kind === 'removed' ? '已移除' : '已废弃';
      lines.push(`      ${h.file}:${h.line}  ${h.api}（${badge}：${label} ${h.since} 起）`);
      lines.push(`        → ${h.rewrite}：${h.snippet}`);
    }
  }
  return lines;
}

function renderSummary(res: ContractScanResult): string[] {
  const featureCount = res.features.reduce((n, g) => n + g.hits.length, 0);
  const removedCount = res.removed.reduce((n, g) => n + g.hits.length, 0);
  const badMatch = res.scan.matches.filter((m) => m.status !== 'ok').length;
  return [
    '',
    `【汇总】工具链声明 ${res.scan.declarations.length} 项（${badMatch} 项不匹配本机）· 语言特性超标 ${featureCount} 处 · 废弃/移除 API ${removedCount} 处`,
  ];
}

function toJson(res: ContractScanResult): string {
  return JSON.stringify(
    {
      root: res.root,
      toolchains: res.scan.matches.map((m) => ({
        projectDir: m.projectDir,
        tool: m.tool,
        declaredVersion: m.declaredVersion,
        localVersion: m.localVersion,
        status: m.status,
      })),
      features: res.features.map(({ declaration: d, boundary, hits }) => ({
        projectDir: d.projectDir,
        tool: d.tool,
        declaredVersion: d.declaredVersion,
        boundary,
        hits: hits.map((h: FeatureHit) => ({ file: h.file, line: h.line, feature: h.feature, since: h.since, rewrite: h.rewrite, snippet: h.snippet })),
      })),
      removed: res.removed.map(({ declaration: d, hits }) => ({
        projectDir: d.projectDir,
        tool: d.tool,
        declaredVersion: d.declaredVersion,
        hits: hits.map((h: RemovedHit) => ({ file: h.file, line: h.line, api: h.api, since: h.since, kind: h.kind, rewrite: h.rewrite, snippet: h.snippet })),
      })),
    },
    null,
    2
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const root = path.resolve(args[0] ?? process.cwd());
  const json = args.includes('--json');
  const res = runContractScan(root);
  if (json) {
    // eslint-disable-next-line no-console
    console.log(toJson(res));
    return;
  }
  const out = [`版本升级契约差检测：${root}`];
  out.push(...renderToolchain(res.scan));
  out.push(...renderFeatures(res));
  out.push(...renderRemoved(res));
  out.push(...renderSummary(res));
  // eslint-disable-next-line no-console
  console.log(out.join('\n'));
}

main();
