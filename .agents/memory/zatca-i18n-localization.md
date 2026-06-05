---
name: ZATCA app English localization (i18next)
description: How to localize the Arabic-first zatca-invoicing app to full English without JSON races or subagent timeouts.
---

# Localizing zatca-invoicing (Arabic-first → bilingual via i18next)

Large effort: hundreds of `artifacts/zatca-invoicing/src` files are 100% hardcoded Arabic with zero `t()`. Done iteratively module-by-module. Keys live in `src/i18n/locales/{en,ar}.json`; `useTranslation()` + `const isRtl = i18n.language === "ar"`.

## Parallel execution without breaking the locale JSON
**Rule:** never let parallel subagents edit `en.json`/`ar.json` directly — concurrent whole-file writes lose updates.
**Proven pattern:** each subagent edits only its own `.tsx` AND writes a per-page FRAGMENT file to `.local/i18n_frag/<File>.json` shaped `{ "en": { "<nsKey>": {...} }, "ar": { "<nsKey>": {...} } }`. The main agent (single writer) deep-merges all fragments into the locale files, then deletes the frag dir. Each page uses a DISTINCT namespace sub-key so even the merge can't collide.
**Why:** lets N pages run in parallel; the only serialized step (the merge) is cheap and conflict-free.
**How to apply:** when a batch is pure `.tsx` edits on DISTINCT files with NO new keys (e.g. the name-display fix), you can skip fragments and let subagents edit their own files directly — still one file per subagent.

## Subagent mechanics
- `subagent()` called INSIDE `code_execution` blocks the notebook and TIMES OUT (~600s). Use the `startAsyncSubagent` callback + the `wait_for_background_tasks` TOOL instead.
- ONE page per subagent. Bundling ~3 large pages (85+ Arabic lines) into one subagent times out.
- Recovery for an interrupted subagent: original Arabic is recoverable via `git show HEAD:<path>` and `git diff HEAD -- <path>`.

## Full English UI requires language-aware ENTITY NAMES
A page can have zero hardcoded-Arabic UI strings and STILL show Arabic in English mode, because entity name fields bind `x.nameAr` directly. "Keep DB dual-name logic as-is" is a trap when the code binds `nameAr` only.
**Fix:** `const pickName = (ar, en) => (isRtl ? (ar ?? en) : (en ?? ar)) ?? "";` then replace `x.nameAr ?? "—"` → `pickName(x.nameAr, x.nameEn) || "—"` (preserve the original fallback). Keeps Arabic mode byte-identical (Arabic-first), makes English mode English with Arabic fallback. Apply to: visible displays, SearchCombobox `label`, search predicates (match BOTH names case-insensitively), Excel/print export VALUES (not the object keys), and `t()` subtitle interpolations.
**SearchCombobox** (`components/ui/search-combobox.tsx`): shows `item.label` as PRIMARY; `labelEn` is only a muted subtitle + a search alias — it does NOT switch by language. So `label` itself must be language-aware.
**Leave alone:** `isRtl ? nameEn : nameAr` columns are intentional *other-language* secondary columns; AI/API request payloads that send `nameAr`; DB query field names; `l.itemName` stored snapshots.
Also localize hardcoded date locales: `toLocaleDateString("ar-SA")` → `toLocaleDateString(isRtl ? "ar-SA" : "en-US")`.

## Verify each batch
`pnpm --filter @workspace/zatca-invoicing run typecheck`; grep residuals: `rg 'nameAr \?\? "—"|toLocaleDateString\("ar-SA"\)'`. Then architect review. Per replit.md, confirm route→component in `App.tsx` before editing a page (filename ≠ route).
