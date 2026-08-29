/* 模拟：改进针脚清洗 + 顺序倒挂缺口 + 共享文件连线，验证数量变化 */
import { readFileSync } from 'node:fs';
const mm = JSON.parse(readFileSync('.design-canvas/mindmap/design-canvas.teach.json', 'utf-8'));

const GENERIC_T = new Set([
  'string', 'number', 'boolean', 'bool', 'int', 'int32', 'int64', 'uint', 'uint32', 'uint64',
  'float', 'float32', 'float64', 'this', 'void', 'any', 'unknown', 'null', 'undefined', 'nil',
  'object', 'Object', 'true', 'false', 'never', 'bigint', 'symbol', 'byte', 'rune', 'error',
  'func', 'function', 'promise', 'Promise', 'array', 'Array', 'map', 'Map', 'record', 'Record',
  // JS/Node/浏览器内置（跨功能到处出现，不能当数据身份）
  'Date', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'Error', 'String', 'Number', 'Boolean', 'Function',
  'BigInt', 'Symbol', 'Buffer', 'URL', 'URLSearchParams', 'JSON', 'Math', 'console', 'process', 'node',
  'PromiseLike', 'Iterator', 'Iterable', 'Generator', 'AsyncIterable', 'ArrayLike', 'Record', 'Object',
]);
const cleanPinStr = (s) => (s || '').replace(/^[:*\s]+/, '').replace(/[\s\]\)]+$/, '').trim();
function pinIdentity(p) {
  const t = cleanPinStr(p.t)
    .replace(/\|.*$/, '')
    .replace(/[\[\]*<>].*$/, '')
    .split('.').pop()
    ?.trim() ?? '';
  const n = cleanPinStr(p.n);
  if (t && (t.startsWith("'") || t.startsWith('"') || /^\d+$/.test(t))) return null;
  // 内联对象类型碎片（含 { }）与函数调用签名（含 ( )）不是数据形态
  if (t && /[{}()\r\n]/.test(t)) return null;
  if (t && t.length >= 2 && !GENERIC_T.has(t) && !t.startsWith('{')) return { key: t, name: n || t };
  if (!t && n && /[\u4e00-\u9fa5]/.test(n) && !['文本','字符串','数字','数值','布尔','数组','对象','字典','映射','列表','集合','空','无','任意','未知','函数','键值对','标识'].includes(n)) return { key: n, name: n };
  return null;
}

let featOk = 0, gapByKind = {}, edgeTotal = 0, shTotal = 0, shFeat = 0, featDetail = [];
for (const f of mm.root.children ?? []) {
  if (f.kind !== 'feature') continue;
  const sg = (f.children ?? []).find((c) => c.kind === 'stepgroup');
  if (!sg) continue;
  const stepNodes = (sg.children ?? []).filter((c) => c.kind === 'step');
  if (!stepNodes.length) continue;
  const pinIn = stepNodes.map((c) => (c.meta?.inputs ?? []).map(pinIdentity));
  const pinOut = stepNodes.map((c) => (c.meta?.outputs ?? []).map(pinIdentity));
  const N = stepNodes.length;
  const hasIn = stepNodes.map((c) => (c.meta?.inputs?.length ?? 0) > 0);
  const hasOut = stepNodes.map((c) => (c.meta?.outputs?.length ?? 0) > 0);
  // 唯一产出者（含多产出者身份，用于缺口过滤）
  const prodCount = new Map();
  for (let i = 0; i < N; i++) for (const o of pinOut[i]) if (o) prodCount.set(o.key, (prodCount.get(o.key) ?? 0) + 1);
  const isUnique = (k) => (prodCount.get(k) ?? 0) === 1;
  // 跨步连线（唯一产出者类型匹配）
  let edges = 0;
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    for (const o of pinOut[i]) if (o && isUnique(o.key)) for (const k of pinIn[j]) if (k && k.key === o.key) { edges++; break; }
  }
  // 顺序倒挂缺口
  const producedBefore = (j) => { const s = new Set(); for (let i = 0; i < j; i++) for (const o of pinOut[i]) if (o) s.add(o.key); return s; };
  const producedAfter = (j) => { const s = new Set(); for (let i = j + 1; i < N; i++) for (const o of pinOut[i]) if (o) s.add(o.key); return s; };
  const consumedAfter = (i) => { const s = new Set(); for (let j = i + 1; j < N; j++) for (const k of pinIn[j]) if (k) s.add(k.key); return s; };
  const consumedBefore = (i) => { const s = new Set(); for (let j = 0; j < i; j++) for (const k of pinIn[j]) if (k) s.add(k.key); return s; };
  let gaps = [];
  for (let i = 0; i < N; i++) {
    if (!(i === 0) && !hasIn[i]) { gaps.push({ kind: 'in_missing' }); gapByKind['in_missing'] = (gapByKind['in_missing'] ?? 0) + 1; }
    if (!(i === N - 1) && !hasOut[i]) { gaps.push({ kind: 'out_missing' }); gapByKind['out_missing'] = (gapByKind['out_missing'] ?? 0) + 1; }
    if (!(i === 0)) for (const k of pinIn[i]) {
      if (k && isUnique(k.key) && !producedBefore(i).has(k.key) && producedAfter(i).has(k.key)) {
        gaps.push({ kind: 'in_no_source', data: k.key }); gapByKind['in_no_source'] = (gapByKind['in_no_source'] ?? 0) + 1;
      }
    }
    if (!(i === N - 1)) for (const o of pinOut[i]) {
      if (o && isUnique(o.key) && !consumedAfter(i).has(o.key) && consumedBefore(i).has(o.key)) {
        gaps.push({ kind: 'out_no_consumer', data: o.key }); gapByKind['out_no_consumer'] = (gapByKind['out_no_consumer'] ?? 0) + 1;
      }
    }
  }
  // 共享文件连续边
  let sh = 0;
  for (let i = 0; i + 1 < N; i++) {
    const a = new Set(stepNodes[i].meta?.involves ?? []);
    const b = new Set(stepNodes[i + 1].meta?.involves ?? []);
    for (const f of a) if (b.has(f)) { sh++; break; }
  }
  if (sh > 0) shFeat++;
  shTotal += sh;
  edgeTotal += edges;
  featDetail.push({ feat: f.label, steps: N, edges, gaps: gaps.length, shared: sh, ins: pinIn.map(x => x.filter(Boolean).length), outs: pinOut.map(x => x.filter(Boolean).length) });
  if (!gaps.length) featOk++;
}
console.log('gapByKind', JSON.stringify(gapByKind));
console.log('edgeTotal(unique type match)', edgeTotal, ' sharedFileEdges', shTotal, ' featsWithShared', shFeat, ' featsNoGap', featOk, 'of', featDetail.length);
console.log(featDetail.map(x => `${x.feat}: steps=${x.steps} edges=${x.edges} gaps=${x.gaps} shared=${x.shared} in=${x.ins.join(',')} out=${x.outs.join(',')}`).join('\n'));
