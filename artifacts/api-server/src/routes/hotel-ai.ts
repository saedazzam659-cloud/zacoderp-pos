// ─────────────────────────────────────────────────────────────────────────
// Hotel AI — dynamic pricing + room recommendation + demand forecast +
// maintenance prediction. Uses the same OpenAI proxy as the rest of the
// app (env vars AI_INTEGRATIONS_OPENAI_BASE_URL / _API_KEY) and degrades
// gracefully to deterministic rule-based responses when the proxy is
// unreachable so the UI never appears broken.
//
// Endpoints:
//   POST /api/hotel-ai/dynamic-price       → AI-optimised nightly rate
//   POST /api/hotel-ai/recommend-room      → best room for guest preferences
//   GET  /api/hotel-ai/forecast            → next-30-days occupancy forecast
//   GET  /api/hotel-ai/maintenance-risk    → rooms most likely to need repair
// ─────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import { db } from "@workspace/db";
import {
  hotelRoomsTable, hotelBookingsTable, hotelGuestsTable, hotelHousekeepingTable,
} from "@workspace/db";
import { and, desc, eq, sql, gte, lte } from "drizzle-orm";
import { extractAuth, resolveCompanyId } from "../middleware/auth.js";
import { moduleAudit, requireModulePermission } from "../middleware/permissions.js";
import { chat as aiChat, isAIAvailable } from "../lib/aiClient.js";
import { requireAiFeature, logAiUsage } from "../middleware/requireAiFeature.js";

const router = Router();
router.use(extractAuth);
router.use(requireModulePermission("hotel"));
router.use(moduleAudit("hotel"));
router.use((req, res, next) => {
  if (!req.authUser) { res.status(401).json({ error: "غير مصرح" }); return; }
  next();
});

function guardCid(req: any, res: any): number | null {
  const cid = resolveCompanyId(req, req.body?.companyId ?? req.query.companyId);
  if (!cid) { res.status(401).json({ error: "غير مصرح" }); return null; }
  return cid;
}

function nightsBetween(checkIn: string, checkOut: string): number {
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  return Math.max(1, Math.round((b - a) / 86400000));
}

// Saudi peak seasons (rough heuristic — Hajj, Ramadan period, summer holidays).
function seasonMultiplier(d: Date): { factor: number; label: string } {
  const m = d.getMonth() + 1;
  if (m === 6 || m === 7 || m === 8) return { factor: 1.25, label: "موسم الصيف (مرتفع)" };
  if (m === 12 || m === 1)            return { factor: 1.15, label: "إجازة الشتاء (مرتفع)" };
  if (m === 3 || m === 4)             return { factor: 1.20, label: "موسم رمضان/عمرة (مرتفع)" };
  if (m === 9 || m === 10)            return { factor: 0.90, label: "موسم منخفض" };
  return { factor: 1.0, label: "موسم عادي" };
}

// ═══════════════════ FUNCTION 1: DYNAMIC PRICING ═══════════════════
router.post("/dynamic-price", requireAiFeature("hotel_ai"), async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.roomId)    { res.status(400).json({ error: "الغرفة مطلوبة" }); return; }
    if (!b.checkIn || !b.checkOut) { res.status(400).json({ error: "تاريخ الدخول والخروج مطلوبان" }); return; }

    // Load room.
    const [room] = await db.select().from(hotelRoomsTable)
      .where(and(eq(hotelRoomsTable.id, Number(b.roomId)), eq(hotelRoomsTable.companyId, cid)));
    if (!room) { res.status(404).json({ error: "الغرفة غير موجودة" }); return; }

    // Compute occupancy of the same hotel right now.
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
      .from(hotelRoomsTable)
      .where(and(eq(hotelRoomsTable.companyId, cid), eq(hotelRoomsTable.hotelId, room.hotelId)));
    const [{ occ }] = await db.select({ occ: sql<number>`count(*)::int` })
      .from(hotelRoomsTable)
      .where(and(
        eq(hotelRoomsTable.companyId, cid),
        eq(hotelRoomsTable.hotelId, room.hotelId),
        sql`${hotelRoomsTable.status} IN ('occupied','reserved')`,
      ));
    const occupancyRate = total > 0 ? occ / total : 0;
    const nights = nightsBetween(String(b.checkIn), String(b.checkOut));
    const season = seasonMultiplier(new Date(String(b.checkIn)));
    const basePrice = Number(room.basePrice);

    // Demand factor from upcoming bookings (next 30 days).
    const horizonStart = new Date();
    const horizonEnd   = new Date(Date.now() + 30 * 86400000);
    const [{ upcoming }] = await db.select({ upcoming: sql<number>`count(*)::int` })
      .from(hotelBookingsTable)
      .where(and(
        eq(hotelBookingsTable.companyId, cid),
        sql`${hotelBookingsTable.status} IN ('confirmed','pending','checked_in')`,
        gte(hotelBookingsTable.checkIn, horizonStart.toISOString().slice(0, 10)),
        lte(hotelBookingsTable.checkIn, horizonEnd.toISOString().slice(0, 10)),
      ));
    const demandFactor = total > 0
      ? 1 + Math.min(0.30, (upcoming / Math.max(total, 1)) * 0.10)
      : 1;
    const occupancyFactor = 1 + occupancyRate * 0.20;          // up to +20% at full occupancy
    const lengthDiscount  = nights >= 7 ? 0.93 : (nights >= 4 ? 0.97 : 1.0);

    const ruleBased = Math.round(basePrice * season.factor * occupancyFactor * demandFactor * lengthDiscount);

    const factorBreakdown = {
      basePrice,
      seasonFactor:    Number(season.factor.toFixed(2)),
      seasonLabel:     season.label,
      occupancyRate:   Number((occupancyRate * 100).toFixed(1)),
      occupancyFactor: Number(occupancyFactor.toFixed(2)),
      demandFactor:    Number(demandFactor.toFixed(2)),
      upcomingBookings: upcoming,
      lengthDiscount:  lengthDiscount,
      nights,
    };

    // If AI not configured, return deterministic answer.
    if (!isAIAvailable()) {
      await logAiUsage(req, { status: "allowed", provider: "rule" });
      res.json({
        suggestedPrice: ruleBased,
        totalForStay:   ruleBased * nights,
        factors:        factorBreakdown,
        explanation:    `سعر مقترح بناءً على: ${season.label}، نسبة إشغال ${(occupancyRate*100).toFixed(0)}%، ${upcoming} حجز قادم، ${nights} ليلة.`,
        source: "rule_based",
      });
      return;
    }

    // Ask the model for an optimised number + Arabic explanation.
    const prompt = `أنت خبير تسعير ديناميكي لفنادق سعودية. اقترح سعر ليلة الغرفة بالريال السعودي بناءً على المعطيات التالية فقط:
- نوع الغرفة: ${room.roomType}
- السعة: ${room.capacity} أشخاص
- السعر الأساسي للغرفة: ${basePrice} ر.س/ليلة
- موسم الإقامة: ${season.label} (مُضاعِف ${season.factor})
- نسبة إشغال الفندق الآن: ${(occupancyRate*100).toFixed(1)}%
- عدد الحجوزات القادمة في 30 يوم: ${upcoming}
- مدة الإقامة: ${nights} ليلة
- سعر مقترح بناءً على القواعد فقط (للمقارنة): ${ruleBased} ر.س/ليلة

أعد JSON فقط بهذا الشكل:
{
  "suggestedPrice": <رقم صحيح بالريال للسعر المقترح لليلة الواحدة>,
  "explanation": "شرح موجز للسعر (جملتان كحد أقصى) باللغة العربية",
  "confidence": "high" | "medium" | "low"
}`;

    const result = await aiChat([
        { role: "system", content: "أنت محرّك تسعير ديناميكي لفنادق سعودية. ترد دائماً بـ JSON صحيح، بالأرقام بالريال السعودي." },
        { role: "user", content: prompt },
      ], { json: true,
      maxTokens: 400,
      providers: ["gemini"] });
    if (!result.ok) {
      await logAiUsage(req, { status: "allowed", provider: "rule", meta: { reason: result.reason } });
      res.json({
        suggestedPrice: ruleBased,
        totalForStay:   ruleBased * nights,
        factors:        factorBreakdown,
        explanation:    `سعر مقترح بناءً على: ${season.label}، نسبة إشغال ${(occupancyRate*100).toFixed(0)}%.`,
        source: "rule_based",
      });
      return;
    }
    const parsed: any = result.data ?? {};
    const aiPrice = Math.max(1, Math.round(Number(parsed.suggestedPrice ?? ruleBased)));
    await logAiUsage(req, { status: "allowed", provider: result.provider });
    res.json({
      suggestedPrice: aiPrice,
      totalForStay:   aiPrice * nights,
      factors:        factorBreakdown,
      explanation:    String(parsed.explanation ?? ""),
      confidence:     parsed.confidence ?? "medium",
      source: "ai" as const,
    });
  } catch (e: any) {
    await logAiUsage(req, { status: "error", meta: { error: String(e?.message || e) } });
    res.status(500).json({ error: e?.message ?? "خطأ" });
  }
});

// ═══════════════════ FUNCTION 2: ROOM RECOMMENDATION ═══════════════════
router.post("/recommend-room", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;
    const b = req.body ?? {};
    if (!b.hotelId)  { res.status(400).json({ error: "الفندق مطلوب" }); return; }
    if (!b.checkIn || !b.checkOut) { res.status(400).json({ error: "تاريخ الدخول والخروج مطلوبان" }); return; }

    // Load all rooms in the hotel that aren't out-of-service or under maintenance.
    const allRooms = await db.select().from(hotelRoomsTable)
      .where(and(
        eq(hotelRoomsTable.companyId, cid),
        eq(hotelRoomsTable.hotelId, Number(b.hotelId)),
        sql`${hotelRoomsTable.status} NOT IN ('out_of_service','maintenance')`,
      ));

    // Exclude rooms with overlapping bookings.
    const blocked = await db.select({ id: hotelBookingsTable.roomId })
      .from(hotelBookingsTable)
      .where(and(
        eq(hotelBookingsTable.companyId, cid),
        sql`${hotelBookingsTable.status} IN ('confirmed','checked_in','pending')`,
        lte(hotelBookingsTable.checkIn, String(b.checkOut)),
        gte(hotelBookingsTable.checkOut, String(b.checkIn)),
      ));
    const blockedSet = new Set(blocked.map(r => r.id));
    const candidates = allRooms.filter(r => !blockedSet.has(r.id));
    if (candidates.length === 0) { res.json({ recommendations: [], explanation: "لا توجد غرف متاحة في هذه الفترة." }); return; }

    // Scoring: capacity match, preferences match (string-based), cheapest first.
    const guestsCount = Math.max(1, Number(b.guestsCount ?? 2));
    const preferences = String(b.preferences ?? "").toLowerCase();
    const budget      = b.budget ? Number(b.budget) : null;

    const scored = candidates.map(r => {
      let score = 0;
      // capacity fit
      if (r.capacity >= guestsCount) score += 30;
      if (r.capacity === guestsCount) score += 20;     // exact match bonus
      else if (r.capacity > guestsCount) score -= (r.capacity - guestsCount) * 3;  // wasted bed penalty
      // preferences (substring match in features/notes)
      const hay = `${r.features ?? ""} ${r.notes ?? ""} ${r.roomType}`.toLowerCase();
      const tokens = preferences.split(/[,\s]+/).filter(Boolean);
      for (const tok of tokens) {
        if (tok && hay.includes(tok)) score += 8;
      }
      // budget (penalty for going over)
      if (budget != null) {
        const price = Number(r.basePrice);
        if (price <= budget) score += 15;
        else score -= Math.min(40, (price - budget) / Math.max(budget, 1) * 40);
      } else {
        // cheaper rooms slightly preferred when no budget given
        score -= Number(r.basePrice) / 100;
      }
      return { room: r, score: Math.round(score * 10) / 10 };
    }).sort((a, b) => b.score - a.score).slice(0, 5);

    res.json({
      recommendations: scored.map(s => ({
        id:         s.room.id,
        roomNumber: s.room.roomNumber,
        roomType:   s.room.roomType,
        capacity:   s.room.capacity,
        basePrice:  Number(s.room.basePrice),
        score:      s.score,
        features:   s.room.features ?? "",
        floor:      s.room.floor ?? "",
      })),
      explanation: `تم تقييم ${candidates.length} غرفة متاحة وفقاً للسعة (${guestsCount} ضيوف)${preferences ? `، التفضيلات (${preferences})` : ""}${budget ? `، الميزانية (${budget} ر.س)` : ""}.`,
      source: "rule_based",
    });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ═══════════════════ FUNCTION 3: DEMAND FORECAST ═══════════════════
router.get("/forecast", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;
    const days = Math.min(60, Math.max(7, Number(req.query.days ?? 30)));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizonEnd = new Date(today.getTime() + days * 86400000);

    // Total rooms available.
    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
      .from(hotelRoomsTable)
      .where(and(eq(hotelRoomsTable.companyId, cid), sql`${hotelRoomsTable.status} NOT IN ('out_of_service')`));

    // Bookings overlapping the horizon.
    const bookings = await db.select({
      checkIn:  hotelBookingsTable.checkIn,
      checkOut: hotelBookingsTable.checkOut,
      status:   hotelBookingsTable.status,
    })
      .from(hotelBookingsTable)
      .where(and(
        eq(hotelBookingsTable.companyId, cid),
        sql`${hotelBookingsTable.status} IN ('confirmed','pending','checked_in')`,
        lte(hotelBookingsTable.checkIn, horizonEnd.toISOString().slice(0, 10)),
        gte(hotelBookingsTable.checkOut, today.toISOString().slice(0, 10)),
      ));

    // Build day-by-day occupancy.
    const series: Array<{ date: string; occupied: number; occupancyRate: number; }> = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      const dStr = d.toISOString().slice(0, 10);
      let occupied = 0;
      for (const bk of bookings) {
        if (bk.checkIn <= dStr && bk.checkOut > dStr) occupied++;
      }
      series.push({
        date: dStr,
        occupied,
        occupancyRate: total > 0 ? Math.round((occupied / total) * 1000) / 10 : 0,
      });
    }
    const avg = series.reduce((s, p) => s + p.occupancyRate, 0) / series.length;
    const peak = series.reduce((m, p) => p.occupancyRate > m.occupancyRate ? p : m, series[0]);

    res.json({
      totalRooms:        total,
      horizonDays:       days,
      averageOccupancy:  Math.round(avg * 10) / 10,
      peakDate:          peak.date,
      peakOccupancy:     peak.occupancyRate,
      series,
      explanation:       `توقع إشغال متوسط ${avg.toFixed(1)}% خلال الـ${days} يوم القادمة، أعلى نسبة ${peak.occupancyRate}% في ${peak.date}.`,
      source: "rule_based",
    });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

// ═══════════════════ FUNCTION 4: MAINTENANCE RISK PREDICTION ═══════════════════
router.get("/maintenance-risk", async (req, res) => {
  try {
    const cid = guardCid(req, res); if (!cid) return;

    // Score every room by:
    // - frequency of housekeeping deep-cleans / maintenance tasks (last 90 days)
    // - room age proxy: number of total bookings (more bookings = more wear)
    // - current status (in maintenance / cleaning bumps the score)
    const horizon = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const rooms = await db.select().from(hotelRoomsTable)
      .where(eq(hotelRoomsTable.companyId, cid));

    const tasks = await db.select({
      roomId:  hotelHousekeepingTable.roomId,
      status:  hotelHousekeepingTable.status,
      taskType: hotelHousekeepingTable.taskType,
      created: hotelHousekeepingTable.createdAt,
    })
      .from(hotelHousekeepingTable)
      .where(and(
        eq(hotelHousekeepingTable.companyId, cid),
        gte(hotelHousekeepingTable.createdAt, new Date(horizon)),
      ));
    const taskCount = new Map<number, number>();
    for (const t of tasks) {
      if (!t.roomId) continue;
      taskCount.set(t.roomId, (taskCount.get(t.roomId) ?? 0) + 1);
    }

    const bookingCount = new Map<number, number>();
    const bk = await db.select({ roomId: hotelBookingsTable.roomId })
      .from(hotelBookingsTable)
      .where(eq(hotelBookingsTable.companyId, cid));
    for (const r of bk) bookingCount.set(r.roomId, (bookingCount.get(r.roomId) ?? 0) + 1);

    const ranked = rooms.map(r => {
      const t = taskCount.get(r.id) ?? 0;
      const b = bookingCount.get(r.id) ?? 0;
      let risk = t * 12 + Math.min(50, b * 1.5);
      if (r.status === "maintenance") risk += 30;
      if (r.status === "cleaning")    risk += 8;
      const level = risk >= 50 ? "high" : (risk >= 25 ? "medium" : "low");
      return {
        roomId:        r.id,
        roomNumber:    r.roomNumber,
        roomType:      r.roomType,
        riskScore:     Math.round(risk),
        riskLevel:     level,
        recentTasks:   t,
        totalBookings: b,
        currentStatus: r.status,
        recommendation: level === "high"
          ? "حدد فحصاً وقائياً عاجلاً لهذه الغرفة."
          : (level === "medium" ? "راقب الغرفة وضعها في جدول صيانة دورية." : "حالة جيدة — لا حاجة لإجراء فوري."),
      };
    }).sort((a, b) => b.riskScore - a.riskScore);

    res.json({
      rooms:      ranked,
      highRisk:   ranked.filter(r => r.riskLevel === "high").length,
      mediumRisk: ranked.filter(r => r.riskLevel === "medium").length,
      lowRisk:    ranked.filter(r => r.riskLevel === "low").length,
      source:     "rule_based",
    });
  } catch (e: any) { res.status(500).json({ error: e?.message ?? "خطأ" }); }
});

export default router;

// Suppress lint for imports kept for future use.
void hotelGuestsTable;
