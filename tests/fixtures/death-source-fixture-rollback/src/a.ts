// C链回滚验收现场：原 import './legacy/old'（死 import）已在 apply 阶段被移除，
// 但物理删 old.ts 触发全项目编译回归（scope 外 b.ts 仍活跃使用）→ 工具自动恢复 old.ts 并标 ROLLED_BACK。


export function a(): string {
  return 'a';
}