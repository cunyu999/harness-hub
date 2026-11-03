import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';

// 前端构建产物直接交给后端静态托管; 开发时把 /api 代理到本机服务。
export default defineConfig({
  root: path.resolve(import.meta.dirname, '.'),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 4311,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4310',
        changeOrigin: false,
      },
    },
  },
});
