import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleaseFromDist, extractReleaseSnapshot, getReleaseByVersion } from "../src/lib/agentRelease.ts";

async function fixture(monorepo: boolean, run: (dist: string, web: string, releases: string, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-capture-"));
  const dist = monorepo ? path.join(root, "artifacts/api-server/dist") : path.join(root, "dist");
  const web = monorepo ? path.join(root, "artifacts/zatca-invoicing/dist/public") : path.join(dist, "public");
  const posWeb = monorepo ? path.join(root, "artifacts/pos/dist/public") : null;
  const releases = path.join(root, "releases");
  try {
    await fs.mkdir(path.join(web, "assets"), { recursive: true });
    if (posWeb) await fs.mkdir(path.join(posWeb, "assets"), { recursive: true });
    await fs.mkdir(dist, { recursive: true });
    await fs.mkdir(releases);
    await fs.writeFile(path.join(dist, "index.mjs"), "same API");
    await fs.writeFile(path.join(web, "index.html"), '<title>App</title><script src="/assets/app.js"></script>');
    await fs.writeFile(path.join(web, "assets/app.js"), "version one");
    if (posWeb) {
      await fs.writeFile(path.join(posWeb, "index.html"), '<title>POS</title><script src="/pos/assets/pos.js"></script>');
      await fs.writeFile(path.join(posWeb, "assets/pos.js"), "pos version one");
    }
    await run(dist, web, releases, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("central web changes alone produce new immutable release, including its actual SPA", async () => {
  await fixture(true, async (dist, web, releases, root) => {
    await fs.mkdir(path.join(dist, "public"), { recursive: true });
    await fs.writeFile(path.join(dist, "public/index.html"), "stale API web");
    const first = await buildReleaseFromDist(dist, releases);
    await fs.writeFile(path.join(dist, "public/index.html"), "another stale API web");
    assert.equal((await buildReleaseFromDist(dist, releases)).version, first.version);
    await fs.writeFile(path.join(web, "assets/app.js"), "version two");
    const second = await buildReleaseFromDist(dist, releases);
    assert.notEqual(second.version, first.version);
    assert.equal((await buildReleaseFromDist(dist, releases)).version, second.version);
    const old = await getReleaseByVersion(first.version, releases);
    assert.equal(old.sha256, first.sha256);
    const extracted = await extractReleaseSnapshot(first, root);
    assert.equal(await fs.readFile(path.join(extracted, "public/assets/app.js"), "utf8"), "version one");
    assert.match(await fs.readFile(path.join(extracted, "public/index.html"), "utf8"), /App/);
    assert.notEqual(await fs.readFile(path.join(extracted, "public/index.html"), "utf8"), "stale API web");
    assert.equal(await fs.readFile(path.join(extracted, "public/pos/assets/pos.js"), "utf8"), "pos version one");
    assert.match(await fs.readFile(path.join(extracted, "public/pos/index.html"), "utf8"), /\/pos\/assets\/pos\.js/);
    await assert.rejects(getReleaseByVersion("0000000000000000", releases), /release_archive_missing_reprepare/);
  });
});

test("standalone release uses its runtime dist/public", async () => {
  await fixture(false, async (dist, _web, releases, root) => {
    const release = await buildReleaseFromDist(dist, releases);
    const extracted = await extractReleaseSnapshot(release, root);
    assert.equal(await fs.readFile(path.join(extracted, "public/assets/app.js"), "utf8"), "version one");
  });
});

test("incomplete authoritative web build fails closed even with stale API public", async () => {
  await fixture(true, async (dist, web, releases) => {
    await fs.mkdir(path.join(dist, "public"), { recursive: true });
    await fs.writeFile(path.join(dist, "public/index.html"), "old");
    await fs.rm(path.join(web, "assets/app.js"));
    await assert.rejects(buildReleaseFromDist(dist, releases), /Frontend.*غير مكتملة/);
    await fs.rm(path.join(web, "index.html"));
    await assert.rejects(buildReleaseFromDist(dist, releases), /Frontend.*غير مكتملة/);
    await fs.rm(path.dirname(path.dirname(web)), { recursive: true, force: true });
    await assert.rejects(buildReleaseFromDist(dist, releases), /Frontend.*غير مكتملة/);
  });
});

test("full-agent release fails closed when the POS artifact exists without a build", async () => {
  await fixture(true, async (dist, _web, releases, root) => {
    await fs.rm(path.join(root, "artifacts/pos/dist/public"), { recursive: true, force: true });
    await assert.rejects(buildReleaseFromDist(dist, releases), /نقاط البيع.*غير مكتملة/);
  });
});

test("full-agent release rejects POS HTML built with root asset paths", async () => {
  await fixture(true, async (dist, _web, releases, root) => {
    await fs.writeFile(
      path.join(root, "artifacts/pos/dist/public/index.html"),
      '<title>POS</title><script src="/assets/pos.js"></script>',
    );
    await assert.rejects(buildReleaseFromDist(dist, releases), /Frontend.*غير مكتملة/);
  });
});