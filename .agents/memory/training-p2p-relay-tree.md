---
name: Training P2P relay-tree broadcast
description: Free mass training broadcast — WebRTC relay tree with LiveKit fallback; protocol/invariant notes
---

- WS signaling hub at `/api/training-room/p2p/ws` relays SDP/ICE only (no media through server). Broadcaster auth = bearer in query (mirrors cobrowseHub pattern); viewer auth = session publicToken + allowPublic + status=live.
- The broadcaster is addressed as `"__root__"` on the viewer side — hub must translate broadcaster-originated signals to `from:"__root__"` and route viewer signals `to:"__root__"` to the broadcaster socket. Breaking this contract silently kills the upstream offer/answer.
- **Why:** viewers only accept upstream SDP from `parentId || "__root__"`; anything else is treated as a downstream child.
- Invariants: viewer may signal ONLY parent/children (anti-snooping); detach must reparent orphans with subtree-exclusion or you create cycles; `relay-capacity:false` viewers become leaves and their children get reattached; broadcaster (re)join does a full `rebuildTree`.
- Fallback chain: P2P viewer 12s no-stream timeout → `onFatal` → LiveKit publicJoin; trainer mic-grant mints a micOnly LiveKit token and the viewer page swaps to LiveRoom.
- Lesson: after context compression, verify "DONE" files actually exist on disk (this hub file was lost while the rest of the feature survived) — architect review caught it.
