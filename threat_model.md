# Threat Model

## Project Overview

Zacode ERP is a multi-tenant business system with a React/Vite POS and an Express API backed by PostgreSQL. Restaurant staff manage menu items, tables, kitchen flow, and billing. Diners may now browse a table's menu and submit a cash-on-collection order through a QR link.

## Assets

- Restaurant orders, menu pricing, inventory links, and accounting records; these must stay within the owning company.
- Guest order links; possession permits menu access and placing orders for one table.
- Guest-entered order details; the QR flow currently avoids collecting contact or payment credentials.

## Trust Boundaries

- Public diner browser to the unauthenticated QR endpoints.
- Authenticated employee browser to the restaurant administration and order-management APIs.
- API server to PostgreSQL, where tenant ownership, menu links, and current order state are authoritative.

## Scan Anchors

- Public and authenticated restaurant routes: `artifacts/api-server/src/routes/pos-restaurant-public.ts` and `artifacts/api-server/src/routes/pos-restaurant.ts`.
- QR ordering page and per-table QR management: `artifacts/pos/src/pages/QrOrder.tsx` and `artifacts/pos/src/pages/RestaurantSettings.tsx`.
- The general online-store route and `store_orders` workflow are separate from restaurant orders.

## Threat Categories

### Spoofing and Elevation of Privilege

QR tokens are bearer links. They must be cryptographically unpredictable, revocable by an authorized employee, and resolved server-side to exactly one active table and company. Public requests must never select a tenant or table by client-supplied numeric IDs.

### Tampering

The API must validate menu item availability, quantities, and modifier selections against the owning company's active menu. Prices and tax totals must be calculated from server-side records. QR orders remain ordinary dine-in restaurant orders and must not create invoices or dispatch kitchen tickets directly.

### Information Disclosure

Public menu responses must contain only the table label and items/categories available to that branch. Employee-only table data and the bearer token must not be included in authenticated table-list responses.

### Denial of Service

Public QR endpoints apply an IP-based request limit. The current limiter is process-local and therefore only a best-effort control when multiple API workers are active; a shared limiter is needed if traffic or abuse warrants stronger enforcement.
