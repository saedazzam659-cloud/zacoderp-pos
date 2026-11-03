import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { centralDb, systemSettingsTable } from "@workspace/db";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage.js";
import { MODULE_SHOWCASE_SETTING_KEY, parseModuleShowcase, publicModuleShowcaseImage } from "../lib/moduleShowcase.js";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

async function readImages() {
  const [row] = await centralDb.select({ value: systemSettingsTable.value })
    .from(systemSettingsTable)
    .where(eq(systemSettingsTable.key, MODULE_SHOWCASE_SETTING_KEY))
    .limit(1);
  return parseModuleShowcase(row?.value);
}

router.get("/module-showcase", async (req, res): Promise<void> => {
  try {
    const images = (await readImages())
      .sort((a, b) => a.moduleKey.localeCompare(b.moduleKey) || a.sortOrder - b.sortOrder);
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ images: images.map(publicModuleShowcaseImage) });
  } catch (error) {
    req.log.error({ err: error }, "Failed to read public module showcase");
    res.status(500).json({ error: "تعذر تحميل صور تعريف الوحدات" });
  }
});

router.get("/module-showcase/images/:id", async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    res.status(404).end();
    return;
  }

  try {
    const image = (await readImages()).find(entry => entry.id === id);
    if (!image) {
      res.status(404).end();
      return;
    }
    const file = await objectStorage.getObjectEntityFile(image.objectPath);
    const [metadata] = await file.getMetadata();
    const contentType = String(metadata.contentType ?? "").toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
      res.status(415).end();
      return;
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(metadata.size ?? ""));
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const nodeStream = file.createReadStream();
    nodeStream.on("error", error => {
      req.log.warn({ err: error, imageId: id }, "Could not stream module showcase image");
      if (!res.headersSent) res.status(404).end();
      else res.destroy(error);
    });
    nodeStream.pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).end();
      return;
    }
    req.log.error({ err: error }, "Failed to serve module showcase image");
    res.status(500).end();
  }
});

export default router;
