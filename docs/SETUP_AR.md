# دليل تشغيل المشروع — السورس كود، السيرفر المحلي، والسيرفر السحابي

> نظام الفاتورة الإلكترونية السعودية (ZATCA) متعدد المستأجرين — Monorepo بـ pnpm

---

## 1) ما هو هذا المشروع؟

مشروع موحّد (Monorepo) يضم 4 تطبيقات تعمل مع بعضها:

| رقم | الاسم | الوصف | المنفذ المحلي |
|---|---|---|---|
| 1 | `artifacts/api-server` | سيرفر الـ API (Express + Drizzle) — كل منطق العمل | 8080 |
| 2 | `artifacts/zatca-invoicing` | الواجهة الأمامية الرئيسية (نظام الفوترة) | 19225 |
| 3 | `artifacts/pos` | تطبيق نقاط البيع | 24730 |
| 4 | `artifacts/mockup-sandbox` | بيئة معاينة المكوّنات (للتطوير فقط) | 8081 |

ومكتبات داخلية مشتركة:

- `lib/db` — مخطط قاعدة البيانات (Drizzle ORM)
- `lib/api-spec`, `lib/api-zod`, `lib/api-client-react` — مواصفات الـ API ومولّدات Zod / Hooks
- `scripts` — أدوات صيانة وفحص

---

## 2) كيف تنزّل السورس كود؟

### الطريقة الأولى — تنزيل ZIP من Replit (الأبسط)

1. من داخل مساحة العمل في Replit: افتح القائمة العلوية ⋯
2. اختَر **Download as zip**
3. سيتم تنزيل ملف يحتوي كامل المشروع (دون مجلد `node_modules`)

### الطريقة الثانية — عبر Git (موصى بها)

من شل Replit:
```bash
# داخل Replit (لرؤية الـ remote)
git remote -v
```
ثم على جهازك:
```bash
git clone <عنوان-المستودع>
cd <اسم-المستودع>
```

> **استثناءات لا تُنزّل:** الملفات في `.gitignore` (مثل `node_modules`, `dist`, `.env`, `.cache`). كل هذه يُعاد توليدها محلياً.

---

## 3) هيكل المشروع باختصار

```
workspace/
├── artifacts/
│   ├── api-server/           # سيرفر Express
│   │   ├── src/routes/       # كل مسارات الـ API
│   │   ├── build.mjs         # سكربت الـ esbuild
│   │   └── package.json
│   ├── zatca-invoicing/      # الواجهة الرئيسية (React + Vite)
│   │   ├── src/              # المكوّنات والصفحات
│   │   ├── vite.config.ts
│   │   └── package.json
│   ├── pos/                  # نقاط البيع
│   └── mockup-sandbox/       # معاينة مكوّنات (تطوير)
│
├── lib/
│   ├── db/                   # مخطط Drizzle + إعدادات
│   │   ├── src/schema/       # ملفات الجداول
│   │   └── drizzle.config.ts
│   ├── api-spec/             # OpenAPI specs
│   ├── api-zod/              # Zod schemas
│   └── api-client-react/     # Hooks لاستهلاك الـ API
│
├── scripts/                  # أدوات صيانة
├── pnpm-workspace.yaml       # تعريف الـ Monorepo
├── package.json              # سكربتات الجذر (build / typecheck)
└── replit.nix                # تبعيات النظام (لمعلومات Replit)
```

---

## 4) التشغيل على سيرفر محلي (Local)

### المتطلبات على جهازك

| البرنامج | النسخة المطلوبة | تنزيل |
|---|---|---|
| **Node.js** | 20.x أو أحدث | https://nodejs.org |
| **pnpm** | 10.x أو أحدث | `npm install -g pnpm` |
| **PostgreSQL** | 14 أو أحدث | https://www.postgresql.org/download/ |
| **OpenSSL** | (لتوليد CSR لـ ZATCA) | غالباً مثبّت مسبقاً على Linux/Mac |
| **Git** | أي نسخة حديثة | https://git-scm.com |

### خطوة 1 — تنزيل المشروع وتثبيت التبعيات

```bash
git clone <عنوان-المستودع>  # أو فك ضغط الـ zip
cd workspace
pnpm install                   # سيقرأ pnpm-lock.yaml ويثبّت كل شيء
```

### خطوة 2 — إنشاء قاعدة البيانات

افتح PostgreSQL وأنشئ قاعدة:
```bash
psql -U postgres
CREATE DATABASE zatca_invoicing;
CREATE USER zatca_user WITH ENCRYPTED PASSWORD 'كلمة_سر_قوية';
GRANT ALL PRIVILEGES ON DATABASE zatca_invoicing TO zatca_user;
\q
```

### خطوة 3 — متغيّرات البيئة

أنشئ ملف `.env` في جذر المشروع (أو صدّر المتغيرات في الـ shell):

```bash
# قاعدة البيانات (إجباري)
DATABASE_URL="postgresql://zatca_user:كلمة_سر_قوية@localhost:5432/zatca_invoicing"

# مفتاح تشفير الجلسات (إجباري) — ولّد قيمة عشوائية طويلة
SESSION_SECRET="ضع-قيمة-عشوائية-طويلة-هنا-32-حرفاً-أو-أكثر"

# للتخزين السحابي (اختياري — للملفات والشعارات)
DEFAULT_OBJECT_STORAGE_BUCKET_ID="..."
PRIVATE_OBJECT_DIR="/private/uploads"
PUBLIC_OBJECT_SEARCH_PATHS="/public"

# لإرسال البريد (اختياري — لتقارير الـ SuperAdmin المجدوّلة)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_USER="بريدك@gmail.com"
SMTP_PASS="كلمة-سر-التطبيق"
SMTP_FROM="\"نظام الفوترة\" <noreply@example.com>"

# لـ ZATCA (إذا كنت ستستعمل API الخدمة الفعلي)
SPL_API_KEY="..."        # من بوابة ZATCA

# لـ AI (اختياري — للمساعد الصوتي)
OPENAI_API_KEY="sk-..."
```

> **تحميل تلقائي:** إذا كنت تشغّل المشروع عبر `pnpm dev`، يمكنك تثبيت `dotenv-cli` (`pnpm add -D -w dotenv-cli`) ثم تشغيل: `dotenv -e .env -- pnpm ...`

### خطوة 4 — إنشاء الجداول في قاعدة البيانات

```bash
cd lib/db
pnpm push          # سيقرأ المخطط وينشئ كل الجداول
# في حال طلب تأكيد لتغييرات قد تحذف بيانات استعمل:
pnpm push-force
cd ../..
```

### خطوة 5 — تشغيل التطبيقات

افتح **3 نوافذ Terminal** (واحدة لكل تطبيق):

**النافذة 1 — سيرفر الـ API:**
```bash
PORT=8080 pnpm --filter @workspace/api-server dev
```

**النافذة 2 — واجهة الفوترة:**
```bash
PORT=19225 BASE_PATH=/ pnpm --filter @workspace/zatca-invoicing dev
```

**النافذة 3 — نقاط البيع:**
```bash
PORT=24730 BASE_PATH=/pos/ pnpm --filter @workspace/pos dev
```

ثم افتح المتصفح على:
- **الواجهة الرئيسية:** http://localhost:19225
- **نقاط البيع:** http://localhost:24730/pos/
- **الـ API (تفقّد الصحة):** http://localhost:8080/api/healthz

### خطوة 6 — بيانات الدخول الافتراضية

أول مرة تشغّل فيها يجب أن تنشئ المستخدم الإداري الأول. ابحث في `lib/db/src/schema` عن سكربت seed أو افتح `psql` وأنشئ صفّاً يدوياً، أو سجّل من خلال صفحة **التسجيل العام** (`/register`) ثم وافق عليه من حساب SuperAdmin.

---

## 5) النشر على سيرفر سحابي (Cloud / VPS)

سأشرح الطريقة الأكثر مرونة: **VPS بنظام Ubuntu** (يصلح لـ DigitalOcean, Hetzner, AWS EC2, Linode, Contabo... إلخ).

### المتطلبات على السيرفر

- Ubuntu 22.04+ (أو 24.04)
- ذاكرة RAM 2GB أو أكثر (يفضّل 4GB لراحة الـ build)
- وصول `sudo`
- اسم نطاق (Domain) مع DNS موجّه إلى عنوان IP السيرفر

### خطوة 1 — تجهيز السيرفر

اتصل بالسيرفر عبر SSH:
```bash
ssh root@عنوان-IP-السيرفر
```

ثبّت التبعيات الأساسية:
```bash
# تحديث النظام
apt update && apt upgrade -y

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# pnpm
npm install -g pnpm

# PostgreSQL
apt install -y postgresql postgresql-contrib

# Nginx (للـ Reverse Proxy)
apt install -y nginx

# OpenSSL وأدوات أخرى
apt install -y openssl git ufw

# pm2 (لإدارة العمليات وإعادة تشغيلها تلقائياً)
npm install -g pm2
```

### خطوة 2 — تجهيز الـ Firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

### خطوة 3 — إنشاء قاعدة البيانات

```bash
sudo -u postgres psql
CREATE DATABASE zatca_invoicing;
CREATE USER zatca_user WITH ENCRYPTED PASSWORD 'كلمة-سر-قوية-جداً';
GRANT ALL PRIVILEGES ON DATABASE zatca_invoicing TO zatca_user;
\c zatca_invoicing
GRANT ALL ON SCHEMA public TO zatca_user;
\q
```

### خطوة 4 — تنزيل المشروع

```bash
# إنشاء مستخدم خاص بالتطبيق (أمان أفضل)
adduser --disabled-password --gecos "" zatca
su - zatca

# تنزيل المشروع
git clone <عنوان-المستودع> ~/app
cd ~/app

# تثبيت التبعيات
pnpm install

# إعداد المتغيّرات
cat > .env <<'EOF'
DATABASE_URL=postgresql://zatca_user:كلمة-سر-قوية-جداً@localhost:5432/zatca_invoicing
SESSION_SECRET=ضع-قيمة-عشوائية-32-حرف-أو-أكثر
NODE_ENV=production
PORT=8080
# … باقي المتغيّرات الاختيارية كما في القسم المحلي
EOF
chmod 600 .env

# إنشاء الجداول
cd lib/db && pnpm push --force && cd ../..

# بناء كل التطبيقات
pnpm -r run build
```

### خطوة 5 — تشغيل التطبيقات بـ PM2

أنشئ ملف `~/app/ecosystem.config.cjs`:
```javascript
module.exports = {
  apps: [
    {
      name: 'api-server',
      cwd: '/home/zatca/app',
      script: 'artifacts/api-server/dist/index.mjs',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '8080',
      },
      max_memory_restart: '1G',
    },
  ],
};
```

> ملاحظة: التطبيقات الأمامية (zatca-invoicing و pos) عبارة عن ملفات ساكنة (`dist/public`) سيخدمها Nginx مباشرة، فلا داعي لتشغيلها بـ PM2.

شغّل:
```bash
pm2 start ecosystem.config.cjs
pm2 save
exit                          # ارجع إلى root
pm2 startup systemd -u zatca --hp /home/zatca   # نسخ الأمر الذي يطبعه ونفّذه
```

### خطوة 6 — إعداد Nginx كـ Reverse Proxy

أنشئ `/etc/nginx/sites-available/zatca`:

```nginx
server {
    listen 80;
    server_name your-domain.com www.your-domain.com;

    # نقاط البيع (POS)
    location /pos/ {
        alias /home/zatca/app/artifacts/pos/dist/public/;
        try_files $uri $uri/ /pos/index.html;
    }

    # الـ API
    location /api/ {
        proxy_pass http://127.0.0.1:8080/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }

    # واجهة الفوترة الرئيسية (الجذر)
    location / {
        root /home/zatca/app/artifacts/zatca-invoicing/dist/public;
        try_files $uri $uri/ /index.html;
    }

    # حدّ أعلى لرفع الملفات (للشعارات والمرفقات)
    client_max_body_size 20M;
}
```

فعّل الموقع:
```bash
ln -s /etc/nginx/sites-available/zatca /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t                      # اختبار الإعداد
systemctl reload nginx
```

### خطوة 7 — شهادة SSL مجانية (Let's Encrypt)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com -d www.your-domain.com
# سيُحدِّث Certbot ملفّ Nginx تلقائياً ويضيف HTTPS
```

التجديد التلقائي يعمل افتراضياً (cron يومي). للتأكد:
```bash
certbot renew --dry-run
```

### خطوة 8 — التحقق

افتح المتصفح على:
- `https://your-domain.com` → نظام الفوترة
- `https://your-domain.com/pos/` → نقاط البيع
- `https://your-domain.com/api/healthz` → يجب أن يرجّع `{"status":"ok"}`

---

## 6) صيانة وتشغيل يومي على السيرفر السحابي

| المهمة | الأمر |
|---|---|
| متابعة سجلّات الـ API | `pm2 logs api-server` |
| إعادة تشغيل الـ API | `pm2 restart api-server` |
| متابعة Nginx | `tail -f /var/log/nginx/error.log` |
| نسخ احتياطي للقاعدة | `pg_dump -U zatca_user zatca_invoicing > backup_$(date +%F).sql` |
| استعادة من نسخة | `psql -U zatca_user zatca_invoicing < backup_xxx.sql` |
| تحديث المشروع من Git | `cd ~/app && git pull && pnpm install && pnpm -r run build && pm2 restart api-server` |
| تطبيق تغييرات المخطط | `cd ~/app/lib/db && pnpm push --force && cd ../.. && pm2 restart api-server` |

---

## 7) قائمة التحقق قبل الإطلاق

- [ ] `SESSION_SECRET` قيمة عشوائية فريدة (وليست القيمة الافتراضية)
- [ ] كلمة سر قاعدة البيانات قوية وغير مستعملة في أي مكان آخر
- [ ] `pg_hba.conf` لا يسمح بدخول خارجي للقاعدة (`localhost` فقط)
- [ ] `.env` صلاحياته `600` (قراءة لمالكه فقط)
- [ ] `ufw` مُفعَّل ولا يفتح إلا 22, 80, 443
- [ ] شهادة SSL مفعّلة (HTTPS)
- [ ] نسخة احتياطية مجدوَلة يومياً (cron + `pg_dump`)
- [ ] `pm2 startup` نُفِّذ ليبدأ التطبيق تلقائياً عند إعادة التشغيل
- [ ] إذا ستستعمل ZATCA في الإنتاج: ضع `SPL_API_KEY` الحقيقي
- [ ] إذا ستستعمل البريد: تأكد من إعدادات SMTP وأنّ المنفذ 587 مفتوح للخروج

---

## 8) في حال واجهتك مشكلة

| المشكلة | الحل |
|---|---|
| `ECONNREFUSED 5432` | PostgreSQL متوقّف → `systemctl start postgresql` |
| الواجهة بيضاء | افتح Console المتصفّح (F12) وانظر للأخطاء، تأكد من أن `BASE_PATH` صحيح |
| `502 Bad Gateway` من Nginx | الـ API لا يعمل → `pm2 logs api-server` |
| البناء ينهار بسبب الذاكرة | تم رفع ذاكرة Node إلى 4GB في `package.json`، إذا استمرّت الزيادة فعّل swap على السيرفر |
| `DATABASE_URL is required` | لم يُحمَّل ملف `.env` → استعمل `dotenv -e .env -- pnpm ...` أو صدّر يدوياً |

---

## 9) خلاصة الفروقات بين Replit والسيرفر السحابي

| | Replit | VPS (Cloud) |
|---|---|---|
| التركيب | تلقائي عبر `pnpm install` | يدوي خطوة بخطوة |
| قاعدة البيانات | متوفّرة جاهزة في `DATABASE_URL` | تنشئها أنت |
| المتغيّرات السريّة | عبر لوحة Secrets | في `.env` أو متغيّرات النظام |
| الـ Build | تلقائي عند الـ Publish | `pnpm -r run build` يدوياً |
| الـ Reverse Proxy | يديره Replit | تنشره أنت بـ Nginx |
| HTTPS | تلقائي | Let's Encrypt يدوياً |
| إعادة التشغيل | تلقائية بعد كل تغيير | عبر `pm2 restart` |
| التكلفة | اشتراك Replit | تكلفة الـ VPS فقط |

---

تم إعداد هذا الدليل ليطابق الإعدادات الحالية لمشروعك. لو احتجت أي مساعدة في خطوة محدّدة من خطوات النشر السحابي، أخبرني وسأرشدك.
