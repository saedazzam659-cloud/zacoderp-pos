import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money, qty as fq, todayISO } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Empty, Field } from '@/components/ui';
import { NumericEntry } from '@/components/NumericEntry';
import { calcInvoiceLine, syncLineDiscount } from '@/lib/invoiceLineCalc';
import { normalizeSearch } from '@/lib/search';

// مرتجع مبيعات — بنفس أسلوب الويب:
// 1) من داخل فاتورة (invoiceId): تُحمَّل أصناف الفاتورة ويحدد المستخدم الكميات المرتجعة.
// 2) مستقل: اختيار عميل وأصناف يدوياً.
// كل مرتجع يُنشأ هنا يظهر في شاشة «مرتجع المبيعات».

interface RetLine {
  itemId: number | null;
  itemName: string;
  qty: number;
  maxQty?: number;      // للسقف عند الإرجاع من فاتورة
  unitPrice: number;
  vatRate: number;
  freeQty: number;
  discount: number;
  discountAmount: number;
  warehouseId?: number | null;
  unitId?: number | null;
  unitName?: string;
  conversionFactor: number;
}

function notify(title: string, msg: string) {
  if (Platform.OS === 'web') console.log(title, msg);
  else Alert.alert(title, msg);
}

export default function SalesReturnForm() {
  const { id, invoiceId: invoiceIdParam } = useLocalSearchParams<{ id: string; invoiceId?: string }>();
  const isNew = id === 'new';
  const returnId = isNew ? null : Number(id);
  const srcInvoiceId = isNew && invoiceIdParam ? Number(invoiceIdParam) : null;
  const router = useRouter();
  const qc = useQueryClient();
  const { companyId, user } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [customerId, setCustomerId] = useState<number | null>(null);
  const [returnDate, setReturnDate] = useState(todayISO());
  const [paymentType, setPaymentType] = useState<'credit' | 'cash' | 'bank'>('cash');
  const [cashBoxId, setCashBoxId] = useState<number | null>(null);
  const [bankAccountId, setBankAccountId] = useState<number | null>(null);
  const [priceIncludesVat, setPriceIncludesVat] = useState(false);
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<RetLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [posting, setPosting] = useState(false);
  const [unposting, setUnposting] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [loadedDoc, setLoadedDoc] = useState<any>(null);
  const [srcLoaded, setSrcLoaded] = useState(false);
  const [showCustomerPick, setShowCustomerPick] = useState(false);
  const [showItemPick, setShowItemPick] = useState(false);
  const [pick, setPick] = useState<null | 'cashbox' | 'bank'>(null);
  const [search, setSearch] = useState('');
  const [itemUnits, setItemUnits] = useState<Record<number, any[]>>({});

  const customersQ = useQuery({
    queryKey: ['customers', companyId],
    queryFn: () => api<any[]>(`/api/customers?companyId=${companyId}`),
    enabled: !!companyId,
  });
  // items تُحمَّل دائماً — نحتاجها لحلّ unitId (الوحدة الرئيسية مطلوبة في السيرفر)
  const itemsQ = useQuery({
    queryKey: ['items', companyId],
    queryFn: () => api<any[]>(`/api/inventory/items?companyId=${companyId}&includeHidden=1`),
    enabled: !!companyId,
  });
  // أسعار حية: إعادة جلب الأصناف عند كل عودة لهذه الشاشة
  useFocusEffect(
    React.useCallback(() => {
      if (companyId) itemsQ.refetch();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [companyId]),
  );
  // الكميات المرتجعة سابقاً لهذه الفاتورة — السقف = المباع − المرتجع سابقاً
  const returnedQ = useQuery({
    queryKey: ['returned-by-item', srcInvoiceId],
    queryFn: () => api<any>(`/api/sales/sales-invoices/${srcInvoiceId}/returned-by-item?companyId=${companyId}`),
    enabled: !!companyId && !!srcInvoiceId,
  });
  const cashBoxesQ = useQuery({
    queryKey: ['cash-boxes', companyId],
    queryFn: () => api<any[]>(`/api/cash-boxes?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const banksQ = useQuery({
    queryKey: ['bank-accounts', companyId],
    queryFn: () => api<any[]>(`/api/bank-accounts?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const branchesQ = useQuery({
    queryKey: ['branches', companyId],
    queryFn: () => api<any[]>(`/api/org/branches?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const warehousesQ = useQuery({
    queryKey: ['warehouses', companyId],
    queryFn: () => api<any[]>(`/api/inventory/warehouses?companyId=${companyId}`),
    enabled: !!companyId,
    retry: false,
  });
  const srcInvoiceQ = useQuery({
    queryKey: ['sales-invoice', srcInvoiceId],
    queryFn: () => api<any>(`/api/sales/sales-invoices/${srcInvoiceId}?companyId=${companyId}`),
    enabled: !!companyId && !!srcInvoiceId,
  });
  const docQ = useQuery({
    queryKey: ['sales-return', returnId],
    queryFn: () => api<any>(`/api/sales/sales-returns/${returnId}?companyId=${companyId}`),
    enabled: !!companyId && !!returnId,
  });

  const customers = Array.isArray(customersQ.data) ? customersQ.data : [];
  const items = Array.isArray(itemsQ.data) ? itemsQ.data : [];
  const cashBoxes = Array.isArray(cashBoxesQ.data) ? cashBoxesQ.data : [];
  const banks = Array.isArray(banksQ.data) ? banksQ.data : [];
  const branches = Array.isArray(branchesQ.data) ? branchesQ.data : [];
  const warehouses = Array.isArray(warehousesQ.data) ? warehousesQ.data : [];
  const customer = customers.find((x) => x.id === customerId) ?? null;

  const branchId =
    loadedDoc?.branchId ??
    srcInvoiceQ.data?.branchId ??
    (user?.branchIds?.length ? user.branchIds[0] : null) ??
    (branches.find((b: any) => b.isDefault || b.is_default)?.id ?? branches[0]?.id ?? null);
  const defaultWarehouseId =
    (warehouses.find((w: any) => w.isDefault || w.is_default)?.id ?? warehouses[0]?.id ?? null);

  // خزنة افتراضية عند الفتح
  useEffect(() => {
    if (!cashBoxId && cashBoxes.length > 0 && !loadedDoc) {
      setCashBoxId((cashBoxes.find((b: any) => b.isDefault || b.is_default) ?? cashBoxes[0]).id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cashBoxes.length]);

  // تعبئة من الفاتورة المصدر — السقف = المباع − المرتجع سابقاً (والافتراضي المتبقي)
  useEffect(() => {
    const inv: any = srcInvoiceQ.data;
    if (!inv || !inv.id || srcLoaded || (srcInvoiceId && returnedQ.isLoading)) return;
    setSrcLoaded(true);
    setCustomerId(inv.customerId ?? null);
    setPriceIncludesVat(!!inv.priceIncludesVat);
    setPaymentType((inv.paymentType === 'bank' ? 'bank' : inv.paymentType === 'credit' ? 'credit' : 'cash') as any);
    const returnedByItem: Record<string, number> = returnedQ.data?.byItem ?? {};
    setLines((Array.isArray(inv.lines) ? inv.lines : [])
      .filter((l: any) => l.itemId != null) // لا يمكن إرجاع سطر بلا صنف
      .map((l: any) => {
        const q = parseFloat(l.qty ?? l.quantity ?? 1) || 1;
        const already = Number(returnedByItem[String(l.itemId)] ?? 0);
        const remaining = Math.max(0, q - already);
        return {
          itemId: l.itemId ?? null,
          itemName: l.itemName ?? l.item?.nameAr ?? `صنف ${l.itemId}`,
          qty: remaining,
          maxQty: remaining,
          unitPrice: parseFloat(l.unitPrice ?? 0) || 0,
          vatRate: parseFloat(l.vatRate ?? 15) || 0,
          freeQty: parseFloat(l.freeQty ?? 0) || 0,
          discount: parseFloat(l.discount ?? 0) || 0,
          discountAmount: parseFloat(l.discountAmount ?? 0) || 0,
          warehouseId: l.warehouseId ?? null,
          unitId: l.unitId ?? null,
          unitName: l.unit?.nameAr ?? l.unitName ?? (typeof l.unit === 'string' ? l.unit : undefined),
          conversionFactor: parseFloat(l.conversionFactor ?? 1) || 1,
        };
      }));
  }, [srcInvoiceQ.data, srcLoaded, returnedQ.data, returnedQ.isLoading, srcInvoiceId]);

  // عرض مرتجع محفوظ
  useEffect(() => {
    const d: any = docQ.data;
    if (!d || !d.id || loadedDoc) return;
    setLoadedDoc(d);
    setCustomerId(d.customerId ?? null);
    setReturnDate(String(d.returnDate ?? '').slice(0, 10) || todayISO());
    setPaymentType((d.paymentType as any) || 'credit');
    setCashBoxId(d.cashBoxId ?? null);
    setBankAccountId(d.bankAccountId ?? null);
    setPriceIncludesVat(!!d.priceIncludesVat);
    setNotes(d.notes ?? '');
    setLines((Array.isArray(d.lines) ? d.lines : []).map((l: any) => ({
      itemId: l.itemId ?? null,
      itemName: l.itemName ?? `صنف ${l.itemId}`,
      qty: parseFloat(l.qty ?? 1) || 1,
      unitPrice: parseFloat(l.unitPrice ?? 0) || 0,
      vatRate: parseFloat(l.vatRate ?? 15) || 0,
      freeQty: parseFloat(l.freeQty ?? 0) || 0,
      discount: parseFloat(l.discount ?? 0) || 0,
      discountAmount: parseFloat(l.discountAmount ?? 0) || 0,
      warehouseId: l.warehouseId ?? null,
      unitId: l.unitId ?? null,
      unitName: l.unit?.nameAr ?? l.unitName ?? (typeof l.unit === 'string' ? l.unit : undefined),
      conversionFactor: parseFloat(l.conversionFactor ?? 1) || 1,
    })));
  }, [docQ.data, loadedDoc]);

  const isPosted = loadedDoc && loadedDoc.status && loadedDoc.status !== 'draft';
  // مسودة محفوظة: تُعدَّل من التطبيق لمن يملك صلاحية return_edit
  const isEditingSaved = !!loadedDoc && !isNew && !isPosted;
  const readOnly = !!isPosted || (isEditingSaved && !mp('return_edit'));

  const totals = useMemo(() => {
    let subtotal = 0, vat = 0;
    for (const l of lines) {
      const amounts = calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount');
      subtotal += amounts.subtotal;
      vat += amounts.vat;
    }
    return { subtotal, vat, total: subtotal + vat };
  }, [lines, priceIncludesVat, user?.company?.taxCalculationMode]);

  const setLineQty = (idx: number, q: number) => {
    setLines((prev) => {
      const next = [...prev];
      const cap = next[idx].maxQty ?? Infinity;
      next[idx] = { ...next[idx], qty: Math.max(0, Math.min(cap, q)) };
      return next;
    });
  };

  const setLineField = (idx: number, field: 'freeQty' | 'discount' | 'discountAmount', value: number) => {
    setLines((prev) => prev.map((l, i) => {
      if (i !== idx) return l;
      if (field === 'freeQty') return { ...l, freeQty: Math.max(0, value) };
      return { ...l, ...syncLineDiscount(l, field, value) };
    }));
  };

  const selectNextUnit = async (line: RetLine, idx: number) => {
    if (line.itemId == null) return;
    let options = itemUnits[line.itemId];
    try {
      if (!options) {
        options = await api<any[]>(`/api/inventory/items/${line.itemId}/units?companyId=${companyId}`);
        setItemUnits((prev) => ({ ...prev, [line.itemId as number]: options }));
      }
    } catch (e: any) {
      notify('تعذّر تحميل الوحدات', e?.message ?? 'أعد المحاولة');
      return;
    }
    if (!options.length) return;
    const current = options.findIndex((u: any) => Number(u.unitId) === line.unitId);
    const next = options[(current + 1) % options.length];
    setLines((prev) => prev.map((l, i) => i === idx ? {
      ...l,
      unitId: Number(next.unitId),
      unitName: next.unit?.nameAr ?? next.unitNameAr ?? next.nameAr ?? String(next.unitId),
      conversionFactor: parseFloat(String(next.conversionFactor ?? 1)) || 1,
      unitPrice: next.salePrice != null ? parseFloat(String(next.salePrice)) || 0 : l.unitPrice,
    } : l));
  };

  const addItem = (it: any) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.itemId === it.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], qty: next[idx].qty + 1 }; return next; }
      return [...prev, {
        itemId: it.id,
        itemName: it.nameAr ?? it.code ?? String(it.id),
        qty: 1,
        unitPrice: parseFloat(String(it.salePrice ?? 0)) || 0,
        vatRate: parseFloat(String(it.vatRate ?? 15)),
        freeQty: 0,
        discount: 0,
        discountAmount: 0,
        warehouseId: defaultWarehouseId,
        unitId: it.unit?.id ?? null,
        unitName: it.unit?.nameAr,
        conversionFactor: 1,
      }];
    });
    setShowItemPick(false);
  };

  // حلّ الوحدة الرئيسية للصنف — السيرفر يرفض أي سطر بلا unitId
  const resolveUnitId = (l: RetLine): number | null => {
    if (l.unitId) return l.unitId;
    const it: any = items.find((x: any) => x.id === l.itemId);
    return it?.unit?.id ?? it?.unitId ?? it?.mainUnitId ?? null;
  };

  const save = async (thenPost: boolean) => {
    const active = lines.filter((l) => l.qty > 0);
    if (!active.length) { setSaveError('حدد كمية مرتجعة لصنف واحد على الأقل'); return; }
    if (!customerId && !srcInvoiceId) { setSaveError('اختر العميل'); return; }
    if (!branchId) { setSaveError('لا يوجد فرع معرّف لحسابك'); return; }
    if (paymentType === 'cash' && !cashBoxId && cashBoxes.length > 0) { setSaveError('اختر الخزنة'); return; }
    if (paymentType === 'bank' && !bankAccountId) { setSaveError('اختر الحساب البنكي'); return; }
    if (!notes.trim()) { setSaveError('الشرح (الملاحظات) مطلوب لكل مرتجع'); return; }
    const noUnit = active.find((l) => !resolveUnitId(l));
    if (noUnit) { setSaveError(`الصنف «${noUnit.itemName}» بلا وحدة رئيسية — لا يمكن إرجاعه من الجوال`); return; }
    setSaveError('');
    thenPost ? setPosting(true) : setSaving(true);
    try {
      const bodyLines = active.map((l) => ({
        itemId: l.itemId ?? undefined,
        itemName: l.itemName,
        qty: l.qty,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate,
        freeQty: l.freeQty,
        discount: l.discount,
        discountAmount: l.discountAmount,
        lineTotal: +calcInvoiceLine(l, priceIncludesVat, user?.company?.taxCalculationMode === 'before_discount' ? 'before_discount' : 'after_discount').total.toFixed(2),
        warehouseId: l.warehouseId ?? defaultWarehouseId ?? undefined,
        unitId: resolveUnitId(l) ?? undefined,
        conversionFactor: l.conversionFactor,
      }));
      const body = {
        companyId,
        returnDate,
        customerId,
        branchId,
        invoiceId: srcInvoiceId ?? undefined,
        paymentType,
        cashBoxId: paymentType === 'cash' ? cashBoxId : null,
        bankAccountId: paymentType === 'bank' ? bankAccountId : null,
        priceIncludesVat,
        subtotal: +totals.subtotal.toFixed(2),
        vatAmount: +totals.vat.toFixed(2),
        discountAmount: 0,
        totalAmount: +totals.total.toFixed(2),
        notes: notes.trim(),
        lines: bodyLines,
      };
      let newId: number | null;
      if (isEditingSaved && returnId) {
        await api(`/api/sales/sales-returns/${returnId}?companyId=${companyId}`, { method: 'PUT', body });
        newId = returnId;
      } else {
        const created = await api<any>('/api/sales/sales-returns', { method: 'POST', body });
        newId = created?.id;
      }
      if (thenPost && newId) {
        await api(`/api/sales/sales-returns/${newId}/post`, { method: 'PATCH', body: { companyId } });
      }
      qc.invalidateQueries({ queryKey: ['sales-returns', companyId] });
      notify('تم', thenPost ? 'تم حفظ المرتجع وترحيله' : 'تم حفظ المرتجع كمسودة');
      router.back();
    } catch (e: any) {
      setSaveError(typeof e === 'string' ? e : e?.message ?? 'فشل الحفظ');
    } finally {
      setSaving(false);
      setPosting(false);
    }
  };

  // حذف مرتجع (مسودة فقط — السيرفر يرفض المرحّل)
  const [deleting, setDeleting] = useState(false);
  const doDelete = async () => {
    if (!returnId) return;
    const go = async () => {
      setDeleting(true);
      try {
        await api(`/api/sales/sales-returns/${returnId}?companyId=${companyId}`, { method: 'DELETE' });
        qc.invalidateQueries({ queryKey: ['sales-returns', companyId] });
        notify('تم', 'تم حذف المرتجع');
        router.back();
      } catch (e: any) {
        notify('تعذّر الحذف', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setDeleting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('حذف المرتجع', 'سيتم حذف المرتجع نهائياً. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'حذف', style: 'destructive', onPress: go },
    ]);
  };

  const doUnpost = () => {
    if (!returnId) return;
    const go = async () => {
      setUnposting(true);
      try {
        await api(`/api/sales/sales-returns/${returnId}/unpost`, { method: 'PATCH', body: { companyId } });
        await qc.invalidateQueries({ queryKey: ['sales-returns', companyId] });
        await qc.invalidateQueries({ queryKey: ['sales-return', returnId] });
        setLoadedDoc((current: any) => current ? { ...current, status: 'draft' } : current);
        notify('تم', 'تم فك ترحيل المرتجع — أصبح مسودة');
      } catch (e: any) {
        notify('تعذّر فك الترحيل', typeof e === 'string' ? e : e?.message ?? 'خطأ غير معروف');
      } finally {
        setUnposting(false);
      }
    };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('فك الترحيل', 'سيتم عكس القيد وحركات المخزون ويصبح المرتجع مسودة. متابعة؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'فك الترحيل', style: 'destructive', onPress: go },
    ]);
  };

  const Seg = ({ options, value, onChange }: { options: { v: string; l: string }[]; value: string; onChange: (v: any) => void }) => (
    <View style={{ flexDirection: 'row-reverse', backgroundColor: c.muted, borderRadius: 12, padding: 3 }}>
      {options.map((o) => (
        <Pressable key={o.v} disabled={readOnly} onPress={() => onChange(o.v)}
          style={{ flex: 1, paddingVertical: 8, borderRadius: 10, backgroundColor: value === o.v ? c.card : 'transparent', alignItems: 'center' }}>
          <Text style={{ fontSize: 13, fontFamily: value === o.v ? 'Inter_600SemiBold' : 'Inter_400Regular', color: value === o.v ? c.primary : c.mutedForeground }}>{o.l}</Text>
        </Pressable>
      ))}
    </View>
  );

  const PickRow = ({ label, value, onPress, testID }: { label: string; value: string; onPress: () => void; testID?: string }) => (
    <Pressable testID={testID} disabled={readOnly} onPress={onPress}
      style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 12, backgroundColor: c.card }}>
      <Text style={{ fontSize: 13, color: c.mutedForeground }}>{label}</Text>
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 6 }}>
        <Text style={{ fontSize: 14, color: c.foreground, fontFamily: 'Inter_500Medium' }}>{value}</Text>
        <Feather name="chevron-down" size={16} color={c.mutedForeground} />
      </View>
    </Pressable>
  );

  if ((returnId && docQ.isLoading) || (srcInvoiceId && srcInvoiceQ.isLoading)) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 12, paddingHorizontal: 14, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold' }}>
          {isNew ? (srcInvoiceId ? `مرتجع من فاتورة ${srcInvoiceQ.data?.docNumber ?? ''}` : 'مرتجع مبيعات جديد') : `مرتجع ${loadedDoc?.docNumber ?? ''}`}
        </Text>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="button-close-return">
          <Feather name="x" size={22} color="#fff" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>طريقة ردّ المبلغ</Text>
          <Seg
            options={[{ v: 'cash', l: 'نقدي' }, { v: 'bank', l: 'بنك' }, { v: 'credit', l: 'على الحساب' }]}
            value={paymentType}
            onChange={setPaymentType}
          />
          {paymentType === 'cash' && cashBoxes.length > 0 ? (
            <PickRow label="الخزنة" value={cashBoxes.find((b) => b.id === cashBoxId)?.nameAr ?? 'اختر'} onPress={() => setPick('cashbox')} testID="pick-return-cashbox" />
          ) : null}
          {paymentType === 'bank' ? (
            <PickRow label="الحساب البنكي" value={banks.find((b) => b.id === bankAccountId)?.nameAr ?? 'اختر'} onPress={() => setPick('bank')} testID="pick-return-bank" />
          ) : null}
          <PickRow
            label="العميل"
            value={customer?.nameAr ?? (srcInvoiceId ? 'من الفاتورة' : 'اختر عميلاً *')}
            onPress={() => { if (!srcInvoiceId) setShowCustomerPick(true); }}
            testID="pick-return-customer"
          />
          <Field label="تاريخ المرتجع (YYYY-MM-DD)" value={returnDate} onChangeText={setReturnDate} ltr testID="input-return-date" />
        </Card>

        <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: c.foreground, textAlign: 'right' }}>
              {srcInvoiceId ? 'أصناف الفاتورة — حدد الكميات المرتجعة' : 'الأصناف المرتجعة'}
            </Text>
            {!srcInvoiceId && !readOnly ? (
              <Pressable testID="button-add-return-item" onPress={() => setShowItemPick(true)} style={{ backgroundColor: c.secondary, borderRadius: 10, padding: 8 }}>
                <Feather name="plus" size={16} color={c.primary} />
              </Pressable>
            ) : null}
          </View>
          {!lines.length ? <Empty icon="package" text="لا توجد أصناف" /> : null}
          {lines.map((l, idx) => (
            <View key={`${l.itemId}-${idx}`} style={{ gap: 6, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 8 }}>
              <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ textAlign: 'right', fontSize: 13, color: c.foreground }}>{l.itemName}</Text>
                  <Text style={{ textAlign: 'right', fontSize: 11, color: c.mutedForeground }}>
                    {money(l.unitPrice)}{l.maxQty != null ? ` · بالفاتورة ${fq(l.maxQty)}` : ''}
                  </Text>
                </View>
                {!readOnly ? (
                  <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8 }}>
                    <Pressable onPress={() => setLineQty(idx, l.qty + 1)} style={{ backgroundColor: c.primary, borderRadius: 8, padding: 6 }}>
                      <Feather name="plus" size={13} color="#fff" />
                    </Pressable>
                    <NumericEntry
                      testID={`input-return-qty-${l.itemId ?? idx}`}
                      value={l.qty}
                      blankWhenOne
                      onChangeValue={(q) => setLineQty(idx, q)}
                      style={{ width: 52, borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 4, textAlign: 'center', fontSize: 14, fontFamily: 'Inter_700Bold', color: c.foreground, backgroundColor: c.background }}
                    />
                    <Pressable onPress={() => setLineQty(idx, l.qty - 1)} style={{ backgroundColor: c.muted, borderRadius: 8, padding: 6 }}>
                      <Feather name="minus" size={13} color={c.foreground} />
                    </Pressable>
                  </View>
                ) : (
                  <Text style={{ fontSize: 14, fontFamily: 'Inter_700Bold', color: c.foreground }}>{fq(l.qty)}</Text>
                )}
              </View>
              {!readOnly && (mp('invoice_free_qty') || mp('invoice_discount') || mp('invoice_unit_selection')) ? (
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row-reverse', alignItems: 'flex-end', gap: 6 }}>
                    {mp('invoice_free_qty') ? (
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>مجاني</Text>
                        <NumericEntry testID={`input-return-free-qty-${l.itemId ?? idx}`} value={l.freeQty} emptyValue={0}
                          onChangeValue={(v) => setLineField(idx, 'freeQty', v)}
                          style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                      </View>
                    ) : null}
                    {mp('invoice_discount') ? (
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم %</Text>
                        <NumericEntry testID={`input-return-discount-${l.itemId ?? idx}`} value={l.discount} emptyValue={0}
                          onChangeValue={(v) => setLineField(idx, 'discount', v)}
                          style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                      </View>
                    ) : null}
                    {mp('invoice_discount') ? (
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ textAlign: 'right', fontSize: 10, color: c.mutedForeground }}>خصم قيمة</Text>
                        <NumericEntry testID={`input-return-discount-amount-${l.itemId ?? idx}`} value={l.discountAmount} emptyValue={0}
                          onChangeValue={(v) => setLineField(idx, 'discountAmount', v)}
                          style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingVertical: 4, textAlign: 'center', fontSize: 12, color: c.foreground }} />
                      </View>
                    ) : null}
                  </View>
                  {mp('invoice_unit_selection') ? (
                    <Pressable onPress={() => selectNextUnit(l, idx)} testID={`button-return-unit-${l.itemId ?? idx}`} style={{ alignSelf: 'flex-start', paddingVertical: 7, paddingHorizontal: 10, borderRadius: 8, backgroundColor: c.muted }}>
                      <Text style={{ fontSize: 11, color: c.foreground }}>{l.unitName ?? 'وحدة'}</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          ))}
        </Card>

        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
            <Text style={{ color: c.mutedForeground }}>الإجمالي قبل الضريبة</Text>
            <Text style={{ fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{money(totals.subtotal)}</Text>
          </View>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
            <Text style={{ color: c.mutedForeground }}>ضريبة القيمة المضافة</Text>
            <Text style={{ fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{money(totals.vat)}</Text>
          </View>
          <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
            <Text style={{ fontFamily: 'Inter_700Bold', color: c.foreground }}>إجمالي المرتجع</Text>
            <Text style={{ fontFamily: 'Inter_700Bold', fontSize: 17, color: c.destructive }}>{money(totals.total)}</Text>
          </View>
        </Card>

        {!readOnly ? (
          <Card>
            <Field label="الشرح / الملاحظات (إلزامي) *" value={notes} onChangeText={setNotes} multiline testID="input-return-notes" />
          </Card>
        ) : null}
        {saveError ? <Text style={{ color: c.destructive, textAlign: 'right', fontSize: 13 }}>{saveError}</Text> : null}
        {!readOnly ? (
          <View style={{ gap: 10 }}>
            {isNew && !mp('return_create') ? (
              <Card><Text style={{ textAlign: 'right', color: c.destructive }}>ليست لديك صلاحية إنشاء مرتجع من التطبيق — تواصل مع مدير النظام.</Text></Card>
            ) : (
              <>
                {mp('return_post') ? <Btn title="حفظ وترحيل المرتجع" onPress={() => save(true)} loading={posting} icon="check-circle" testID="button-save-post-return" /> : null}
                <Btn title="حفظ كمسودة" onPress={() => save(false)} loading={saving} kind="outline" testID="button-save-draft-return" />
                {isEditingSaved && mp('return_delete') ? (
                  <Btn title="حذف المرتجع" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-return" />
                ) : null}
              </>
            )}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>{isPosted ? 'هذا المرتجع مرحّل — للعرض فقط.' : 'ليست لديك صلاحية تعديل المرتجعات من التطبيق.'}</Text></Card>
            {isPosted && mp('return_unpost') ? (
              <Btn title="فك ترحيل المرتجع" icon="rotate-ccw" kind="destructive" loading={unposting} onPress={doUnpost} testID="button-unpost-return" />
            ) : null}
            {!isPosted && loadedDoc && mp('return_delete') ? (
              <Btn title="حذف المرتجع" icon="trash-2" kind="destructive" loading={deleting} onPress={doDelete} testID="button-delete-return" />
            ) : null}
          </View>
        )}
      </ScrollView>

      {/* خزنة/بنك */}
      <Modal visible={!!pick} transparent animationType="slide" onRequestClose={() => setPick(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '60%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>
              {pick === 'cashbox' ? 'اختيار الخزنة' : 'اختيار الحساب البنكي'}
            </Text>
            <FlatList
              data={pick === 'cashbox' ? cashBoxes : banks}
              keyExtractor={(x: any) => String(x.id)}
              renderItem={({ item }: any) => (
                <Pressable
                  onPress={() => { pick === 'cashbox' ? setCashBoxId(item.id) : setBankAccountId(item.id); setPick(null); }}
                  style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between' })}
                >
                  <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>
                    {item.nameAr}{(item.isDefault || item.is_default) ? '  (افتراضي)' : ''}
                  </Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      {/* اختيار العميل */}
      <Modal visible={showCustomerPick} transparent animationType="slide" onRequestClose={() => setShowCustomerPick(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>اختيار العميل</Text>
            <TextInput value={search} onChangeText={setSearch} placeholder="بحث..." placeholderTextColor={c.mutedForeground}
              style={{ borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 10, textAlign: 'right', color: c.foreground }} />
            <FlatList
              data={customers.filter((x) => {
                const s = normalizeSearch(search);
                return !s || normalizeSearch(x.nameAr).includes(s) || normalizeSearch(x.nameEn).includes(s) || normalizeSearch(x.code).includes(s);
              })}
              keyExtractor={(x) => String(x.id)}
              renderItem={({ item }) => (
                <Pressable onPress={() => { setCustomerId(item.id); setShowCustomerPick(false); }}
                  style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1 })}>
                  <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>{item.nameAr}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>

      {/* اختيار صنف (وضع المرتجع المستقل) */}
      <Modal visible={showItemPick} transparent animationType="slide" onRequestClose={() => setShowItemPick(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <View style={{ backgroundColor: c.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, maxHeight: '75%', padding: 14, gap: 10 }}>
            <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>إضافة صنف</Text>
            <TextInput value={search} onChangeText={setSearch} placeholder="بحث بالاسم أو الكود..." placeholderTextColor={c.mutedForeground}
              style={{ borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 10, textAlign: 'right', color: c.foreground }} />
            <FlatList
              data={items.filter((i: any) => {
                const s = normalizeSearch(search);
                return !s || normalizeSearch(i.nameAr).includes(s) || normalizeSearch(i.nameEn).includes(s) || normalizeSearch(i.code).includes(s) || normalizeSearch(i.barcode).includes(s);
              }).slice(0, 60)}
              keyExtractor={(x: any) => String(x.id)}
              renderItem={({ item }: any) => (
                <Pressable onPress={() => addItem(item)}
                  style={({ pressed }) => ({ paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: c.border, opacity: pressed ? 0.6 : 1, flexDirection: 'row-reverse', justifyContent: 'space-between' })}>
                  <Text style={{ textAlign: 'right', fontSize: 14, color: c.foreground }}>{item.nameAr}</Text>
                  <Text style={{ fontSize: 13, color: c.mutedForeground }}>{money(item.salePrice)}</Text>
                </Pressable>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
