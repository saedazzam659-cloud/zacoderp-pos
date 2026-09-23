/**
 * Temporary two-publish workaround for Replit's schema-diff dependency order.
 *
 * Stage 2 (current): production has all ten composite UNIQUE target keys, so
 * the composite FKs are enabled and development is reconciled for Publish 2.
 * The staged procedure and verification checklist are documented in:
 * .local/staged-publish/contracting-composite-fks-stage2.md
 */
export const CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED = true;