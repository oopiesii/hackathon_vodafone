import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, "../..", "");
  const api = `http://${env.HOST || "127.0.0.1"}:${env.PORT || "8080"}`;
  return {
    plugins: [react()],
    server: {
      port: Number(env.WEB_PORT) || 5173,
      strictPort: true,
      // Браузер бачить один origin, тож cookie сесії працюють без CORS.
      proxy: { "/api": { target: api, changeOrigin: false } },
    },
  };
});
