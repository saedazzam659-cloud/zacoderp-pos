import { useEffect, useMemo, useState } from "react";
import { Info, Loader2, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type RestaurantModifierGroup = {
  id: string;
  nameAr: string;
  nameEn?: string | null;
  required: boolean;
  selectionMode: "single" | "multiple";
  minSelect: number;
  maxSelect: number;
  options: Array<{
    id: string;
    itemId: number;
    nameAr: string;
    nameEn?: string | null;
    code: string;
    extraPrice: number;
    consumptionQtyPerSelection?: number;
    itemType?: "stock" | "service";
    unitId?: number | null;
    unitName?: string | null;
    vatRate?: number | string;
  }>;
};

export type RestaurantModifierItem = {
  id: number;
  nameAr: string;
  nameEn?: string | null;
  price: string;
};

export type RestaurantModifierSelection = Array<{
  groupId: string;
  optionIds: string[];
}>;

type RestaurantModifierDialogProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  item: RestaurantModifierItem;
  groups: RestaurantModifierGroup[];
  language: "ar" | "en";
  submitting?: boolean;
  initialSelection?: Array<{ groupId: string; optionIds: string[] }>;
  confirmLabel?: string;
  onConfirm(selection: RestaurantModifierSelection): void;
};

export default function RestaurantModifierDialog({
  open,
  onOpenChange,
  item,
  groups,
  language,
  submitting = false,
  initialSelection,
  confirmLabel,
  onConfirm,
}: RestaurantModifierDialogProps) {
  const isArabic = language === "ar";
  const direction = isArabic ? "rtl" : "ltr";
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string[]>>({});
  const [search, setSearch] = useState("");
  const text = (ar: string, en: string) => isArabic ? ar : en;
  const itemName = isArabic ? item.nameAr : item.nameEn || item.nameAr;

  useEffect(() => {
    if (open) {
      setSelectedByGroup(Object.fromEntries((initialSelection ?? []).map(selection => [selection.groupId, selection.optionIds])));
      setSearch("");
    }
  }, [open, item.id, initialSelection]);

  const currency = useMemo(() => new Intl.NumberFormat(
    isArabic ? "ar-SA" : "en-US",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 },
  ), [isArabic]);
  const formatPrice = (amount: number) =>
    `${currency.format(Number.isFinite(amount) ? amount : 0)} ${text("ر.س", "SAR")}`;

  const totalOptionCount = groups.reduce((sum, group) => sum + group.options.length, 0);
  const hasAnyOptions = totalOptionCount > 0;
  const query = search.trim().toLocaleLowerCase(isArabic ? "ar" : "en");
  const visibleGroups = groups.map((group) => ({
    ...group,
    visibleOptions: group.options.filter((option) => {
      if (!query) return true;
      return [
        option.nameAr,
        option.nameEn ?? "",
        option.code,
      ].some((value) => value.toLocaleLowerCase(isArabic ? "ar" : "en").includes(query));
    }),
  }));

  const getBounds = (group: RestaurantModifierGroup) => {
    const max = Math.min(
      group.options.length,
      Math.max(0, group.maxSelect),
      group.selectionMode === "single" ? 1 : Number.POSITIVE_INFINITY,
    );
    const min = group.required ? Math.max(1, group.minSelect) : Math.max(0, group.minSelect);
    return { min, max };
  };

  const selectedOptionCount = Object.values(selectedByGroup).reduce(
    (sum, optionIds) => sum + optionIds.length,
    0,
  );
  const selectedExtras = groups.reduce((sum, group) => {
    const selected = new Set(selectedByGroup[group.id] ?? []);
    return sum + group.options.reduce(
      (groupSum, option) => groupSum + (selected.has(option.id) ? (Number(option.extraPrice) || 0) : 0),
      0,
    );
  }, 0);
  const basePrice = Number(item.price) || 0;
  const previewTotal = basePrice + selectedExtras;

  const unavailableRequiredGroups = groups.filter(
    (group) => group.required && group.options.length === 0,
  );
  const invalidGroups = groups.filter((group) => {
    if (group.options.length === 0) return false;
    const count = selectedByGroup[group.id]?.length ?? 0;
    const { min, max } = getBounds(group);
    return count < min || count > max;
  });
  const canConfirm = !submitting && unavailableRequiredGroups.length === 0 && invalidGroups.length === 0;

  function toggleOption(group: RestaurantModifierGroup, optionId: string) {
    if (submitting) return;
    const { max } = getBounds(group);
    setSelectedByGroup((current) => {
      const selected = current[group.id] ?? [];
      if (selected.includes(optionId)) {
        return { ...current, [group.id]: selected.filter((id) => id !== optionId) };
      }
      if (selected.length >= max) return current;
      return {
        ...current,
        [group.id]: group.selectionMode === "single" ? [optionId] : [...selected, optionId],
      };
    });
  }

  function confirmSelection() {
    if (!canConfirm) return;
    const selection = groups.flatMap((group) => {
      const optionIds = selectedByGroup[group.id] ?? [];
      return optionIds.length ? [{ groupId: group.id, optionIds: [...optionIds] }] : [];
    });
    onConfirm(selection);
  }

  const noSearchResults = hasAnyOptions && visibleGroups.every((group) => group.visibleOptions.length === 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!submitting) onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        dir={direction}
        lang={language}
        aria-busy={submitting}
        className="flex max-h-[min(90dvh,760px)] w-[calc(100%-1rem)] max-w-2xl flex-col gap-0 overflow-hidden rounded-[1.35rem] border-border/80 bg-card p-0 shadow-2xl sm:w-full"
        data-testid="dialog-restaurant-modifiers"
      >
        <DialogHeader className="border-b border-border/80 bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),transparent_62%)] px-5 pb-4 pt-5 text-start sm:px-7 sm:pt-6">
          <div className="flex items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <SlidersHorizontal className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-xl font-black tracking-tight sm:text-2xl">
                {text("خصّص الصنف", "Customize item")}
              </DialogTitle>
              <DialogDescription className="mt-1 line-clamp-2 text-sm">
                {itemName}
              </DialogDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              aria-label={text("إغلاق", "Close")}
              data-testid="button-close-modifiers"
              className="size-9 shrink-0 rounded-xl"
            >
              <X className="size-4" />
            </Button>
          </div>

          {hasAnyOptions && (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-primary/20 bg-[linear-gradient(110deg,hsl(var(--primary)/0.10),hsl(var(--primary)/0.025)_58%,transparent)] px-4 py-3 text-start shadow-sm">
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  <Sparkles className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block font-black text-foreground">
                    {text("خيارات وإضافات الصنف", "Item options and add-ons")}
                  </span>
                  <span className="mt-0.5 block text-xs font-medium text-muted-foreground">
                    {text(
                      `${selectedOptionCount} محددة من ${totalOptionCount} خيار`,
                      `${selectedOptionCount} selected of ${totalOptionCount}`,
                    )}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="rounded-full bg-background/90 px-2.5 py-1 text-[11px] font-extrabold text-primary shadow-sm">
                  {text("اختر مباشرة", "Choose directly")}
                </span>
              </span>
            </div>
          )}

          {hasAnyOptions && (
            <div className="relative mt-4">
              <Search
                aria-hidden="true"
                className={`pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground ${isArabic ? "right-3.5" : "left-3.5"}`}
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={text("ابحث عن إضافة أو خيار...", "Search add-ons...")}
                aria-label={text("البحث عن الإضافات", "Search add-ons")}
                data-testid="input-modifier-search"
                className={`h-11 rounded-xl border-border/80 bg-background/80 ${isArabic ? "pr-10" : "pl-10"}`}
              />
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-7 sm:py-5">
          {!hasAnyOptions ? (
            <div
              className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-primary/25 bg-primary/[0.035] px-5 py-8 text-center"
              data-testid="empty-modifier-options"
            >
              <span className="mb-3 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                <Info className="size-5" aria-hidden="true" />
              </span>
              <h3 className="font-black">
                {text("لا توجد إضافات لهذا الصنف", "No add-ons for this item")}
              </h3>
              <p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                {text(
                  "يمكنك متابعة إضافة الصنف إلى الطلب كما هو.",
                  "You can continue and add this item as it is.",
                )}
              </p>
            </div>
          ) : noSearchResults ? (
            <div className="flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-border px-5 py-8 text-center" role="status">
              <Search className="mb-3 size-6 text-muted-foreground/70" aria-hidden="true" />
              <p className="font-bold">{text("لا توجد خيارات مطابقة", "No matching options")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {text("جرّب كلمة أخرى أو امسح البحث.", "Try another term or clear the search.")}
              </p>
              <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setSearch("")} data-testid="button-clear-modifier-search">
                {text("مسح البحث", "Clear search")}
              </Button>
            </div>
          ) : (
            <div id="modifier-options-list" className="space-y-3.5">
              {visibleGroups.map((group) => {
                const selected = selectedByGroup[group.id] ?? [];
                const { min, max } = getBounds(group);
                const selectionLabel = group.selectionMode === "single"
                  ? text("اختر خياراً واحداً", "Choose one")
                  : text(`اختر ${min} إلى ${max}`, `Choose ${min}–${max}`);
                const groupName = isArabic ? group.nameAr : group.nameEn || group.nameAr;

                return (
                  <section
                    key={group.id}
                    aria-labelledby={`modifier-group-title-${group.id}`}
                    className="overflow-hidden rounded-2xl border border-border/80 bg-background/65"
                    data-testid={`modifier-group-${group.id}`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/70 bg-muted/35 px-4 py-3">
                      <div className="min-w-0">
                        <h3 id={`modifier-group-title-${group.id}`} className="font-black leading-5">
                          {groupName}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {group.options.length === 0
                            ? text("لا توجد خيارات متاحة حالياً", "No options are currently available")
                            : selectionLabel}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {group.required && (
                          <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-[11px] font-bold text-amber-800">
                            {text("مطلوب", "Required")}
                          </span>
                        )}
                        {group.options.length > 0 && (
                          <span className="rounded-full bg-card px-2.5 py-1 text-[11px] font-bold text-muted-foreground">
                            {selected.length}/{max}
                          </span>
                        )}
                      </div>
                    </div>

                    {group.options.length === 0 ? (
                      group.required && (
                        <p className="px-4 py-3 text-sm text-destructive" role="status">
                          {text(
                            "هذه الإضافة مطلوبة لكنها غير متاحة. لا يمكن متابعة الطلب الآن.",
                            "This required add-on is unavailable. You cannot continue right now.",
                          )}
                        </p>
                      )
                    ) : group.visibleOptions.length === 0 ? (
                      <p className="px-4 py-4 text-sm text-muted-foreground">
                        {text("لا توجد خيارات مطابقة في هذه المجموعة.", "No matching options in this group.")}
                      </p>
                    ) : (
                      <div
                        role={group.selectionMode === "single" ? "radiogroup" : "group"}
                        aria-labelledby={`modifier-group-title-${group.id}`}
                        className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4"
                      >
                        {group.visibleOptions.map((option) => {
                          const checked = selected.includes(option.id);
                          const optionName = isArabic ? option.nameAr : option.nameEn || option.nameAr;
                          const atLimit = selected.length >= max && !checked;
                          const inputId = `modifier-${group.id}-${option.id}`;
                          return (
                            <label
                              key={option.id}
                              htmlFor={inputId}
                              data-testid={`option-card-${group.id}-${option.id}`}
                              className={`group flex min-h-[104px] cursor-pointer flex-col justify-between gap-2 rounded-xl border px-2.5 py-2.5 transition-all focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-1 ${
                                checked
                                  ? "border-primary bg-primary/[0.08] shadow-sm ring-1 ring-primary/15"
                                  : "border-border/75 bg-card hover:-translate-y-0.5 hover:border-primary/50 hover:bg-primary/[0.035] hover:shadow-sm"
                              } ${atLimit || submitting ? "cursor-not-allowed opacity-55" : ""}`}
                            >
                              <span className="flex w-full items-start justify-between gap-2">
                                <span className="line-clamp-2 min-h-10 min-w-0 text-start text-[13px] font-extrabold leading-5">
                                  {optionName}
                                </span>
                                <input
                                  id={inputId}
                                  type={group.selectionMode === "single" ? "radio" : "checkbox"}
                                  name={`modifier-group-${group.id}`}
                                  checked={checked}
                                  disabled={submitting || atLimit}
                                  onChange={() => toggleOption(group, option.id)}
                                  aria-label={`${optionName}, ${formatPrice(Number(option.extraPrice) || 0)}`}
                                  data-testid={`input-modifier-option-${option.id}`}
                                  className="mt-0.5 size-4 shrink-0 accent-[hsl(var(--primary))] focus-visible:outline-none"
                                />
                              </span>
                              <span className="flex w-full items-center justify-between gap-1 border-t border-border/60 pt-2">
                                <span className="min-w-0 truncate font-mono text-[9px] tracking-wide text-muted-foreground">
                                  {option.code}
                                </span>
                                <span className={`shrink-0 text-end text-xs font-black ${Number(option.extraPrice) > 0 ? "text-primary" : "text-muted-foreground"}`}>
                                  {Number(option.extraPrice) > 0
                                    ? `+ ${formatPrice(Number(option.extraPrice))}`
                                    : formatPrice(Number(option.extraPrice) || 0)}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="border-t border-border/80 bg-card px-4 py-3.5 sm:px-7">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-muted-foreground">
                {text("سعر الصنف", "Item price")} · {formatPrice(basePrice)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {text("الإضافات المحددة", "Selected add-ons")} · {formatPrice(selectedExtras)}
              </p>
            </div>
            <div className="text-end">
              <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {text("معاينة الإجمالي", "Preview total")}
              </p>
              <p className="mt-0.5 text-xl font-black tracking-tight text-primary" data-testid="text-modifier-total-preview">
                {formatPrice(previewTotal)}
              </p>
            </div>
          </div>
          <p className="mb-3 flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{text("المبلغ للمعاينة فقط؛ يعتمد السعر النهائي على تحقق النظام.", "Price is a preview only; the server validates the final amount.")}</span>
          </p>
          {invalidGroups.length > 0 && (
            <p className="mb-3 text-xs font-semibold text-amber-800" role="status" data-testid="status-modifier-requirements">
              {text("أكمل الاختيارات المطلوبة للمتابعة.", "Complete the required selections to continue.")}
            </p>
          )}
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-modifiers"
              className="h-11 w-full rounded-xl sm:w-auto"
            >
              {text("إلغاء", "Cancel")}
            </Button>
            <Button
              type="button"
              disabled={!canConfirm}
              onClick={confirmSelection}
              data-testid="button-confirm-modifiers"
              className="h-11 w-full rounded-xl px-5 font-black shadow-sm sm:w-auto"
            >
              {submitting ? <Loader2 className="me-2 size-4 animate-spin" aria-hidden="true" /> : null}
              {submitting
                ? text("جارٍ الإضافة...", "Adding...")
                : confirmLabel ?? (hasAnyOptions
                  ? `${text("تأكيد الطلب", "Confirm order")}${selectedOptionCount ? ` · ${selectedOptionCount}` : ""}`
                  : text("متابعة بدون إضافات", "Continue without add-ons"))}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
