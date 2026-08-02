import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { WORDBANKS_DIR, ASSETS_DIR, WEB_DIST_DIR } from './paths.js';
import { attachRoomServer } from './rooms/server.js';

/** 构建 Fastify 实例并挂上 WebSocket 房间服务器,但不监听端口 —— 交给调用方决定端口。 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  /**
   * BGM 不再约定单一文件名：只暴露 audio 目录下的常见浏览器音频格式。
   * 文件名由服务器编码为静态 URL，前端只展示 name/url，避免客户端枚举本地目录。
   */
  app.get('/api/audio-playlist', async () => {
    const audioDir = path.join(ASSETS_DIR, 'audio');
    const supported = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.aac', '.flac']);
    try {
      const files = await fs.promises.readdir(audioDir, { withFileTypes: true });
      const tracks = files
        .filter((file) => file.isFile() && supported.has(path.extname(file.name).toLowerCase()))
        .map((file) => ({
          name: path.basename(file.name, path.extname(file.name)),
          url: `/assets/audio/${encodeURIComponent(file.name)}`,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      return { tracks };
    } catch {
      return { tracks: [] };
    }
  });

  // 词库只读静态目录。items.json 等大文件由 fastify-static 按需流式传输,
  // 服务端从不把它整体读进内存或转发给不需要的分类。
  await app.register(fastifyStatic, {
    root: WORDBANKS_DIR,
    prefix: '/wordbanks/',
    decorateReply: false,
  });

  // 素材目录,全部可选,不存在的文件由前端走 CSS/Web Audio 降级
  await app.register(fastifyStatic, {
    root: ASSETS_DIR,
    prefix: '/assets/',
    decorateReply: false,
    wildcard: true,
  });

  // 生产构建产物。开发态下 apps/web 由独立的 vite dev server 提供,这里可能不存在。
  if (fs.existsSync(WEB_DIST_DIR)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST_DIR,
      prefix: '/',
      decorateReply: true,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && !req.url.startsWith('/wordbanks') && !req.url.startsWith('/assets')) {
        reply.sendFile('index.html');
        return;
      }
      reply.code(404).send({ error: 'not_found' });
    });
  }

  app.get('/healthz', async () => ({ ok: true }));

  return app;
}

export async function startServer(port: number): Promise<FastifyInstance> {
  const app = await buildApp();
  await app.listen({ port, host: '0.0.0.0' });
  attachRoomServer(app.server);
  return app;
}
