import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
    resolve: { alias: { "@lukas.b97/umwelt": fileURLToPath(new URL("src/index.ts", import.meta.url)) } },
    test: {
        include: ["test/**/*.test.ts"],
        globalSetup: ["test/postgres.ts"],
        hookTimeout: 120_000,
        testTimeout: 30_000
    }
})
