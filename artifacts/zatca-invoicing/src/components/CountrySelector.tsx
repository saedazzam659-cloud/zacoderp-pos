import { Globe } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { COUNTRIES } from "@/lib/countries";
import { useVisitorCountry } from "@/lib/useVisitorCountry";

// ─── CountrySelector ───────────────────────────────────────────────
// Compact dropdown used in the top bar of the public landing pages
// (Home, Login, Pricing) so visitors can manually override the
// auto-detected country (CF-IPCountry header). Persists the choice in
// the visitor_country cookie via the useVisitorCountry hook so it
// survives navigation and reloads.
//
// Props:
// - className   → extra Tailwind classes for the trigger
// - variant     → "compact" (icon-only width) or "full" (label + flag)
//
// We deliberately render only the bilingual nameAr label (the rest of the
// public site is Arabic-first) and prefix it with a globe icon so the
// purpose is obvious without translation.
type Props = {
  className?: string;
  variant?: "compact" | "full";
  testId?: string;
};

export function CountrySelector({ className = "", variant = "compact", testId = "country-selector" }: Props) {
  const [country, setCountry] = useVisitorCountry();

  return (
    <Select value={country} onValueChange={setCountry}>
      <SelectTrigger
        className={`h-9 ${variant === "compact" ? "w-[150px]" : "w-[200px]"} ${className}`}
        data-testid={testId}
      >
        <Globe className="h-3.5 w-3.5 ms-1 text-muted-foreground shrink-0" />
        <SelectValue placeholder="اختر الدولة" />
      </SelectTrigger>
      <SelectContent>
        {COUNTRIES.map(c => (
          <SelectItem key={c.code} value={c.code} data-testid={`country-option-${c.code}`}>
            <div className="flex items-center gap-2">
              <span>{c.nameAr}</span>
              {variant === "full" && (
                <span className="text-xs text-muted-foreground">({c.currency.code})</span>
              )}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
