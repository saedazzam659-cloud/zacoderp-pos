/**
 * Temporary two-publish workaround for Replit's schema-diff dependency order.
 *
 * Stage 1 (current): publish the composite UNIQUE target keys without the new
 * composite FKs. After production confirms all ten keys, set this to true
 * for stage 2 and reconcile development as documented in:
 * .local/staged-publish/contracting-composite-fks-stage2.md
 */
export const CONTRACTING_COMPOSITE_SCOPE_FKS_ENABLED = false;