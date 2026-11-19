import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative asset URLs so the built app can be served under any path prefix.
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": { target: "ws://localhost:3001", ws: true },
    },
  },
});
