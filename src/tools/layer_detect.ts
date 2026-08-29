/**
 * architecture-analyzer（路线图序号5）+ Layer Visualization 渲染支持（序号7）
 *
 * 启发式架构分层：按文件路径的目录段/文件名模式推断文件所属架构层
 * （api/service/data/ui/middleware/utility/config/types/test/entry/core）。
 * 借鉴 vendor/Understand-Anything 的 layer-detector.ts（目录模式匹配 + 首中即止），
 * 适配本项目 TS 仓库并补充中文层名与配色。
 *
 * 纯函数：detectArchLayers 输入 DSL，返回加工副本（存储文件不动），
 * 为每个 type=file 节点写入 arch_layer，并生成 dsl.layers 供图例/着色。
 *
 * 打磨（2026-08-29）：
 *   - 分层定义可配置：detectArchLayers / matchLayer 接受自定义 LayerDef[]，
 *     覆盖默认 9 层（贴合任意项目自己的架构心智，如 积木/契约/胶水 三明治）。
 *   - 层间违规检测：detectLayerViolations 依据每层 allowed_deps 判定
 *     "from 层引用了不允许依赖的 to 层"（如胶水层被积木层反向引用）。
 *     allowed_deps 解析顺序：层定义内 allowed_deps → 内置 DEFAULT_ALLOWED_DEPS → 允许一切（不误报）。
 */

import type { DesignDSL, Node, ArchLayer, SemanticFile } from '../dsl/types.js';

/** 层定义：目录/文件名段模式 → 层。首中即止（顺序敏感：更具体的层排前） */
export interface LayerDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  patterns: string[];
  /** 允许本层 import 的层 id 列表；缺省用内置 DEFAULT_ALLOWED_DEPS，未定义规则/未归类层 = 允许一切（不判违规） */
  allowed_deps?: string[];
}

const LAYER_DEFS: LayerDef[] = [
  {
    id: 'api',
    name: 'API 层',
    desc: 'HTTP 端点、路由处理器与接口控制',
    color: '#4a7c9b',
    patterns: ['api', 'apis', 'routes', 'route', 'controller', 'controllers', 'handler', 'handlers', 'endpoint', 'endpoints', 'serializers', 'blueprints', 'routers'],
  },
  {
    id: 'service',
    name: '服务层',
    desc: '业务逻辑与应用服务编排',
    color: '#8b6fb0',
    patterns: ['service', 'services', 'usecase', 'use-case', 'business', 'core', 'domain', 'logic', 'jobs', 'channels', 'composables', 'internal', 'signals', 'mailers'],
  },
  {
    id: 'data',
    name: '数据层',
    desc: '数据模型、数据库访问与持久化',
    color: '#5a9e6f',
    patterns: ['data', 'model', 'models', 'entity', 'entities', 'schema', 'schemas', 'database', 'db', 'migration', 'migrations', 'repository', 'repo', 'persistence', 'sql', 'storage', 'store', 'stores'],
  },
  {
    id: 'ui',
    name: 'UI 层',
    desc: '用户界面组件与视图呈现',
    color: '#b07a8a',
    patterns: ['ui', 'component', 'components', 'view', 'views', 'page', 'pages', 'screen', 'screens', 'layout', 'layouts', 'widget', 'widgets', 'renderer'],
  },
  {
    id: 'middleware',
    name: '中间件层',
    desc: '请求/响应中间件与拦截器',
    color: '#4a9b8c',
    patterns: ['middleware', 'interceptor', 'interceptors', 'guard', 'guards', 'filter', 'pipes', 'plugin', 'plugins'],
  },
  {
    id: 'utility',
    name: '工具层',
    desc: '共享工具、辅助函数与通用库',
    color: '#6a8fb0',
    patterns: ['util', 'utils', 'helper', 'helpers', 'lib', 'common', 'shared', 'tools', 'tool', 'support', 'kernel'],
  },
  {
    id: 'config',
    name: '配置层',
    desc: '应用配置与环境设置',
    color: '#c9a06c',
    patterns: ['config', 'configs', 'setting', 'settings', 'env', 'constants'],
  },
  {
    id: 'types',
    name: '类型层',
    desc: '类型定义、契约与数据传输对象',
    color: '#4fa3c9',
    patterns: ['types', 'type', 'interface', 'interfaces', 'contracts', 'dtos', 'dto', 'request', 'response', 'dsl'],
  },
  {
    id: 'test',
    name: '测试层',
    desc: '测试文件与测试工具',
    color: '#788291',
    patterns: ['test', 'tests', 'spec', 'specs', '__test__', '__tests__'],
  },
  {
    id: 'entry',
    name: '入口层',
    desc: '程序入口与启动引导',
    color: '#e07b5f',
    patterns: ['main', 'index', 'server', 'app', 'cmd', 'bin', 'entry'],
  },
];

/** 未匹配任何模式的兜底层 */
const CORE_DEF: LayerDef = { id: 'core', name: '核心层', desc: '核心/未归类文件', color: '#65707e', patterns: [] };

/** 内置默认层间允许依赖方向（保守：入口/测试/未归类层允许一切，不误报）。
 *  未列出的层 id 同样视为允许一切。自定义层可用 allowed_deps 覆盖本表。 */
export const DEFAULT_ALLOWED_DEPS: Record<string, string[]> = {
  api: ['api', 'service', 'middleware', 'data', 'utility', 'config', 'types'],
  service: ['service', 'data', 'utility', 'config', 'types'],
  middleware: ['middleware', 'service', 'data', 'utility', 'config', 'types'],
  ui: ['ui', 'service', 'data', 'utility', 'types'],
  data: ['data', 'utility', 'types'],
  utility: ['utility', 'types'],
  config: ['config', 'utility', 'types'],
  types: ['types'],
  test: ['test', 'entry', 'api', 'service', 'ui', 'middleware', 'data', 'utility', 'config', 'types'],
  entry: ['entry', 'api', 'service', 'ui', 'middleware', 'data', 'utility', 'config', 'types'],
  core: ['core', 'entry', 'api', 'service', 'ui', 'middleware', 'data', 'utility', 'config', 'types'],
};

/** 目录段/文件名段和其复数形式做匹配（借用 vendor 的 segment === pattern || segment === pattern + 's' 思路）。
 * 由文件相对路径推断架构层 id。导出以便 feature_map 直接复用（避免重复实现分层判定）。
 * 第二参 layers 为自定义层定义（缺省用内置 9 层）。 */
export function matchLayer(rel: string, layers: LayerDef[] = LAYER_DEFS): string {
  const segments = rel.replace(/\\/g, '/').split('/');
  for (const L of layers) {
    for (const segRaw of segments) {
      // 去掉扩展名再匹配（'server.ts' → 'server'），并统一小写
      const base = segRaw.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
      if (!base) continue;
      for (const p of L.patterns) {
        if (base === p || base === p + 's') return L.id;
      }
    }
  }
  return CORE_DEF.id;
}

const defOf = (id: string, layers: LayerDef[] = LAYER_DEFS): LayerDef =>
  layers.find((d) => d.id === id) ?? CORE_DEF;

/**
 * 为 file 节点推断架构层并生成 dsl.layers。
 * 返回加工副本（不就地修改存储 DSL）；已有 arch_layer 的节点不覆盖。
 * 顺带把层名回填到 semantic.files[].responsibility 前缀（职责回填，序号5）。
 * 第二参 layers 为自定义层定义（缺省用内置 9 层）。
 * 注意：显式传入自定义 layers 时会强制重算所有节点的 arch_layer
 * （覆盖导入时按默认 9 层预填的结果）；缺省时保留已有值（手动标注/预填不覆盖）。
 */
export function detectArchLayers(dsl: DesignDSL, layers?: LayerDef[]): DesignDSL {
  const defs = layers ?? LAYER_DEFS;
  const byLayer = new Map<string, string[]>();

  const nodes: Node[] = dsl.geometry.nodes.map((n) => {
    if (n.type !== 'file') return n;
    const layer = matchLayer(n.description ?? n.id, defs);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), n.id]);
    return layers ? { ...n, arch_layer: layer } : n.arch_layer ? n : { ...n, arch_layer: layer };
  });

  // 职责回填：把层名加进 SemanticFile 的 responsibility 前缀（若尚未包含），并写入 layer 字段
  let semantic = dsl.semantic;
  if (semantic && semantic.files.length > 0) {
    const layerNameById = (id: string): string => defOf(id, defs).name;
    const files: SemanticFile[] = semantic.files.map((f) => {
      const node = nodes.find((n) => n.id === f.id);
      const layer = node?.arch_layer;
      if (!layer) return f;
      const name = layerNameById(layer);
      const responsibility = f.responsibility && f.responsibility.includes(name)
        ? f.responsibility
        : `${name} · ${f.responsibility ?? ''}`.replace(/\s*·\s*$/, '');
      return { ...f, responsibility, layer };
    });
    semantic = { ...semantic, files };
  }

  const layerSet = defs.map((d) => d.id);
  const layersOut: ArchLayer[] = [...byLayer.entries()]
    .sort((a, b) => layerSet.indexOf(a[0]) - layerSet.indexOf(b[0]) || a[0].localeCompare(b[0]))
    .map(([id, ids]) => {
      const d = defOf(id, defs);
      return { id, name: d.name, description: d.desc, color: d.color, count: ids.length };
    });

  return { ...dsl, layers: layersOut, semantic, geometry: { ...dsl.geometry, nodes } };
}

// ─────────────────────────────────────────────────────────────
// 层间违规检测（跨层依赖方向）
// ─────────────────────────────────────────────────────────────

/** 文件级 import 边（from/to 均为项目内相对路径，via 为源码里写到的导入串） */
export interface ImportEdge {
  from: string;
  to: string;
  via: string;
}

/** 一条层间依赖违规：from 层引用了不在其 allowed_deps 内的 to 层 */
export interface LayerViolation {
  from_file: string;
  from_layer: string;
  to_file: string;
  to_layer: string;
  via: string;
}

export interface DetectLayerViolationsInput {
  defs: LayerDef[];
  /** rel path → layer id（key 需与 edges 的 from/to 一致） */
  fileLayers: Record<string, string>;
  edges: ImportEdge[];
}

/**
 * 轻量 import 解析（TS/JS/Go/Py）：返回本文件引用的"相对/本地"模块路径列表（去重）。
 * 仅识别静态字符串形式，且只保留相对路径（./ ../）——那才是项目内跨文件依赖边的主要来源。
 * 局限：Go 跨包用模块路径（module 前缀）不在覆盖内；动态 import 字符串不可见。
 */
export function parseImportsLight(src: string): string[] {
  const out = new Set<string>();
  // TS/JS：import x from 'p' / import 'p'（裸导入）/ require('p') / import('p')
  const tsRe = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tsRe.exec(src))) {
    const s = m[1];
    if (s.startsWith('./') || s.startsWith('../')) out.add(s);
  }
  // Go：import "p" / import alias "p" / import ( "p" ... ) 的相对路径
  const goRe = /import\s+(?:[a-zA-Z_][\w.]*\s+)?"([^"]+)"/g;
  while ((m = goRe.exec(src))) {
    const s = m[1];
    if (s.startsWith('./') || s.startsWith('../')) out.add(s);
  }
  const goGroupRe = /import\s*\(([\s\S]*?)\)/g;
  const goItemRe = /"([^"]+)"/g;
  while ((m = goGroupRe.exec(src))) {
    let im: RegExpExecArray | null;
    while ((im = goItemRe.exec(m[1]))) {
      const s = im[1];
      if (s.startsWith('./') || s.startsWith('../')) out.add(s);
    }
  }
  // Python：from . import / from .x import / from ..x import / import .x
  const pyRe = /(?:from\s+(\.\.*[\w.]*)\s+import|import\s+(\.\.*[\w.]+)(?:\s+as\s+\w+)?)/g;
  while ((m = pyRe.exec(src))) {
    const raw = m[1] || m[2] || '';
    if (!raw.startsWith('.')) continue; // 绝对导入 → 非项目内相对边
    const rel = pyRelToPath(raw);
    if (rel.startsWith('./') || rel.startsWith('../')) out.add(rel);
  }
  return [...out];
}

/** Python 相对导入形式 → ./ ../ 形式路径（'..' → '../'，'.pkg' → './pkg'，'..pkg' → '../pkg'） */
function pyRelToPath(p: string): string {
  let dots = 0;
  let i = 0;
  while (i < p.length && p[i] === '.') {
    dots++;
    i++;
  }
  const rest = p.slice(i).replace(/\./g, '/');
  if (dots <= 1) return `./${rest}`;
  return `${'../'.repeat(dots - 1)}${rest}`;
}

/**
 * 判定层间依赖违规：from 层引用了不在其 allowed_deps 内的 to 层。
 * allowed_deps 解析顺序：层定义内 allowed_deps → 内置 DEFAULT_ALLOWED_DEPS → 允许一切（不误报）。
 * 同层引用不判违规；未归类（core）/无规则层不判违规。
 */
export function detectLayerViolations(input: DetectLayerViolationsInput): LayerViolation[] {
  const { defs, fileLayers, edges } = input;
  const allowedOf = (layerId: string): Set<string> | null => {
    const d = defs.find((x) => x.id === layerId);
    const list = d?.allowed_deps ?? DEFAULT_ALLOWED_DEPS[layerId];
    return list ? new Set(list) : null;
  };
  const out: LayerViolation[] = [];
  for (const e of edges) {
    const fromLayer = fileLayers[e.from];
    const toLayer = fileLayers[e.to];
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
    // core 是"未归类兜底"而非架构层：依赖它/被它依赖不算架构违规，避免噪音
    if (fromLayer === 'core' || toLayer === 'core') continue;
    const allowed = allowedOf(fromLayer);
    if (!allowed || allowed.has(toLayer)) continue;
    out.push({
      from_file: e.from,
      from_layer: fromLayer,
      to_file: e.to,
      to_layer: toLayer,
      via: e.via,
    });
  }
  return out;
}
