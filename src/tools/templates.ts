/**
 * 模板库
 *
 * 预置常见架构模板，一键生成设计起点。
 * LLM 或用户可以基于模板快速创建 feature，然后增量修改。
 *
 * 内置模板：
 * - crud_service: CRUD 服务（API → Service → Repository → DB）
 * - event_driven: 事件驱动（Producer → Queue → Consumer → Store）
 * - microservice: 微服务拓扑（Gateway → Service×N → Shared DB）
 * - pipeline: 数据管道（Source → Transform → Sink）
 */

import type { DesignDSL, Node, Edge } from '../dsl/types.js';
import { saveDSL, getDSL } from '../storage.js';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  node_count: number;
  edge_count: number;
  tags: string[];
}

interface Template {
  info: TemplateInfo;
  build: (featureName: string, title?: string) => DesignDSL;
}

// ─────────────────────────────────────────────────────────────
// 模板定义
// ─────────────────────────────────────────────────────────────

const templates: Template[] = [
  {
    info: {
      id: 'crud_service',
      name: 'CRUD 服务',
      description: '标准 CRUD 架构：API 接口层 → 业务服务层 → 数据访问层 → 数据库',
      node_count: 5,
      edge_count: 4,
      tags: ['web', 'backend', 'rest'],
    },
    build: (feature, title) => ({
      id: 'feature_' + feature,
      type: 'feature_diagram',
      feature,
      version: '1.0.0',
      title: title || 'CRUD 服务',
      status: 'draft',
      geometry: {
        layout: 'vertical_flow',
        width: 600,
        height: 500,
        nodes: [
          { id: 'api', label: 'API 接口层', type: 'api', x: 200, y: 40, width: 160, height: 60 },
          { id: 'service', label: '业务服务层', type: 'service', x: 200, y: 140, width: 160, height: 60 },
          { id: 'validator', label: '数据校验', type: 'service', x: 200, y: 240, width: 160, height: 60 },
          { id: 'repo', label: '数据访问层', type: 'service', x: 200, y: 340, width: 160, height: 60 },
          { id: 'db', label: '数据库', type: 'database', x: 200, y: 440, width: 160, height: 60 },
        ],
        edges: [
          { id: 'e1', from: 'api', to: 'service', label: '调用' },
          { id: 'e2', from: 'service', to: 'validator', label: '校验' },
          { id: 'e3', from: 'validator', to: 'repo', label: '持久化' },
          { id: 'e4', from: 'repo', to: 'db', label: '读写' },
        ],
      },
      semantic: { files: [], multi_file_invariants: [] },
      annotations: [],
    }),
  },
  {
    info: {
      id: 'event_driven',
      name: '事件驱动',
      description: '事件驱动架构：生产者 → 消息队列 → 消费者 → 存储',
      node_count: 6,
      edge_count: 5,
      tags: ['async', 'messaging', 'backend'],
    },
    build: (feature, title) => ({
      id: 'feature_' + feature,
      type: 'feature_diagram',
      feature,
      version: '1.0.0',
      title: title || '事件驱动架构',
      status: 'draft',
      geometry: {
        layout: 'vertical_flow',
        width: 700,
        height: 500,
        nodes: [
          { id: 'producer', label: '事件生产者', type: 'service', x: 50, y: 40, width: 140, height: 60 },
          { id: 'queue', label: '消息队列', type: 'queue', x: 250, y: 140, width: 140, height: 60 },
          { id: 'consumer1', label: '消费者 A', type: 'service', x: 100, y: 260, width: 140, height: 60 },
          { id: 'consumer2', label: '消费者 B', type: 'service', x: 350, y: 260, width: 140, height: 60 },
          { id: 'store1', label: '存储 A', type: 'database', x: 100, y: 380, width: 140, height: 60 },
          { id: 'store2', label: '存储 B', type: 'database', x: 350, y: 380, width: 140, height: 60 },
        ],
        edges: [
          { id: 'e1', from: 'producer', to: 'queue', label: '发布事件' },
          { id: 'e2', from: 'queue', to: 'consumer1', label: '订阅' },
          { id: 'e3', from: 'queue', to: 'consumer2', label: '订阅' },
          { id: 'e4', from: 'consumer1', to: 'store1', label: '写入' },
          { id: 'e5', from: 'consumer2', to: 'store2', label: '写入' },
        ],
      },
      semantic: { files: [], multi_file_invariants: [] },
      annotations: [],
    }),
  },
  {
    info: {
      id: 'microservice',
      name: '微服务拓扑',
      description: '微服务架构：API 网关 → 多个微服务 → 共享数据库 + 配置中心',
      node_count: 7,
      edge_count: 8,
      tags: ['microservice', 'distributed', 'backend'],
    },
    build: (feature, title) => ({
      id: 'feature_' + feature,
      type: 'feature_diagram',
      feature,
      version: '1.0.0',
      title: title || '微服务拓扑',
      status: 'draft',
      geometry: {
        layout: 'vertical_flow',
        width: 700,
        height: 500,
        nodes: [
          { id: 'gateway', label: 'API 网关', type: 'api', x: 280, y: 40, width: 140, height: 60 },
          { id: 'auth', label: '认证服务', type: 'service', x: 80, y: 140, width: 140, height: 60 },
          { id: 'user', label: '用户服务', type: 'service', x: 280, y: 140, width: 140, height: 60 },
          { id: 'order', label: '订单服务', type: 'service', x: 480, y: 140, width: 140, height: 60 },
          { id: 'db', label: '共享数据库', type: 'database', x: 280, y: 280, width: 140, height: 60 },
          { id: 'config', label: '配置中心', type: 'service', x: 80, y: 380, width: 140, height: 60 },
          { id: 'registry', label: '服务注册', type: 'service', x: 480, y: 380, width: 140, height: 60 },
        ],
        edges: [
          { id: 'e1', from: 'gateway', to: 'auth', label: '路由' },
          { id: 'e2', from: 'gateway', to: 'user', label: '路由' },
          { id: 'e3', from: 'gateway', to: 'order', label: '路由' },
          { id: 'e4', from: 'auth', to: 'db', label: '读写' },
          { id: 'e5', from: 'user', to: 'db', label: '读写' },
          { id: 'e6', from: 'order', to: 'db', label: '读写' },
          { id: 'e7', from: 'auth', to: 'config', label: '配置' },
          { id: 'e8', from: 'user', to: 'registry', label: '注册' },
        ],
      },
      semantic: { files: [], multi_file_invariants: [] },
      annotations: [],
    }),
  },
  {
    info: {
      id: 'pipeline',
      name: '数据管道',
      description: '数据处理管道：数据源 → 清洗 → 转换 → 聚合 → 输出',
      node_count: 5,
      edge_count: 4,
      tags: ['data', 'etl', 'pipeline'],
    },
    build: (feature, title) => ({
      id: 'feature_' + feature,
      type: 'feature_diagram',
      feature,
      version: '1.0.0',
      title: title || '数据管道',
      status: 'draft',
      geometry: {
        layout: 'horizontal_flow',
        width: 900,
        height: 200,
        nodes: [
          { id: 'source', label: '数据源', type: 'database', x: 40, y: 60, width: 140, height: 60 },
          { id: 'clean', label: '数据清洗', type: 'service', x: 220, y: 60, width: 140, height: 60 },
          { id: 'transform', label: '数据转换', type: 'service', x: 400, y: 60, width: 140, height: 60 },
          { id: 'aggregate', label: '数据聚合', type: 'service', x: 580, y: 60, width: 140, height: 60 },
          { id: 'sink', label: '输出存储', type: 'database', x: 760, y: 60, width: 140, height: 60 },
        ],
        edges: [
          { id: 'e1', from: 'source', to: 'clean', label: '抽取' },
          { id: 'e2', from: 'clean', to: 'transform', label: '清洗后' },
          { id: 'e3', from: 'transform', to: 'aggregate', label: '转换后' },
          { id: 'e4', from: 'aggregate', to: 'sink', label: '加载' },
        ],
      },
      semantic: { files: [], multi_file_invariants: [] },
      annotations: [],
    }),
  },
];

// ─────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────

export interface ListTemplatesResult {
  message: string;
  templates: TemplateInfo[];
}

export function listTemplates(): ListTemplatesResult {
  const lines: string[] = ['可用模板 (' + templates.length + ' 个):', ''];
  for (const t of templates) {
    lines.push('  [' + t.info.id + '] ' + t.info.name);
    lines.push('    ' + t.info.description);
    lines.push('    节点: ' + t.info.node_count + ', 边: ' + t.info.edge_count + ', 标签: ' + t.info.tags.join(', '));
  }
  return { message: lines.join('\n'), templates: templates.map(t => t.info) };
}

export interface CreateFromTemplateInput {
  template_id: string;
  feature: string;
  title?: string;
}

export interface CreateFromTemplateResult {
  message: string;
  feature: string;
  template_id: string;
  node_count: number;
  edge_count: number;
}

export function createFromTemplate(input: CreateFromTemplateInput): CreateFromTemplateResult {
  const { template_id, feature, title } = input;

  if (!/^[a-zA-Z0-9_-]+$/.test(feature)) {
    throw new Error('非法 feature 名: "' + feature + '"');
  }

  const template = templates.find(t => t.info.id === template_id);
  if (!template) {
    throw new Error('模板 "' + template_id + '" 不存在，使用 list_templates 查看可用模板');
  }

  const existing = getDSL(feature);
  if (existing) {
    throw new Error('feature "' + feature + '" 已存在');
  }

  const dsl = template.build(feature, title);
  saveDSL(dsl);

  return {
    message: [
      '已从模板创建 feature: ' + feature,
      '模板: ' + template.info.name + ' (' + template_id + ')',
      '标题: ' + dsl.title,
      '节点: ' + dsl.geometry.nodes.length + ' 个',
      '边: ' + (dsl.geometry.edges?.length ?? 0) + ' 条',
      '',
      '使用 render_design 渲染画布，或用 add_node / add_edge 继续编辑',
    ].join('\n'),
    feature,
    template_id,
    node_count: dsl.geometry.nodes.length,
    edge_count: dsl.geometry.edges?.length ?? 0,
  };
}
