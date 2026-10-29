import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pdfjsAssets } from "./scripts/pdfjs-assets.mjs";

let workspaceTarget;
try { workspaceTarget = new URL(process.env.WORKSPACE_API_URL || "http://127.0.0.1:4177"); }
catch { throw new Error("WORKSPACE_API_URL 必须是本机工作台的 HTTP 回环地址。"); }
if (workspaceTarget.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(workspaceTarget.hostname) ||
  workspaceTarget.username || workspaceTarget.password || workspaceTarget.pathname !== "/" || workspaceTarget.search || workspaceTarget.hash) {
  throw new Error("WORKSPACE_API_URL 必须是本机工作台的 HTTP 回环地址。");
}

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    proxy: Object.fromEntries(["/api", "/mcp", "/health"].map((path) => [path, { target: workspaceTarget.origin, changeOrigin: true }])),
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  preview: { host: "127.0.0.1" },
  plugins: [react(), pdfjsAssets()],
});
