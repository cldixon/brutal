import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// The web app, built to dist/ for the Worker's static assets. In dev, the Worker (bun run dev at
// the root, port 8787) answers the API.
export default defineConfig({
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    proxy: { "/api": "http://localhost:8787", "/v1": "http://localhost:8787" },
  },
});
