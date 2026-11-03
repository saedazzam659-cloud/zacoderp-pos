import { z } from "zod";

export const MODULE_SHOWCASE_SETTING_KEY = "public_module_showcase_v1";

export const MODULE_SHOWCASE_KEYS = [
  "accounting",
  "banks",
  "fixedAssets",
  "inventory",
  "sales",
  "purchases",
  "production",
  "projects",
  "contracting",
  "maintenance",
  "hr",
  "hotels",
  "hospitals",
] as const;

export const moduleShowcaseImageSchema = z.object({
  id: z.string().uuid(),
  moduleKey: z.enum(MODULE_SHOWCASE_KEYS),
  objectPath: z.string().regex(/^\/objects\/uploads\/[0-9a-f-]{36}$/i),
  altText: z.string().trim().min(1).max(180),
  caption: z.string().trim().max(160).default(""),
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const moduleShowcaseImagesSchema = z.array(moduleShowcaseImageSchema).max(520);

export type ModuleShowcaseImage = z.infer<typeof moduleShowcaseImageSchema>;

export function parseModuleShowcase(value: string | undefined): ModuleShowcaseImage[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Module showcase settings contain invalid JSON");
  }
  return moduleShowcaseImagesSchema.parse(parsed);
}

export function publicModuleShowcaseImage(image: ModuleShowcaseImage) {
  return {
    id: image.id,
    moduleKey: image.moduleKey,
    altText: image.altText,
    caption: image.caption,
    sortOrder: image.sortOrder,
    url: `/api/module-showcase/images/${image.id}`,
  };
}
