import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';

// في نسخ الإنتاج: أي خطأ JS قاتل يغلق التطبيق فورًا بلا رسالة — نلتقطه
// ونعرضه في تنبيه حتى يمكن تشخيصه من جهاز المستخدم مباشرة.
if (!__DEV__) {
  const g: any = globalThis as any;
  const prev = g.ErrorUtils?.getGlobalHandler?.();
  g.ErrorUtils?.setGlobalHandler?.((e: any, isFatal?: boolean) => {
    try { Alert.alert('خطأ في التطبيق', String(e?.message ?? e).slice(0, 500)); } catch {}
    try { prev?.(e, isFatal); } catch {}
  });
}
import { checkForcedUpdate, currentAppVersion, type UpdateCheck } from '@/lib/appUpdate';
import { AppState } from 'react-native';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthProvider } from '@/contexts/AuthContext';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

// بيانات حية دائماً: أي شاشة تُفتح تعيد جلب بياناتها من السيرفر فوراً
// (staleTime 0 + refetchOnMount 'always')، فتظهر تعديلات الأسعار/الأصناف
// التي تمت من الويب مباشرة دون الحاجة لإغلاق التطبيق أو السحب للتحديث.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnMount: 'always',
      refetchOnReconnect: true,
    },
  },
});

// عند عودة التطبيق من الخلفية إلى الواجهة، تُحدَّث كل الاستعلامات النشطة
// تلقائياً (react-query focusManager) — نفس سلوك المتصفح عند العودة للتبويب.
AppState.addEventListener('change', (s) => {
  focusManager.setFocused(s === 'active');
});

// Forced-update gate sits ABOVE the router so deep links can't bypass it.
// Fail-open (offline/server error ⇒ app works normally); while checking we
// render the router immediately — the gate replaces it only when required.
function UpdateGate({ children }: { children: React.ReactNode }) {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  useEffect(() => {
    let alive = true;
    checkForcedUpdate().then((r) => { if (alive) setUpdate(r); });
    return () => { alive = false; };
  }, []);

  if (update?.required) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', padding: 32, gap: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: '#111', textAlign: 'center' }}>يتوفر تحديث مطلوب</Text>
        <Text style={{ fontSize: 14, color: '#555', textAlign: 'center', lineHeight: 22 }}>
          إصدارك الحالي ({currentAppVersion()}) لم يعد مدعوماً.{'\n'}
          حدّث التطبيق إلى الإصدار {update.latestVersion} للمتابعة.
        </Text>
        <Pressable
          onPress={() => Linking.openURL(update.downloadUrl)}
          style={{ backgroundColor: '#0f766e', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, marginTop: 8 }}
        >
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>تحديث التطبيق الآن</Text>
        </Pressable>
      </View>
    );
  }
  return <>{children}</>;
}

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" />
      <Stack.Screen name="invoice/[id]" />
      <Stack.Screen name="returns" />
      <Stack.Screen name="return/[id]" />
      <Stack.Screen name="voucher/new" />
      <Stack.Screen name="voucher/list" />
      <Stack.Screen name="report/[kind]" />
      <Stack.Screen name="scan" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <UpdateGate>
                  <RootLayoutNav />
                </UpdateGate>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
