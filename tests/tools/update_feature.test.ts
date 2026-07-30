/**
 * update_feature 统一写操作入口测试
 *
 * 覆盖场景：
 * - node：add / update / delete / move
 * - edge：add / update（删除重建）/ delete
 * - file：add / update / delete
 * - api：add / update / delete
 * - binding：节点与文件绑定
 * - status：状态更新（同步 file + 重算 feature 状态）
 * - 批量混合操作按顺序执行
 * - 原子性：任一失败全部回滚
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFeature } from '../../src/tools/feature_ops';
import { updateFeature } from '../../src/tools/update_feature';
import { clearAllFeatures, getDSL } from '../../src/storage';

describe('update_feature - 节点操作', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('add node：批量添加多个节点', () => {
    createFeature({ feature: 'uf_node_add' });
    const result = updateFeature({
      feature: 'uf_node_add',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: { label: '服务A', x: 100, y: 100, type: 'service' } },
        { op: 'add', type: 'node', id: 'n2', data: { label: '数据库', x: 300, y: 100, type: 'database', status: 'in_progress' } },
      ],
    });
    expect(result.message).toContain('2 个操作');
    const dsl = getDSL('uf_node_add')!;
    expect(dsl.geometry.nodes).toHaveLength(2);
    expect(dsl.geometry.nodes[0].label).toBe('服务A');
    expect(dsl.geometry.nodes[1].status).toBe('in_progress');
  });

  it('update node：仅修改传入字段', () => {
    createFeature({ feature: 'uf_node_upd' });
    updateFeature({
      feature: 'uf_node_upd',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: { label: '旧标签', x: 10, y: 20 } },
        { op: 'update', type: 'node', id: 'n1', data: { label: '新标签', bg: '#FF0000' } },
      ],
    });
    const node = getDSL('uf_node_upd')!.geometry.nodes[0];
    expect(node.label).toBe('新标签');
    expect(node.x).toBe(10); // 未传入字段保持不变
    expect(node.style?.bg).toBe('#FF0000');
  });

  it('move node：相对平移 dx/dy', () => {
    createFeature({ feature: 'uf_node_move' });
    updateFeature({
      feature: 'uf_node_move',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: { x: 100, y: 100 } },
        { op: 'move', type: 'node', id: 'n1', data: { dx: 50, dy: -30 } },
      ],
    });
    const node = getDSL('uf_node_move')!.geometry.nodes[0];
    expect(node.x).toBe(150);
    expect(node.y).toBe(70);
  });

  it('delete node：连带删除关联边', () => {
    createFeature({ feature: 'uf_node_del' });
    updateFeature({
      feature: 'uf_node_del',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: {} },
        { op: 'add', type: 'node', id: 'n2', data: {} },
        { op: 'add', type: 'edge', id: 'e1', data: { from: 'n1', to: 'n2' } },
        { op: 'delete', type: 'node', id: 'n1' },
      ],
    });
    const dsl = getDSL('uf_node_del')!;
    expect(dsl.geometry.nodes).toHaveLength(1);
    expect(dsl.geometry.edges).toHaveLength(0);
  });
});

describe('update_feature - 边操作', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('add edge：完整属性', () => {
    createFeature({ feature: 'uf_edge_add' });
    updateFeature({
      feature: 'uf_edge_add',
      operations: [
        { op: 'add', type: 'node', id: 'a', data: {} },
        { op: 'add', type: 'node', id: 'b', data: {} },
        { op: 'add', type: 'edge', id: 'e1', data: { from: 'a', to: 'b', label: '调用', edge_type: 'curve', arrow: 'both' } },
      ],
    });
    const edge = getDSL('uf_edge_add')!.geometry.edges[0];
    expect(edge.from).toBe('a');
    expect(edge.label).toBe('调用');
    expect(edge.type).toBe('curve');
    expect(edge.arrow).toBe('both');
  });

  it('update edge：删除重建并保留未修改字段', () => {
    createFeature({ feature: 'uf_edge_upd' });
    updateFeature({
      feature: 'uf_edge_upd',
      operations: [
        { op: 'add', type: 'node', id: 'a', data: {} },
        { op: 'add', type: 'node', id: 'b', data: {} },
        { op: 'add', type: 'edge', id: 'e1', data: { from: 'a', to: 'b', label: '旧标签', edge_type: 'straight' } },
        { op: 'update', type: 'edge', id: 'e1', data: { label: '新标签' } },
      ],
    });
    const edge = getDSL('uf_edge_upd')!.geometry.edges[0];
    expect(edge.label).toBe('新标签');
    expect(edge.type).toBe('straight'); // 未修改字段保留
  });

  it('add edge 缺少 from/to 报错', () => {
    createFeature({ feature: 'uf_edge_bad' });
    expect(() =>
      updateFeature({
        feature: 'uf_edge_bad',
        operations: [{ op: 'add', type: 'edge', id: 'e1', data: { from: 'a' } }],
      }),
    ).toThrow(/data\.from 和 data\.to/);
  });
});

describe('update_feature - 语义层操作', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('file：add / update / delete 全流程', () => {
    createFeature({ feature: 'uf_file' });
    updateFeature({
      feature: 'uf_file',
      operations: [
        { op: 'add', type: 'file', id: 'f1', data: { path: 'service/user.go', responsibility: '用户服务' } },
        { op: 'update', type: 'file', id: 'f1', data: { responsibility: '用户认证服务', status: 'in_progress' } },
      ],
    });
    let file = getDSL('uf_file')!.semantic!.files[0];
    expect(file.responsibility).toBe('用户认证服务');
    expect(file.status).toBe('in_progress');

    updateFeature({
      feature: 'uf_file',
      operations: [{ op: 'delete', type: 'file', id: 'f1' }],
    });
    expect(getDSL('uf_file')!.semantic!.files).toHaveLength(0);
  });

  it('api：add / update / delete 全流程', () => {
    createFeature({ feature: 'uf_api' });
    updateFeature({
      feature: 'uf_api',
      operations: [
        { op: 'add', type: 'file', id: 'f1', data: { path: 'svc.go', responsibility: '服务' } },
        { op: 'add', type: 'api', id: 'f1', data: { signature: 'Login(u string) (string, error)', notes: '登录' } },
        { op: 'add', type: 'api', id: 'f1', data: { signature: 'Logout() error' } },
        { op: 'update', type: 'api', id: 'f1', data: { signature: 'Logout() error', new_signature: 'Logout(ctx) error', notes: '登出' } },
      ],
    });
    let apis = getDSL('uf_api')!.semantic!.files[0].expected_apis!;
    expect(apis).toHaveLength(2);
    expect(apis[1].signature).toBe('Logout(ctx) error');

    updateFeature({
      feature: 'uf_api',
      operations: [{ op: 'delete', type: 'api', id: 'f1', data: { signature: 'Login(u string) (string, error)' } }],
    });
    apis = getDSL('uf_api')!.semantic!.files[0].expected_apis!;
    expect(apis).toHaveLength(1);
  });

  it('binding：绑定节点与文件并同步状态', () => {
    createFeature({ feature: 'uf_bind' });
    updateFeature({
      feature: 'uf_bind',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: { label: '用户服务' } },
        { op: 'add', type: 'file', id: 'n1', data: { path: 'svc/user.go', responsibility: '用户服务', status: 'done' } },
        { op: 'update', type: 'binding', id: 'n1', data: { file_id: 'n1' } },
      ],
    });
    const dsl = getDSL('uf_bind')!;
    expect(dsl.geometry.nodes[0].status).toBe('done');
    expect(dsl.semantic!.files[0].status).toBe('done');
  });

  it('status：更新状态并重算 feature 整体状态', () => {
    createFeature({ feature: 'uf_status' });
    updateFeature({
      feature: 'uf_status',
      operations: [
        { op: 'add', type: 'node', id: 'n1', data: {} },
        { op: 'add', type: 'node', id: 'n2', data: {} },
        { op: 'update', type: 'status', id: 'n1', data: { status: 'done' } },
      ],
    });
    const dsl = getDSL('uf_status')!;
    expect(dsl.geometry.nodes[0].status).toBe('done');
    expect(dsl.status).toBe('in_progress'); // 1 done + 1 draft → 整体 in_progress
  });
});

describe('update_feature - 原子性', () => {
  beforeEach(() => clearAllFeatures());
  afterEach(() => clearAllFeatures());

  it('中途失败回滚全部变更', () => {
    createFeature({ feature: 'uf_rollback' });
    updateFeature({
      feature: 'uf_rollback',
      operations: [{ op: 'add', type: 'node', id: 'existing', data: { label: '原有节点' } }],
    });

    // 第二个操作重复添加 existing → 失败，第一个操作添加的 new_node 应被回滚
    expect(() =>
      updateFeature({
        feature: 'uf_rollback',
        operations: [
          { op: 'add', type: 'node', id: 'new_node', data: {} },
          { op: 'add', type: 'node', id: 'existing', data: {} },
        ],
      }),
    ).toThrow(/回滚/);

    const dsl = getDSL('uf_rollback')!;
    expect(dsl.geometry.nodes).toHaveLength(1);
    expect(dsl.geometry.nodes[0].id).toBe('existing');
  });

  it('失败时抛出错误包含操作进度和原因', () => {
    createFeature({ feature: 'uf_err_msg' });
    try {
      updateFeature({
        feature: 'uf_err_msg',
        operations: [
          { op: 'add', type: 'node', id: 'n1', data: {} },
          { op: 'delete', type: 'node', id: 'ghost' },
        ],
      });
      expect.unreachable('不应到达');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('2/2');
      expect(msg).toContain('回滚');
      expect(msg).toContain('ghost');
    }
  });

  it('feature 不存在直接报错', () => {
    expect(() =>
      updateFeature({
        feature: 'ghost_feature',
        operations: [{ op: 'add', type: 'node', id: 'n1', data: {} }],
      }),
    ).toThrow(/不存在/);
  });

  it('operations 为空报错', () => {
    createFeature({ feature: 'uf_empty' });
    expect(() =>
      updateFeature({ feature: 'uf_empty', operations: [] }),
    ).toThrow(/不能为空/);
  });
});
