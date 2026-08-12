import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // apps/web 下也收:像错题本(engine/mistakes.ts)这种只有 type-only import
    // 的纯逻辑模块,不需要 DOM 也不需要 React,直接跑 node 环境就能测。
    include: ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts'],
    environment: 'node',
  },
});
