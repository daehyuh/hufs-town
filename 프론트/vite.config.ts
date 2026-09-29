import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = [".localhost", "127.0.0.1", "::1"];
  const configuredHosts = [
    env.TOWN_VITE_ALLOWED_HOSTS ?? "",
    process.env.TOWN_VITE_ALLOWED_HOSTS ?? "",
  ].join(",");
  for (const host of configuredHosts.split(",")) {
    const value = host.trim();
    if (value && !allowedHosts.includes(value)) allowedHosts.push(value);
  }
  return {
    plugins: [react()],
    server: {
      host: env.TOWN_VITE_HOST ?? "::1",
      port: 5173,
      strictPort: true,
      allowedHosts,
      headers: {
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store",
      },
      proxy: {
        "/api":
          process.env.TOWN_API_TARGET ??
          env.TOWN_API_TARGET ??
          "http://127.0.0.1:18080",
        "/world": {
          target:
            process.env.TOWN_WORLD_TARGET ??
            env.TOWN_WORLD_TARGET ??
            "http://127.0.0.1:18081",
          ws: true,
        },
      },
    },
    build: {
      rollupOptions: { output: { manualChunks: { phaser: ["phaser"] } } },
    },
  };
});
