import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/chiapartment/",
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200, // three.js is a single large vendor chunk
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei"],
          charts: ["recharts"],
        },
      },
    },
  },
});
