import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Plus, Ruler, Save, X } from "lucide-react";
import { inventoryApi } from "@/lib/inventoryApi";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  units: any[];
  companyId?: number;
  onCreated: (item: any) => void;
};

type QuickAddValues = {
  nameAr: string;
  nameEn: string;
  code: string;
  unitId: string;
  salePrice: string;
  vatRate: string;
  unitNameAr: string;
  unitNameEn: string;
  unitCode: string;
};

function apiErrorMessage(error: unknown): string {
  const raw = String((error as any)?.message ?? error ?? "");
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      return String(parsed?.error ?? parsed?.message ?? raw);
    } catch {
      // Keep the original message if it isn't a JSON API response.
    }
  }
  return raw || "حدث خطأ غير متوقع.";
}

export default function QuotationQuickAddItemDialog({
  open,
  onOpenChange,
  units,
  companyId,
  onCreated,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showUnitForm, setShowUnitForm] = useState(false);
  const activeUnits = (Array.isArray(units) ? units : []).filter((unit: any) => unit.isActive !== false);
  const form = useForm<QuickAddValues>({
    defaultValues: {
      nameAr: "",
      nameEn: "",
      code: "",
      unitId: "",
      salePrice: "0",
      vatRate: "15",
      unitNameAr: "",
      unitNameEn: "",
      unitCode: "",
    },
  });
  const nameAr = form.watch("nameAr") ?? "";
  const unitId = form.watch("unitId") ?? "";

  function resetForm() {
    form.reset({
      nameAr: "",
      nameEn: "",
      code: "",
      unitId: activeUnits[0]?.id != null ? String(activeUnits[0].id) : "",
      salePrice: "0",
      vatRate: "15",
      unitNameAr: "",
      unitNameEn: "",
      unitCode: "",
    });
    setShowUnitForm(activeUnits.length === 0);
  }

  useEffect(() => {
    if (open) resetForm();
    // Initialize on open only; cache updates must not erase in-progress typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const createUnitMutation = useMutation({
    mutationFn: async (values: Pick<QuickAddValues, "unitNameAr" | "unitNameEn" | "unitCode">) => {
      const name = values.unitNameAr.trim();
      if (name.length < 2) throw new Error("اسم وحدة القياس مطلوب.");
      const unit = await inventoryApi.createUnit({
        nameAr: name,
        nameEn: values.unitNameEn.trim() || undefined,
        code: values.unitCode.trim() || undefined,
        conversionFactor: "1",
      });
      if (!unit?.id) throw new Error("لم يُرجع الخادم معرّف وحدة القياس.");
      return unit;
    },
    onSuccess: (unit: any) => {
      queryClient.setQueryData<any[]>(["units", companyId], (current) => {
        const rows = Array.isArray(current) ? current : [];
        return rows.some((row: any) => String(row.id) === String(unit.id))
          ? rows
          : [...rows, unit];
      });
      form.setValue("unitId", String(unit.id), { shouldValidate: true, shouldDirty: true });
      form.setValue("unitNameAr", "");
      form.setValue("unitNameEn", "");
      form.setValue("unitCode", "");
      form.clearErrors(["unitNameAr", "unitNameEn", "unitCode"]);
      setShowUnitForm(false);
      toast({
        title: "تمت إضافة وحدة القياس",
        description: "ستُستخدم كوحدة أساسية للصنف الجديد.",
      });
    },
    onError: (error: any) => toast({
      title: "تعذرت إضافة وحدة القياس",
      description: apiErrorMessage(error),
      variant: "destructive",
    }),
  });

  const createItemMutation = useMutation({
    mutationFn: async () => {
      const values = form.getValues();
      const trimmedName = values.nameAr.trim();
      const selectedUnitId = Number(values.unitId);
      if (trimmedName.length < 2) throw new Error("اسم الصنف مطلوب (حرفان على الأقل).");
      if (!Number.isSafeInteger(selectedUnitId) || selectedUnitId <= 0) {
        throw new Error("اختر وحدة قياس أساسية أو أضف وحدة جديدة.");
      }

      const item = await inventoryApi.createItem({
        nameAr: trimmedName,
        nameEn: values.nameEn.trim() || undefined,
        code: values.code.trim() || undefined,
        itemType: "stock",
        itemNature: "merchandise",
        unitId: selectedUnitId,
        costPrice: "0",
        salePrice: values.salePrice.trim() || "0",
        vatRate: values.vatRate.trim() || "15",
        reorderLevel: "0",
        costMethod: "weighted_avg",
        showInPos: true,
      });
      if (!item?.id) throw new Error("تم حفظ الصنف دون استلام معرّفه من الخادم.");

      let baseUnitLinked = false;
      try {
        await inventoryApi.addItemUnit(Number(item.id), {
          unitId: selectedUnitId,
          relationFactor: "1",
          costPrice: "0",
          salePrice: values.salePrice.trim() || "0",
          isBase: true,
          isActive: true,
          decimalPlaces: 2,
          roundingMode: "half_up",
        });
        baseUnitLinked = true;
      } catch {
        // The item row is already saved. Check whether the relation committed
        // before reporting a partial result (for example, after a lost response).
        const links = await inventoryApi.getItemUnits(Number(item.id)).catch(() => []);
        baseUnitLinked = Array.isArray(links) && links.some((link: any) =>
          String(link.unitId) === String(selectedUnitId) && link.isBase === true,
        );
      }

      return { item, baseUnitLinked };
    },
    onSuccess: ({ item, baseUnitLinked }: { item: any; baseUnitLinked: boolean }) => {
      onCreated(item);
      onOpenChange(false);
      if (baseUnitLinked) {
        toast({
          title: "تمت إضافة الصنف",
          description: "أُضيف إلى قائمة الأصناف في عرض السعر.",
        });
      } else {
        toast({
          title: "تم إنشاء الصنف مع ملاحظة",
          description: "لم يتأكد ربط وحدة القياس بالصنف. الصنف محفوظ ويمكن مراجعته من شاشة الأصناف.",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => toast({
      title: "تعذرت إضافة الصنف",
      description: apiErrorMessage(error),
      variant: "destructive",
    }),
  });

  const busy = createItemMutation.isPending || createUnitMutation.isPending;
  const closeDialog = (nextOpen: boolean) => {
    if (!nextOpen && busy) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={closeDialog}>
      <DialogContent dir="rtl" className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <div className="mt-0.5 rounded-xl bg-primary/10 p-2.5 text-primary">
              <Package className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <DialogTitle>إضافة صنف إلى عرض السعر</DialogTitle>
              <DialogDescription>
                أضف بيانات الصنف ووحدة بيعه هنا، وسيظهر مباشرة في قائمة الأصناف دون مغادرة العرض.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit(() => createItemMutation.mutate())}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="nameAr"
                rules={{ required: "اسم الصنف مطلوب.", minLength: { value: 2, message: "اكتب حرفين على الأقل." } }}
                render={({ field }) => (
                  <FormItem className="space-y-1.5 sm:col-span-2">
                    <FormLabel>اسم الصنف (عربي) *</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-new-quotation-item-name-ar"
                        autoFocus
                        placeholder="مثال: كرسي مكتبي"
                        maxLength={200}
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="nameEn"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>اسم الصنف (إنجليزي)</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-new-quotation-item-name-en"
                        placeholder="اختياري"
                        maxLength={200}
                        dir="ltr"
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="code"
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>كود الصنف</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-new-quotation-item-code"
                        placeholder="يُولّد تلقائياً إذا تُرك فارغاً"
                        maxLength={80}
                        dir="ltr"
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <section className="space-y-3 rounded-xl border bg-muted/20 p-3">
              {activeUnits.length > 0 ? (
                <FormField
                  control={form.control}
                  name="unitId"
                  rules={{ required: "اختر وحدة القياس الأساسية." }}
                  render={({ field }) => (
                    <FormItem className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Ruler className="h-4 w-4 text-primary" />
                          <FormLabel>وحدة القياس الأساسية *</FormLabel>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5 text-xs"
                          data-testid="button-create-quotation-unit"
                          onClick={() => setShowUnitForm((value) => !value)}
                        >
                          <Plus className="h-3.5 w-3.5" />
                          {showUnitForm ? "إخفاء إضافة الوحدة" : "إضافة وحدة قياس"}
                        </Button>
                      </div>
                      <FormControl>
                        <Select value={field.value || undefined} onValueChange={field.onChange} disabled={busy}>
                          <SelectTrigger data-testid="select-new-quotation-item-unit" className="h-9">
                            <SelectValue placeholder="اختر وحدة القياس" />
                          </SelectTrigger>
                          <SelectContent>
                            {activeUnits.map((unit: any) => (
                              <SelectItem key={unit.id} value={String(unit.id)}>
                                {unit.nameAr ?? unit.nameEn ?? unit.code ?? `#${unit.id}`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Ruler className="h-4 w-4 text-primary" />
                    وحدة القياس الأساسية *
                  </div>
                  <p className="rounded-lg border border-dashed bg-background px-3 py-2 text-xs text-muted-foreground">
                    لا توجد وحدة قياس نشطة؛ أضف وحدة جديدة لتصبح الوحدة الأساسية للصنف.
                  </p>
                </div>
              )}

              {showUnitForm && (
                <div className="space-y-3 rounded-lg border border-primary/20 bg-background p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Ruler className="h-4 w-4 text-primary" />
                    وحدة قياس جديدة
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="unitNameAr"
                      rules={{ required: "اسم وحدة القياس مطلوب.", minLength: { value: 2, message: "اكتب حرفين على الأقل." } }}
                      render={({ field }) => (
                        <FormItem className="space-y-1.5">
                          <FormLabel>اسم الوحدة (عربي) *</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              data-testid="input-new-quotation-unit-name-ar"
                              placeholder="مثال: قطعة"
                              maxLength={100}
                              disabled={busy}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="unitCode"
                      render={({ field }) => (
                        <FormItem className="space-y-1.5">
                          <FormLabel>كود الوحدة</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              data-testid="input-new-quotation-unit-code"
                              placeholder="تلقائي"
                              maxLength={40}
                              dir="ltr"
                              disabled={busy}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="unitNameEn"
                      render={({ field }) => (
                        <FormItem className="space-y-1.5 sm:col-span-2">
                          <FormLabel>اسم الوحدة (إنجليزي)</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              data-testid="input-new-quotation-unit-name-en"
                              placeholder="Piece"
                              maxLength={100}
                              dir="ltr"
                              disabled={busy}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="button-cancel-quotation-unit"
                      onClick={() => setShowUnitForm(false)}
                      disabled={busy}
                    >
                      إلغاء
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="gap-1.5"
                      data-testid="button-save-quotation-unit"
                      onClick={() => {
                        const values = form.getValues();
                        if (values.unitNameAr.trim().length < 2) {
                          form.setError("unitNameAr", { type: "manual", message: "اكتب اسم وحدة القياس." });
                          return;
                        }
                        createUnitMutation.mutate({
                          unitNameAr: values.unitNameAr,
                          unitNameEn: values.unitNameEn,
                          unitCode: values.unitCode,
                        });
                      }}
                      disabled={busy}
                    >
                      <Save className="h-3.5 w-3.5" />
                      حفظ الوحدة
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="salePrice"
                rules={{ min: { value: 0, message: "السعر لا يمكن أن يكون سالباً." } }}
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>سعر البيع الافتراضي</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-new-quotation-item-sale-price"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        step="any"
                        dir="ltr"
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="vatRate"
                rules={{
                  min: { value: 0, message: "أقل نسبة ضريبة هي 0%." },
                  max: { value: 100, message: "أعلى نسبة ضريبة هي 100%." },
                }}
                render={({ field }) => (
                  <FormItem className="space-y-1.5">
                    <FormLabel>نسبة الضريبة %</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        data-testid="input-new-quotation-item-vat-rate"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        max="100"
                        step="any"
                        dir="ltr"
                        disabled={busy}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-2">
              <Button
                type="button"
                variant="outline"
                className="gap-1.5"
                data-testid="button-cancel-quotation-item"
                onClick={() => closeDialog(false)}
                disabled={busy}
              >
                <X className="h-4 w-4" />
                إلغاء
              </Button>
              <Button
                type="submit"
                className="gap-1.5"
                data-testid="button-save-quotation-item"
                disabled={busy || nameAr.trim().length < 2 || !unitId}
              >
                <Save className="h-4 w-4" />
                {createItemMutation.isPending ? "جاري حفظ الصنف..." : "حفظ وإضافة الصنف"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}