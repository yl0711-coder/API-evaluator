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
});
