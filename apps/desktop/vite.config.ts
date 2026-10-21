import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative asset URLs so the packaged custom protocol can load JS/CSS.
  base: "./",
  clearScreen: false,
  build: {
    manifest: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the terminal off the startup chunk even if a future import is
          // static. highlight.js core stays a dynamic import: forcing it into
          // a manual chunk pulls a shared binding back into the startup script.
          // Grammars stay one chunk each. `scripts/check-chunks.mjs` locks both.
          const normalized = id.replaceAll("\\", "/");
          if (normalized.includes("/node_modules/@xterm/")) return "xterm";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
