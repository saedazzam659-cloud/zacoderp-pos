import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

const isBuild = process.argv.includes("build");
const rawPort = process.env.PORT;

if (!rawPort && !isBuild) {
  throw new Error("PORT environment variable is required for dev server.");
}

const port = rawPort ? Number(rawPort) : 5173;
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? (isBuild ? "/" : undefined);
if (!basePath) {
  throw new Error("BASE_PATH environment variable is required for dev server.");
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_"],
  server: {
    host: "0.0.0.0",
    port,
    strictPort: true,
    allowedHosts: true,
    hmr: { clientPort: 443 },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: { target: "es2020", minify: "esbuild", sourcemap: false },
});
