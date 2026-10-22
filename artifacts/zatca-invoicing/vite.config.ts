import { defineConfig } from "vite";
import { robotsHeader, robotsText, frontendSourceMap } from "../api-server/src/lib/crawlPolicy";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
import { staticUiLocalizationPlugin } from "./src/i18n/staticUiLocalizationPlugin";

const isBuild = process.argv.includes("build");
const rawPort = process.env.PORT;

if (!rawPort && !isBuild) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = rawPort ? Number(rawPort) : 5173;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH ?? (isBuild ? "/" : undefined);

if (!basePath) {
  throw new Error(
    "BASE_PATH environment variable is required but was not provided.",
  );
}

// Route-sensitive advisory policy; development source maps/HMR stay intact.
function crawlPolicy() {
  const middleware = (production: boolean) => (req: any, res: any, next: any) => {
    res.setHeader("X-Robots-Tag", robotsHeader(req.url || "/"));
    if (production && /^(GET|HEAD)$/.test(req.method) && frontendSourceMap(req.url || "")) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if ((req.url || "").split("?")[0] === "/robots.txt") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(robotsText(`${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || "localhost"}`));
      return;
    }
    next();
  };
  return {
    name: "crawl-policy",
    configureServer(server: any) {
      server.middlewares.use(middleware(false));
    },
    configurePreviewServer(server: any) {
      server.middlewares.use(middleware(true));
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [
    crawlPolicy(),
    staticUiLocalizationPlugin(),
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    sourcemap: false,
    // Skip the gzip-size report — on this app's large bundle it adds
    // meaningful build time and peak memory for no production benefit.
    reportCompressedSize: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react/jsx-runtime"],
          "router": ["wouter"],
          "query": ["@tanstack/react-query"],
          "radix": [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-select",
            "@radix-ui/react-popover",
            "@radix-ui/react-tooltip",
            "@radix-ui/react-tabs",
            "@radix-ui/react-toast",
          ],
          "icons": ["lucide-react"],
          "charts": ["recharts"],
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/sitemap.xml": {
        target: process.env.API_URL || "http://localhost:8080",
        changeOrigin: true,
        rewrite: () => "/api/sitemap.xml",
      },
      "/robots.txt": {
        target: process.env.API_URL || "http://localhost:8080",
        changeOrigin: true,
        rewrite: () => "/api/robots.txt",
      },
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
