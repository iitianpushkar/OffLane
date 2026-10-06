import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "web/index.html"),
        app: resolve(import.meta.dirname, "web/app/index.html"),
        demo: resolve(import.meta.dirname, "web/demo/index.html"),
      },
    },
  },
});
