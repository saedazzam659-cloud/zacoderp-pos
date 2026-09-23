import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildFreshAgentDatabaseSchema,
  packageSignature,
  verifyPackageEntry,
  type ExternalPackageEntry,
} from "../src/lib/agentExternalPackages.js";

test("fresh schema builder exports structure only and applies the existing external-agent sanitizer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "external-schema-test-"));
  const priorPath = process.env.PATH;
  try {
    const fakeDump = path.join(dir, "pg_dump");
    await writeFile(fakeDump, `#!/bin/sh
case " $* " in *" --schema-only "*) ;; *) exit 17;; esac
case " $* " in *" --exclude-table=public.agent_invoice_samples "*) ;; *) exit 19;; esac
case " $* " in *" --exclude-table=public.agent_invoice_samples_id_seq "*) ;; *) exit 20;; esac
for last; do :; done
[ "$last" = "postgresql://central.example/test" ] || exit 18
while [ "$1" != "--file" ]; do shift; done
printf '%s\\n' '-- PostgreSQL database dump' 'CREATE SCHEMA public;' 'CREATE TABLE public.companies (id integer);' '    invoice_acceleration_mode text,' '\\\\restrict secret' > "$2"
`, { mode: 0o700 });
    await chmod(fakeDump, 0o700);
    process.env.PATH = `${dir}:${priorPath}`;
    const output = await buildFreshAgentDatabaseSchema("postgresql://central.example/test", dir);
    assert.equal(path.basename(output), "database-schema.sql");
    assert.equal(await readFile(output, "utf8"), "-- PostgreSQL database dump\nCREATE TABLE public.companies (id integer);\n");
  } finally {
    process.env.PATH = priorPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("fresh restore policy is signed and cannot be added to an agent dump", () => {
  const previous = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "unit-test-signature-secret-not-production";
  try {
    const entry: ExternalPackageEntry = {
      objectPath: "/objects/example",
      filename: "database-schema.sql",
      sizeBytes: 200,
      sha256: "a".repeat(64),
      signature: "",
      uploadedAt: new Date(0).toISOString(),
      version: "test",
      format: "sql",
      encrypted: true,
      verified: true,
      origin: "generated",
      databaseSource: "fresh",
    };
    const signatureInput = { agentId: 13, kind: "db" as const, sha256: entry.sha256, sizeBytes: entry.sizeBytes, format: entry.format };
    entry.signature = packageSignature({ ...signatureInput, databaseSource: "fresh" });
    assert.equal(verifyPackageEntry(13, "db", entry), true);
    assert.equal(verifyPackageEntry(13, "db", { ...entry, databaseSource: "agent" }), false);
    assert.equal(verifyPackageEntry(13, "db", { ...entry, databaseSource: undefined }), false);
    assert.equal(verifyPackageEntry(13, "db", { ...entry, origin: "uploaded" }), false);
    assert.equal(verifyPackageEntry(13, "db", { ...entry, format: "pg_custom" }), false);
    const legacy = { ...entry, databaseSource: undefined, signature: packageSignature(signatureInput) };
    assert.equal(verifyPackageEntry(13, "db", legacy), true);
    assert.equal(verifyPackageEntry(13, "db", { ...legacy, databaseSource: "fresh" }), false);
  } finally {
    if (previous === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous;
  }
});