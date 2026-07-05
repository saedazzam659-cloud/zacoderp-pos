import * as React from "react";
import { MoreVertical, FileText, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateField } from "@/components/ui/date-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * Per-line supplier tax metadata. Captured on a payment-voucher / journal-entry
 * line so a consolidated (multi-tax) voucher can attribute each tax line to its
 * own supplier even when NO header supplier is chosen. Flows into the VAT
 * declaration report + the tax account statement.
 */
export interface SupplierTaxDetails {
  supplierName: string;
  supplierVatNumber: string;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: string; // ISO YYYY-MM-DD
}

export const EMPTY_SUPPLIER_TAX_DETAILS: SupplierTaxDetails = {
  supplierName: "",
  supplierVatNumber: "",
  supplierInvoiceNumber: "",
  supplierInvoiceDate: "",
};

export function hasSupplierTaxDetails(v?: Partial<SupplierTaxDetails> | null): boolean {
  if (!v) return false;
  return !!(
    (v.supplierName && v.supplierName.trim()) ||
    (v.supplierVatNumber && v.supplierVatNumber.trim()) ||
    (v.supplierInvoiceNumber && v.supplierInvoiceNumber.trim()) ||
    (v.supplierInvoiceDate && v.supplierInvoiceDate.trim())
  );
}

interface Props {
  value: SupplierTaxDetails;
  onChange: (next: SupplierTaxDetails) => void;
  disabled?: boolean;
  /** Extra menu items rendered above the supplier-details item (e.g. delete). */
  extraItems?: React.ReactNode;
  /** data-testid suffix so callers can target the trigger button. */
  testId?: string;
}

const NS = "supplierTaxDialog";

/**
 * A single ⋮ (3-dots) menu whose primary item opens an attractive dialog for
 * entering the supplier's tax metadata. Shared verbatim by the payment-voucher
 * and journal-entry line editors so the two forms never diverge.
 */
export function SupplierTaxDetailsMenu({ value, onChange, disabled, extraItems, testId }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<SupplierTaxDetails>(value);

  // Re-seed the draft from the incoming value ONLY on the closed→open
  // transition, never on subsequent `value` changes while the dialog stays
  // open. The parent forms (payment-voucher / journal-entry) pass `value` as a
  // fresh object literal every render and run many background queries; if we
  // depended on `value` here, any mid-edit re-render (a React Query refetch, an
  // SSE tick) would fire this effect and wipe whatever the user has typed so
  // far — most visibly the supplier name (the top field, entered first) — while
  // fields typed afterwards survived. Seeding only on open fixes that race.
  const prevOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !prevOpen.current) setDraft(value);
    prevOpen.current = open;
  }, [open, value]);

  const filled = hasSupplierTaxDetails(value);

  const set = (patch: Partial<SupplierTaxDetails>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    onChange({
      supplierName: draft.supplierName.trim(),
      supplierVatNumber: draft.supplierVatNumber.trim(),
      supplierInvoiceNumber: draft.supplierInvoiceNumber.trim(),
      supplierInvoiceDate: draft.supplierInvoiceDate.trim(),
    });
    setOpen(false);
  };

  const clear = () => {
    setDraft({ ...EMPTY_SUPPLIER_TAX_DETAILS });
    onChange({ ...EMPTY_SUPPLIER_TAX_DETAILS });
    setOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={disabled}
            className={`h-9 w-9 shrink-0 ${filled ? "text-primary" : "text-muted-foreground"}`}
            title={t(`${NS}.menu`, "خيارات البند")}
            data-testid={testId ? `line-menu-${testId}` : undefined}
          >
            <MoreVertical className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {extraItems}
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setOpen(true); }}>
            <FileText className="h-4 w-4 me-2" />
            {t(`${NS}.open`, "بيانات المورد الضريبية")}
            {filled && <Check className="h-4 w-4 ms-auto text-primary" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {t(`${NS}.title`, "بيانات المورد الضريبية")}
            </DialogTitle>
            <DialogDescription>
              {t(`${NS}.desc`, "تُستخدم عند عدم اختيار مورد بالرأس، وتظهر في تقرير الضريبة وكشف حساب الضريبة.")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">{t(`${NS}.supplierName`, "اسم المورد")}</Label>
              <Input
                value={draft.supplierName}
                onChange={(e) => set({ supplierName: e.target.value })}
                placeholder={t(`${NS}.supplierNamePh`, "اسم المورد")}
                className="h-11 text-base"
                data-testid="supplier-tax-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-semibold">{t(`${NS}.vatNumber`, "الرقم الضريبي للمورد")}</Label>
              <Input
                value={draft.supplierVatNumber}
                onChange={(e) => set({ supplierVatNumber: e.target.value })}
                placeholder="3XXXXXXXXXXXXX3"
                dir="ltr"
                inputMode="numeric"
                className="h-11 text-base font-mono text-left"
                data-testid="supplier-tax-vat"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold">{t(`${NS}.invoiceNumber`, "رقم الفاتورة")}</Label>
                <Input
                  value={draft.supplierInvoiceNumber}
                  onChange={(e) => set({ supplierInvoiceNumber: e.target.value })}
                  placeholder={t(`${NS}.invoiceNumberPh`, "رقم فاتورة المورد")}
                  className="h-11 text-base"
                  data-testid="supplier-tax-invno"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-semibold">{t(`${NS}.invoiceDate`, "تاريخ الفاتورة")}</Label>
                <DateField
                  value={draft.supplierInvoiceDate}
                  onChange={(e) => set({ supplierInvoiceDate: e.target.value })}
                  className="h-11 text-base"
                  data-testid="supplier-tax-invdate"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-2">
            <Button type="button" variant="ghost" onClick={clear} data-testid="supplier-tax-clear">
              {t(`${NS}.clear`, "مسح")}
            </Button>
            <Button type="button" onClick={save} data-testid="supplier-tax-save">
              {t(`${NS}.save`, "حفظ البيانات")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SupplierTaxDetailsMenu;
