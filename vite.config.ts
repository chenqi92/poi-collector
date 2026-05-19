import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  build: {
    // Tauri 内嵌的 webview 是固定较新版本，可以放心吃高 ES 特性
    target: "esnext",
    // 预生成 <link rel="modulepreload"> 让浏览器在主包解析期间并行抓 lazy chunk
    modulePreload: { polyfill: false },
    // 手动按依赖分组，让 React / Leaflet / Radix 各占独立 chunk，可独立缓存
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          leaflet: ["leaflet", "react-leaflet", "leaflet-draw", "leaflet.markercluster"],
        },
      },
    },
    chunkSizeWarningLimit: 800,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Force IPv4 for Tauri compatibility
    host: '127.0.0.1',
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
