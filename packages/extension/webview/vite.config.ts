import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const isDemo = mode === "demo";
  const base = process.env.VITE_BASE || "./";

  return {
    plugins: [vue()],
    base,
    define: {
      __GIT_INSIGHT_PREVIEW__: JSON.stringify(false),
      __GIT_INSIGHT_DEMO__: JSON.stringify(isDemo),
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
    build: {
      outDir: resolve(__dirname, isDemo ? "../dist/pages" : "../dist/webview"),
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
  };
});
