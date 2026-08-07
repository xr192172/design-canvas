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
 */

import type { DesignDSL, Node, ArchLayer, SemanticFile } from '../dsl/types.js';

/** 层定义：目录/文件名段模式 → 层。首中即止（顺序敏感：更具体的层排前） */
interface LayerDef {
  id: string;
  name: string;
  desc: string;
  color: string;
  patterns: string[];
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

/** 目录段/文件名段和其复数形式做匹配（借用 vendor 的 segment === pattern || segment === pattern + 's' 思路） */
function matchLayer(rel: string): string {
  const segments = rel.replace(/\\/g, '/').split('/');
  for (const L of LAYER_DEFS) {
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

const defOf = (id: string): LayerDef => LAYER_DEFS.find((d) => d.id === id) ?? CORE_DEF;

/**
 * 为 file 节点推断架构层并生成 dsl.layers。
 * 返回加工副本（不就地修改存储 DSL）；已有 arch_layer 的节点不覆盖。
 * 顺带把层名回填到 semantic.files[].responsibility 前缀（职责回填，序号5）。
 */
export function detectArchLayers(dsl: DesignDSL): DesignDSL {
  const byLayer = new Map<string, string[]>();

  const nodes: Node[] = dsl.geometry.nodes.map((n) => {
    if (n.type !== 'file') return n;
    const layer = matchLayer(n.description ?? n.id);
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), n.id]);
    return n.arch_layer ? n : { ...n, arch_layer: layer };
  });

  // 职责回填：把层名加进 SemanticFile 的 responsibility 前缀（若尚未包含），并写入 layer 字段
  let semantic = dsl.semantic;
  if (semantic && semantic.files.length > 0) {
    const layerNameById = (id: string): string => defOf(id).name;
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

  const layers: ArchLayer[] = [...byLayer.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, ids]) => {
      const d = defOf(id);
      return { id, name: d.name, description: d.desc, color: d.color, count: ids.length };
    });

  return { ...dsl, layers, semantic, geometry: { ...dsl.geometry, nodes } };
}