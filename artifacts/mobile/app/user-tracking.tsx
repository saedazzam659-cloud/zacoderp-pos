import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { getGetMobileTrackingManagerReportQueryKey, useGetMobileTrackingManagerReport } from '@workspace/api-client-react';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Card } from '@/components/ui';

type Period = 'day' | 'week' | 'month';
const dateKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const periodRange = (period: Period) => {
  const end = new Date(); const start = new Date(end);
  if (period === 'week') start.setDate(start.getDate() - 6);
  if (period === 'month') start.setDate(start.getDate() - 29);
  return { from: dateKey(start), to: dateKey(end) };
};
const timeLabel = (s?: string | null) => s ? new Date(s).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' }) : 'لا توجد حركة مسجلة';

export default function UserTrackingScreen() {
  const c = useColors(); const insets = useSafeAreaInsets();
  const { mp } = useMobilePerms();
  const [period, setPeriod] = useState<Period>('day');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const range = useMemo(() => periodRange(period), [period]);
  const q = useGetMobileTrackingManagerReport(range, { query: { queryKey: getGetMobileTrackingManagerReportQueryKey(range), enabled: mp('mobile_tracking_manage'), refetchInterval: 20_000 } });
  const users = q.data?.users ?? [];
  const selected = users.find(u => u.id === selectedId) ?? users[0];
  const label = period === 'day' ? 'اليوم' : period === 'week' ? 'آخر ٧ أيام' : 'آخر ٣٠ يومًا';

  const shareReport = async () => {
    if (!selected) return;
    const points = selected.points;
    const latest = points.at(-1);
    const message = [
      `تقرير حركة ${selected.nameAr || selected.nameEn || selected.username}`,
      `الفترة: ${range.from} إلى ${range.to}`,
      `عدد المواقع المسجلة: ${selected.summary.pointCount}`,
      `المسافة التقديرية: ${selected.summary.distanceKm} كم`,
      `أول حركة: ${timeLabel(selected.summary.firstAt)}`,
      `آخر حركة: ${timeLabel(selected.summary.lastAt)}`,
      latest ? `آخر موقع: https://www.openstreetmap.org/?mlat=${latest.lat}&mlon=${latest.lng}#map=16/${latest.lat}/${latest.lng}` : '',
      ...points.slice(-10).reverse().map((p, i) =>
        `${i + 1}. ${timeLabel(p.recordedAt)} — https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=16/${p.lat}/${p.lng}`),
      points.length > 10 ? `ملاحظة: عُرضت أحدث 10 مواقع من أصل ${points.length}.` : '',
      'تم إنشاء التقرير من نظام زاكود ERP.',
    ].filter(Boolean).join('\n');
    try { await Linking.openURL(`https://wa.me/?text=${encodeURIComponent(message)}`); }
    catch {
      try { await Share.share({ message, title: 'تقرير حركة المندوب' }); }
      catch { if (Platform.OS === 'web') window.alert('تعذّرت مشاركة التقرير'); }
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ paddingTop: (Platform.OS === 'web' ? 67 : insets.top) + 8, paddingHorizontal: 18, paddingBottom: 16, backgroundColor: c.primary, flexDirection: 'row-reverse', alignItems: 'center', gap: 12 }}>
        <Feather name="map-pin" size={22} color={c.primaryForeground} />
        <View style={{ flex: 1 }}>
          <Text style={{ textAlign: 'right', color: c.primaryForeground, fontSize: 20, fontFamily: 'Inter_700Bold' }}>متابعة المناديب</Text>
          <Text style={{ textAlign: 'right', color: c.primaryForeground, opacity: 0.8, fontSize: 12 }}>تحديث تلقائي · {label}</Text>
        </View>
        <Pressable accessibilityLabel="تحديث" onPress={() => q.refetch()} testID="tracking-refresh" style={{ padding: 8 }}>
          <Feather name="refresh-cw" size={18} color={c.primaryForeground} />
        </Pressable>
      </View>

      {!mp('mobile_tracking_manage') ? (
        <View style={{ padding: 18 }}><Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>هذه الشاشة متوقفة. اطلب من مدير النظام تفعيل «متابعة تحركات المناديب» من صلاحيات تطبيقات الموبايل.</Text></Card></View>
      ) : q.isPending ? <ActivityIndicator style={{ marginTop: 40 }} color={c.primary} /> : q.isError ? (
        <View style={{ padding: 18 }}><Card><Text style={{ textAlign: 'right', color: c.destructive }}>{(q.error as Error)?.message ?? 'تعذّر تحميل بيانات المتابعة'}</Text></Card></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: (Platform.OS === 'web' ? 34 : insets.bottom) + 24 }}>
          <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
            {(['day', 'week', 'month'] as Period[]).map(p => (
              <Pressable key={p} testID={`tracking-period-${p}`} onPress={() => setPeriod(p)} style={{ flex: 1, paddingVertical: 11, borderRadius: 12, alignItems: 'center', backgroundColor: period === p ? c.primary : c.card, borderWidth: 1, borderColor: period === p ? c.primary : c.border }}>
                <Text style={{ color: period === p ? c.primaryForeground : c.foreground, fontFamily: 'Inter_600SemiBold', fontSize: 13 }}>{p === 'day' ? 'اليوم' : p === 'week' ? 'أسبوع' : 'شهر'}</Text>
              </Pressable>
            ))}
          </View>
          <Card style={{ flexDirection: 'row-reverse', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center', gap: 3 }}><Text style={{ fontSize: 22, color: c.primary, fontFamily: 'Inter_700Bold' }}>{users.length}</Text><Text style={{ color: c.mutedForeground, fontSize: 12 }}>مندوب مفعّل</Text></View>
            <View style={{ alignItems: 'center', gap: 3 }}><Text style={{ fontSize: 22, color: c.primary, fontFamily: 'Inter_700Bold' }}>{users.reduce((n, u) => n + u.summary.pointCount, 0)}</Text><Text style={{ color: c.mutedForeground, fontSize: 12 }}>موقع مسجل</Text></View>
          </Card>
          {users.length === 0 ? <Card><Text style={{ textAlign: 'right', color: c.mutedForeground }}>لا يوجد مندوب فعّل مشاركة موقعه في هذه الفترة. تأكد من صلاحية «ربط التطبيق بالرقابة المباشرة» وإذن الموقع على هاتفه.</Text></Card> : users.map(u => {
            const last = u.points.at(-1); const active = selected?.id === u.id;
            return (
              <Pressable key={u.id} testID={`tracking-user-${u.id}`} onPress={() => setSelectedId(u.id)}>
                <Card style={{ gap: 9, borderColor: active ? c.primary : c.border, borderWidth: active ? 2 : 1 }}>
                  <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 10 }}>
                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.secondary, alignItems: 'center', justifyContent: 'center' }}><Feather name="user" size={18} color={c.primary} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ textAlign: 'right', color: c.foreground, fontFamily: 'Inter_700Bold', fontSize: 15 }}>{u.nameAr || u.nameEn || u.username}</Text>
                      <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 12 }}>{last ? `آخر تحديث ${timeLabel(last.recordedAt)}` : 'لا توجد حركة في الفترة'}</Text>
                    </View>
                    <View style={{ backgroundColor: last ? c.accent : c.muted, borderRadius: 20, paddingHorizontal: 9, paddingVertical: 5 }}><Text style={{ color: last ? c.success : c.mutedForeground, fontSize: 11 }}>{last ? 'مسجل' : 'غير متصل'}</Text></View>
                  </View>
                  <View style={{ flexDirection: 'row-reverse', justifyContent: 'space-between' }}>
                    <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{u.summary.pointCount} نقطة · {u.summary.distanceKm} كم تقديري</Text>
                    {last ? <Pressable onPress={() => void Linking.openURL(`https://www.openstreetmap.org/?mlat=${last.lat}&mlon=${last.lng}#map=16/${last.lat}/${last.lng}`)}><Text style={{ color: c.primary, fontSize: 12 }}>فتح آخر موقع</Text></Pressable> : null}
                  </View>
                </Card>
              </Pressable>
            );
          })}
          {selected?.points.length ? <Card style={{ gap: 10 }}>
            <Text style={{ textAlign: 'right', color: c.foreground, fontFamily: 'Inter_700Bold', fontSize: 15 }}>أحدث تحركات {selected.nameAr || selected.nameEn || selected.username}</Text>
            {selected.points.slice(-8).reverse().map((point, index) => (
              <Pressable key={`${point.recordedAt}-${index}`} onPress={() => void Linking.openURL(`https://www.openstreetmap.org/?mlat=${point.lat}&mlon=${point.lng}#map=16/${point.lat}/${point.lng}`)} style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8, paddingVertical: 5 }}>
                <Feather name="map-pin" size={15} color={c.primary} />
                <Text style={{ flex: 1, textAlign: 'right', color: c.foreground, fontSize: 12 }}>{timeLabel(point.recordedAt)}</Text>
                <Feather name="external-link" size={14} color={c.mutedForeground} />
              </Pressable>
            ))}
          </Card> : null}
          {selected ? <Pressable testID="tracking-share-whatsapp" onPress={shareReport} style={{ backgroundColor: '#147a55', borderRadius: 14, padding: 15, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
            <Feather name="message-circle" size={18} color="#fff" /><Text style={{ color: '#fff', fontFamily: 'Inter_700Bold' }}>مشاركة تقرير {label} عبر واتساب</Text>
          </Pressable> : null}
          <Text style={{ textAlign: 'center', color: c.mutedForeground, fontSize: 11 }}>المواقع متاحة فقط للمستخدمين الذين فُعّلت لهم المتابعة وسمحوا للموبايل باستخدام الموقع.</Text>
        </ScrollView>
      )}
    </View>
  );
}
