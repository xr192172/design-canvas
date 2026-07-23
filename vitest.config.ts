import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 共享 storage 目录（.design-canvas/features/），多文件并行会相互清理
    // 改为单线程串行跑，避免测试间状态污染
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
