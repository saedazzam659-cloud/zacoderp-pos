import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';

// NOTE: the forced-update gate lives in app/_layout.tsx (UpdateGate) so
// deep links into any route are covered — do not re-add it here.
export default function Index() {
  const { user, loading } = useAuth();
  const c = useColors();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
        <ActivityIndicator color={c.primary} size="large" />
      </View>
    );
  }
  return user ? <Redirect href="/(tabs)/invoices" /> : <Redirect href="/login" />;
}
