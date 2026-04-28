import { useEffect } from "react";
import { useLocation, Link } from "wouter";
import { Helmet } from "react-helmet-async";
import { FileQuestion, Home, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─────────────────────────────────────────────────────────────────────────
// Public 404 page — replaces the generic placeholder. Important for the
// "Fix crawl errors" SEO recommendation:
//   • Sets <meta name="robots" content="noindex,follow"> so Google drops
//     dead URLs from its index instead of recording them as soft-404s.
//   • Logs the broken path to /api/seo/log-404 so admins can audit weekly.
//   • Offers clear navigation back to the public surface (Home, Pricing,
//     POS) so visitors don't bounce — Google measures bounce on 404s too.
//   • No redirect to /login, so guests landing on a stale URL aren't
//     funnelled into the auth wall by mistake.
// ─────────────────────────────────────────────────────────────────────────

const BASE = (import.meta as any).env.BASE_URL?.replace(/\/$/, "") || "";

export default function NotFound() {
  const [location, setLocation] = useLocation();

  // Fire-and-forget log of the broken path so admins can spot bad
  // inbound links (broken backlinks, mistyped URLs, stale sitemap rows).
  // We swallow all errors — a failed log must never affect the user.
  useEffect(() => {
    const path = (typeof window !== "undefined" ? window.location.pathname : location) || "/";
    const referrer = typeof document !== "undefined" ? document.referrer : "";
    fetch(`${BASE}/api/seo/log-404`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ path, referrer }),
      keepalive: true,
    }).catch(() => { /* ignore */ });
  }, [location]);

  useEffect(() => {
    const prev = document.title;
    document.title = "الصفحة غير موجودة (404) — نظام محاسبة سعودي معتمد من ZATCA";
    return () => { document.title = prev; };
  }, []);

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-gradient-to-b from-primary/5 via-background to-muted px-4 py-12">
      <Helmet>
        <html lang="ar" dir="rtl" />
        <title>الصفحة غير موجودة (404) — نظام محاسبة سعودي معتمد من ZATCA</title>
        <meta name="robots" content="noindex,follow" />
        <meta name="description" content="عذراً، الصفحة المطلوبة غير موجودة. يمكنك العودة للرئيسية أو تصفّح الباقات المتاحة." />
      </Helmet>

      <div className="max-w-xl w-full text-center" data-testid="not-found-card">
        <div className="inline-flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-primary mb-5">
          <FileQuestion className="h-10 w-10" />
        </div>
        <div className="text-7xl font-extrabold text-primary/30 mb-2 leading-none">404</div>
        <h1 className="text-2xl md:text-3xl font-extrabold mb-3" data-testid="not-found-title">
          عذراً، لم نجد هذه الصفحة
        </h1>
        <p className="text-muted-foreground mb-8 leading-relaxed">
          ربما تم نقل الصفحة، أو الرابط الذي وصلت منه قديم. يمكنك العودة لرئيسية الموقع
          أو تصفّح الباقات والأدلة المتاحة.
        </p>
        <div className="flex flex-wrap justify-center gap-3 mb-8">
          <Button size="lg" onClick={() => setLocation("/")} className="gap-1.5" data-testid="not-found-home">
            <Home className="h-4 w-4" /> العودة للرئيسية
          </Button>
          <Button size="lg" variant="outline" onClick={() => setLocation("/pricing")} className="gap-1.5" data-testid="not-found-pricing">
            عرض الباقات <ArrowLeft className="h-4 w-4" />
          </Button>
        </div>
        {/* Real <a href> via wouter Link so crawlers can follow the
            internal links on the 404 page and discover the marketing
            funnel even when they land on a dead URL. */}
        <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <Link href="/" className="hover:text-primary hover:underline" data-testid="not-found-link-home">الرئيسية</Link>
          <span>·</span>
          <Link href="/pos-system" className="hover:text-primary hover:underline" data-testid="not-found-link-pos">نقاط البيع</Link>
          <span>·</span>
          <Link href="/pricing" className="hover:text-primary hover:underline" data-testid="not-found-link-pricing">الباقات</Link>
          <span>·</span>
          <Link href="/login" className="hover:text-primary hover:underline" data-testid="not-found-link-login">تسجيل الدخول</Link>
        </div>
      </div>
    </div>
  );
}
