import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';

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
import { MobileVoiceAssistant } from '@/components/MobileVoiceAssistant';
import { useColors } from '@/hooks/useColors';
import * as Updates from 'expo-updates';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Location from 'expo-location';
import { mobileTrackingEnabled, startMobileLocationTracking, stopMobileLocationTracking } from '@/lib/mobileLocationTracking';

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
// Fail-open (offline/server error ⇒ app works normally). The Expo OTA check
// below is separate and only blocks while checking briefly or downloading.
function UpdateGate({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [otaStatus, setOtaStatus] = useState<'idle' | 'checking' | 'downloading'>(
    Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled ? 'checking' : 'idle',
  );
  const forcedUpdateRequired = React.useRef(false);

  useEffect(() => {
    let alive = true;
    checkForcedUpdate().then((r) => {
      if (!alive) return;
      forcedUpdateRequired.current = r.required;
      setUpdate(r);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    if (Platform.OS === 'web' || __DEV__ || !Updates.isEnabled) {
      setOtaStatus('idle');
      return () => { alive = false; };
    }

    const applyAvailableUpdate = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Don't hold the app at startup indefinitely if the device is offline.
        const checkResult = await Promise.race([
          Updates.checkForUpdateAsync(),
          new Promise<null>((resolve) => {
            timeout = setTimeout(() => resolve(null), 5_000);
          }),
        ]);
        if (timeout) clearTimeout(timeout);
        if (!alive || !checkResult || !checkResult.isAvailable) return;
        if (forcedUpdateRequired.current) return;

        setOtaStatus('downloading');
        const fetchResult = await Updates.fetchUpdateAsync();
        if (!alive || !fetchResult.isNew || forcedUpdateRequired.current) return;

        await Updates.reloadAsync();
      } catch (error) {
        // OTA failures must not block sign-in or offline work.
        console.warn('Expo update check failed; continuing with the installed version.', error);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (alive) setOtaStatus('idle');
      }
    };

    void applyAvailableUpdate();
    return () => { alive = false; };
  }, []);

  if (update?.required) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 32, gap: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.foreground, textAlign: 'center' }}>يتوفر تحديث مطلوب</Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 22 }}>
          إصدارك الحالي ({currentAppVersion()}) لم يعد مدعوماً.{'\n'}
          حدّث التطبيق إلى الإصدار {update.latestVersion} للمتابعة.
        </Text>
        <Pressable
          onPress={() => Linking.openURL(update.downloadUrl)}
          style={{ backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 32, marginTop: 8 }}
        >
          <Text style={{ color: colors.primaryForeground, fontSize: 16, fontWeight: '700' }}>تحديث التطبيق الآن</Text>
        </Pressable>
      </View>
    );
  }

  if (otaStatus !== 'idle') {
    const downloading = otaStatus === 'downloading';
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 32, gap: 16 }}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={{ fontSize: 20, fontWeight: '700', color: colors.foreground, textAlign: 'center' }}>
          {downloading ? 'جارٍ تنزيل تحديث التطبيق' : 'جارٍ التحقق من التحديثات'}
        </Text>
        <Text style={{ fontSize: 14, color: colors.mutedForeground, textAlign: 'center', lineHeight: 22 }}>
          {downloading
            ? 'سيُعاد تشغيل التطبيق تلقائياً بعد اكتمال التنزيل.'
            : 'لحظات، نتحقق من توفر إصدار أحدث.'}
        </Text>
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

function MobileLocationGate({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const colors = useColors();
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const enabled = serverEnabled === true;
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!user || Platform.OS === 'web') {
      setServerEnabled(false);
      if (!user) void stopMobileLocationTracking();
      return;
    }
    let alive = true;
    const refresh = async () => {
      try {
        const next = await mobileTrackingEnabled();
        if (!alive) return;
        setServerEnabled(next);
        if (!next) {
          await stopMobileLocationTracking();
          if (alive) setReady(true);
        }
      } catch {
        if (alive) { setServerEnabled(null); setReady(false); setMessage('تعذر التحقق من إعداد الرقابة المباشرة. تحقق من اتصال الإنترنت.'); }
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    return () => { alive = false; clearInterval(interval); sub.remove(); };
  }, [user?.id]);

  useEffect(() => {
    let alive = true;
    if (serverEnabled === null) { setReady(false); return () => { alive = false; }; }
    if (!enabled || Platform.OS === 'web' || !user) {
      setReady(true);
      setMessage('');
      return () => { alive = false; };
    }
    setReady(false);
    (async () => {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        const bg = await Location.getBackgroundPermissionsAsync();
        if (!fg.granted || !bg.granted) {
          if (alive) {
            setShowSettings((!fg.granted && !fg.canAskAgain) || (!bg.granted && !bg.canAskAgain));
            setMessage('تفعيل الرقابة المباشرة يتطلب السماح بموقعك أثناء استخدام التطبيق وفي الخلفية. لن يستمر التتبع بعد تسجيل الخروج.');
          }
          return;
        }
        await startMobileLocationTracking();
        if (alive) { setReady(true); setMessage(''); }
      } catch (e: any) {
        if (alive) setMessage(e?.message ?? 'تعذر بدء تتبع الموقع.');
      }
    })();
    return () => { alive = false; };
  }, [enabled, serverEnabled, user?.id]);

  if (!user || Platform.OS === 'web' || serverEnabled === false) return <>{children}</>;
  if (serverEnabled === null) return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 14, backgroundColor: colors.background }}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={{ color: colors.mutedForeground, textAlign: 'center' }}>{message || 'جارٍ التحقق من إعدادات الرقابة المباشرة…'}</Text>
      <Pressable onPress={() => void logout().catch((e: any) => setMessage(e?.message ?? 'تعذر تسجيل الخروج'))} style={{ padding: 12 }}>
        <Text style={{ color: colors.primary, fontWeight: '700' }}>تسجيل الخروج</Text>
      </Pressable>
    </View>
  );
  if (ready) return <>{children}</>;
  const requestTracking = async () => {
    setBusy(true); setMessage('');
    setShowSettings(false);
    try {
      const fg = await Location.requestForegroundPermissionsAsync();
      if (!fg.granted) {
        setShowSettings(!fg.canAskAgain);
        throw new Error('لم يتم منح إذن الموقع أثناء استخدام التطبيق.');
      }
      const bg = await Location.requestBackgroundPermissionsAsync();
      if (!bg.granted) {
        setShowSettings(!bg.canAskAgain);
        throw new Error('يلزم اختيار السماح بالموقع طوال الوقت من إعدادات الهاتف.');
      }
      await startMobileLocationTracking();
      setReady(true);
    } catch (e: any) {
      setMessage(e?.message ?? 'تعذر تفعيل الموقع. تحقق من إعدادات الهاتف.');
    } finally { setBusy(false); }
  };
  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 28, gap: 14, backgroundColor: colors.background }}>
      <Text style={{ color: colors.foreground, fontSize: 22, fontWeight: '700', textAlign: 'center' }}>تفعيل الرقابة المباشرة</Text>
      <Text style={{ color: colors.mutedForeground, fontSize: 15, lineHeight: 24, textAlign: 'center' }}>
        فعّل الموقع للسماح لمديرك بمتابعة تحركات العمل. يعمل التتبع خلال جلسة تسجيل الدخول فقط ويتوقف عند تسجيل الخروج.
      </Text>
      {!!message && <Text accessibilityRole="alert" style={{ color: colors.destructive, textAlign: 'center' }}>{message}</Text>}
      {showSettings && <Pressable onPress={() => void Linking.openSettings()} style={{ padding: 12, alignItems: 'center' }}><Text style={{ color: colors.primary, fontWeight: '700' }}>فتح إعدادات التطبيق</Text></Pressable>}
      <Pressable onPress={requestTracking} disabled={busy} style={{ backgroundColor: colors.primary, padding: 15, borderRadius: 12, alignItems: 'center' }}>
        {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Text style={{ color: colors.primaryForeground, fontWeight: '700' }}>السماح بمتابعة الموقع</Text>}
      </Pressable>
      <Pressable onPress={() => void logout().catch((e: any) => setMessage(e?.message ?? 'تعذر تسجيل الخروج'))} style={{ padding: 12, alignItems: 'center' }}>
        <Text style={{ color: colors.mutedForeground }}>تسجيل الخروج</Text>
      </Pressable>
    </View>
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
                      <MobileLocationGate>
                        <View style={{ flex: 1 }}>
                          <RootLayoutNav />
                        </View>
                        <BottomBar />
                        <MobileVoiceAssistant />
                      </MobileLocationGate>
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
