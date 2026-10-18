---
name: Mobile live-location tracking boundary
description: Product and privacy constraints for connecting mobile sessions to the live user-tracking map.
---

Mobile live tracking is opt-in per user through the manager's mobile-permissions screen. When enabled, the app requires foreground and background OS location permission before exposing authenticated app screens; it tracks only during the authenticated work session and stops tracking on logout or when the manager disables the permission. The OS permission cannot be bypassed.

Mobile managers need a separate explicit `mobile_tracking_manage` grant to view representatives and their location reports in the mobile app. Keep the grant off by default, including for admins and bulk-allow actions, and enforce it server-side as well as hiding the screen. Period reports may be shared through WhatsApp with location links; when user profiles have no phone number, let the manager choose the recipient in WhatsApp rather than adding unsourced contact data.

**Why:** The user requested that a manager follow mobile users' work movements in the existing live-tracking module, while the employee should know the app is sharing location and tracking should not continue after logout.

**How to apply:** Keep employee GPS opt-in and manager mobile-view access as separate explicit permissions, both off by default. Use the current OpenStreetMap map; Google Maps API activation is not required for GPS coordinates. Background tracking must be verified in a native installed build, not assumed from Expo Go.
