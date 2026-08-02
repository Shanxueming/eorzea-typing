import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发态下 wordbanks / assets / WebSocket 全部由 apps/server 提供,
// 生产态由同一个 Fastify 进程直接托管 dist 产物,不需要代理。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 不写 host 的话 Windows 上 Vite 有时只绑定 IPv6 的 ::1,
    // 浏览器把 localhost 解析成 127.0.0.1(IPv4)时会连不上。显式绑所有网卡。
    host: true,
    proxy: {
      '/api': 'http://localhost:8799',
      '/wordbanks': 'http://localhost:8799',
      '/assets': 'http://localhost:8799',
      '/ws': { target: 'ws://localhost:8799', ws: true },
    },
  },
  optimizeDeps: {
    exclude: ['@eorzea/shared'],
  },
  build: {
    // Vite 默认把构建产物也放进 dist/assets/,和游戏素材的 /assets/ 静态路由
    // (apps/server 里托管 data/../assets/ 目录)撞名,生产环境下会把 JS/CSS
    // 请求打到素材目录去、404。改个不冲突的目录名。
    assetsDir: 'app-assets',
  },
});
