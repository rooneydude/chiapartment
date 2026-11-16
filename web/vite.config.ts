import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/chiapartment/",
  plugins: [react()],
  build: {
    // three.js arrives with the 3D view as one large file, loaded only when a
    // building page asks for it.
    chunkSizeWarningLimit: 1200,
    // No manualChunks on purpose. Naming the 3D and chart libraries as chunks
    // also pulls what they share with the rest of the app — React itself —
    // into those files, and then the dashboard cannot start until the whole
    // 3D library has downloaded (or at all, if that download fails). Split
    // along the lazy imports instead: the dashboard gets only what it uses.
  },
});
