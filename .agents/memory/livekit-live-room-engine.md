---
name: LiveKit live-room engine
description: Unified training-hall + support-room LiveKit wiring — routing, authz, and public-join gotchas.
---

- Shared Arabic room UI: `components/livekit/LiveRoom.tsx` (roles publisher/subscriber, chat+raise-hand via data channel `{t:"chat"|"hand"}`, mic grant via participant permissions); API helpers in `lib/liveRoomApi.ts`.
- **Public join must clear TWO gates**: frontend early-return in `App.tsx` BEFORE auth gates (`location.startsWith("/training/join/")`), AND backend router mounted BEFORE the path-less `zatcaRouter` (its catch-all 401s any unmatched /api/*). Mounting only after zatcaRouter silently kills the "no-login link" feature.
  **Why:** architect review caught the public API path 401ing despite correct frontend routing.
- **Support-room SA authz**: `isAgent` must be `role==="superadmin" && call.agentUserId===u.id` — a bare role check lets any SA join/end a colleague's call (cross-call eavesdropping).
- Ring flow: server SSE `support_call_invite/cancelled` → AuthContext re-broadcasts as window CustomEvents `support-call:invite/cancelled` → global `IncomingSupportCall` (App root) answers via `joinCall` → fullscreen LiveRoom; leave calls `endCall`.
- Training broadcast is browser-bound: media publishes ONLY while the trainer's tab is inside the room; leaving the room UI stops both LiveKit publishing AND the P2P broadcaster socket while DB status stays "live" — misleads viewers. Warn the trainer on leave; session list must poll (~10s) so trainee join buttons appear when a session goes live.
- P2P viewer fail-timer contract: the 12s first-video timeout must arm ONLY on `parent-assigned` (broadcaster actually online) — never at start() or while "waiting", or viewers get bounced into an EMPTY LiveKit room and back to the join screen in a loop.
- LiveKit billing scales with participant-minutes — 1000-viewer sessions can be costly; warn before large public sessions.
