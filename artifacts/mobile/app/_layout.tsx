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
import { api, getDomain, getToken } from '@/lib/api';
import { isOfflineEnabled, syncOutbox } from '@/lib/offline';

// مزامنة صادر الأوف لاين إن كان الوضع مفعلاً (single-flight داخلي)
const trySyncOffline = () => {
  isOfflineEnabled().then(async (on) => {
    if (!on) return;
    if (!await getToken()) return;
    syncOutbox(await getDomain(), api).catch(() => {});
  }).catch(() => {});
};
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { BottomBar } from '@/components/BottomBar';
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
  // عودة التطبيق للواجهة = فرصة لمزامنة عمليات الأوف لاين المعلقة
  if (s === 'active') trySyncOffline();
});

// محاولة مزامنة دورية كل 60 ثانية أثناء عمل التطبيق
setInterval(trySyncOffline, 60_000);

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

// ─── مزامنة لحظية ───────────────────────────────────────────────────────────
// نستفتي السيرفر كل 5 ثوانٍ عن «نسخة بيانات» الشركة (تُرفع بعد أي تعديل ناجح
// من الويب أو الموبايل). عند تغيّرها نبطل كل الكاش فتتحدث الشاشة المفتوحة
// فوراً — فك ترحيل/حذف من الويب يظهر في التطبيق دون خروج ودخول.
function DataVersionPoller() {
  const { user } = useAuth();
  const lastV = React.useRef<number | null>(null);
  useEffect(() => {
    if (!user) { lastV.current = null; return; }
    let alive = true;
    const tick = async () => {
      try {
        const r = await api<{ v: number }>('/api/realtime/data-version');
        if (!alive || typeof r?.v !== 'number') return;
        if (lastV.current != null && r.v !== lastV.current) {
          queryClient.invalidateQueries();
        }
        lastV.current = r.v;
      } catch { /* أوفلاين/خطأ مؤقت — نحاول في الدورة التالية */ }
    };
    tick();
    const id = setInterval(() => {
      // لا داعي للاستفتاء والتطبيق في الخلفية
      if (AppState.currentState === 'active') tick();
    }, 5_000);
    return () => { alive = false; clearInterval(id); };
  }, [user]);
  return null;
}

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" />
      <Stack.Screen name="invoice/[id]" />
      <Stack.Screen name="quotations" />
      <Stack.Screen name="quotation/[id]" />
      <Stack.Screen name="returns" />
      <Stack.Screen name="return/[id]" />
      <Stack.Screen name="items" />
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
                <ThemeProvider>
                  <UpdateGate>
                    <DataVersionPoller />
                    <View style={{ flex: 1 }}>
                      <View style={{ flex: 1 }}>
                        <RootLayoutNav />
                      </View>
                      {/* شريط تنقّل سفلي ثابت في كل الشاشات (نمط فيسبوك) */}
                      <BottomBar />
                    </View>
                  </UpdateGate>
                </ThemeProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
