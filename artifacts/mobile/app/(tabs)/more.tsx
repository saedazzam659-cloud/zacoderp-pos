import React, { useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { api, getDomain, setDomain, defaultDomain } from '@/lib/api';
import { discardFailed, downloadAll, isOfflineEnabled, lastDownloadAt, outboxCounts, setOfflineEnabled, syncOutbox } from '@/lib/offline';
import { useAuth } from '@/contexts/AuthContext';
import { THEME_OPTIONS, useTheme } from '@/contexts/ThemeContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Field } from '@/components/ui';

export default function More() {
  const { user, logout } = useAuth();
  const { mp } = useMobilePerms();
  const { theme, setTheme } = useTheme();
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [showServer, setShowServer] = useState(false);
  const [domain, setDomainState] = useState('');

  useEffect(() => {
    getDomain().then(setDomainState);
  }, [showServer]);

  // ─── وضع الأوف لاين ────────────────────────────────────────────────────
  const companyId = user?.companyId ?? user?.company?.id;
  const [offlineOn, setOfflineOn] = useState(false);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [lastDl, setLastDl] = useState<string | null>(null);
  const [offlineBusy, setOfflineBusy] = useState(false);
  const refreshOfflineState = () => {
    isOfflineEnabled().then(setOfflineOn);
    getDomain().then(async (d) => {
      const c = await outboxCounts(d);
      setPending(c.pending); setFailed(c.failed);
      setLastDl(await lastDownloadAt(d));
    });
  };
  useEffect(refreshOfflineState, []);

  const toggleOffline = async () => {
    if (offlineBusy) return;
    if (offlineOn) {
      const go = async () => { await setOfflineEnabled(false); refreshOfflineState(); };
      if (Platform.OS === 'web') { go(); return; }
      Alert.alert('إيقاف وضع الأوف لاين', 'سيتم مسح النسخة المحلية من البيانات (العمليات المعلقة تبقى وتُزامن). متابعة؟', [
        { text: 'إلغاء', style: 'cancel' },
        { text: 'إيقاف', style: 'destructive', onPress: go },
      ]);
      return;
    }
    if (!companyId) return;
    setOfflineBusy(true);
    try {
      await setOfflineEnabled(true);
      const r = await downloadAll(await getDomain(), Number(companyId), api);
      refreshOfflineState();
      const msg = r.failed.length
        ? `اكتمل التنزيل جزئياً (${r.ok} قائمة) — تعذّر: ${r.failed.length}. أعد التحديث لاحقاً.`
        : `تم تنزيل كامل بيانات الشركة (${r.ok} قائمة). يمكنك الآن العمل بدون إنترنت.`;
      if (Platform.OS === 'web') window.alert(msg); else Alert.alert('وضع الأوف لاين', msg);
    } catch (e: any) {
      await setOfflineEnabled(false);
      const msg = e?.message ?? 'فشل التنزيل — تأكد من الاتصال ثم أعد المحاولة';
      if (Platform.OS === 'web') window.alert(msg); else Alert.alert('تعذّر التفعيل', msg);
    } finally {
      setOfflineBusy(false);
      refreshOfflineState();
    }
  };

  const doManualSync = async () => {
    if (offlineBusy) return;
    setOfflineBusy(true);
    try {
      const d = await getDomain();
      const r = await syncOutbox(d, api);
      if (companyId) await downloadAll(d, Number(companyId), api);
      refreshOfflineState();
      const parts: string[] = [];
      if (r.sent) parts.push(`تمت مزامنة ${r.sent} عملية`);
      if (r.remaining > 0) parts.push(`متبقٍ ${r.remaining} (سيُعاد إرسالها تلقائياً)`);
      if (r.failed > 0) parts.push(`${r.failed} عملية فاشلة تحتاج مراجعة`);
      const msg = parts.length ? parts.join(' — ') : 'تمت المزامنة بالكامل وتحديث النسخة المحلية';
      if (Platform.OS === 'web') window.alert(msg); else Alert.alert('المزامنة', msg);
    } catch (e: any) {
      const msg = e?.message ?? 'تعذّرت المزامنة — تأكد من الاتصال';
      if (Platform.OS === 'web') window.alert(msg); else Alert.alert('المزامنة', msg);
    } finally {
      setOfflineBusy(false);
      refreshOfflineState();
    }
  };

  const doLogout = () => {
    const go = async () => { await logout(); router.replace('/login'); };
    if (Platform.OS === 'web') { go(); return; }
    Alert.alert('تسجيل الخروج', 'هل تريد تسجيل الخروج؟', [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'خروج', style: 'destructive', onPress: go },
    ]);
  };

  const saveDomain = async () => {
    await setDomain(domain);
    setShowServer(false);
  };

  const RowItem = ({ icon, title, onPress, danger, testID }: { icon: keyof typeof Feather.glyphMap; title: string; onPress: () => void; danger?: boolean; testID?: string }) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row-reverse',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 4,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Feather name={icon} size={19} color={danger ? c.destructive : c.primary} />
      <Text style={{ flex: 1, textAlign: 'right', fontSize: 15, color: danger ? c.destructive : c.foreground, fontFamily: 'Inter_500Medium' }}>
        {title}
      </Text>
      <Feather name="chevron-left" size={18} color={c.mutedForeground} />
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 22, paddingHorizontal: 16, gap: 4 }}>
        <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold', textAlign: 'right' }}>
          {user?.company?.nameAr ?? 'زاكود ERP'}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13, textAlign: 'right' }}>
          المستخدم: {user?.username ?? '—'}
          {user?.company?.vatNumber ? ` · الرقم الضريبي: ${user.company.vatNumber}` : ''}
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Card style={{ paddingVertical: 4 }}>
          {mp('vouchers_view') ? (
            <>
              <RowItem icon="file-text" title="سندات القبض" onPress={() => router.push('/voucher/list' as any)} testID="row-vouchers" />
              <View style={{ height: 1, backgroundColor: c.border }} />
            </>
          ) : null}
          {mp('quotations_view') ? (
            <>
              <RowItem icon="tag" title="عروض الأسعار" onPress={() => router.push('/quotations' as any)} testID="row-quotations" />
              <View style={{ height: 1, backgroundColor: c.border }} />
            </>
          ) : null}
          {mp('hr_attendance_view') ? (
            <>
              <RowItem icon="clock" title="تقرير حضوري (الحضور والانصراف)" onPress={() => router.push('/hr-attendance' as any)} testID="row-hr-attendance" />
              <View style={{ height: 1, backgroundColor: c.border }} />
            </>
          ) : null}
          {mp('offline_controls') ? <RowItem
            icon={offlineOn ? 'wifi-off' : 'download-cloud'}
            title={offlineBusy ? 'جارٍ التنزيل/المزامنة…' : offlineOn ? 'وضع الأوف لاين: مفعّل (اضغط للإيقاف)' : 'تفعيل وضع الأوف لاين'}
            onPress={toggleOffline}
            testID="row-offline-toggle"
          /> : null}
          {offlineOn && mp('offline_controls') ? (
            <>
              <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 12, paddingHorizontal: 4, paddingBottom: 6 }}>
                {lastDl ? `آخر تنزيل: ${String(lastDl).slice(0, 16).replace('T', ' ')}` : ''}
                {pending > 0 ? `  ·  بانتظار المزامنة: ${pending}` : '  ·  لا عمليات معلقة'}
                {failed > 0 ? `  ·  فاشلة: ${failed}` : ''}
              </Text>
              <RowItem icon="refresh-cw" title="مزامنة وتحديث البيانات الآن" onPress={doManualSync} testID="row-offline-sync" />
              {failed > 0 ? (
                <RowItem icon="alert-triangle" danger title={`حذف العمليات الفاشلة (${failed}) — لن تُرسل`} testID="row-offline-discard-failed" onPress={() => {
                  const go = async () => { await discardFailed(await getDomain()); refreshOfflineState(); };
                  if (Platform.OS === 'web') { go(); return; }
                  Alert.alert('حذف العمليات الفاشلة', 'هذه العمليات رفضها الخادم 5 مرات ولن تُرسل. حذفها نهائي — تأكد أنك أدخلتها يدوياً من النظام. متابعة؟', [
                    { text: 'إلغاء', style: 'cancel' },
                    { text: 'حذف', style: 'destructive', onPress: go },
                  ]);
                }} />
              ) : null}
            </>
          ) : null}
          {mp('offline_controls') ? <View style={{ height: 1, backgroundColor: c.border }} /> : null}
          {/* ─── ألوان التطبيق ─── */}
          <View style={{ paddingVertical: 10, gap: 10 }}>
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8 }}>
              <Feather name="droplet" size={18} color={c.primary} />
              <Text style={{ fontFamily: 'Inter_600SemiBold', fontSize: 14, color: c.foreground }}>ألوان التطبيق</Text>
            </View>
            <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 12, paddingHorizontal: 4 }}>
              {THEME_OPTIONS.map((opt) => {
                const active = theme === opt.key;
                return (
                  <Pressable key={opt.key} onPress={() => setTheme(opt.key)} style={{ alignItems: 'center', gap: 4 }} testID={`theme-${opt.key}`}>
                    <View style={{
                      width: 38, height: 38, borderRadius: 19, backgroundColor: opt.swatch,
                      borderWidth: active ? 3 : 1, borderColor: active ? c.foreground : c.border,
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {active ? <Feather name="check" size={18} color="#fff" /> : null}
                    </View>
                    <Text style={{ fontSize: 11, color: active ? c.foreground : c.mutedForeground }}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
          <View style={{ height: 1, backgroundColor: c.border }} />
          {mp('server_settings') ? <>
            <RowItem icon="server" title="إعدادات الخادم" onPress={() => setShowServer(true)} testID="row-server-settings" />
            <View style={{ height: 1, backgroundColor: c.border }} />
          </> : null}
          <RowItem icon="log-out" title="تسجيل الخروج" onPress={doLogout} danger testID="row-logout" />
        </Card>
        <Text style={{ textAlign: 'center', color: c.mutedForeground, fontSize: 12 }}>
          زاكود ERP موبايل — يعمل بنفس صلاحيات حسابك على النظام الرئيسي
        </Text>
      </ScrollView>

      <Modal visible={showServer} transparent animationType="slide" onRequestClose={() => setShowServer(false)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}>
          <Card style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, gap: 14, paddingBottom: 34 }}>
            <Text style={{ fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>إعدادات الخادم</Text>
            <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right' }}>
              اترك النطاق الافتراضي إن كنت تستخدم السحابة، أو أدخل نطاق شركتك/سيرفر الوكيل الخاص.
            </Text>
            <Field label="نطاق الخادم" value={domain} onChangeText={setDomainState} placeholder={defaultDomain()} ltr testID="input-server-domain" />
            <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
              <View style={{ flex: 1 }}><Btn title="حفظ" onPress={saveDomain} testID="button-save-domain" /></View>
              <View style={{ flex: 1 }}><Btn title="إلغاء" onPress={() => setShowServer(false)} kind="outline" /></View>
            </View>
          </Card>
        </View>
      </Modal>
    </View>
  );
}
