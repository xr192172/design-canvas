import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    // 全局 setup：DESIGN_CANVAS_HOME 指向临时目录，隔离测试对活态 DSL 的写入
    setupFiles: ['tests/setup.ts'],
    // 共享 storage 目录（.design-canvas/features/），多文件并行会相互清理
    // 改为单线程串行跑，避免测试间状态污染
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
