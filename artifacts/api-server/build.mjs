import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, copyFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      // "nodemailer" / "pdf-parse" / "mammoth" — pure-JS, bundle cleanly.
      // Keeping them external caused ERR_MODULE_NOT_FOUND in production
      // because the runtime image only ships the esbuild bundle, not
      // node_modules. They are dynamically `import()`-ed from
      // routes/bank-reconciliation.ts (PDF / DOCX statement parsing) and
      // must be inlined for the deployed bundle to find them.
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/pubsub",
      "@google-cloud/bigquery",
      "@google-cloud/firestore",
      "@google-cloud/secret-manager",
      "@google/*",
      "googleapis",
      "firebase-admin",
      // Note: @google-cloud/storage is imported at module top-level in
      // src/lib/objectStorage.ts and objectAcl.ts. We intentionally let
      // esbuild bundle it (do NOT add "@google-cloud/storage" to
      // "@google-cloud/*"-style globs) — the runtime image does not
      // ship node_modules, so externalizing it causes ERR_MODULE_NOT_FOUND
      // on boot.
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] }),
      // drizzle-kit/api dynamically imports optional DB drivers (pglite, neon,
      // libsql, planetscale, vercel-postgres, postgres, op-sqlite, expo-sqlite)
      // for dialects we don't use. We only use node-postgres ("pg"). Marking
      // them as `external` doesn't help because Node still resolves dynamic
      // import specifiers eagerly. Instead, redirect them to an empty in-memory
      // module so the bundle is self-contained and the unused branches throw
      // only if ever hit at runtime (they aren't, since we use pg).
      {
        name: "stub-optional-db-drivers",
        setup(build) {
          const stubbed = new Set([
            "@electric-sql/pglite",
            "postgres",
            "@vercel/postgres",
            "@neondatabase/serverless",
            "@planetscale/database",
            "@libsql/client",
            "@op-engineering/op-sqlite",
            "expo-sqlite",
            "mysql2",
            "mysql2/promise",
            "better-sqlite3",
            "esbuild-register/dist/node",
            // drizzle-orm dialect entrypoints we don't use. We only use
            // drizzle-orm/node-postgres + drizzle-orm/pg-core. The others
            // are referenced via dynamic import inside drizzle-kit/api.
            "drizzle-orm/aws-data-api/pg",
            "drizzle-orm/aws-data-api/pg/migrator",
            "drizzle-orm/better-sqlite3",
            "drizzle-orm/better-sqlite3/migrator",
            "drizzle-orm/d1",
            "drizzle-orm/d1/migrator",
            "drizzle-orm/libsql",
            "drizzle-orm/libsql/migrator",
            "drizzle-orm/mysql2",
            "drizzle-orm/mysql2/migrator",
            "drizzle-orm/neon-serverless",
            "drizzle-orm/neon-serverless/migrator",
            "drizzle-orm/pglite",
            "drizzle-orm/pglite/migrator",
            "drizzle-orm/planetscale-serverless",
            "drizzle-orm/planetscale-serverless/migrator",
            "drizzle-orm/postgres-js",
            "drizzle-orm/postgres-js/migrator",
            "drizzle-orm/singlestore",
            "drizzle-orm/singlestore/migrator",
            "drizzle-orm/sqlite-proxy",
            "drizzle-orm/sqlite-proxy/migrator",
            "drizzle-orm/vercel-postgres",
            "drizzle-orm/vercel-postgres/migrator",
          ]);
          build.onResolve({ filter: /.*/ }, (args) => {
            if (stubbed.has(args.path)) {
              return { path: args.path, namespace: "stub-driver" };
            }
            return null;
          });
          build.onLoad({ filter: /.*/, namespace: "stub-driver" }, (args) => ({
            contents: `throw new Error("Optional DB driver '${args.path}' is not bundled — only the 'pg' driver is supported in this runtime.");`,
            loader: "js",
          }));
        },
      },
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  // pdf-parse v2 → pdfjs-dist v5 spawns a worker thread from a sibling
  // file `pdf.worker.mjs` resolved relative to the running script's
  // directory. In production the only thing shipped is the esbuild
  // bundle (no node_modules), so the worker file is missing and we get
  // `Setting up fake worker failed: Cannot find module .../dist/pdf.worker.mjs`.
  // Copy the worker next to the bundle so pdfjs's default lookup works.
  const pdfParseEntry = createRequire(import.meta.url).resolve("pdf-parse");
  const pdfWorkerSrc = path.resolve(path.dirname(pdfParseEntry), "pdf.worker.mjs");
  await copyFile(pdfWorkerSrc, path.resolve(distDir, "pdf.worker.mjs"));
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
