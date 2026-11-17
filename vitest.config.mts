import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // Τα tests της κάρτας έγκρισης θέλουν την αυτόνομη αναζήτηση κλειστή· όσα τη δοκιμάζουν τη ρυθμίζουν μόνα τους.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000, env: { AUTO_SEARCHES_PER_DAY: "0" } },
});
