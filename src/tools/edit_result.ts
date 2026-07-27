/**
 * 编辑操作统一返回类型
 */

/** 所有 edit 操作的统一返回：人话消息 + 目标 feature */
export interface EditResult {
  message: string;
  feature: string;
}
