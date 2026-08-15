import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import baseColors from '@/constants/colors';

// ─── ثيمات ألوان التطبيق ────────────────────────────────────────────────────
// كل ثيم يعيد تلوين الهوية (primary/secondary/accent…) فوق التوكنز الأساسية.
// الاختيار محفوظ محلياً على الجهاز (AsyncStorage) ويطبَّق فوراً عبر useColors.

export type ThemeKey = 'emerald' | 'ocean' | 'royal' | 'sunset' | 'rose' | 'graphite';

type Palette = typeof baseColors.light;

const overrides: Record<ThemeKey, Partial<Palette>> = {
  emerald: {}, // الافتراضي — أخضر زمردي (هوية زاكود)
  ocean: {
    tint: '#0369a1', primary: '#0369a1', primaryDark: '#075985',
    secondary: '#e0f2fe', secondaryForeground: '#075985',
    accent: '#dbeafe', accentForeground: '#075985',
    success: '#0e7a56', background: '#f3f7fa', muted: '#eaf1f5',
  },
  royal: {
    tint: '#6d28d9', primary: '#6d28d9', primaryDark: '#5b21b6',
    secondary: '#ede9fe', secondaryForeground: '#5b21b6',
    accent: '#f3e8ff', accentForeground: '#5b21b6',
    background: '#f7f5fb', muted: '#f0edf6',
  },
  sunset: {
    tint: '#c2410c', primary: '#c2410c', primaryDark: '#9a3412',
    secondary: '#ffedd5', secondaryForeground: '#9a3412',
    accent: '#fff7ed', accentForeground: '#9a3412',
    background: '#faf6f2', muted: '#f5efe9',
  },
  rose: {
    tint: '#be123c', primary: '#be123c', primaryDark: '#9f1239',
    secondary: '#ffe4e6', secondaryForeground: '#9f1239',
    accent: '#fff1f2', accentForeground: '#9f1239',
    background: '#faf4f5', muted: '#f5edee',
  },
  graphite: {
    tint: '#334155', primary: '#334155', primaryDark: '#1e293b',
    secondary: '#e2e8f0', secondaryForeground: '#1e293b',
    accent: '#f1f5f9', accentForeground: '#1e293b',
    background: '#f4f6f8', muted: '#edf0f3',
  },
};

export const THEME_OPTIONS: Array<{ key: ThemeKey; label: string; swatch: string }> = [
  { key: 'emerald',  label: 'زمردي',   swatch: '#0e7a56' },
  { key: 'ocean',    label: 'أزرق',    swatch: '#0369a1' },
  { key: 'royal',    label: 'بنفسجي',  swatch: '#6d28d9' },
  { key: 'sunset',   label: 'برتقالي', swatch: '#c2410c' },
  { key: 'rose',     label: 'وردي',    swatch: '#be123c' },
  { key: 'graphite', label: 'رمادي',   swatch: '#334155' },
];

const STORAGE_KEY = 'app_theme_key';

interface ThemeState {
  theme: ThemeKey;
  colors: Palette & { radius: number };
  setTheme: (t: ThemeKey) => void;
}

const defaultColors = { ...baseColors.light, radius: baseColors.radius };

const ThemeContext = createContext<ThemeState>({
  theme: 'emerald',
  colors: defaultColors,
  setTheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeKey>('emerald');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v && v in overrides) setThemeState(v as ThemeKey);
    }).catch(() => {});
  }, []);

  const setTheme = useCallback((t: ThemeKey) => {
    setThemeState(t);
    AsyncStorage.setItem(STORAGE_KEY, t).catch(() => {});
  }, []);

  const colors = useMemo(
    () => ({ ...baseColors.light, ...overrides[theme], radius: baseColors.radius }),
    [theme],
  );

  const value = useMemo(() => ({ theme, colors, setTheme }), [theme, colors, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
