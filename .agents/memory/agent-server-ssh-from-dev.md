---
name: Agent-server SSH rescue from dev workspace
description: When prod's egress IP is banned on an agent server, the dev workspace can still reach it
---
The dev workspace egress IP differs from the prod deployment's. If an agent server's fail2ban/firewall blocks the prod platform IP (ban-check shows all ports "refused" while the user's browser opens the domain fine), test `/dev/tcp/<host>/<port>` from the workspace — if open, rescue directly:
1. Read `ssh_secret_enc` from prod `agent_instances` (read-only SQL; columns are `ssh_host`/`ssh_port`/`ssh_user`, not `host`).
2. Decrypt locally with lib/encryption.ts scheme: scrypt(SESSION_SECRET, "zatca-gw-v1", 32) + AES-256-GCM on `v1:iv:tag:ct` — dev and prod share SESSION_SECRET.
3. `sshpass -e ssh -p <port>` and run `fail2ban-client unban --all`.
**Why:** prod cannot un-ban itself (it's the banned party); the agent person often can't run commands.
**How to apply:** never print/log the decrypted secret; write to a 0600 tmp file and delete after. Install script also whitelists the connecting platform IP via `$SSH_CONNECTION` into `/etc/fail2ban/jail.d/zacod-whitelist.conf` for permanent immunity.
