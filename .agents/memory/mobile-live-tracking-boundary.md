---
name: Mobile live-location tracking boundary
description: Product and privacy constraints for connecting mobile sessions to the live user-tracking map.
---

Mobile live tracking is opt-in per user through the manager's mobile-permissions screen. When enabled, the app requires foreground and background OS location permission before exposing authenticated app screens; it tracks only during the authenticated work session and stops tracking on logout or when the manager disables the permission. The OS permission cannot be bypassed.

**Why:** The user requested that a manager follow mobile users' work movements in the existing live-tracking module, while the employee should know the app is sharing location and tracking should not continue after logout.

**How to apply:** Keep this permission explicitly off by default, including for administrators and bulk "allow all" actions. Use the current OpenStreetMap map; Google Maps API activation is not required for GPS coordinates. Background tracking must be verified in a native installed build, not assumed from Expo Go.
