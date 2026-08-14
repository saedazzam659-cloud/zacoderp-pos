import React, { useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { getDomain, setDomain, defaultDomain } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Field } from '@/components/ui';

export default function More() {
  const { user, logout } = useAuth();
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [showServer, setShowServer] = useState(false);
  const [domain, setDomainState] = useState('');

  useEffect(() => {
    getDomain().then(setDomainState);
  }, [showServer]);

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
          <RowItem icon="file-text" title="سندات القبض" onPress={() => router.push('/voucher/list' as any)} testID="row-vouchers" />
          <View style={{ height: 1, backgroundColor: c.border }} />
          <RowItem icon="server" title="إعدادات الخادم" onPress={() => setShowServer(true)} testID="row-server-settings" />
          <View style={{ height: 1, backgroundColor: c.border }} />
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
