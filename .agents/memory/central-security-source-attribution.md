---
name: Central security source attribution
description: Trust boundary and identity rules for showing central-versus-agent sessions and login history.
---

Central Security must derive an agent/server identity from the central agent registry and the database source selected by the server. Never accept an unsigned client header as agent attribution. Qualify session and audit-row identities with their source because numeric IDs can collide across independent databases.

**Why:** A login client's IP country can differ from the Saudi agent/server that handled it, and separate databases can reuse the same numeric user and audit IDs. Conflating these signals misidentifies servers and can make merged rows overwrite one another.

**How to apply:** Label IP/GPS from the login event as the login source. Show heartbeat-IP geography separately as an approximate server location. For all-source history, collect each source, merge by timestamp, and paginate globally; preserve healthy-source results with warnings when another source is unavailable.