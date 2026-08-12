import { resolve } from "node:path";
import { defineConfig } from "vite";

const vitePort = Number(process.env.VITE_PORT || 5179);
const apiPort = Number(process.env.API_PORT || 5180);

export default defineConfig({
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: vitePort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
    },
  },
  build: {
    // 多页构建：主站 + 独立的「模型档案」页。
    // 模型档案的视觉风格（印刷版式）与主站差别大，做成独立入口后它不加载主站 styles.css，
    // 两套皮肤互不牵制；产物为 dist/model-profile/index.html，对应线上路径 /model-profile/。
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        "model-profile": resolve(import.meta.dirname, "model-profile/index.html"),
      },
    },
  },
});
