import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { Briefcase, Loader2, X, Check } from "lucide-react";

/**
 * Compact topbar widget showing the current manually-selected session.
 * Click → dropdown listing all assigned sessions; pick to switch, or
 * "no session" to clear. No-op when the user has zero sessions.
 */
export default function SessionIndicator() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { manualSessions, currentSessionId, selectManualSession } = useAuth();
  const [busy, setBusy] = useState(false);

  if (!manualSessions || manualSessions.length === 0) return null;

  const current = manualSessions.find((s) => s.id === currentSessionId) ?? null;

  const switchTo = async (id: number | null) => {
    if (id === currentSessionId) return;
    setBusy(true);
    try { await selectManualSession(id); }
    catch (e) { toast({ title: t("sessions.pickError"), description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-2 px-2 text-xs font-medium"
          title={t("sessions.indicatorTooltip")}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Briefcase className="h-4 w-4 text-primary" />}
          {current ? (
            <Badge variant="secondary" className="max-w-[140px] truncate">{current.name}</Badge>
          ) : (
            <span className="text-muted-foreground">{t("sessions.noneSelected")}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>{t("sessions.indicatorTitle")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {manualSessions.map((s) => (
          <DropdownMenuItem
            key={s.id}
            onClick={() => switchTo(s.id)}
            className="gap-2"
          >
            {s.id === currentSessionId
              ? <Check className="h-4 w-4 text-primary" />
              : <span className="w-4" />}
            <span className="flex-1 truncate">{s.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => switchTo(null)}
          className="gap-2 text-muted-foreground"
        >
          <X className="h-4 w-4" />
          {t("sessions.clearSelection")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
