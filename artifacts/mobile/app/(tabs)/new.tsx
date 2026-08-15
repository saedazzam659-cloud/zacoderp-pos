import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { useMobilePerms } from '@/hooks/useMobilePerms';
import { useColors } from '@/hooks/useColors';

export default function NewMenu() {
  const c = useColors();
  const router = useRouter();
  const { can } = useAuth();
  const { mp } = useMobilePerms();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const items: { icon: keyof typeof Feather.glyphMap; title: string; sub: string; href: string; show: boolean; testID: string }[] = [
    // تطبيق الموبايل محكوم بصلاحيات تطبيقات الموبايل (mp) فقط — صلاحيات
    // الويب granular وغالباً لا تحتوي مفاتيح المجموعات مثل sales_module،
    // فاشتراط can() كان يخفي كل العناصر عن المستخدمين غير الـ admin.
    { icon: 'file-plus', title: 'فاتورة مبيعات', sub: 'فاتورة ضريبية أو مبسطة', href: '/invoice/new', show: mp('invoice_create'), testID: 'action-new-invoice' },
    { icon: 'file-text', title: 'عرض سعر', sub: 'عرض سعر قابل للتحويل إلى فاتورة', href: '/quotation/new', show: mp('quotation_create'), testID: 'action-new-quotation' },
    { icon: 'list', title: 'عروض الأسعار', sub: 'استعراض ومتابعة عروض الأسعار', href: '/quotations', show: mp('quotations_view'), testID: 'action-quotations-list' },
    { icon: 'corner-up-right', title: 'مرتجع مبيعات', sub: 'إرجاع أصناف من عميل', href: '/returns', show: mp('return_create'), testID: 'action-sales-returns' },
    { icon: 'download', title: 'سند قبض', sub: 'تحصيل دفعة من عميل', href: '/voucher/new', show: mp('voucher_create'), testID: 'action-new-voucher' },
    { icon: 'user-plus', title: 'عميل جديد', sub: 'إضافة عميل إلى السجل', href: '/(tabs)/customers', show: mp('customer_create'), testID: 'action-new-customer' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 16, paddingHorizontal: 16 }}>
        <Text style={{ color: '#fff', fontSize: 19, fontFamily: 'Inter_700Bold', textAlign: 'right' }}>إنشاء جديد</Text>
      </View>
      <View style={{ padding: 16, gap: 12 }}>
        {items.filter((i) => i.show).map((i) => (
          <Pressable
            key={i.title}
            testID={i.testID}
            onPress={() => router.push(i.href as any)}
            style={({ pressed }) => ({
              backgroundColor: c.card,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: c.border,
              padding: 16,
              flexDirection: 'row-reverse',
              alignItems: 'center',
              gap: 14,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: c.secondary, alignItems: 'center', justifyContent: 'center' }}>
              <Feather name={i.icon} size={22} color={c.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: 'Inter_600SemiBold', textAlign: 'right', color: c.foreground }}>{i.title}</Text>
              <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right', marginTop: 2 }}>{i.sub}</Text>
            </View>
            <Feather name="chevron-left" size={20} color={c.mutedForeground} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
