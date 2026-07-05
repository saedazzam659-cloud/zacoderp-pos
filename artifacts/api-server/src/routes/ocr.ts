// ─────────────────────────────────────────────────────────────────────────
// OCR / table-extraction endpoint — used by the offline POS "item import"
// tool's HYBRID mode. When the register is online (cloud mode) it posts a
// photographed/scanned price-list here for high-accuracy Gemini-vision
// extraction; when offline it falls back to a bundled tesseract.js engine on
// the device (see pos-desktop lib/imageOcr.ts). This route is the ONLINE half.
//
// Transport note (prod edge WAF): the client sends the raw base64 blob and the
// mime type as SEPARATE JSON fields, never a `data:<mime>;base64,<blob>` URI —
// the production ingress WAF 403s any body containing a data: base64 URI. We
// rebuild the data URL server-side.
// ─────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import { extractAuth } from "../middleware/auth.js";

const router = Router();

// Reuse the same Gemini config as the unified aiClient (free-tier first).
const GEMINI_KEY   = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

// All OCR calls require authentication (prevents anonymous abuse of AI credits).
router.use(extractAuth);
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

interface OcrBody { imageBase64?: string; mime?: string }

const PROMPT = [
  "You are a precise OCR + table-extraction engine for a price list / item list.",
  "Read the attached image and return STRICT JSON of the shape:",
  '{ "rows": string[][] }',
  "where each element of rows is one table row and each inner string is one cell.",
  "If the first row is a header row, keep it as the first row.",
  "Preserve Arabic text exactly. Keep numbers as written (do not reformat).",
  "Split columns as they visually appear (name / code / barcode / price / cost ...).",
  "If a cell is empty leave an empty string. Do NOT add commentary or markdown — JSON only.",
].join("\n");

/**
 * POST /api/ocr/extract
 * Body: { imageBase64: <raw base64, no data: prefix>, mime: "image/png" | ... }
 * → { ok: true, rows: string[][] } | { ok: false, error }
 */
router.post("/extract", async (req, res) => {
  const { imageBase64, mime } = (req.body ?? {}) as OcrBody;

  if (!imageBase64 || typeof imageBase64 !== "string") {
    res.status(400).json({ ok: false, error: "لم يتم إرسال صورة." });
    return;
  }
  const cleanMime = (mime || "image/png").toLowerCase();
  if (!ALLOWED_MIME.has(cleanMime)) {
    res.status(400).json({ ok: false, error: "نوع الصورة غير مدعوم (PNG/JPG/WEBP فقط)." });
    return;
  }
  if (!GEMINI_KEY) {
    res.status(503).json({ ok: false, error: "خدمة القراءة السحابية غير متاحة حاليًا. استخدم الوضع دون اتصال." });
    return;
  }

  // Guard payload size (base64 ~ 1.37× bytes); 12MB base64 ≈ 9MB image.
  if (imageBase64.length > 12_000_000) {
    res.status(413).json({ ok: false, error: "الصورة كبيرة جدًا. استخدم صورة أصغر أو أوضح." });
    return;
  }

  try {
    const url = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`;
    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: cleanMime === "image/jpg" ? "image/jpeg" : cleanMime, data: imageBase64 } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0 },
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45_000);
    let r: Response;
    try {
      r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      req.log?.warn({ status: r.status, detail: detail.slice(0, 500) }, "ocr gemini call failed");
      res.status(502).json({ ok: false, error: "تعذّرت قراءة الصورة سحابيًا. حاول مرة أخرى أو استخدم الوضع دون اتصال." });
      return;
    }

    const data: any = await r.json();
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const txt = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();

    const rows = parseRows(txt);
    if (!rows.length) {
      res.status(422).json({ ok: false, error: "لم يتم العثور على جدول واضح في الصورة." });
      return;
    }
    res.json({ ok: true, rows });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      res.status(504).json({ ok: false, error: "انتهت مهلة قراءة الصورة. حاول مرة أخرى." });
      return;
    }
    req.log?.error({ err: e }, "ocr extract error");
    res.status(500).json({ ok: false, error: "خطأ غير متوقع أثناء قراءة الصورة." });
  }
});

/** Parse the model's JSON reply into a clean 2D string grid, tolerantly. */
function parseRows(txt: string): string[][] {
  if (!txt) return [];
  let jsonText = txt;
  // Strip accidental ```json fences.
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) jsonText = fence[1];
  let parsed: any;
  try { parsed = JSON.parse(jsonText); } catch {
    // Last resort: pull the first {...} block.
    const m = jsonText.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch { return []; }
  }
  const rawRows = Array.isArray(parsed) ? parsed : parsed?.rows;
  if (!Array.isArray(rawRows)) return [];
  const grid: string[][] = [];
  for (const row of rawRows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((c) => (c == null ? "" : String(c).trim()));
    if (cells.some((c) => c)) grid.push(cells);
  }
  return grid;
}

export default router;
