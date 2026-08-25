import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        rewrite: (path) => path.replace(/^\/api\/v1/, "/v1"),
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
