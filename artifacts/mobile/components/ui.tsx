import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useColors } from '@/hooks/useColors';
import colors from '@/constants/colors';

const R = colors.radius;

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const c = useColors();
  return (
    <View
      style={[
        {
          backgroundColor: c.card,
          borderRadius: R,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: c.border,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Btn({
  title,
  onPress,
  kind = 'primary',
  icon,
  disabled,
  loading,
  small,
  testID,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'outline' | 'ghost' | 'destructive';
  icon?: keyof typeof Feather.glyphMap;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  testID?: string;
}) {
  const c = useColors();
  const bg =
    kind === 'primary' ? c.primary : kind === 'destructive' ? c.destructive : 'transparent';
  const fg =
    kind === 'primary' || kind === 'destructive' ? c.primaryForeground : c.primary;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderRadius: R,
          borderWidth: kind === 'outline' ? 1.2 : 0,
          borderColor: c.primary,
          paddingVertical: small ? 8 : 13,
          paddingHorizontal: small ? 12 : 18,
          flexDirection: 'row-reverse',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <>
          {icon ? <Feather name={icon} size={small ? 15 : 18} color={fg} /> : null}
          <Text style={{ color: fg, fontSize: small ? 13 : 15, fontFamily: 'Inter_600SemiBold' }}>
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  secure,
  keyboardType,
  ltr,
  multiline,
  testID,
  right,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  secure?: boolean;
  keyboardType?: 'default' | 'numeric' | 'decimal-pad' | 'email-address';
  ltr?: boolean;
  multiline?: boolean;
  testID?: string;
  right?: React.ReactNode;
}) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, color: c.mutedForeground, textAlign: 'right', fontFamily: 'Inter_500Medium' }}>
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row-reverse',
          alignItems: 'center',
          borderWidth: 1.2,
          borderColor: c.input,
          borderRadius: R,
          backgroundColor: c.card,
          paddingHorizontal: 12,
        }}
      >
        <TextInput
          testID={testID}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={c.mutedForeground}
          secureTextEntry={secure}
          keyboardType={keyboardType}
          multiline={multiline}
          style={{
            flex: 1,
            paddingVertical: 12,
            fontSize: 15,
            color: c.foreground,
            textAlign: ltr ? 'left' : 'right',
            writingDirection: ltr ? 'ltr' : 'rtl',
            minHeight: multiline ? 70 : undefined,
          }}
          autoCapitalize="none"
        />
        {right}
      </View>
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: active ? c.primary : c.card,
        borderColor: active ? c.primary : c.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingVertical: 7,
        paddingHorizontal: 14,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: active ? c.primaryForeground : c.foreground,
          fontSize: 13,
          fontFamily: active ? 'Inter_600SemiBold' : 'Inter_400Regular',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Empty({ icon = 'inbox', text }: { icon?: keyof typeof Feather.glyphMap; text: string }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 48, gap: 10 }}>
      <Feather name={icon} size={34} color={c.mutedForeground} />
      <Text style={{ color: c.mutedForeground, fontSize: 14, textAlign: 'center' }}>{text}</Text>
    </View>
  );
}

export function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 40, gap: 12, paddingHorizontal: 24 }}>
      <Feather name="alert-circle" size={30} color={c.destructive} />
      <Text style={{ color: c.foreground, fontSize: 14, textAlign: 'center' }}>{text}</Text>
      {onRetry ? <Btn title="إعادة المحاولة" onPress={onRetry} kind="outline" small /> : null}
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8 }, style]}>
      {children}
    </View>
  );
}

export const t = StyleSheet.create({
  h1: { fontSize: 22, fontFamily: 'Inter_700Bold', textAlign: 'right' } as TextStyle,
  h2: { fontSize: 17, fontFamily: 'Inter_600SemiBold', textAlign: 'right' } as TextStyle,
  body: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'right' } as TextStyle,
  small: { fontSize: 12, fontFamily: 'Inter_400Regular', textAlign: 'right' } as TextStyle,
  num: { fontFamily: 'Inter_600SemiBold' } as TextStyle,
});
