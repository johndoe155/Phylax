import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * Server tests, in Node. They need the `@shared` alias, because the server imports the shared domain modules
 * the same way the browser did.
 */
export default defineConfig({
  resolve: { alias: { "@shared": path.join(root, "shared") } },
  test: {
    name: "server",
    root: path.join(root, "server"),
    include: ["**/*.test.ts"],
    environment: "node",
    // The integration tests share one database, so they must not run at the same time.
    fileParallelism: false,
    testTimeout: 30000,
  },
});
