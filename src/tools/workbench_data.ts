/**
 * workbench_data —— DSL 协作工作台的**数据契约层**（v1，冻结）
 *
 * 背景（2026-08-25 用户定调）：数据地基与前端分两条线并行开发——
 *   窗口A（本仓库）：数据管线打地基，产出本契约的 JSON；
 *   窗口B（前端）：从 mock 壳往下搭，先拿 JSON mock 跑通全部交互，
 *   最后 fetch 真实 JSON「重新长数据路线」。
 * 对接圣经 = 本文件的 TypeScript 接口 + `brickify_cli --workbench-data` 产出的示例 JSON。
 *
 * 设计参照 DataFlow-Harness（北大 OpenDCAI, arXiv:2607.16617）的分层：
 *   Pipeline Backend 是权威数据源（DAG=节点+边+状态），WebUI 只是投影。
 * 本层同理：WorkbenchData 是权威快照，render_workbench 只做渲染，
 * 前端B 也可直接消费同一份 JSON——一份契约，两个消费方。
 *
 * 忠实纪律（数据装配规则，前端不可不知）：
 *   status 只映射确定性事实——
 *     gray  = 槽内无簇（空槽如实，"未开始"）
 *     focus = review 槽（人机闭环=人参与处，"你正在这里"）
 *     warn  = 槽内有待处理问题信号（"有问题"）
 *     info  = 含 rule 降级簇（启发式归类，"待确认"）
 *     ok    = 其余（"正常"）
 *   问题信号两种：mixed-file（混合职责文件，建议卡）+ inversion（分层倒挂，需确认卡）。
 *   布局即数据：节点坐标与连线 path 是 mock 原文（七槽位与 mock 七节点同构），
 *   前端B 照 x/y/w 摆节点、照 paths.d 画贝塞尔即可，无需自行计算布局。
 *
 * 版本纪律：本文件是冻结契约。只加可选字段算兼容；改语义/删字段必须升 version。
 */

import path from 'node:path';
import fs from 'node:fs';
import type { BrickifyResult } from './brickify.js';
import type { AnatomyResult, AnatomySlotView } from './classify_bricks.js';
import type { ClusterNarratives } from './cluster_narrator.js';

// ─── 契约类型（v1） ───

/** 问题信号：混合职责文件（建议拆分）或分层倒挂（需人确认） */
export interface WorkbenchIssue {
  id: string;
  kind: 'mixed-file' | 'inversion';
  severe: boolean; // true=需确认（倒挂） false=建议（混合文件）
  title: string;
  desc: string;
  /** 证据：混合文件信号带文件路径与簇名列表 */
  evidence?: { file?: string; clusters?: string[] };
}

/** 功能簇（积木内聚块）——title/desc 是 narrate 的 LLM 人话 */
export interface WorkbenchCluster {
  id: string;
  title: string;
  desc: string;
  files: number;
  /** 内聚度 0-100 */
  cohesion: number;
  /** 归类方式：llm=LLM 归类 / rule=启发式降级（界面标"待确认"的来源之一） */
  classifiedBy: 'llm' | 'rule';
  confidence: number;
  reason: string;
}

/** 槽位内的积木分组 */
export interface WorkbenchGroup {
  brick: string;
  title: string;
  clusters: WorkbenchCluster[];
}

/** 流水线槽位（= 画布节点） */
export interface WorkbenchSlot {
  id: string;
  label: string;
  icon: string; // lucide 图标名
  /** 画布坐标（mock 原文，px；画布逻辑区 60..960 × 80..460） */
  x: number;
  y: number;
  w?: number;
  status: 'ok' | 'warn' | 'info' | 'gray' | 'focus';
  statusText: string;
  /** 节点一行描述 = 槽内簇人话标题前 3 个 */
  desc: string;
  /** 槽位判据（subtitle，面板用） */
  subtitle: string;
  /** 面板"这是什么？" */
  explainWhat: string;
  /** 面板"为什么需要它？"（簇人话拼接） */
  explainWhy: string;
  groups: WorkbenchGroup[];
  issues: WorkbenchIssue[];
}

/** 画布连线（mock 的 8 条贝塞尔 path 原文，d 为 SVG path 语法） */
export interface WorkbenchPath {
  d: string;
  active: boolean;
}

export interface WorkbenchData {
  /** 契约版本：破坏性变更必须升 version，消费方按 version 分派 */
  version: 1;
  meta: {
    project: string;
    sourceRoot: string;
    scannedFiles: number;
    bricks: number;
    totalIssues: number;
    generatedAt: string; // ISO 8601
    classifyMode: 'llm' | 'rule';
    classifyStats: string; // 如 "LLM 归类 32/33"
    narrateStats: string; // 如 "LLM 32/32"
  };
  /** sidebar 项目卡：narrate overview 的项目级人话 */
  project: {
    title: string;
    overview: string;
  };
  slots: WorkbenchSlot[];
  paths: WorkbenchPath[];
  /** 默认选中槽：问题最多者；无问题时选中枢 compute */
  defaultSlot: string;
}

// ─── 布局常量（mock 原文：坐标/连线照抄保形） ───

const SLOT_LAYOUT: Array<{ id: string; label: string; icon: string; x: number; y: number; w?: number }> = [
  { id: 'intake', label: '输入摄取', icon: 'scan-search', x: 60, y: 80 },
  { id: 'parse', label: '解析转换', icon: 'file-code-2', x: 300, y: 80 },
  { id: 'compute', label: '核心运算', icon: 'cpu', x: 540, y: 180 },
  { id: 'store', label: '状态存储', icon: 'database', x: 780, y: 80 },
  { id: 'render', label: '呈现输出', icon: 'file-output', x: 780, y: 340 },
  { id: 'observe', label: '观测质检', icon: 'shield-alert', x: 540, y: 340 },
  { id: 'review', label: '人机闭环', icon: 'user-check', x: 300, y: 320, w: 200 },
];

const MOCK_PATHS: WorkbenchPath[] = [
  { d: 'M240,146 C260,146 280,146 300,146', active: false },
  { d: 'M480,146 C540,146 560,146 580,160 C600,174 615,180 630,180', active: false },
  { d: 'M720,246 C780,246 810,212 870,212', active: false },
  { d: 'M630,312 L630,340', active: true },
  { d: 'M540,246 C510,246 500,280 500,320 C500,350 500,375 500,385', active: true },
  { d: 'M540,406 C525,406 512,395 502,390', active: true },
  { d: 'M870,212 C870,270 700,320 500,320', active: true },
  { d: 'M500,390 C600,390 700,406 780,406', active: false },
];

// ─── 数据装配（权威快照的唯一实现） ───

export function buildWorkbenchData(
  result: BrickifyResult,
  anatomy: AnatomyResult,
  narratives: ClusterNarratives,
  projectName: string,
): WorkbenchData {
  // 混合文件信号 → 按积木主槽归属（该积木簇数最多的槽）
  const brickMainSlot = new Map<string, string>();
  for (const lane of anatomy.slots) {
    for (const g of lane.groups) {
      const cur = brickMainSlot.get(g.brick);
      const curCount = cur ? (anatomy.slots.find((s) => s.slot.id === cur)?.groups.find((x) => x.brick === g.brick)?.clusters.length ?? 0) : 0;
      if (g.clusters.length > curCount) brickMainSlot.set(g.brick, lane.slot.id);
    }
  }

  const issuesBySlot = new Map<string, WorkbenchIssue[]>();
  const pushIssue = (slot: string, issue: WorkbenchIssue): void => {
    const arr = issuesBySlot.get(slot) ?? [];
    arr.push(issue);
    issuesBySlot.set(slot, arr);
  };
  for (const m of result.mixed_files) {
    const brick = m.file.split('/')[0];
    const slot = brickMainSlot.get(brick) ?? 'compute';
    pushIssue(slot, {
      id: `mixed:${m.file}`,
      kind: 'mixed-file',
      severe: false,
      title: `混合职责文件：${m.file}`,
      desc: `该文件内检测到 ${m.clusters.length} 个独立功能簇（${m.clusters
        .slice(0, 2)
        .map((c) => `[${c.slice(0, 4).join(', ')}${c.length > 4 ? '…' : ''}]`)
        .join(' ')}${m.clusters.length > 2 ? ' …' : ''}），不同职责挤在一个文件里，建议拆分为独立模块。`,
      evidence: { file: m.file, clusters: m.clusters.map((c) => c[0]) },
    });
  }
  for (const lim of anatomy.limitations) {
    pushIssue('observe', { id: `inversion:${lim.slice(0, 40)}`, kind: 'inversion', severe: true, title: '分类与依赖分层倒挂', desc: lim });
  }

  const narrClusters = narratives.clusters ?? {};
  const slots: WorkbenchSlot[] = SLOT_LAYOUT.map((n) => {
    const lane = anatomy.slots.find((s) => s.slot.id === n.id) as AnatomySlotView | undefined;
    const groups: WorkbenchGroup[] = (lane?.groups ?? []).map((g) => ({
      brick: g.brick,
      title: g.brickTitle || g.brick,
      clusters: g.clusters.map((c) => ({
        id: c.id,
        title: c.title || narrClusters[c.id]?.title || c.id,
        desc: c.desc || narrClusters[c.id]?.desc || c.id,
        files: c.files,
        cohesion: c.cohesion > 1 ? Math.round(c.cohesion) : Math.round(c.cohesion * 100),
        classifiedBy: c.classification.mode === 'rule' ? 'rule' : 'llm',
        confidence: c.classification.confidence,
        reason: c.classification.reason,
      })),
    }));
    const clusters = groups.flatMap((g) => g.clusters);
    const fileCount = clusters.reduce((a, c) => a + c.files, 0);
    const issues = issuesBySlot.get(n.id) ?? [];
    const hasRule = clusters.some((c) => c.classifiedBy === 'rule');

    // 状态：只映射确定性事实（契约纪律，见文件头）
    let status: WorkbenchSlot['status'];
    let statusText: string;
    if (clusters.length === 0) {
      status = 'gray';
      statusText = '未开始';
    } else if (n.id === 'review') {
      status = 'focus';
      statusText = '进行中';
    } else if (issues.length > 0) {
      status = 'warn';
      statusText = '有问题';
    } else if (hasRule) {
      status = 'info';
      statusText = '待确认';
    } else {
      status = 'ok';
      statusText = '正常';
    }

    const titles = clusters.map((c) => c.title);
    const desc =
      clusters.length === 0 ? '本项目没有这部分' : titles.slice(0, 3).join(' · ') + (titles.length > 3 ? ` 等${titles.length}簇` : '');

    const explainWhy =
      clusters.length === 0
        ? '本项目没有这一层——流水线照样完整运行，这也是信息：说明该项目把这部分职责省略或合并到了别处。'
        : `这一层由 ${groups.length} 块积木的 ${clusters.length} 个功能簇构成：` +
          titles.slice(0, 4).map((t) => `「${t}」`).join('') +
          (titles.length > 4 ? ` 等 ${titles.length} 个。` : '。') +
          `共 ${fileCount} 个源文件在此层协同。`;

    return {
      id: n.id,
      label: n.label,
      icon: n.icon,
      x: n.x,
      y: n.y,
      ...(n.w ? { w: n.w } : {}),
      status,
      statusText,
      desc,
      subtitle: lane?.slot.desc ?? '',
      explainWhat: lane?.slot.desc ?? '',
      explainWhy,
      groups,
      issues,
    };
  });

  const totalIssues = result.mixed_files.length + anatomy.limitations.length;
  const defaultSlot =
    slots.reduce((a, b) => (b.issues.length > a.issues.length ? b : a), slots[0]).issues.length > 0
      ? slots.reduce((a, b) => (b.issues.length > a.issues.length ? b : a), slots[0]).id
      : (slots.find((s) => s.id === 'compute') ?? slots[0]).id;

  return {
    version: 1,
    meta: {
      project: projectName,
      sourceRoot: result.meta.source_root,
      scannedFiles: result.meta.scanned_files,
      bricks: result.bricks.length,
      totalIssues,
      generatedAt: new Date().toISOString(),
      classifyMode: anatomy.meta.mode === 'llm' ? 'llm' : 'rule',
      classifyStats: anatomy.meta.mode === 'llm' ? `LLM 归类 ${anatomy.meta.llm_ok}/${anatomy.meta.total}` : '启发式归类',
      narrateStats: `LLM ${narratives.meta.llm_ok}/${narratives.meta.total}`,
    },
    project: {
      title: narratives.overview.title,
      overview: narratives.overview.desc,
    },
    slots,
    paths: MOCK_PATHS,
    defaultSlot,
  };
}

/** 契约 JSON 落盘（窗口B 的对接物：mock 数据源 / 最终 fetch 目标） */
export function writeWorkbenchDataJson(data: WorkbenchData, out_file: string): string {
  const abs = path.resolve(out_file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2), 'utf-8');
  return abs;
}
