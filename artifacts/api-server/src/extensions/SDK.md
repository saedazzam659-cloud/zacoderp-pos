# Zacode Extension Platform — SDK & Developer Guide

> Phase 2 (Runtime & SDK). This document is the contract for building an
> extension that runs inside the Zacode ERP. It covers the manifest spec, the
> runtime endpoints, the browser SDK, and a walkthrough of the bundled sample
> (`partner-toolkit`).

## 1. Model & guarantees

An extension is **additive** and **sandboxed**. It can:

- register **screens** (rendered inside a sandboxed `<iframe>`),
- present those screens as ordinary **screens**, **reports**, or **dashboards**,
- own **custom tables** (logical collections stored in the shared, tenant-scoped
  `ext_records` table — never its own DDL, never a core table),
- expose **custom API routes** under its own namespace,
- read/write **core data** ONLY through the gated **Core Data API**.

Hard invariants enforced by the runtime:

1. **Signed manifests.** Every extension's manifest is Ed25519-signed by the
   platform key; a manifest that fails verification is refused at load.
2. **No code from the database.** Handler code lives in-process (the `BUILTINS`
   registry). The DB row only carries the signed manifest + enable state.
3. **Sandbox isolation.** Screens render in an `<iframe sandbox="allow-scripts
   allow-forms">` — **never** `allow-same-origin`. The iframe cannot read host
   cookies, host `localStorage`, or the host DOM.
4. **Two gates, both default OFF.** (a) the company module gate
   `extensions_platform`, and (b) the per-company per-extension `enabled` flag.
5. **Tenant isolation.** Every core read/write and every `ext_records` row is
   hard-scoped to the caller's `company_id` server-side.
6. **Least privilege.** Core access is honoured ONLY for a `resource:action`
   present in the SIGNED manifest `permissions`. Permissions cannot be widened
   after signing.
7. **Audited.** Every Core Data API call and every custom-table mutation is
   written to the audit log (`module = "extensions"`).

## 2. Manifest spec

```jsonc
{
  "manifestVersion": 1,
  "extensionId": "partner-toolkit",        // lowercase slug, unique
  "name": { "ar": "حزمة أدوات الشريك", "en": "Partner Toolkit" },
  "version": "1.0.0",
  "vendor": "Zacode",
  "description": "…",

  // UI surfaces. `kind` controls how the host groups the screen.
  "screens": [
    { "key": "dashboard", "titleAr": "لوحة المعلومات", "titleEn": "Dashboard",
      "icon": "LayoutDashboard", "kind": "dashboard" },
    { "key": "report", "titleAr": "تقرير", "titleEn": "Report", "kind": "report" },
    { "key": "notes", "titleAr": "ملاحظات", "kind": "screen" }
  ],

  // Custom API routes under /api/ext/<extensionId>/api/<path>.
  "apiRoutes": [
    { "method": "GET", "path": "/summary", "description": "…" }
  ],

  // Custom "tables" (collections). Rows live in ext_records; the runtime
  // accepts data ops ONLY for a collection declared here.
  "tables": [
    { "key": "notes", "titleAr": "الملاحظات", "titleEn": "Notes" }
  ],

  // Core permissions, '<resource>:read' | '<resource>:write'. ENFORCED.
  "permissions": ["customers:read", "invoices:read", "items:read"]
}
```

Field rules:

- `extensionId`, table `key` — lowercase slug (`^[a-z0-9][a-z0-9_-]*$`).
- `screens[].kind` — `screen` (default) | `report` | `dashboard`.
- `permissions[]` — must match `^[a-z_]+:(read|write)$`.

## 3. Runtime endpoints

All endpoints are under `/api/ext`. The sandboxed iframe authenticates by
passing the bearer token as a `?token=` query param (it cannot set an
`Authorization` header); the runtime shims it back into auth.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/ext/sdk.js` | Public SDK source (tooling/docs). |
| GET | `/api/ext/installed` | Extensions enabled for the current company. |
| GET | `/api/ext/catalog` | Full signed catalog (admin). |
| POST | `/api/ext/:extId/enable` \| `/disable` | Toggle per company (admin). |
| GET | `/api/ext/:extId/screen?screenKey=…` | Sandboxed screen HTML. |
| ANY | `/api/ext/:extId/api/<path>` | The extension's own API routes. |
| GET | `/api/ext/:extId/core/:resource?search=&limit=` | Gated core **list**. |
| POST | `/api/ext/:extId/core/:resource` | Gated core **create**. |
| GET | `/api/ext/:extId/data/:collection?limit=` | List own records. |
| GET | `/api/ext/:extId/data/:collection/:id` | Get one record. |
| POST | `/api/ext/:extId/data/:collection` | Create record (`{ data }`). |
| PUT/PATCH | `/api/ext/:extId/data/:collection/:id` | Update record (`{ data }`). |
| DELETE | `/api/ext/:extId/data/:collection/:id` | Delete record. |

### Core Data API resources

Each exposes a hand-picked, read-shaped projection (no secrets/internal cols),
always filtered to the caller's company:

| Resource | Actions |
| --- | --- |
| `customers` | read, write |
| `items` | read |
| `invoices` | read |
| `suppliers` | read |
| `accounts` | read |

A call without the matching signed permission returns `403 EXT_PERMISSION_DENIED`.

## 4. Browser SDK (`window.Zacode`)

Screen documents **inline** the SDK plus a private bootstrap (the strict CSP is
`script-src 'unsafe-inline'`, so no external `<script src>`). When you build a
screen with `renderExtensionDocument()`, `window.Zacode` is guaranteed available
in your `appScript`.

```js
Zacode.ctx                        // { extensionId, companyId, role }

// Gated CORE data (subject to manifest permissions)
await Zacode.core.list("customers", { search, limit });
await Zacode.core.create("customers", { nameAr, phone });

// The extension's OWN tables (ext_records collections)
await Zacode.data.list("notes", { limit });
await Zacode.data.get("notes", id);
await Zacode.data.create("notes", { text: "…" });
await Zacode.data.update("notes", id, { text: "…" });
await Zacode.data.remove("notes", id);

// The extension's OWN custom API routes
await Zacode.api.get("/summary");
await Zacode.api.post("/do-thing", { … });
```

Errors reject with `{ message, status, code, payload }`.

## 5. Building an extension (host side)

A builtin extension is an object implementing `BuiltinExtension`:

```ts
import { renderExtensionDocument } from "./sdk.js";
import { coreList, CoreApiError } from "./coreDataApi.js";

export const myExtension: BuiltinExtension = {
  extensionId: "my-ext",
  manifest, // ExtensionManifest (validated + signed at seed time)
  renderScreen(screenKey, ctx) {
    return renderExtensionDocument({
      extensionId: "my-ext",
      ctx,
      title: "…",
      styles: "…",
      bodyHtml: "<div id='app'>…</div>",
      appScript: `Zacode.core.list("invoices").then(render);`,
    });
  },
  async handleApi(sub, req, res, ctx) {
    if (sub === "/summary") {
      // SERVER-SIDE core access goes through the SAME gated gateway,
      // so the permission check applies here too.
      const invoices = await coreList(manifest, ctx, "invoices", { limit: 500 });
      res.json({ count: invoices.length });
      return;
    }
    res.status(404).json({ error: "EXT_ROUTE_NOT_FOUND" });
  },
};
```

Register it in `registry.ts` `BUILTINS`. It is seeded **disabled** for every
company; an admin enables it from the Extensions admin screen.

## 6. Sample walkthrough — `partner-toolkit`

The bundled sample (`partnerToolkit.ts`) exercises **every** capability:

- **Dashboard screen** (`kind: dashboard`) — `Zacode.core.list` on customers,
  invoices and items → KPI cards. Proves gated, read-only core access from the
  sandbox.
- **Report screen** (`kind: report`) — lists recent core invoices via the
  gateway.
- **Notes screen** (`kind: screen`) — full CRUD against its own `notes`
  collection via `Zacode.data.*`. Proves tenant-scoped custom-table storage
  with no DDL and no core-table contact.
- **Custom API** — `GET /summary` aggregates core data **server-side** through
  the same `coreList` gateway, proving the permission model applies to server
  code as well as the browser.

Manifest permissions are read-only (`customers:read`, `invoices:read`,
`items:read`) and it owns exactly one table (`notes`). Disable a permission (or
the whole extension) and the corresponding calls return `403` — the gate is the
single, audited seam where core data leaves the core.
