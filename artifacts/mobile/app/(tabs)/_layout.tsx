import React from 'react';
import { Platform } from 'react-native';
import { Tabs, Redirect } from 'expo-router';
import { Feather } from '@expo/vector-icons';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';

export default function TabsLayout() {
  const { user, loading } = useAuth();
  const c = useColors();

  if (!loading && !user) return <Redirect href="/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.primary,
        tabBarInactiveTintColor: c.mutedForeground,
        tabBarStyle: {
          backgroundColor: c.card,
          borderTopColor: c.border,
          ...(Platform.OS === 'web' ? { height: 84, paddingBottom: 24 } : null),
        },
        tabBarLabelStyle: { fontFamily: 'Inter_500Medium', fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="invoices"
        options={{
          title: 'الفواتير',
          tabBarIcon: ({ color, size }) => <Feather name="file-text" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: 'العملاء',
          tabBarIcon: ({ color, size }) => <Feather name="users" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="new"
        options={{
          title: 'جديد',
          tabBarIcon: ({ color, size }) => <Feather name="plus-circle" size={size + 4} color={color} />,
        }}
      />
      <Tabs.Screen
        name="reports"
        options={{
          title: 'الملخص',
          tabBarIcon: ({ color, size }) => <Feather name="bar-chart-2" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'المزيد',
          tabBarIcon: ({ color, size }) => <Feather name="menu" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
