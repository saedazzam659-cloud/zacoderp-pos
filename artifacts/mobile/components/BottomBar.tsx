import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname, useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';

// ─── شريط تنقّل سفلي ثابت (نمط فيسبوك) ─────────────────────────────────────
// يظهر في كل الشاشات (وليس فقط تبويبات الجذر) حتى يستطيع المستخدم الانتقال
// بسرعة من أي شاشة داخلية. يُخفى في تسجيل الدخول وشاشة الماسح فقط.
// إظهار كل عنصر محكوم بصلاحيات تطبيق الموبايل (مفاتيح screen_*).

const HIDDEN_ON = ['/login', '/scan'];

type Item = {
  key: string;
  title: string;
  icon: keyof typeof Feather.glyphMap;
  href: string;
  /** يعتبر العنصر نشطاً إذا بدأ المسار بأحد هذه البادئات */
  activePrefixes: string[];
  show: boolean;
  center?: boolean;
};

export function BottomBar() {
  const { user, loading } = useAuth();
  const { mp } = useMobilePerms();
  const c = useColors();
  const router = useRouter();
  const pathname = usePathname() || '/';
  const insets = useSafeAreaInsets();

  if (loading || !user) return null;
  if (HIDDEN_ON.some((p) => pathname.startsWith(p))) return null;

  const anyCreate =
    mp('invoice_create') || mp('quotation_create') || mp('return_create') ||
    mp('voucher_create') || mp('customer_create');

  const allItems: Item[] = [
    {
      key: 'invoices', title: 'الفواتير', icon: 'file-text', href: '/(tabs)/invoices',
      activePrefixes: ['/invoices', '/invoice'],
      show: mp('screen_invoices') && mp('invoices_view'),
    },
    {
      key: 'customers', title: 'العملاء', icon: 'users', href: '/(tabs)/customers',
      activePrefixes: ['/customers'],
      show: mp('screen_customers') && mp('customers_view'),
    },
    {
      key: 'new', title: 'جديد', icon: 'plus', href: '/(tabs)/new',
      activePrefixes: ['/new'],
      show: mp('screen_new') && anyCreate,
      center: true,
    },
    {
      key: 'reports', title: 'الملخص', icon: 'bar-chart-2', href: '/(tabs)/reports',
      activePrefixes: ['/reports', '/report'],
      show: mp('screen_reports') && mp('reports_view'),
    },
    {
      key: 'more', title: 'المزيد', icon: 'menu', href: '/(tabs)/more',
      activePrefixes: ['/more', '/quotations', '/quotation', '/returns', '/return', '/voucher'],
      show: true,
    },
  ];
  const items = allItems.filter((i) => i.show);

  const isActive = (i: Item) =>
    i.activePrefixes.some((p) => pathname === p || pathname.startsWith(p + '/')) ||
    (i.key === 'invoices' && pathname === '/');

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.card,
        borderTopWidth: 1,
        borderTopColor: c.border,
        paddingBottom: Platform.OS === 'web' ? 18 : Math.max(insets.bottom, 6),
        paddingTop: 6,
        // ظل خفيف أعلى الشريط
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.06,
        shadowRadius: 6,
        elevation: 12,
      }}
      testID="bottom-bar"
    >
      {items.map((i) => {
        const active = isActive(i);
        if (i.center) {
          return (
            <Pressable
              key={i.key}
              onPress={() => router.navigate(i.href as any)}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}
              testID={`bottombar-${i.key}`}
            >
              <View
                style={{
                  width: 46, height: 46, borderRadius: 23, marginBottom: 2,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: active ? c.primaryDark : c.primary,
                  shadowColor: c.primary, shadowOpacity: 0.35, shadowRadius: 6,
                  shadowOffset: { width: 0, height: 3 }, elevation: 6,
                }}
              >
                <Feather name={i.icon} size={24} color={c.primaryForeground} />
              </View>
            </Pressable>
          );
        }
        return (
          <Pressable
            key={i.key}
            onPress={() => router.navigate(i.href as any)}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 2 }}
            testID={`bottombar-${i.key}`}
          >
            <View
              style={{
                paddingHorizontal: 14, paddingVertical: 3, borderRadius: 12,
                backgroundColor: active ? c.secondary : 'transparent',
              }}
            >
              <Feather name={i.icon} size={21} color={active ? c.primary : c.mutedForeground} />
            </View>
            <Text
              style={{
                fontSize: 10.5,
                fontFamily: active ? 'Inter_600SemiBold' : 'Inter_500Medium',
                color: active ? c.primary : c.mutedForeground,
              }}
            >
              {i.title}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
