# Clothing and footwear module: data design

## Existing records and relationships

- A model is a normal company-owned row in `items` with no `parentItemId`.
- Each actual color/size combination is a child item whose `parentItemId` points to the model.
- Each child keeps its own item code, optional barcode, cost, sale price, VAT rate, and stock identity.
- The child’s `variantAttributes` stores the selected labels as `اللون` and `المقاس`. The module does not create rows for combinations the company does not sell.
- A root item is listed as a clothing model only when it has the existing `ملابس وأحذية` item tag. New models receive that tag; linking an existing stock item adds only the tag and leaves its other fields and movements intact.
- Purchase, sales, POS, returns, transfers, counts, adjustments, stock ledgers, and item reports already address item IDs. Reusing child items keeps those workflows and their accounting/costing rules in control.
- Existing company isolation and item permissions continue to apply. The new page requires both the existing item permission and the separate company-level `clothing` entitlement.

## Schema and migration plan

This implementation adds no table or column and does not rewrite existing item, invoice, stock, or accounting data. It uses the current item-variant relationship and JSON attributes; therefore there is no schema push, startup DDL, backfill, or production migration to run. No database backup is needed for a schema migration because no schema migration is being made.

The only entitlement change is a new `clothing` key in the existing company menu-permission JSON. A missing key is treated as disabled, the public registration path cannot grant it, and only the SuperAdmin menu-permissions screen can enable it.

## Scope boundary

Color and size values are entered independently while building each model’s matrix. Only selected combinations are persisted as child items. This avoids a second inventory system and leaves all legacy screens and document behavior unchanged while the company entitlement is off.
