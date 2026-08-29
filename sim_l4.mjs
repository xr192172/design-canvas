/* 模拟 L4：单步文件视图，两种连线规则对比（当前唯一产出者 vs 放宽任意类型匹配） */
import { readFileSync } from 'node:fs';
const mm = JSON.parse(readFileSync('.design-canvas/mindmap/design-canvas.teach.json', 'utf-8'));
const GENERIC_T = new Set(['string','number','boolean','bool','int','int32','int64','uint','uint32','uint64','float','float32','float64','this','void','any','unknown','null','undefined','nil','object','Object','true','false','never','bigint','symbol','byte','rune','error','func','function','promise','Promise','array','Array','map','Map','record','Record','Date','Set','WeakMap','WeakSet','RegExp','Error','String','Number','Boolean','Function','BigInt','Symbol','Buffer','URL','URLSearchParams','JSON','Math','console','process','node','PromiseLike','Iterator','Iterable','Generator','AsyncIterable','ArrayLike']);
const cleanPinStr = (s) => (s || '').replace(/^[:*\s]+/, '').replace(/[\s\]\)]+$/, '').trim();
function pinIdentity(p) {
  const t = cleanPinStr(p.t).replace(/\|.*$/, '').replace(/[\[\]*<>].*$/, '').split('.').pop()?.trim() ?? '';
  const n = cleanPinStr(p.n);
  if (t && (t.startsWith("'") || t.startsWith('"') || /^\d+$/.test(t))) return null;
  if (t && /[{}()\r\n]/.test(t)) return null;
  if (t && t.length >= 2 && !GENERIC_T.has(t) && !t.startsWith('{')) return { key: t, name: n || t };
  if (!t && n && /[\u4e00-\u9fa5]/.test(n)) return { key: n, name: n };
  return null;
}
let stepWithFiles = 0, currentEdges = 0, relaxedEdges = 0, stepsWithRelaxed = 0, stepsWithPins = 0;
for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  if (!sg) continue;
  for (const c of (sg.children ?? []).filter((x) => x.kind === 'step')) {
    const fps = c.meta?.filePins ?? [];
    const files = fps.filter((fp) => fp.path).map((fp) => ({ id: fp.path, inputs: fp.inputs, outputs: fp.outputs }));
    if (files.length < 2) continue;
    stepWithFiles++;
    const pinIn = files.map((f) => (f.inputs ?? []).map(pinIdentity).filter(Boolean));
    const pinOut = files.map((f) => (f.outputs ?? []).map(pinIdentity).filter(Boolean));
    const hasPin = pinIn.some((x) => x.length) || pinOut.some((x) => x.length);
    if (hasPin) stepsWithPins++;
    const prodByKey = new Map();
    for (const outs of pinOut) for (const o of outs) prodByKey.set(o.key, (prodByKey.get(o.key) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) for (let j = 0; j < files.length; j++) {
      if (i === j) continue;
      for (const o of pinOut[i]) if ((prodByKey.get(o.key) ?? 0) === 1 && pinIn[j].some((k) => k.key === o.key)) { currentEdges++; break; }
    }
    for (let i = 0; i < files.length; i++) for (let j = 0; j < files.length; j++) {
      if (i === j) continue;
      for (const o of pinOut[i]) if (pinIn[j].some((k) => k.key === o.key)) { relaxedEdges++; break; }
    }
    if (currentEdges || relaxedEdges) stepsWithRelaxed++;
  }
}
console.log('stepsWithFiles(>=2)', stepWithFiles, 'stepsWithPins', stepsWithPins, 'currentUniqueEdges', currentEdges, 'relaxedEdges', relaxedEdges, 'stepsWithAnyEdge', stepsWithRelaxed);
