import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [vue()],
  base: "./",
  define: {
    __GIT_INSIGHT_PREVIEW__: JSON.stringify(false),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    outDir: resolve(__dirname, "../dist/webview"),
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
