// C链验收现场：原 import './legacy/old'（死 import）已被 deprecate_offline --apply --remove-file 移除，
// 且模块 src/legacy/old.ts 已物理删除（见 git 历史）；本文件仅保留无副作用的导出逻辑。


export function hello(): string {
  return 'hello';
}