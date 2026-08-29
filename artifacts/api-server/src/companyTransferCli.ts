import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import {
  buildPortableBackupPackage,
  preflightPortableBackupPackage,
  restorePortableBackupPackage,
} from "./lib/companyBackupPackage.js";
import { ObjectStorageService } from "./lib/objectStorage.js";
import { withPostSuccessCleanupWarning } from "./lib/companyTransferCleanup.js";

function result(value: unknown): void {
  console.log(`ZACOD_COMPANY_TRANSFER_RESULT=${Buffer.from(JSON.stringify(value)).toString("base64")}`);
}

async function main(): Promise<void> {
  const [, , command, companyIdText, filePath, exportedBy = ""] = process.argv;
  const companyId = Number(companyIdText);
  if (!Number.isInteger(companyId) || companyId <= 0 || !filePath) {
    throw new Error("Invalid company transfer CLI arguments");
  }
  if (command === "export") {
    const built = await buildPortableBackupPackage(companyId, exportedBy || null, {
      sanitizeForCompanyTransfer: true,
    });
    try {
      await pipeline(createReadStream(built.path), createWriteStream(filePath, { mode: 0o600 }));
      result({ ok: true, files: built.summary.files, bytes: built.summary.bytes });
    } finally {
      await built.cleanup();
    }
    return;
  }
  if (command === "restore") {
    const objectPath = `/objects/company-backup-packages/${companyId}/${randomUUID()}.zacbackup`;
    const service = new ObjectStorageService();
    const settled = await withPostSuccessCleanupWarning(async () => {
      await pipeline(
        createReadStream(filePath),
        service.getPrivateObjectFile(objectPath.replace(/^\/objects\//, "")).createWriteStream({
          metadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
        }),
      );
      const preflight = await preflightPortableBackupPackage(companyId, objectPath);
      if (!preflight.integrity.ok) throw new Error(preflight.integrity.issues[0]?.message || "Portable preflight failed");
      return restorePortableBackupPackage(companyId, objectPath);
    }, async () => {
      await service.getObjectEntityFile(objectPath).then((file) =>
        file.delete({ ignoreNotFound: true }));
    });
    result({
      ok: true,
      integrity: settled.value.integrity,
      files: settled.value.files,
      cleanupWarning: settled.cleanupWarning,
    });
    return;
  }
  throw new Error("Unknown company transfer CLI command");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});