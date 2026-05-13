import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ListPlus, Check } from "lucide-react";

/**
 * Post-login picker for the manually-managed Sessions entity.
 *
 * Display rules:
 *   - assigned == 1 → silently auto-select; never show modal.
 *   - assigned >  1 → modal listing the sessions (one click selects).
 *   - assigned == 0 → modal with "continue without session" + (perm-gated)
 *     "create new" inline form.
 *
 * The modal opens at most once per token (per login) — once the user picks,
 * skips, or quick-creates, we record the token in a ref and won't reopen
 * until they log out and back in.
 */
export default function SessionPickerModal() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    user, token, isAuthenticated,
    manualSessions, currentSessionId,
    selectManualSession, quickCreateManualSession,
  } = useAuth();
  // Either the role check or one of the two perm keys grants quick-create.
  // The server enforces the same rule, so this is purely a UI affordance.
  const canSelfCreatePerm = usePermission("sessions_self_create", "create");
  const canManagePerm = usePermission("sessions", "create");
  const canSelfCreate = canSelfCreatePerm || canManagePerm;

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | "skip" | "create" | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  // Track which token we've handled so we never re-open the modal until the
  // user logs out + back in (a fresh login installs a new token).
  const handledToken = useRef<string | null>(null);

  useEffect(() => {
    // Logged out — reset everything so the next login opens fresh.
    if (!isAuthenticated || !user || !token) {
      handledToken.current = null;
      setOpen(false);
      setShowCreate(false);
      setNewName("");
      setBusy(null);
      return;
    }
    // A request is already in flight (auto-select / pick / skip / create) —
    // don't re-evaluate; let it finish. This is critical: without this guard
    // the effect re-runs after we set `busy`, falls through to the
    // `setOpen(true)` line below and the modal flashes open during the
    // single-session auto-pick path.
    if (busy != null) return;
    if (handledToken.current === token) return;          // already handled
    if (currentSessionId != null) {                       // already chose
      handledToken.current = token;
      setOpen(false);
      return;
    }
    // Auto-select when exactly one session is assigned.
    if (manualSessions.length === 1) {
      const only = manualSessions[0];
      setBusy(only.id);
      // Mark the token as handled BEFORE the await so the effect doesn't try
      // to re-evaluate after the request settles and busy clears.
      handledToken.current = token;
      selectManualSession(only.id)
        .catch((e: Error) => {
          // Auto-pick failed — let the user choose manually instead.
          handledToken.current = null;
          toast({ title: t("sessions.pickError"), description: e.message, variant: "destructive" });
          setOpen(true);
        })
        .finally(() => setBusy(null));
      return;
    }
    // 0 sessions → user is not linked to any session; skip silently
    // (no modal). The picker only surfaces when the user actually has
    // assigned sessions to choose from.
    if (manualSessions.length === 0) {
      handledToken.current = token;
      setOpen(false);
      return;
    }
    // >1 → ask the user to pick.
    setOpen(true);
  }, [isAuthenticated, user, token, manualSessions, currentSessionId,
      selectManualSession, t, toast, busy]);

  const finish = () => {
    if (token) handledToken.current = token;
    setOpen(false);
    setShowCreate(false);
    setNewName("");
  };

  const handlePick = async (id: number) => {
    setBusy(id);
    try { await selectManualSession(id); finish(); }
    catch (e) { toast({ title: t("sessions.pickError"), description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const handleSkip = async () => {
    setBusy("skip");
    try { await selectManualSession(null); finish(); }
    catch (e) { toast({ title: t("sessions.pickError"), description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    try { await quickCreateManualSession(name); finish(); }
    catch (e) { toast({ title: t("sessions.createError"), description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(null); }
  };

  const empty = manualSessions.length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && busy == null) handleSkip(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sessions.pickerTitle")}</DialogTitle>
          <DialogDescription>
            {empty ? t("sessions.pickerEmpty") : t("sessions.pickerHint")}
          </DialogDescription>
        </DialogHeader>

        {!showCreate ? (
          <div className="space-y-2">
            {manualSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy !== null}
                onClick={() => handlePick(s.id)}
                className="w-full flex items-center justify-between gap-3 rounded-lg border px-4 py-3 hover:bg-accent transition-colors disabled:opacity-60 text-start"
              >
                <span className="font-medium">{s.name}</span>
                {busy === s.id
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Check className="h-4 w-4 text-muted-foreground" />}
              </button>
            ))}
            {canSelfCreate && (
              <Button
                variant="outline"
                className="w-full gap-2"
                onClick={() => setShowCreate(true)}
                disabled={busy !== null}
              >
                <ListPlus className="h-4 w-4" />{t("sessions.createNew")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="newSessName">{t("sessions.nameLabel")}</Label>
            <Input
              id="newSessName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("sessions.namePlaceholder")}
              maxLength={120}
              autoFocus
            />
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {showCreate ? (
            <>
              <Button variant="ghost" onClick={() => { setShowCreate(false); setNewName(""); }} disabled={busy !== null}>
                {t("common.cancel")}
              </Button>
              <Button onClick={handleCreate} disabled={!newName.trim() || busy !== null}>
                {busy === "create" && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
                {t("sessions.create")}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={handleSkip} disabled={busy !== null}>
              {busy === "skip" && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("sessions.continueWithoutSession")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
