// GitHub Releases auto-sync for POS Desktop MSI downloads.
//
// Polls the public GitHub Releases API once an hour and mirrors any new
// `pos-desktop-v*` tag into `download_releases` so SuperAdmins no longer
// have to copy/paste the MSI URL manually after every build.
//
// Scope: country=ALL, platform=win-x64 (the default download-page entry).
// Per-country overrides created in /admin/pos-devices keep working —
// this syncer only touches the ALL/win-x64 row.
//
// No GitHub token required for public repos (60 req/h IP rate limit is
// plenty for an hourly poll). If GITHUB_RELEASES_TOKEN is set, it's used
// to lift the limit.
import { db } from "@workspace/db";
import { downloadReleasesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger.js";

const REPO = "saedazzam659-cloud/zacoderp-pos";
const TAG_PREFIX = "pos-desktop-v";
const COUNTRY = "ALL";
const PLATFORM = "win-x64";
const TICK_MS = 60 * 60_000;       // 1h
const STARTUP_DELAY_MS = 60_000;   // 1 min after boot

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}
interface GhRelease {
  tag_name: string;
  name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: GhAsset[];
}

export interface SyncSummary {
  checked: boolean;
  latestTag: string | null;
  alreadySynced?: boolean;
  inserted?: boolean;
  deactivatedCount?: number;
  version?: string;
  url?: string;
  reason?: string;
}

async function fetchLatestRelease(): Promise<GhRelease | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "zacoderp-release-syncer",
  };
  if (process.env.GITHUB_RELEASES_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_RELEASES_TOKEN}`;
  }
  // Fetch the most recent 10 releases and pick the newest one whose
  // tag starts with TAG_PREFIX. /releases/latest skips pre-releases and
  // may point at the wrong project line in multi-component repos.
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, { headers });
  if (!r.ok) throw new Error(`github releases api ${r.status}`);
  const releases = (await r.json()) as GhRelease[];
  const candidates = releases
    .filter((rel) => !rel.draft && rel.tag_name?.startsWith(TAG_PREFIX))
    .sort((a, b) => +new Date(b.published_at) - +new Date(a.published_at));
  return candidates[0] ?? null;
}

function pickMsiAsset(rel: GhRelease): GhAsset | null {
  return rel.assets.find((a) => a.name.toLowerCase().endsWith(".msi")) ?? null;
}

/**
 * Sync once. Idempotent: when the latest tag is already mirrored, this
 * returns { alreadySynced: true } without touching the DB.
 */
export async function runReleaseSyncOnce(): Promise<SyncSummary> {
  const rel = await fetchLatestRelease();
  if (!rel) return { checked: true, latestTag: null, reason: "no matching release on GitHub" };

  const version = rel.tag_name.slice(TAG_PREFIX.length).trim();
  if (!version) return { checked: true, latestTag: rel.tag_name, reason: "empty version after tag prefix" };

  const asset = pickMsiAsset(rel);
  if (!asset) return { checked: true, latestTag: rel.tag_name, version, reason: "no .msi asset on release" };

  // Is this version already in the table for this scope?
  const [existing] = await db.select({ id: downloadReleasesTable.id, isActive: downloadReleasesTable.isActive })
    .from(downloadReleasesTable)
    .where(and(
      eq(downloadReleasesTable.countryCode, COUNTRY),
      eq(downloadReleasesTable.platform, PLATFORM),
      eq(downloadReleasesTable.version, version),
    ))
    .limit(1);

  if (existing) {
    // Already mirrored. If it's not active for some reason, reactivate it.
    if (!existing.isActive) {
      await db.transaction(async (tx) => {
        await tx.update(downloadReleasesTable)
          .set({ isActive: false, updatedAt: new Date() })
          .where(and(
            eq(downloadReleasesTable.countryCode, COUNTRY),
            eq(downloadReleasesTable.platform, PLATFORM),
            eq(downloadReleasesTable.isActive, true),
          ));
        await tx.update(downloadReleasesTable)
          .set({ isActive: true, updatedAt: new Date() })
          .where(eq(downloadReleasesTable.id, existing.id));
      });
      return { checked: true, latestTag: rel.tag_name, version, alreadySynced: true, inserted: false, reason: "reactivated" };
    }
    return { checked: true, latestTag: rel.tag_name, version, alreadySynced: true, inserted: false };
  }

  // New version — insert + deactivate previous active rows for the same scope.
  let deactivatedCount = 0;
  await db.transaction(async (tx) => {
    const dResult = await tx.update(downloadReleasesTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(downloadReleasesTable.countryCode, COUNTRY),
        eq(downloadReleasesTable.platform, PLATFORM),
        eq(downloadReleasesTable.isActive, true),
      ))
      .returning({ id: downloadReleasesTable.id });
    deactivatedCount = dResult.length;

    await tx.insert(downloadReleasesTable).values({
      countryCode: COUNTRY,
      platform: PLATFORM,
      version,
      downloadUrl: asset.browser_download_url,
      fileSizeBytes: asset.size,
      releaseNotes: rel.body ?? null,
      isActive: true,
      publishedAt: new Date(rel.published_at),
    });
  });

  logger.info(
    { version, url: asset.browser_download_url, deactivatedCount },
    "gh-release-sync: new POS desktop release mirrored",
  );
  return {
    checked: true, latestTag: rel.tag_name, version,
    inserted: true, alreadySynced: false,
    deactivatedCount, url: asset.browser_download_url,
  };
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startGithubReleaseSyncScheduler(): void {
  if (intervalHandle) return;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;
  setTimeout(() => {
    runReleaseSyncOnce()
      .then((s) => logger.info({ summary: s }, "gh-release-sync: initial sweep done"))
      .catch((err) => logger.error({ err }, "gh-release-sync: initial sweep failed"));
    intervalHandle = setInterval(() => {
      runReleaseSyncOnce().catch((err) =>
        logger.error({ err }, "gh-release-sync: tick failed"));
    }, TICK_MS);
    logger.info({ tickMs: TICK_MS, repo: REPO }, "gh-release-sync: scheduler started");
  }, STARTUP_DELAY_MS);
}

export function stopGithubReleaseSyncScheduler(): void {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}
