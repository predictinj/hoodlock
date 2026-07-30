import { defineConfig } from "vite";
import { resolve } from "path";

// Two-page build: the marketing landing (/) and the app (/app.html).
// `npx vite build web` (Dockerfile) picks this config up from web/.
export default defineConfig({
  // The Merkle rules and the list normalisation are shared with the server and
  // with the contract's tests. Aliased rather than copied: a second copy would
  // drift, and a drifted root means every claim fails.
  resolve: {
    alias: { "@shared": resolve(__dirname, "..", "shared") },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        app: resolve(__dirname, "app.html"),
        embed: resolve(__dirname, "embed.html"),
      },
    },
  },
});
