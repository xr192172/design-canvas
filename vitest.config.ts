import { defineConfig } from 'vitest/config';

export default defineConfig({
  // node:sqlite 是 Node 22.5+ 内建模块，Vite 5 的内建清单不认识它，
  // 会剥掉 node: 前缀当文件路径解析（Failed to load url sqlite）——SSR external 跳过转换
  ssr: {
    external: ['node:sqlite'],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
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
