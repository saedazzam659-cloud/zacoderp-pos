export const AGENT_MODULE_SCREEN_TILE_IDS = [
  "sales", "purchasing", "inventory", "cash", "accounting", "hr", "production",
  "simpleManufacturing", "contracting", "maintenance", "installments", "hotel",
  "hospital", "school", "crm", "fixedAssets", "pos", "security",
] as const;

export type AgentUiSettings = {
  moduleScreensAsTiles?: string[];
  compactInvoiceTypeSelector?: boolean;
  colorfulInvoiceTabs?: boolean;
  userGuideEnabled?: boolean;
  loginPage?: {
    showMarketingContent?: boolean;
    hideLoginSubtitle?: boolean;
    hideLoginModeSwitch?: boolean;
    backgroundColor?: string | null;
    cardColor?: string | null;
    accentColor?: string | null;
  };
};

const moduleIds = new Set<string>(AGENT_MODULE_SCREEN_TILE_IDS);
const safeColor = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

/** Publicly returned display preferences only; unknown keys and unsafe values are discarded. */
export function sanitizeAgentUiSettings(value: unknown): AgentUiSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawLogin = source.loginPage && typeof source.loginPage === "object" && !Array.isArray(source.loginPage)
    ? source.loginPage as Record<string, unknown>
    : {};
  return {
    moduleScreensAsTiles: Array.isArray(source.moduleScreensAsTiles)
      ? [...new Set(source.moduleScreensAsTiles.filter(
          (id): id is string => typeof id === "string" && moduleIds.has(id),
        ))]
      : [],
    compactInvoiceTypeSelector: source.compactInvoiceTypeSelector === true,
    colorfulInvoiceTabs: source.colorfulInvoiceTabs === true,
    userGuideEnabled: source.userGuideEnabled === true,
    loginPage: {
      showMarketingContent: rawLogin.showMarketingContent === true,
      hideLoginSubtitle: rawLogin.hideLoginSubtitle === true,
      hideLoginModeSwitch: rawLogin.hideLoginModeSwitch === true,
      backgroundColor: safeColor(rawLogin.backgroundColor),
      cardColor: safeColor(rawLogin.cardColor),
      accentColor: safeColor(rawLogin.accentColor),
    },
  };
}