import React, { useEffect, useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { useAuth, getRememberedLogin } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Btn, Card, Field } from '@/components/ui';

export default function Login() {
  const { login, user } = useAuth();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const [companyCode, setCompanyCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getRememberedLogin().then((r) => {
      if (r.companyCode) setCompanyCode(r.companyCode);
      if (r.username) setUsername(r.username);
    });
  }, []);

  useEffect(() => {
    if (user) router.replace('/(tabs)/invoices');
  }, [user, router]);

  const submit = async () => {
    if (!companyCode.trim() || !username.trim() || !password) {
      setError('أدخل رمز الشركة واسم المستخدم وكلمة المرور');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(companyCode, username, password);
      router.replace('/(tabs)/invoices');
    } catch (e: any) {
      setError(e?.message ?? 'فشل تسجيل الدخول');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <LinearGradient
        colors={[c.primaryDark, c.primary]}
        style={{ paddingTop: topInset + 34, paddingBottom: 52, alignItems: 'center', gap: 8 }}
      >
        <View
          style={{
            width: 66,
            height: 66,
            borderRadius: 20,
            backgroundColor: 'rgba(255,255,255,0.15)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: '#fff', fontSize: 32, fontFamily: 'Inter_700Bold' }}>Z</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 24, fontFamily: 'Inter_700Bold' }}>زاكود ERP</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>
          نظام الفاتورة الإلكترونية — تطبيق الجوال
        </Text>
      </LinearGradient>

      <ScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        <Card style={{ marginTop: -30, gap: 14 }}>
          <Text style={{ fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>
            تسجيل الدخول
          </Text>

          <Field
            label="رمز الشركة"
            value={companyCode}
            onChangeText={setCompanyCode}
            placeholder="مثال: 1001"
            keyboardType="numeric"
            ltr
            testID="input-company-code"
          />
          <Field
            label="اسم المستخدم"
            value={username}
            onChangeText={setUsername}
            placeholder="اسم المستخدم"
            ltr
            testID="input-username"
          />
          <Field
            label="كلمة المرور"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secure={!showPass}
            ltr
            testID="input-password"
            right={
              <Pressable onPress={() => setShowPass((s) => !s)} hitSlop={10}>
                <Feather name={showPass ? 'eye-off' : 'eye'} size={18} color={c.mutedForeground} />
              </Pressable>
            }
          />

          {error ? (
            <Text style={{ color: c.destructive, fontSize: 13, textAlign: 'right' }}>{error}</Text>
          ) : null}

          <Btn title="دخول" onPress={submit} loading={busy} testID="button-login" />
        </Card>

        <Text style={{ textAlign: 'center', color: c.mutedForeground, fontSize: 12, marginTop: 24 }}>
          يعمل التطبيق على نفس حساب النظام الرئيسي وبنفس الصلاحيات
        </Text>
      </ScrollView>
    </View>
  );
}
