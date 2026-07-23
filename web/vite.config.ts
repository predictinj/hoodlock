import { defineConfig } from "vite";
import { resolve } from "path";

// Two-page build: the marketing landing (/) and the app (/app.html).
// `npx vite build web` (Dockerfile) picks this config up from web/.
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
      },
    },
  },
});
