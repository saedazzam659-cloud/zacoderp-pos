---
name: Agent full edition + one-click provisioning
description: Invariants for the «نسخة كاملة» agent edition, its release/update channel, and the SSH provision pipeline.
---

## Editions
`agent_instances.mode`: `frontend_only`, `full_shell`, `full`. `full` runs the whole api-server bundle locally on the agent server (systemd `zacod-app` on 127.0.0.1:8080, Caddy fronting it); the other two are served from central.

## Release channel
- `lib/agentRelease.ts` tars the server's OWN `dist/` (version = sha256(index.mjs)[:16]) → every central Publish is automatically a new agent release. `dist/public/` SPA assets ride along only in the PRODUCTION build — dev dist has no UI, so full-edition install tests must pull from prod.
- Public routes `/api/agent/release/manifest|bundle` auth by installationId+licenseKey and require mode=full, status=active, unexpired license — the kill-switch also stops updates. Updater = cron every 10 min comparing manifest version; heredoc for the updater must stay quoted (`<<'ZACOD_UPD'`).

## Provision pipeline invariants
**Why:** code-review found root shell-injection + races on first pass.
- Everything interpolated into root SSH scripts must pass `assertShellSafeHostLike` (host/domain) or `assertShellSafeDbUrl`; never rely on shQ alone for values inside unquoted heredocs.
- Claim (`deployStatus='deploying'` conditional UPDATE, 30-min stale reclaim) must happen BEFORE license auto-mint, then re-read the row — otherwise a concurrent request overwrites the key the pipeline uses and release downloads 403.
- UI: deploy + init-db + provision buttons all disable while `deployStatus==="deploying"` (they share the lease).
- Full-mode app env uses a LOOPBACK DATABASE_URL (rewrite host→127.0.0.1, drop sslmode); central keeps the public URL because schema init/fingerprint run from central — that is why the agent Postgres is remotely reachable (scram + strong hex password). Tightening exposure = known follow-up.
- Progress streams into deployLog (reused column, no DDL); UI polls the list every 3s while deploying.

## خيارات التسطيب (variants)
- `/provision` body: `{variant: full|no_db|upload, encryptBundle}` — الافتراضي يطابق السلوك القديم تمامًا.
- no_db: يرفض بوضوح إذا لا يوجد dbUrlEnc (لا يثبّت PostgreSQL أبدًا).
- upload: حزم مرفوعة (backend مطلوب tgz، frontend اختياري يُفك في public/، db backup اختياري) تخزن في tmpdir/zacod-custom-pkg/<id>؛ تُسحب عبر `/agent/release/custom` بنفس مصادقة bundle؛ بدون كرون تحديث تلقائي.
- **استعادة الـ DB backup يجب أن تسبق الخطوة 4 (سكيما+بصمة)** وإلا مسحت البصمة → تعطل النبض؛ وتفشل بصوت عالٍ (ON_ERROR_STOP=1 / --exit-on-error) لا استعادة صامتة.
- التشفير: صيغة openssl القياسية Salted__ + AES-256-CBC + PBKDF2-SHA256 iter=10000 (Node pbkdf2Sync 48 بايت = key+iv)؛ المفتاح HMAC(SESSION_SECRET, installationId:licenseKey) — fail-closed إذا غاب SESSION_SECRET؛ يُسلَّم عبر SSH فقط ويُحفظ في app.env للمحدّث، لا يمر في أي URL.

## حساب السوبر أدمن للنسخة الكاملة
- حقول sa_username / sa_email / sa_password_enc على صف الوكيل (كلمة المرور write-only مشفّرة، publicRow يعيد saPasswordSet فقط).
- تُزرع في قاعدة الوكيل بخطوة 4.5 من التسطيب (بعد السكيما والبصمة) عبر upsert على users بشرط company_id IS NULL — نفس قواعد التحقق المركزية (username regex، كلمة مرور ≥10 بأحرف وأرقام).
- الحقول تظهر في نموذج الوكيل فقط عند mode=full؛ تعديلها بعد التسطيب يتطلب إعادة «تسطيب كامل» ليُعاد الزرع.
