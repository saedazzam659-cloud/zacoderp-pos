import React, { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Feather } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import { Card, ErrorBox } from '@/components/ui';

/**
 * تقرير حضوري — حضور وانصراف الموظف المرتبط بالمستخدم الحالي.
 * GET /api/employees/my-attendance?companyId&year&month
 * (يتطلب ربط المستخدم بملف موظف من شاشة الموظفين في الويب،
 *  ومحكوم بصلاحية الموبايل hr_attendance_view)
 */

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  present: { label: 'حاضر', color: '#059669' },
  late: { label: 'متأخر', color: '#d97706' },
  absent: { label: 'غائب', color: '#dc2626' },
  leave: { label: 'إجازة', color: '#0284c7' },
  vacation: { label: 'إجازة', color: '#0284c7' },
  weekend: { label: 'عطلة', color: '#6b7280' },
  holiday: { label: 'عطلة', color: '#6b7280' },
};

const hhmm = (v?: string | null) => (v ? String(v).slice(0, 5) : '—');
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export default function HrAttendance() {
  const router = useRouter();
  const { companyId } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const prevMonth = () => { if (month === 1) { setMonth(12); setYear(year - 1); } else setMonth(month - 1); };
  const nextMonth = () => { if (month === 12) { setMonth(1); setYear(year + 1); } else setMonth(month + 1); };

  const q = useQuery({
    queryKey: ['hr-attendance', companyId, year, month],
    queryFn: () => api<any>(`/api/employees/my-attendance?companyId=${companyId}&year=${year}&month=${month}`),
    enabled: !!companyId,
    retry: false,
  });

  const s = q.data?.summary;
  const rows: any[] = q.data?.rows ?? [];

  const StatCard = ({ label, value, color }: { label: string; value: string | number; color?: string }) => (
    <View style={{ flex: 1, minWidth: '30%', backgroundColor: c.card, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 10, gap: 2 }}>
      <Text style={{ textAlign: 'center', fontSize: 17, fontFamily: 'Inter_700Bold', color: color ?? c.foreground }}>{value}</Text>
      <Text style={{ textAlign: 'center', fontSize: 11, color: c.mutedForeground }}>{label}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {/* Header */}
      <View style={{ backgroundColor: c.primary, paddingTop: topInset + 10, paddingBottom: 14, paddingHorizontal: 16, flexDirection: 'row-reverse', alignItems: 'center', gap: 10 }}>
        <Pressable onPress={() => router.back()} hitSlop={10} testID="btn-back">
          <Feather name="arrow-right" size={22} color="#fff" />
        </Pressable>
        <Text style={{ flex: 1, color: '#fff', fontSize: 17, fontFamily: 'Inter_700Bold', textAlign: 'right' }}>
          تقرير حضوري
        </Text>
      </View>

      {/* Month picker */}
      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }}>
        <Pressable onPress={prevMonth} hitSlop={10} testID="btn-prev-month" style={{ padding: 6 }}>
          <Feather name="chevron-right" size={22} color={c.primary} />
        </Pressable>
        <Text style={{ fontSize: 15, fontFamily: 'Inter_700Bold', color: c.foreground }}>
          {MONTHS[month - 1]} {year}
        </Text>
        <Pressable onPress={nextMonth} hitSlop={10} testID="btn-next-month" style={{ padding: 6 }}>
          <Feather name="chevron-left" size={22} color={c.primary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 12, paddingBottom: 90 }}>
        {q.isLoading ? (
          <ActivityIndicator style={{ marginTop: 30 }} color={c.primary} />
        ) : q.isError ? (
          <ErrorBox text={(q.error as any)?.message ?? 'تعذّر تحميل التقرير'} onRetry={() => q.refetch()} />
        ) : (
          <>
            {q.data?.employee ? (
              <Text style={{ textAlign: 'right', color: c.mutedForeground, fontSize: 13 }}>
                {q.data.employee.nameAr} · {q.data.employee.code}
                {q.data.employee.jobTitle ? ` · ${q.data.employee.jobTitle}` : ''}
              </Text>
            ) : null}

            {/* Summary */}
            <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8 }}>
              <StatCard label="أيام الحضور" value={s?.present ?? 0} color="#059669" />
              <StatCard label="أيام الغياب" value={s?.absent ?? 0} color="#dc2626" />
              <StatCard label="أيام الإجازة" value={s?.leave ?? 0} color="#0284c7" />
              <StatCard label="أيام التأخير" value={s?.lateDays ?? 0} color="#d97706" />
              <StatCard label="دقائق التأخير" value={s?.lateMinutes ?? 0} color="#d97706" />
              <StatCard label="دقائق الانصراف المبكر" value={s?.earlyLeaveMinutes ?? 0} color="#d97706" />
              <StatCard label="ساعات العمل" value={s?.workedHours ?? 0} />
              <StatCard label="ساعات إضافية" value={s?.overtimeHours ?? 0} />
            </View>

            {/* Day rows */}
            {rows.length === 0 ? (
              <Card><Text style={{ textAlign: 'center', color: c.mutedForeground, paddingVertical: 14 }}>لا توجد سجلات حضور لهذا الشهر</Text></Card>
            ) : (
              <Card style={{ paddingVertical: 2 }}>
                {rows.map((r, i) => {
                  const st = STATUS_LABEL[r.status] ?? { label: r.status || '—', color: c.mutedForeground };
                  const late = num(r.lateMinutes);
                  const early = num(r.earlyLeaveMinutes);
                  return (
                    <View key={r.date} style={{ paddingVertical: 10, paddingHorizontal: 4, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: c.border, gap: 4 }}>
                      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text style={{ fontSize: 14, fontFamily: 'Inter_600SemiBold', color: c.foreground }}>{r.date}</Text>
                        <Text style={{ fontSize: 12, fontFamily: 'Inter_600SemiBold', color: st.color }}>{st.label}</Text>
                      </View>
                      <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 14 }}>
                        <Text style={{ fontSize: 12, color: c.mutedForeground }}>حضور: {hhmm(r.checkIn)}</Text>
                        <Text style={{ fontSize: 12, color: c.mutedForeground }}>انصراف: {hhmm(r.checkOut)}</Text>
                        {num(r.workedHours) > 0 ? (
                          <Text style={{ fontSize: 12, color: c.mutedForeground }}>ساعات: {num(r.workedHours)}</Text>
                        ) : null}
                      </View>
                      {late > 0 || early > 0 ? (
                        <View style={{ flexDirection: 'row-reverse', gap: 14 }}>
                          {late > 0 ? <Text style={{ fontSize: 12, color: '#d97706' }}>تأخير {late} دقيقة</Text> : null}
                          {early > 0 ? <Text style={{ fontSize: 12, color: '#d97706' }}>انصراف مبكر {early} دقيقة</Text> : null}
                        </View>
                      ) : null}
                      {r.notes ? <Text style={{ fontSize: 11, color: c.mutedForeground, textAlign: 'right' }}>{r.notes}</Text> : null}
                    </View>
                  );
                })}
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
