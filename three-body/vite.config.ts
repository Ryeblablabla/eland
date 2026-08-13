import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { loadLlmKey } from "./server/env"
import { handleElandApi } from "./server/eland-api"
import { normalizeModelProvider } from "./src/game/llm"

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => resolve(raw))
  })
}

function sendJson(res: import("http").ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(body))
}

/** ELAND 决策服务（/api/decide，客户端 BatchDecider 的兼容入口） */
function elandDecideApi(): Plugin {
  return {
    name: "eland-decide-api",
    configureServer(server) {
      server.middlewares.use("/api/decide", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return }
        void (async () => {
          try {
            const { handleDecide } = await import("./server/kimi-gateway")
            const payload = JSON.parse(await readBody(req)) as { model?: unknown }
            const provider = normalizeModelProvider(payload.model)
            const result = await handleDecide(payload, loadLlmKey(provider), provider)
            sendJson(res, result.status, result.body)
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      })
    },
  }
}

/** 演化会话后端：单步 / 自动 / 天象 / 历史回放 / 截断续演 */
function elandSessionApi(): Plugin {
  return {
    name: "eland-session-api",
    configureServer(server) {
      server.middlewares.use("/api/eland", (req, res) => {
        void (async () => {
          try {
            const url = new URL(`/api/eland${req.url ?? ""}`, "http://localhost")
            const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {}
            const result = await handleElandApi(req.method, url, body)
            return sendJson(res, result.status, result.body)
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), elandDecideApi(), elandSessionApi()],
  server: {
    port: 3217, // 项目专属端口，避开其他预览
    strictPort: false, // 被占用时自动递增到空闲端口
    hmr: false, // 关闭自动热更新，改动后手动刷新页面
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
