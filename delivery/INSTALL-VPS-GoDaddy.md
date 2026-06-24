# دليل تركيب نظام زاكود ERP (ZATCA) على سيرفر VPS (GoDaddy)

هذا الدليل يشرح تركيب النظام بالكامل (الواجهة + الـ API + قاعدة البيانات) على سيرفر
GoDaddy VPS يعمل بنظام **Ubuntu 22.04 / 24.04 LTS**. كل الأوامر تُنفَّذ عبر SSH كمستخدم
لديه صلاحية `sudo`.

---

## 1) محتويات الحزمة

| الملف | الوصف |
|-------|-------|
| `zatca-erp-source.tar.gz` | **السورس كود الكامل** لكل المشروع (monorepo): الـ API، الواجهة، نقاط البيع، **وسورس برنامج الويندوز (Tauri/Rust) داخل `artifacts/pos-desktop/`**، بالإضافة إلى ملف بناء الويندوز عبر GitHub Actions (`.github/workflows/pos-desktop-build.yml`). |
| `database-full.sql.gz` | **نسخة كاملة من قاعدة البيانات** (257 جدول مع كل البيانات) بصيغة pg_dump مضغوطة. |
| `INSTALL-VPS-GoDaddy.md` | هذا الدليل. |

> ملاحظة: الأرشيف **لا يحتوي** على `node_modules` (تُثبَّت بأمر `pnpm install`) ولا على أي
> ملفات أسرار `.env` (تُنشأ يدوياً في الخطوة 6) — هذا مقصود للأمان وحجم أصغر.

---

## 2) متطلبات السيرفر (الحد الأدنى الموصى به)

- نظام التشغيل: **Ubuntu 22.04 أو 24.04 LTS** (64-bit).
- المعالج/الذاكرة: **2 vCPU / 4 GB RAM** كحد أدنى (يُفضّل 4 vCPU / 8 GB لبناء الواجهة بسلاسة).
- مساحة قرص: 20 GB أو أكثر.
- البرامج: Node.js 20، pnpm 9، PostgreSQL 16، Nginx، Git.
- نطاق (دومين) موجّه إلى IP السيرفر إن أردت شهادة SSL.

---

## 3) تجهيز السيرفر

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential nginx ufw

# فتح المنافذ الأساسية
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

---

## 4) تثبيت Node.js 20 + pnpm

```bash
# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# pnpm + pm2 (مدير العمليات)
sudo npm install -g pnpm@9 pm2

node -v   # يجب أن يكون 20.x
pnpm -v   # 9.x
```

---

## 5) تثبيت PostgreSQL 16

> النسخة الاحتياطية أُخذت من PostgreSQL 16، لذا استخدم **PostgreSQL 16** لتجنّب مشاكل الاسترجاع.

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt update
sudo apt install -y postgresql-16

sudo systemctl enable --now postgresql
```

إنشاء قاعدة البيانات والمستخدم:

```bash
sudo -u postgres psql <<'SQL'
CREATE USER zacod WITH PASSWORD 'ضع_كلمة_سر_قوية_هنا';
CREATE DATABASE zacoderp OWNER zacod;
GRANT ALL PRIVILEGES ON DATABASE zacoderp TO zacod;
SQL
```

---

## 6) رفع وفك السورس كود

ارفع الملفات إلى السيرفر (من جهازك):

```bash
scp zatca-erp-source.tar.gz database-full.sql.gz user@SERVER_IP:/home/user/
```

ثم على السيرفر:

```bash
sudo mkdir -p /var/www/zacoderp
sudo chown -R $USER:$USER /var/www/zacoderp
tar xzf ~/zatca-erp-source.tar.gz -C /var/www/zacoderp
cd /var/www/zacoderp
```

---

## 7) استرجاع قاعدة البيانات

```bash
gunzip -c ~/database-full.sql.gz | psql "postgresql://zacod:كلمة_السر@localhost:5432/zacoderp"
```

> النسخة تحتوي على `DROP ... IF EXISTS` فتُعيد إنشاء كل الجداول والبيانات على قاعدة فارغة.
> إن ظهر تحذير بخصوص `\restrict` فهو غير مؤثر (ميزة في pg_dump 16).

---

## 8) متغيرات البيئة `.env`

أنشئ ملف `.env` في جذر المشروع `/var/www/zacoderp/.env`:

```bash
cat > /var/www/zacoderp/.env <<'ENV'
# ── مطلوب ──
DATABASE_URL=postgresql://zacod:كلمة_السر@localhost:5432/zacoderp
SESSION_SECRET=ضع_هنا_ناتج_openssl_rand_hex_48
NODE_ENV=production
PORT=8080

# ── التخزين السحابي (مرفقات الفواتير، الشعار، صور الأصناف، النسخ) ──
# اتركها فارغة لتعطيل المرفقات، أو وجّهها إلى بكت S3 متوافق (راجع القسم 12).
DEFAULT_OBJECT_STORAGE_BUCKET_ID=
PRIVATE_OBJECT_DIR=
PUBLIC_OBJECT_SEARCH_PATHS=

# ── اختياري: ميزات الذكاء الاصطناعي (للنظام بدائل قاعدية تعمل بدونها) ──
AI_INTEGRATIONS_OPENAI_API_KEY=
AI_INTEGRATIONS_OPENAI_BASE_URL=
GEMINI_API_KEY=

# ── اختياري: البريد (SMTP) لإرسال الإشعارات ──
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# ── اختياري: خرائط / كابتشا / العنوان الوطني السعودي ──
MAPBOX_ACCESS_TOKEN=
TURNSTILE_SECRET_KEY=
SPL_API_KEY=

LOG_LEVEL=info
ENV
```

توليد `SESSION_SECRET`:

```bash
openssl rand -hex 48
```

> الواجهة قد تحتاج متغيرات تبدأ بـ `VITE_` (مثل `VITE_MAPBOX_ACCESS_TOKEN`, `VITE_TURNSTILE_SITE_KEY`)
> **وقت البناء** — أضِفها قبل تنفيذ خطوة البناء إن استخدمت الخرائط/الكابتشا.

---

## 9) تثبيت الحزم والبناء

```bash
cd /var/www/zacoderp
pnpm install --frozen-lockfile

# بناء المكتبات المشتركة + توليد عقد الـ API
pnpm run typecheck:libs
pnpm --filter @workspace/api-spec run codegen || true

# بناء الـ API
pnpm --filter @workspace/api-server run build

# بناء الواجهة الرئيسية (المسار الجذر "/")
pnpm --filter @workspace/zatca-invoicing run build

# بناء واجهة نقاط البيع (المسار "/pos/")
BASE_PATH=/pos/ pnpm --filter @workspace/pos run build
```

ناتج بناء كل واجهة يكون في مجلد `dist/` داخل مجلد الـ artifact المعني.

---

## 10) تشغيل الـ API بـ PM2

الـ API يستمع على المنفذ المحدد في `PORT` (هنا 8080) ويخدم المسارات `/api`، `/sitemap.xml`،
`/robots.txt`، `/ai-overview.json`.

```bash
cd /var/www/zacoderp
pm2 start "node --enable-source-maps artifacts/api-server/dist/index.mjs" \
  --name zacod-api \
  --cwd /var/www/zacoderp \
  --env production

pm2 save
pm2 startup    # نفّذ السطر الذي يطبعه لتشغيل PM2 تلقائياً عند الإقلاع
```

تأكد من العمل:

```bash
curl http://localhost:8080/api/healthz
```

---

## 11) Nginx — توجيه المسارات (Reverse Proxy)

النظام مبني على **توجيه بالمسار**: الواجهة الرئيسية على `/`، نقاط البيع على `/pos/`،
والـ API على `/api`. ننسخ نفس المنطق في Nginx.

```bash
sudo tee /etc/nginx/sites-available/zacoderp <<'NGINX'
server {
    listen 80;
    server_name your-domain.com;     # ضع نطاقك أو IP السيرفر
    client_max_body_size 25m;

    # الـ API + المسارات الخاصة بالخادم
    location /api/            { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }
    location = /sitemap.xml   { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }
    location = /robots.txt    { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }
    location = /ai-overview.json { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }

    # واجهة نقاط البيع (ملفات ثابتة)
    location /pos/ {
        alias /var/www/zacoderp/artifacts/pos/dist/;
        try_files $uri $uri/ /pos/index.html;
    }

    # الواجهة الرئيسية (ملفات ثابتة) — يجب أن تبقى آخر قاعدة
    location / {
        root /var/www/zacoderp/artifacts/zatca-invoicing/dist;
        try_files $uri $uri/ /index.html;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/zacoderp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

افتح المتصفح على `http://your-domain.com` ويجب أن تظهر الواجهة.

---

## 12) شهادة SSL (HTTPS) مجاناً

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

certbot يضبط التجديد التلقائي.

---

## 13) ⚠️ ملاحظة مهمة: التخزين السحابي (Object Storage)

ميزات **رفع الشعار، مرفقات الفواتير، صور الأصناف، والنسخ الاحتياطي للملفات** كانت تستخدم
خدمة التخزين الخاصة بـ Replit (App Storage عبر Google Cloud Storage). هذه الخدمة **لا تعمل
تلقائياً** على سيرفر GoDaddy.

أمامك خياران:
1. **تعطيلها مؤقتاً**: اترك متغيرات `DEFAULT_OBJECT_STORAGE_BUCKET_ID` / `PRIVATE_OBJECT_DIR`
   / `PUBLIC_OBJECT_SEARCH_PATHS` فارغة — باقي النظام (الفوترة، المحاسبة، المخزون، ZATCA)
   يعمل بشكل كامل، فقط أزرار رفع الملفات تكون معطّلة.
2. **ربطها ببكت S3 متوافق** (AWS S3 / Cloudflare R2): يتطلب تعديلاً بسيطاً في
   `artifacts/api-server/src/lib/objectStorage.ts` لاستخدام SDK الخاص بـ S3 بدل عميل
   Google Cloud + Replit connectors. أخبرني إن رغبت بتنفيذ هذا التعديل.

بقية المتغيرات (الذكاء الاصطناعي، SMTP، الخرائط، الكابتشا) **اختيارية** — النظام يعمل بدونها
مع بدائل قاعدية أو بتعطيل الميزة المعنية.

---

## 14) بناء برنامج الويندوز (POS Desktop)

سورس برنامج الويندوز موجود في `artifacts/pos-desktop/` (Tauri + React + Rust + SQLite).
**لا يُبنى على سيرفر لينكس** — يُبنى على جهاز ويندوز أو عبر GitHub Actions:

**الطريقة الموصى بها (GitHub Actions):**
1. ارفع المشروع إلى مستودع GitHub خاص بك.
2. ادفع وسماً (tag) بالشكل `pos-desktop-v<الإصدار>` — مثل `pos-desktop-v1.0.0`.
3. سيقوم ملف `.github/workflows/pos-desktop-build.yml` ببناء ملف **MSI** تلقائياً ونشره
   كـ Draft Release، ثم تنشره يدوياً من صفحة Releases.

**البناء المحلي على ويندوز (بديل):**
```powershell
# على جهاز ويندوز فيه Node 20 + pnpm + Rust (rustup)
pnpm install
pnpm --filter @workspace/pos-desktop run tauri build
# الناتج: artifacts/pos-desktop/src-tauri/target/release/bundle/msi/*.msi
```

> برنامج الويندوز يعمل بنمطين: **سحابي** (يتصل بالـ API على سيرفرك) و**مستقل** (offline
> بقاعدة SQLite محلية). راجع التفاصيل داخل كود `artifacts/pos-desktop/`.

---

## 15) التحديثات المستقبلية

```bash
cd /var/www/zacoderp
# انسخ السورس الجديد فوق القديم ثم:
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/zatca-invoicing run build
BASE_PATH=/pos/ pnpm --filter @workspace/pos run build
pm2 restart zacod-api
sudo systemctl reload nginx
```

لتحديث هيكل قاعدة البيانات بعد تغييرات السكيمة:
```bash
pnpm --filter @workspace/db run db:push   # راجع سكربتات مجلد lib/db
```

---

## 16) استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| الواجهة بيضاء / 404 | تأكد أن `try_files ... /index.html` موجودة في Nginx وأن مجلد `dist` مبني. |
| `502 Bad Gateway` على `/api` | الـ API متوقف — `pm2 logs zacod-api` لمعرفة السبب. |
| خطأ اتصال قاعدة البيانات | تحقق من `DATABASE_URL` وأن PostgreSQL يعمل: `sudo systemctl status postgresql`. |
| فشل البناء بنقص ذاكرة | زِد RAM أو أضف swap؛ البناء يستخدم `--max-old-space-size=2048`. |
| المرفقات/الشعار لا تُرفع | راجع القسم 13 (التخزين السحابي). |

---

### دعم
الكود موثّق داخلياً في `replit.md` وملفات `.agents/memory/` (غير مضمّنة في هذه الحزمة لكونها
ملاحظات تطوير داخلية). أخبرني إن رغبت بـ: (1) ربط التخزين بـ S3، (2) سكربت تركيب آلي واحد،
أو (3) إعداد systemd بدل PM2.
