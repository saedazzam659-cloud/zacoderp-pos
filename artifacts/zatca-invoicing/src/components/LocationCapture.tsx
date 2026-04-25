import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MapPin, Loader2, ExternalLink, AlertTriangle, CheckCircle2 } from "lucide-react";

export interface LocationValue {
  lat: string | null;
  lng: string | null;
  link: string | null;
}

interface Props {
  value: LocationValue;
  onChange: (v: LocationValue) => void;
  disabled?: boolean;
}

const fmt = (n: number) => n.toFixed(6);
const buildMapsLink = (lat: number, lng: number) =>
  `https://www.google.com/maps?q=${fmt(lat)},${fmt(lng)}`;

export function LocationCapture({ value, onChange, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const captureLocation = () => {
    if (!("geolocation" in navigator)) {
      setErr("جهازك أو متصفحك لا يدعم تحديد الموقع.");
      return;
    }
    setBusy(true);
    setErr(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        onChange({
          lat: fmt(lat),
          lng: fmt(lng),
          link: buildMapsLink(lat, lng),
        });
        setBusy(false);
      },
      (e) => {
        setBusy(false);
        if (e.code === 1) setErr("تم رفض إذن الموقع — اسمح للمتصفح بالوصول للموقع ثم حاول مجدداً.");
        else if (e.code === 2) setErr("تعذّر تحديد الموقع — تأكد من تفعيل خدمات GPS.");
        else if (e.code === 3) setErr("انتهت مهلة محاولة تحديد الموقع — حاول مجدداً.");
        else setErr("حدث خطأ أثناء جلب الموقع.");
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  };

  const clearLocation = () => onChange({ lat: null, lng: null, link: null });
  const has = !!(value.lat && value.lng);

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={has ? "outline" : "default"}
          size="sm"
          onClick={captureLocation}
          disabled={busy || disabled}
          data-enter-skip="true"
          className="gap-1.5"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
          {busy ? "جاري الجلب..." : has ? "إعادة جلب الموقع" : "جلب الموقع الحالي"}
        </Button>
        {has && (
          <>
            <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
              <CheckCircle2 className="h-3 w-3" /> تم الجلب
            </span>
            <a
              href={value.link ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
            >
              فتح في خرائط جوجل <ExternalLink className="h-3 w-3" />
            </a>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearLocation}
              data-enter-skip="true"
              className="text-xs text-muted-foreground h-7"
            >
              مسح
            </Button>
          </>
        )}
      </div>

      {has && (
        <div className="grid grid-cols-2 gap-2 text-xs font-mono" dir="ltr">
          <div className="rounded bg-background border px-2 py-1">
            <span className="text-muted-foreground">Lat:</span> {value.lat}
          </div>
          <div className="rounded bg-background border px-2 py-1">
            <span className="text-muted-foreground">Lng:</span> {value.lng}
          </div>
        </div>
      )}

      {err && (
        <div className="flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{err}</span>
        </div>
      )}

      {!has && !err && (
        <p className="text-xs text-muted-foreground">
          يستخدم النظام GPS لتعبئة الإحداثيات ورابط الخرائط تلقائياً.
        </p>
      )}
    </div>
  );
}
