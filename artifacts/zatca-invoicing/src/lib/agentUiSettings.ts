export const AGENT_MODULE_SCREEN_TILE_OPTIONS = [
  { id: "sales", label: "المبيعات", href: "/sales" },
  { id: "purchasing", label: "الموردون والمشتريات", href: "/purchasing" },
  { id: "inventory", label: "المخزون", href: "/inventory" },
  { id: "cash", label: "الخزينة والبنوك", href: "/cash" },
  { id: "accounting", label: "المحاسبة", href: "/accounting" },
  { id: "hr", label: "الموارد البشرية", href: "/hr" },
  { id: "production", label: "الإنتاج والتصنيع", href: "/production" },
  { id: "maintenance", label: "الصيانة", href: "/maintenance" },
  { id: "installments", label: "التقسيط", href: "/installments" },
  { id: "hotel", label: "الفنادق", href: "/hotel" },
  { id: "hospital", label: "المستشفيات", href: "/hospital" },
  { id: "crm", label: "إدارة العملاء", href: "/crm" },
  { id: "fixedAssets", label: "الأصول الثابتة", href: "/fixed-assets" },
  { id: "pos", label: "نقاط البيع", href: "/pos-management" },
  { id: "security", label: "الأمان", href: "/security" },
] as const;

export type AgentModuleScreenTileId = typeof AGENT_MODULE_SCREEN_TILE_OPTIONS[number]["id"];

export type AgentUiSettings = {
  moduleScreensAsTiles: AgentModuleScreenTileId[];
  compactInvoiceTypeSelector: boolean;
  colorfulInvoiceTabs: boolean;
  loginPage: {
    showMarketingContent: boolean;
    hideLoginSubtitle: boolean;
    hideLoginModeSwitch: boolean;
    backgroundColor: string | null;
    cardColor: string | null;
    accentColor: string | null;
  };
};

export const DEFAULT_AGENT_UI_SETTINGS: AgentUiSettings = {
  moduleScreensAsTiles: [],
  compactInvoiceTypeSelector: false,
  colorfulInvoiceTabs: false,
  loginPage: {
    showMarketingContent: false,
    hideLoginSubtitle: false,
    hideLoginModeSwitch: false,
    backgroundColor: null,
    cardColor: null,
    accentColor: null,
  },
};

const moduleIds = new Set<string>(AGENT_MODULE_SCREEN_TILE_OPTIONS.map(({ id }) => id));
const safeColor = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;

export function normalizeAgentUiSettings(value: unknown): AgentUiSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawLogin = source.loginPage && typeof source.loginPage === "object" && !Array.isArray(source.loginPage)
    ? source.loginPage as Record<string, unknown>
    : {};
  const modules = Array.isArray(source.moduleScreensAsTiles)
    ? [...new Set(source.moduleScreensAsTiles.filter(
        (id): id is AgentModuleScreenTileId => typeof id === "string" && moduleIds.has(id),
      ))]
    : [];
  return {
    moduleScreensAsTiles: modules,
    compactInvoiceTypeSelector: source.compactInvoiceTypeSelector === true,
    colorfulInvoiceTabs: source.colorfulInvoiceTabs === true,
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