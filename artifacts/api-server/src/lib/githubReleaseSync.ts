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
const PLATFORM = "win-x64";          // .msi — public /download page
const PLATFORM_EXE = "win-x64-exe";  // offline MSI (full WebView2) — /install wizard
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
  // The small ONLINE MSI (public /download page + in-app updater). Exclude the
  // offline MSI, whose name ends with `-offline.msi`.
  return (
    rel.assets.find(
      (a) =>
        a.name.toLowerCase().endsWith(".msi") &&
        !a.name.toLowerCase().endsWith("-offline.msi"),
    ) ?? null
  );
}

// The OFFLINE installer used by the protected /install wizard. It is now an MSI
// (`*-offline.msi`) with the full WebView2 runtime embedded — same installer
// TYPE (per-machine MSI) as the online one, so the in-app updater always
// replaces it cleanly with no per-user/per-machine split. Older releases shipped
// a NSIS `*-setup.exe`; fall back to it so historic tags still mirror.
function pickExeAsset(rel: GhRelease): GhAsset | null {
  const lower = (a: GhAsset) => a.name.toLowerCase();
  return (
    rel.assets.find((a) => lower(a).endsWith("-offline.msi")) ??
    rel.assets.find((a) => lower(a).endsWith("-setup.exe")) ??
    rel.assets.find((a) => lower(a).endsWith(".exe")) ??
    null
  );
}

// Mirror a single asset into download_releases for (COUNTRY, platform).
// Idempotent per (country, platform, version): re-running with an
// already-mirrored version is a no-op (reactivating it if it was disabled).
async function mirrorAsset(
  rel: GhRelease,
  version: string,
  platform: string,
  asset: GhAsset,
): Promise<Pick<SyncSummary, "inserted" | "alreadySynced" | "deactivatedCount" | "url" | "reason">> {
  const [existing] = await db.select({
    id: downloadReleasesTable.id,
    isActive: downloadReleasesTable.isActive,
    downloadUrl: downloadReleasesTable.downloadUrl,
    fileSizeBytes: downloadReleasesTable.fileSizeBytes,
  })
    .from(downloadReleasesTable)
    .where(and(
      eq(downloadReleasesTable.countryCode, COUNTRY),
      eq(downloadReleasesTable.platform, platform),
      eq(downloadReleasesTable.version, version),
    ))
    .limit(1);

  if (existing) {
    // A version is normally immutable, but a release can legitimately be
    // RE-CUT under the same tag (e.g. the first build shipped a wrong/old
    // binary and was deleted + re-uploaded). If the asset URL or size now
    // differs from what we mirrored, the old row points at a stale/broken
    // download — refresh it instead of treating the version as a no-op,
    // otherwise the fix can never reach clients without a manual DB edit.
    const assetChanged =
      existing.downloadUrl !== asset.browser_download_url ||
      existing.fileSizeBytes !== asset.size;

    if (existing.isActive && !assetChanged) {
      return { inserted: false, alreadySynced: true };
    }

    await db.transaction(async (tx) => {
      await tx.update(downloadReleasesTable)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(
          eq(downloadReleasesTable.countryCode, COUNTRY),
          eq(downloadReleasesTable.platform, platform),
          eq(downloadReleasesTable.isActive, true),
        ));
      await tx.update(downloadReleasesTable)
        .set({
          isActive: true,
          downloadUrl: asset.browser_download_url,
          fileSizeBytes: asset.size,
          releaseNotes: rel.body ?? null,
          publishedAt: new Date(rel.published_at),
          updatedAt: new Date(),
        })
        .where(eq(downloadReleasesTable.id, existing.id));
    });
    return {
      inserted: false,
      alreadySynced: true,
      url: asset.browser_download_url,
      reason: assetChanged ? "asset refreshed" : "reactivated",
    };
  }

  let deactivatedCount = 0;
  await db.transaction(async (tx) => {
    const dResult = await tx.update(downloadReleasesTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(
        eq(downloadReleasesTable.countryCode, COUNTRY),
        eq(downloadReleasesTable.platform, platform),
        eq(downloadReleasesTable.isActive, true),
      ))
      .returning({ id: downloadReleasesTable.id });
    deactivatedCount = dResult.length;

    await tx.insert(downloadReleasesTable).values({
      countryCode: COUNTRY,
      platform,
      version,
      downloadUrl: asset.browser_download_url,
      fileSizeBytes: asset.size,
      releaseNotes: rel.body ?? null,
      isActive: true,
      publishedAt: new Date(rel.published_at),
    });
  });

  logger.info(
    { version, platform, url: asset.browser_download_url, deactivatedCount },
    "gh-release-sync: new POS desktop release mirrored",
  );
  return { inserted: true, alreadySynced: false, deactivatedCount, url: asset.browser_download_url };
}

/**
 * Sync once. Mirrors BOTH the `.msi` (platform `win-x64`, used by the public
 * /download page) and the NSIS one-click `.exe` (platform `win-x64-exe`, used
 * by the protected /install wizard). Idempotent: when the latest tag is
 * already mirrored, this returns { alreadySynced: true } without DB writes.
 *
 * The returned summary stays MSI-focused for backward compatibility with the
 * admin sync endpoint; the .exe mirror is best-effort and logged separately so
 * a missing/failed .exe never blocks the .msi from publishing.
 */
export async function runReleaseSyncOnce(): Promise<SyncSummary> {
  const rel = await fetchLatestRelease();
  if (!rel) return { checked: true, latestTag: null, reason: "no matching release on GitHub" };

  const version = rel.tag_name.slice(TAG_PREFIX.length).trim();
  if (!version) return { checked: true, latestTag: rel.tag_name, reason: "empty version after tag prefix" };

  // Mirror the one-click .exe first (best-effort) so its failure can't abort
  // the .msi result, then mirror the .msi as the authoritative summary.
  const exeAsset = pickExeAsset(rel);
  if (exeAsset) {
    try {
      await mirrorAsset(rel, version, PLATFORM_EXE, exeAsset);
    } catch (err) {
      logger.error({ err, version }, "gh-release-sync: .exe mirror failed (continuing with .msi)");
    }
  } else {
    logger.warn({ version }, "gh-release-sync: no .exe asset on release — /install one-click skipped");
  }

  const asset = pickMsiAsset(rel);
  if (!asset) return { checked: true, latestTag: rel.tag_name, version, reason: "no .msi asset on release" };

  const r = await mirrorAsset(rel, version, PLATFORM, asset);
  return { checked: true, latestTag: rel.tag_name, version, ...r };
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
