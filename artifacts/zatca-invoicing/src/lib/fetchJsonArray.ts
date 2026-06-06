// Resilient list fetch: ALWAYS resolves to an array.
//
// A non-OK response (e.g. 403 when the logged-in user's role lacks a module
// permission such as "warehouses" in a given company) returns a JSON error
// OBJECT, not an array. Returning that object straight from a React Query
// queryFn makes `data` a non-array, so the common `const { data: x = [] }`
// destructuring default never kicks in (it only applies to `undefined`).
// A later render-time `x.find(...)` / `x.map(...)` then throws
// "x.find is not a function" and the global ErrorBoundary white-screens the
// whole form — but only for the companies/users where the gate denies the
// request, which is why the crash looks "data-driven".
//
// Funnel every list query through here so a denied/failed fetch degrades to []
// instead of crashing the page.
export async function fetchJsonArray(url: string, headers: HeadersInit): Promise<any[]> {
  try {
    const r = await fetch(url, { headers });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
