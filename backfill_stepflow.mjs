/* 临时回填：改进契约投影 + 推导并注入每功能 flowEdges/gaps + 文件级 fileEdges + 跨功能 crossEdges 到 teach JSON
 * · 步骤针脚用「改进后」的全量投影重投影（meta.inputs/outputs 刷新，保留 LLM narration/描述）
 * · 逐文件针脚用「改进后」的单文件投影重投影（meta.filePins：每步涉及文件各自吃什么/吐什么，L4 用）
 * · 跨步连线按「唯一产出者」保守规则（同数据名被 ≥2 步产出则视为基础设施，不连）
 * · 文件级连线（L4 高亮用）：功能内全部文件跨步骤去重收集 → 唯一产出者「产出→消费」连线
 * · 缺口「无源/悬空」仅在全项目都没有产出者/消费方时报（跨功能外部输入不算漏步）
 * · 跨功能连线（L2 功能视图高亮用）：数据名只被一个功能产出 → 流向消费它的功能
 * 幂等可重复执行。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildFileIndex, projectStepDataShape, projectFileDataShape, deriveStepFlow, deriveFileFlow, deriveCrossFeatureFlow, pinIdentityKeys } from './dist/src/tools/derive_mind_map.js';

const dslPath = '.design-canvas/live/design-canvas.dsl.json';
const jsonPath = '.design-canvas/mindmap/design-canvas.teach.json';
const dsl = JSON.parse(readFileSync(dslPath, 'utf-8'));
const fileIndex = buildFileIndex(dsl);
const mm = JSON.parse(readFileSync(jsonPath, 'utf-8'));

// 1) 重投影所有功能的步骤针脚 + 逐文件针脚（全量 API + 代表力打分），刷新 meta.inputs/outputs + meta.filePins
const featIds = [];
const stepsById = new Map(); // featureId -> steps[]
for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  if (!sg) continue;
  const stepNodes = (sg.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  const steps = stepNodes.map((c) => {
    const shape = projectStepDataShape(c.meta?.involves, fileIndex);
    // 逐文件针脚：每个涉及文件单独投影（L4 文件视图渲染 + 文件级连线）
    const filePins = (c.meta?.involves ?? []).map((p) => {
      const fs = projectFileDataShape(p, fileIndex);
      return { path: p, inputs: fs?.inputs, outputs: fs?.outputs };
    });
    c.meta = {
      ...(c.meta ?? {}),
      involves: c.meta?.involves ?? [],
      inputs: shape?.inputs ?? [],
      outputs: shape?.outputs ?? [],
      filePins,
    };
    return {
      title: c.label,
      detail: c.description || '',
      involves: c.meta?.involves,
      inputs: c.meta?.inputs,
      outputs: c.meta?.outputs,
    };
  });
  featIds.push(f.id);
  stepsById.set(f.id, steps);
}

// 2) 每功能的产出/消费身份集（同款 pinIdentity 清洗，供跨功能 global 集计算）
const outIds = new Map(); // featureId -> Set<身份key>
const inIds = new Map();  // featureId -> Set<身份key>
for (const id of featIds) {
  const steps = stepsById.get(id);
  outIds.set(id, new Set(steps.flatMap((s) => [...pinIdentityKeys(s.outputs)])));
  inIds.set(id, new Set(steps.flatMap((s) => [...pinIdentityKeys(s.inputs)])));
}

// 3) 每功能：推导跨步连线 + 缺口 + 文件级连线（global=排除自身的其它功能产出/消费集）
let featTotal = 0, edgeTotal = 0, gapTotal = 0, fileEdgeTotal = 0;
for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  if (!sg) continue;
  const stepNodes = (sg.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  const steps = stepsById.get(f.id);
  const producedElsewhere = new Set(featIds.filter((id) => id !== f.id).flatMap((id) => [...outIds.get(id)]));
  const consumedElsewhere = new Set(featIds.filter((id) => id !== f.id).flatMap((id) => [...inIds.get(id)]));
  const { edges, gaps } = deriveStepFlow(
    steps, stepNodes.map((c) => c.id),
    { produced: producedElsewhere, consumed: consumedElsewhere },
  );
  // 文件级连线（L4 高亮用）：功能内全部文件跨步骤去重收集 → 唯一产出者「产出→消费」
  const allFiles = [];
  const seenFile = new Set();
  for (const sn of stepNodes) {
    for (const fp of sn.meta?.filePins ?? []) {
      if (seenFile.has(fp.path)) continue;
      seenFile.add(fp.path);
      allFiles.push({ id: fp.path, inputs: fp.inputs, outputs: fp.outputs });
    }
  }
  const fileEdges = deriveFileFlow(allFiles);
  sg.meta = { ...(sg.meta ?? {}), pending: sg.meta?.pending };
  if (edges.length) sg.meta.flowEdges = edges; else delete sg.meta.flowEdges;
  if (gaps.length) sg.meta.gaps = gaps; else delete sg.meta.gaps;
  if (fileEdges.length) sg.meta.fileEdges = fileEdges; else delete sg.meta.fileEdges;
  featTotal++; edgeTotal += edges.length; gapTotal += gaps.length; fileEdgeTotal += fileEdges.length;
}

// 4) 跨功能数据流（唯一产出者）→ 挂到根 meta.crossEdges
const crossFeats = featIds.map((id) => ({ id, steps: stepsById.get(id) }));
const crossEdges = deriveCrossFeatureFlow(crossFeats);
mm.root.meta = { ...(mm.root.meta ?? {}), crossEdges: crossEdges.length ? crossEdges : undefined };

writeFileSync(jsonPath, JSON.stringify(mm, null, 2), 'utf-8');
console.log(
  `回填完成：${featTotal} 个功能 · 跨步连线 ${edgeTotal} 条 · 缺口 ${gapTotal} 条 · 文件级连线 ${fileEdgeTotal} 条 · 跨功能连线 ${crossEdges.length} 条 → ${jsonPath}`,
);
