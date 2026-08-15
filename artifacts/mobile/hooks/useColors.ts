import { useTheme } from '@/contexts/ThemeContext';

/**
 * Returns the design tokens for the ACTIVE theme (see ThemeContext).
 * The user picks the theme from «المزيد → ألوان التطبيق»; the choice is
 * persisted on-device and applied instantly across every screen.
 */
export function useColors() {
  return useTheme().colors;
}
