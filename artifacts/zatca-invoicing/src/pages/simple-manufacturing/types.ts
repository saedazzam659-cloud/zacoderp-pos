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
  routings: Array<{
    id: number;
    productItemId: number | null;
    productNameAr?: string | null;
    nameAr: string;
    isActive?: boolean;
    stagesCount?: number;
  }>;
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
  productItemId: number | null;
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
  costPolicy: Record<string, any>;
};
