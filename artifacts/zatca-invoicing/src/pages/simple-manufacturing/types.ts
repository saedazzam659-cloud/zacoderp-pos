export type Catalog = {
  // `/catalog` returns the inventory identifiers used by the simple facade.
  // Keep `unitId` separate from the display/unit-code value: the endpoint does
  // not return a unit code, so callers must use their explicit PCE fallback.
  items: Array<{
    id: number;
    code: string;
    nameAr: string;
    nameEn?: string | null;
    itemNature?: string | null;
    unitId?: number | null;
    unitCode?: string | null;
    unitOptions?: Array<{
      unitId?: number | null;
      code: string;
      nameAr: string;
      nameEn?: string | null;
      isBase?: boolean;
      factor?: string | number;
      conversionFactor?: number;
      baseUnitCode?: string | null;
    }>;
  }>;
  units?: Array<{
    id: number;
    code: string;
    nameAr: string;
  }>;
  warehouses: Array<{ id: number; code: string; nameAr: string; branchId?: number | null; isDefault?: boolean }>;
  templates: Array<{
    id: number;
    name: string;
    configuration: Record<string, any>;
    branchId?: number | null;
    isActive?: boolean;
    updatedAt?: string;
  }>;
  bomTemplates?: Array<{
    id: number;
    nameAr: string;
    productItemId: number;
    productNameAr?: string;
    outputQty?: string | number;
    outputUnitCode?: string | null;
    linesCount?: number;
  }>;
  routings: Array<{
    id: number;
    productItemId: number | null;
    productNameAr?: string | null;
    nameAr: string;
    isActive?: boolean;
    stagesCount?: number;
    stages?: Array<{
      id: number;
      nameAr: string;
      sequence?: number;
      plannedMinutes?: number;
      workCenterId?: number | null;
        resourceMode?: "labor" | "machine" | "both";
        resourceId?: number | null;
        workerCount?: number | null;
    }>;
  }>;
  accounting?: {
    settings: {
      defaultWipAccountId?: number | null;
      defaultRawInventoryAccountId?: number | null;
      defaultFinishedGoodsAccountId?: number | null;
      defaultWasteAccountId?: number | null;
        electricityTariffPerKwh?: string | number | null;
    } | null;
    accounts: Array<{
      id: number;
      code: string;
      nameAr: string;
      nameEn?: string | null;
      accountType?: string | null;
      isPosting?: boolean;
    }>;
  };
};

export type Order = {
  id: number;
  orderNumber: string;
  title: string;
  status: string;
  plannedQty: string | number;
  producedQty: string | number;
  estimatedCost: string | number;
  actualCost: string | number;
  resourceCostingVersion?: number;
  productItemId: number | null;
  issueJournalEntryId?: number | null;
  receiptJournalEntryId?: number | null;
  plannedStartDate?: string | null;
  createdAt?: string;
};

export type WizardState = {
  title: string;
  productItemId: string;
  plannedQty: string;
  unitCode: string;
  notes: string;
  plannedStartDate: string;
  plannedEndDate: string;
  rawWarehouseId: string;
  finishedWarehouseId: string;
  workCenterId: string;
  plannedHours: string;
  costPeriod: string;
  templateId: string;
  sourceOrderId: string | null;
  resourceCostingVersion: boolean;
  costPolicy: Record<string, any>;
};

export type ManufacturingCostCategory =
  | "payroll"
  | "fixed_asset_depreciation"
  | "prepaid_amortization";

export type ManufacturingCostMode = "none" | "linked" | "manual";

export type ManufacturingCostConfiguration = Record<ManufacturingCostCategory, {
  mode: ManufacturingCostMode;
  amount: string;
  description: string;
  counterpartAccountId: string;
}>;
