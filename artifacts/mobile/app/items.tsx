import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { money } from '@/lib/format';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { normalizeSearch } from '@/lib/search';
import { Btn, Card, Empty, ErrorBox, Field } from '@/components/ui';

// ─── شاشة الأصناف ───────────────────────────────────────────────────────────
// عرض وإضافة وتعديل الأصناف من الموبايل — بنفس حقول الويب الأساسية:
// الاسم، الباركود، نوع الصنف، وحدة القياس (تُحمَّل من السيرفر)، الأسعار والضريبة.
// محكومة بمفاتيح صلاحيات الموبايل items_view / item_create / item_edit / item_delete.

interface ItemRow {
  id: number;
  code?: string;
  nameAr?: string;
  nameEn?: string;
  barcode?: string;
  itemType?: string;
  salePrice?: number | string;
  costPrice?: number | string;
  vatRate?: number | string;
  unitId?: number | null;
  unit?: { id: number; nameAr?: string } | null;
}

interface UnitRow { id: number; nameAr?: string; code?: string }

const ITEM_TYPES: Array<{ value: string; label: string }> = [
  { value: 'stock', label: 'مخزني' },
  { value: 'service', label: 'خدمي' },
  { value: 'fixed_asset', label: 'أصل ثابت' },
  { value: 'prepaid_expense', label: 'مصروف مقدم' },
];

const typeLabel = (v?: string) => ITEM_TYPES.find((t) => t.value === v)?.label ?? v ?? '—';

export default function Items() {
  const { companyId } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const qc = useQueryClient();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [nameAr, setNameAr] = useState('');
  const [barcode, setBarcode] = useState('');
  const [itemType, setItemType] = useState('stock');
  const [unitId, setUnitId] = useState<number | null>(null);
  const [salePrice, setSalePrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [vatRate, setVatRate] = useState('15');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showUnitPick, setShowUnitPick] = useState(false);
  const [showTypePick, setShowTypePick] = useState(false);

  const q = useQuery({
    queryKey: ['items', companyId],
    queryFn: () => api<ItemRow[]>(`/api/inventory/items?companyId=${companyId}&includeHidden=1`),
    enabled: !!companyId,
  });

  // وحدات القياس — تُحمَّل من السيرفر (وتُخزَّن محلياً في وضع الأوف لاين)
  const unitsQ = useQuery({
    queryKey: ['units', companyId],
    queryFn: () => api<UnitRow[]>(`/api/inventory/units?companyId=${companyId}`),
    enabled: !!companyId,
  });
  const units = Array.isArray(unitsQ.data) ? unitsQ.data : [];

  const rows = useMemo(() => {
    const list = Array.isArray(q.data) ? q.data : [];
    const s = normalizeSearch(search);
    if (!s) return list;
    return list.filter(
      (r) =>
        normalizeSearch(r.nameAr).includes(s) ||
        normalizeSearch(r.nameEn).includes(s) ||
        normalizeSearch(r.code).includes(s) ||
        normalizeSearch(r.barcode).includes(s),
    );
  }, [q.data, search]);

  const closeModal = () => {
    setShowForm(false); setEditId(null); setNameAr(''); setBarcode('');
    setItemType('stock'); setUnitId(null); setSalePrice(''); setCostPrice(''); setVatRate('15'); setError('');
  };

  const openEdit = (r: ItemRow) => {
    setEditId(r.id);
    setNameAr(r.nameAr ?? '');
    setBarcode(r.barcode ?? '');
    setItemType(r.itemType ?? 'stock');
    setUnitId(r.unit?.id ?? r.unitId ?? null);
    setSalePrice(String(r.salePrice ?? ''));
    setCostPrice(String(r.costPrice ?? ''));
    setVatRate(String(r.vatRate ?? '15'));
    setError('');
    setShowForm(true);
  };

  const save = async () => {
    if (!nameAr.trim()) { setError('اسم الصنف مطلوب'); return; }
    setBusy(true); setError('');
    try {
      const body = {
        companyId,
        nameAr: nameAr.trim(),
        barcode: barcode.trim() || undefined,
        itemType,
        unitId: unitId ?? undefined,
        salePrice: parseFloat(salePrice) || 0,
        costPrice: parseFloat(costPrice) || 0,
        vatRate: parseFloat(vatRate) || 0,
      };
      if (editId) await api(`/api/inventory/items/${editId}?companyId=${companyId}`, { method: 'PUT', body });
      else await api('/api/inventory/items', { method: 'POST', body });
      closeModal();
      qc.invalidateQueries({ queryKey: ['items', companyId] });
    } catch (e: any) {
      setError(e?.message ?? 'فشل الحفظ');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!editId) return;
    setBusy(true); setError('');
    try {
      await api(`/api/inventory/items/${editId}?companyId=${companyId}`, { method: 'DELETE' });
      closeModal();
      qc.invalidateQueries({ queryKey: ['items', companyId] });
    } catch (e: any) {
      setError(e?.message ?? 'تعذّر الحذف — قد يكون للصنف حركات مرتبطة');
    } finally {
      setBusy(false);
    }
  };

  const unitName = (id: number | null) => units.find((u) => u.id === id)?.nameAr ?? 'بدون وحدة';

  const PickRow = ({ label, value, onPress, testID }: { label: string; value: string; onPress: () => void; testID?: string }) => (
    <View style={{ gap: 5 }}>
      <Text style={{ fontSize: 12.5, color: c.mutedForeground, textAlign: 'right', fontFamily: 'Inter_500Medium' }}>{label}</Text>
      <Pressable
        testID={testID}
        onPress={onPress}
        style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1.2, borderColor: c.input, borderRadius: 12, padding: 12, backgroundColor: c.card }}
      >
        <Text style={{ fontSize: 14, color: c.foreground, fontFamily: 'Inter_500Medium' }}>{value}</Text>
        <Feather name="chevron-down" size={16} color={c.mutedForeground} />
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 14, paddingHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold' }}>الأصناف</Text>
          {mp('item_create') ? (
            <Pressable testID="button-new-item" onPress={() => setShowForm(true)} style={{ backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 12, padding: 8 }}>
              <Feather name="plus" size={20} color="#fff" />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: 12, paddingHorizontal: 10 }}>
          <Feather name="search" size={16} color="rgba(255,255,255,0.8)" />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="بحث بالاسم أو الكود أو الباركود"
            placeholderTextColor="rgba(255,255,255,0.7)"
            style={{ flex: 1, color: '#fff', paddingVertical: 9, textAlign: 'right', fontSize: 14 }}
          />
        </View>
      </View>

      {!mp('items_view') ? (
        <View style={{ padding: 20 }}>
          <Empty icon="lock" text="ليست لديك صلاحية عرض الأصناف من التطبيق" />
        </View>
      ) : q.isError ? (
        <ErrorBox text={(q.error as Error)?.message ?? 'فشل تحميل الأصناف'} onRetry={() => q.refetch()} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 30 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={c.primary} />}
          ListEmptyComponent={q.isLoading ? null : <Empty icon="package" text="لا توجد أصناف بعد" />}
          renderItem={({ item }) => (
            <Pressable
              testID={`item-row-${item.id}`}
              disabled={!mp('item_edit') && !mp('item_delete')}
              onPress={() => openEdit(item)}
              style={({ pressed }) => ({ backgroundColor: c.card, borderRadius: 14, borderWidth: 1, borderColor: c.border, padding: 13, gap: 5, opacity: pressed ? 0.7 : 1 })}
            >
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 15, color: c.foreground }}>{item.nameAr ?? '—'}</Text>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{item.code ?? ''}</Text>
              </View>
              <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' }}>
                <View style={{ flexDirection: 'row-reverse', gap: 12 }}>
                  <Text style={{ color: c.mutedForeground, fontSize: 12.5 }}>{typeLabel(item.itemType)}</Text>
                  <Text style={{ color: c.mutedForeground, fontSize: 12.5 }}>{item.unit?.nameAr ?? unitName(item.unitId ?? null)}</Text>
                </View>
                <Text style={{ color: c.primary, fontSize: 14.5, fontFamily: 'Inter_700Bold' }}>{money(item.salePrice)}</Text>
              </View>
            </Pressable>
          )}
        />
      )}

      {/* نموذج إضافة/تعديل صنف */}
      <Modal visible={showForm} transparent animationType="slide" onRequestClose={closeModal}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <Card style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, gap: 12, paddingBottom: 30, maxHeight: '88%' }}>
            <ScrollView contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled">
              <Text style={{ fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>
                {editId ? 'تعديل صنف' : 'صنف جديد'}
              </Text>
              <Field label="اسم الصنف *" value={nameAr} onChangeText={setNameAr} testID="input-item-name" />
              <Field label="الباركود" value={barcode} onChangeText={setBarcode} keyboardType="numeric" ltr />
              <PickRow label="نوع الصنف" value={typeLabel(itemType)} onPress={() => setShowTypePick(true)} testID="picker-item-type" />
              <PickRow label="وحدة القياس" value={unitName(unitId)} onPress={() => setShowUnitPick(true)} testID="picker-item-unit" />
              <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
                <View style={{ flex: 1 }}><Field label="سعر البيع" value={salePrice} onChangeText={setSalePrice} keyboardType="numeric" ltr /></View>
                <View style={{ flex: 1 }}><Field label="التكلفة" value={costPrice} onChangeText={setCostPrice} keyboardType="numeric" ltr /></View>
                <View style={{ flex: 1 }}><Field label="الضريبة %" value={vatRate} onChangeText={setVatRate} keyboardType="numeric" ltr /></View>
              </View>
              {error ? <Text style={{ color: c.destructive, fontSize: 13, textAlign: 'right' }}>{error}</Text> : null}
              <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
                {(!editId || mp('item_edit')) ? (
                  <View style={{ flex: 1 }}><Btn title="حفظ" onPress={save} loading={busy} testID="button-save-item" /></View>
                ) : null}
                <View style={{ flex: 1 }}><Btn title="إلغاء" onPress={closeModal} kind="outline" /></View>
              </View>
              {editId && mp('item_delete') ? (
                <Btn title="حذف الصنف" icon="trash-2" kind="destructive" loading={busy} onPress={doDelete} testID="button-delete-item" />
              ) : null}
            </ScrollView>
          </Card>
        </View>
      </Modal>

      {/* منتقي نوع الصنف */}
      <Modal visible={showTypePick} transparent animationType="fade" onRequestClose={() => setShowTypePick(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }} onPress={() => setShowTypePick(false)}>
          <Card style={{ gap: 4 }}>
            {ITEM_TYPES.map((t) => (
              <Pressable
                key={t.value}
                testID={`type-option-${t.value}`}
                onPress={() => { setItemType(t.value); setShowTypePick(false); }}
                style={{ padding: 13, borderRadius: 10, backgroundColor: itemType === t.value ? c.secondary : 'transparent' }}
              >
                <Text style={{ textAlign: 'right', fontSize: 15, color: itemType === t.value ? c.primary : c.foreground, fontFamily: 'Inter_500Medium' }}>{t.label}</Text>
              </Pressable>
            ))}
          </Card>
        </Pressable>
      </Modal>

      {/* منتقي وحدة القياس */}
      <Modal visible={showUnitPick} transparent animationType="fade" onRequestClose={() => setShowUnitPick(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 }} onPress={() => setShowUnitPick(false)}>
          <Card style={{ gap: 4, maxHeight: '70%' }}>
            <ScrollView>
              <Pressable onPress={() => { setUnitId(null); setShowUnitPick(false); }} style={{ padding: 13 }}>
                <Text style={{ textAlign: 'right', fontSize: 15, color: c.mutedForeground }}>بدون وحدة</Text>
              </Pressable>
              {units.map((u) => (
                <Pressable
                  key={u.id}
                  testID={`unit-option-${u.id}`}
                  onPress={() => { setUnitId(u.id); setShowUnitPick(false); }}
                  style={{ padding: 13, borderRadius: 10, backgroundColor: unitId === u.id ? c.secondary : 'transparent' }}
                >
                  <Text style={{ textAlign: 'right', fontSize: 15, color: unitId === u.id ? c.primary : c.foreground, fontFamily: 'Inter_500Medium' }}>
                    {u.nameAr ?? u.code ?? String(u.id)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Card>
        </Pressable>
      </Modal>
    </View>
  );
}
