import { db, getActiveExternalDb } from "@workspace/db";
import { sql } from "drizzle-orm";

export const SCHOOL_TRANSPORT_DDL = [
  `CREATE TABLE IF NOT EXISTS school_transport_vehicles (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    plate_number TEXT NOT NULL,
    owner_type TEXT NOT NULL DEFAULT 'school_owned',
    capacity INTEGER NOT NULL DEFAULT 0,
    fixed_asset_id INTEGER,
    supplier_id INTEGER,
    lease_contract_no TEXT,
    lease_start_date DATE,
    lease_end_date DATE,
    monthly_rent NUMERIC(15, 2),
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_school_transport_vehicle_company_code
    ON school_transport_vehicles(company_id, code)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_school_transport_vehicle_company_plate
    ON school_transport_vehicles(company_id, plate_number)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_school_transport_vehicle_company_asset
    ON school_transport_vehicles(company_id, fixed_asset_id)`,
  `CREATE TABLE IF NOT EXISTS school_transport_routes (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    campus_id INTEGER REFERENCES school_campuses(id) ON DELETE SET NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES school_transport_vehicles(id) ON DELETE RESTRICT,
    driver_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    attendant_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    direction TEXT NOT NULL DEFAULT 'round_trip',
    capacity_override INTEGER,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_transport_route_company_year_code
      UNIQUE (company_id, academic_year_id, code)
  )`,
  `CREATE TABLE IF NOT EXISTS school_transport_stops (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    route_id INTEGER NOT NULL REFERENCES school_transport_routes(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL,
    name TEXT NOT NULL,
    address TEXT,
    pickup_time TEXT,
    dropoff_time TEXT,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_transport_stop_route_sequence
      UNIQUE (company_id, route_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS school_transport_assignments (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    academic_year_id INTEGER NOT NULL REFERENCES school_academic_years(id) ON DELETE RESTRICT,
    enrollment_id INTEGER NOT NULL REFERENCES school_enrollments(id) ON DELETE RESTRICT,
    route_id INTEGER NOT NULL REFERENCES school_transport_routes(id) ON DELETE RESTRICT,
    pickup_stop_id INTEGER REFERENCES school_transport_stops(id) ON DELETE RESTRICT,
    dropoff_stop_id INTEGER REFERENCES school_transport_stops(id) ON DELETE RESTRICT,
    service_type TEXT NOT NULL DEFAULT 'round_trip',
    start_date DATE NOT NULL,
    end_date DATE,
    status TEXT NOT NULL DEFAULT 'active',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_school_transport_assignment_company_year_enrollment
      UNIQUE (company_id, academic_year_id, enrollment_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_school_transport_routes_company_year_active
    ON school_transport_routes(company_id, academic_year_id, is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_school_transport_assignments_company_route_status
    ON school_transport_assignments(company_id, route_id, status)`,
] as const;

const centralCacheKey = {};
const initializationByPool = new WeakMap<object, Promise<void>>();

export async function ensureSchoolTransportSchema(): Promise<void> {
  const key = (getActiveExternalDb()?.pool as object | undefined) ?? centralCacheKey;
  const existing = initializationByPool.get(key);
  if (existing) return existing;

  const pending = (async () => {
    for (const statement of SCHOOL_TRANSPORT_DDL) {
      await db.execute(sql.raw(statement));
    }
  })();
  initializationByPool.set(key, pending);

  try {
    await pending;
  } catch (error) {
    if (initializationByPool.get(key) === pending) initializationByPool.delete(key);
    throw error;
  }
}
