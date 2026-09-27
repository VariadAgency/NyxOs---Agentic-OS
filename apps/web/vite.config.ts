import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Im Entwicklungsmodus gehen API und /live an den lokalen Probe-Server.
const target = process.env.NYXOS_API ?? "http://127.0.0.1:47890";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": target,
      "/health": target,
      "/live": { target: target.replace(/^http/, "ws"), ws: true },
    },
  },
});
