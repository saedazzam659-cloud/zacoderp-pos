---
name: POS Desktop per-user screen permissions
description: Saved screen access, admin overrides, and safe navigation
---

# POS Desktop per-user screen permissions

Permission edits stay as drafts until Save. Persist only values that differ from the selected user's role defaults, and keep unknown permission rows when replacing the known screen keys. Admin defaults begin with all screens, but explicit per-user overrides restrict admin screens too; role checks remain an additional gate for admin-only screens. Every standalone screen must have a permission key, and the same allowed screen list must control navigation, open tab chips, and rendered screen content. Do not reveal cached permissions from a previous login while the current user's permissions are loading; fail closed and allow retry if loading fails.

**Why:** The administrator role originally bypassed custom per-user settings, and shared cached permissions or stale open tabs could expose screens from another user session. Admins also need a clear warning that disabling their own permissions page requires another admin to restore it.

**How to apply:** Keep bulk edits atomic and staged. When adding a screen, include it in the permission catalog and navigation mapping; preserve the admin-only role gate where needed, then verify denied screens cannot render from a saved tab or internal navigation action.
