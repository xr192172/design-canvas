/**
 * 批注层类型（阶段 C · 画布手绘批注覆盖层）
 * 数据挂 DSL 顶层 canvas_notes，独立于语义模型：
 * 仅供前端画布渲染与协作，不参与 get_dsl 语义/代码侧逻辑。
 * 坐标为画布世界坐标（world px），随 world transform 缩放平移。
 */

/** 批注图元类型 */
export type CanvasNoteType = 'highlight' | 'arrow' | 'oval' | 'sticky' | 'text';

/** 批注层图元 */
export interface CanvasNote {
  /** 图元唯一 ID */
  id: string;
  /** 批注套 ID：同一次批注层会话（开启→关闭）内创建的图元共享同一套，一套=一个批注；历史数据缺省时按单元素处理 */
  groupId?: string;
  /** 节点锚定：批注随锚定节点移动/布局重排而跟随；ox/oy = 基准点相对节点左上角的偏移（世界 px）。缺省=绝对坐标 */
  anchor?: { nodeId: string; ox: number; oy: number };
  /** 图元类型 */
  type: CanvasNoteType;
  /** 笔迹/箭头关键点序列 [[x,y],...]（世界坐标） */
  points?: number[][];
  /** 便签/文本锚点 x（世界坐标） */
  x?: number;
  /** 便签/文本锚点 y（世界坐标） */
  y?: number;
  /** 便签/文本宽度（世界 px） */
  w?: number;
  /** 便签/文本高度（世界 px） */
  h?: number;
  /** 便签/文本内容 */
  text?: string;
  /** 颜色（CSS 色值） */
  color?: string;
  /** 笔迹/箭头线宽（世界 px） */
  strokeWidth?: number;
  /** 创建时间 */
  created?: string;
  /** 兼容未知扩展字段（不阻断解析） */
  [key: string]: unknown;
}
