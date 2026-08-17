import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  // 源码定位只在明确需要时启用，避免日常开发为每个 TSX 生成额外 AST 与 sourcemap。
  plugins: [...(process.env.KIMI_INSPECT === '1' ? [inspectAttr()] : []), react()],
  server: {
    port: 3217, // 项目专属端口，避开其他预览
    strictPort: true,
    hmr: false, // 关闭自动热更新，改动后手动刷新页面
    // Vite 只负责前端资源；规则模拟与会话状态运行在独立 Node/Worker 进程。
    proxy: {
      '/api': {
        target: process.env.THREEBODY_API_ORIGIN ?? 'http://127.0.0.1:3220',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
