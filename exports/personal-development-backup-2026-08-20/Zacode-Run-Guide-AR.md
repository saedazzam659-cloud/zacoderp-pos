# دليل تشغيل نسخة Zacode المحفوظة

هذا الدليل يشرح تشغيل **نسخة السورس** و**نسخة قاعدة البيانات** اللتين تم تنزيلهما من بيئة التطوير.

> **تنبيه أمني:** لا ترفع ملف قاعدة البيانات أو ملفات الأسرار إلى GitHub أو أي خدمة عامة. تحتوي قاعدة البيانات على بيانات تشغيل وحسابات وبيانات حساسة.

## الملفات المطلوبة

ضع الملفات في مكان آمن على جهازك:

- `zacode-source-development.tar.gz` — سورس المشروع.
- `zacode-database-development-full.sql.gz` — قاعدة بيانات تطوير كاملة.

## 1) المتطلبات

على Linux أو WSL (Ubuntu/Debian مثلًا) ثبّت:

- Node.js 22 أو أحدث.
- Corepack وpnpm.
- PostgreSQL 16 أو إصدار متوافق، مع أدوات `psql` و`pg_dump`.
- `tar` و`gzip`.

للتحقق:

```bash
node --version
corepack --version
psql --version
```

## 2) فك السورس وتثبيت الحزم

```bash
tar -xzf zacode-source-development.tar.gz
cd zacode-source-development

corepack enable
pnpm install --frozen-lockfile
```

لا يحتوي الأرشيف على `node_modules` عمدًا، لذلك يجب تنفيذ `pnpm install` بعد فك السورس.

## 3) إعداد قاعدة بيانات PostgreSQL

أنشئ قاعدة بيانات ومستخدمًا محليًا، ثم عيّن رابط الاتصال في متغير البيئة:

```bash
createdb zacode_dev
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/zacode_dev'
```

استعد النسخة **فقط إلى قاعدة فارغة**:

```bash
gunzip -c /PATH/TO/zacode-database-development-full.sql.gz | psql "$DATABASE_URL"
```

إذا كانت القاعدة تحتوي على بيانات، خذ نسخة احتياطية أولًا ولا تستعد الملف فوقها مباشرة.

## 4) إعداد متغيرات البيئة

أنشئ ملفًا محليًا آمنًا خارج Git أو عيّن المتغيرات في جلسة الطرفية. الحد الأدنى لتشغيل الخادم:

```bash
export NODE_ENV=development
export PORT=8080
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/zacode_dev'
export SESSION_SECRET="$(openssl rand -hex 32)"
export PUBLIC_BASE_URL='http://localhost:5173'
```

- لا تنسخ قيمة `SESSION_SECRET` من بيئة أخرى؛ أنشئ قيمة قوية جديدة لكل بيئة.
- ميزات البريد والرسائل والذكاء الاصطناعي والتخزين قد تحتاج متغيرات إضافية خاصة بها. اتركها غير مضبوطة إن لم تكن ستستخدم تلك الميزات، أو أضفها إلى مدير الأسرار في بيئتك.

## 5) تشغيل Backend

من جذر المشروع، في نافذة طرفية أولى:

```bash
pnpm --filter @workspace/api-server run dev
```

الأمر يبني الخادم ثم يشغله. افتراضيًا سيستمع على المنفذ `8080` إذا لم تغيّر `PORT`.

## 6) تشغيل Frontend

في نافذة طرفية ثانية، من جذر المشروع:

```bash
pnpm --filter @workspace/zatca-invoicing run dev
```

افتح العنوان الذي يظهره Vite، وعادةً:

```text
http://localhost:5173
```

## 7) فحص وبناء الإنتاج

قبل النشر أو بعد أي تعديل:

```bash
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/zatca-invoicing run typecheck
pnpm --filter @workspace/zatca-invoicing run build
```

مخرجات البناء:

- Backend: `artifacts/api-server/dist/index.mjs`
- Frontend: `artifacts/zatca-invoicing/dist/public/`

## 8) تشغيل نسخة Production يدويًا

بعد بناء Backend:

```bash
export NODE_ENV=production
export PORT=8080
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/zacode_prod'
export SESSION_SECRET='ضع-قيمة-قوية-ومحفوظة-بأمان'
export PUBLIC_BASE_URL='https://your-domain.example'

pnpm --filter @workspace/api-server run start
```

قدّم ملفات Frontend المبنية من `artifacts/zatca-invoicing/dist/public/` بواسطة Nginx أو Caddy أو خدمة استضافة ثابتة، مع توجيه طلبات `/api` إلى Backend.

## 9) تجهيز وكيل خارجي من المنصة

للتسطيب على سيرفر وكيل من شاشة **الحزمة الخارجية** استخدم الملفات الخاصة بالوكيل، وليس ملف النسخة الشخصية:

1. `zacode-backend-dev.tar.gz` في حقل **Backend**.
2. `zacode-frontend-dev.tar.gz` في حقل **Frontend**.
3. `zacode-database-dev-agent-safe.sql.gz` في حقل **قاعدة البيانات**.

ثم اختر:

- نوع النسخة: **Full**.
- مصدر الحزمة: **خارجي**.

ملف `agent-safe` يستثني بيانات إدارة الوكلاء وجلسات وأكواد حماية Super Admin، ليتم إنشاؤها بشكل صحيح على الخادم المستهدف.

### التحديثات بعد التسطيب

الحزم الخارجية لا تُستبدل تلقائيًا عند نشر تحديث مركزي. لتحديث وكيل خارجي:

1. جهّز وارفع حزم Backend وFrontend الجديدة من شاشة الحزمة الخارجية.
2. وافق على التحديث من لوحة Super Admin المحلية على الوكيل.

## 10) أوامر مفيدة

```bash
# اختبار سياسة Backend
pnpm --filter @workspace/api-server exec node --import tsx --test __tests__/agent-local-superadmin.test.ts

# اختبارات Backend العامة
pnpm --filter @workspace/api-server test

# بناء كل الحزم الموجودة في مساحة العمل
pnpm run build
```

## مشاكل شائعة

| المشكلة | الإجراء |
| --- | --- |
| `Use pnpm instead` | استخدم `pnpm` وليس npm أو yarn. |
| فشل اتصال قاعدة البيانات | راجع `DATABASE_URL` وتأكد أن PostgreSQL يعمل وأن قاعدة البيانات استُعيدت. |
| فشل فك تشفير بيانات أو جلسات بعد نقل القاعدة | استخدم `SESSION_SECRET` ثابتًا للبيئة نفسها، أو أعد ضبط بيانات الاعتماد المشفرة في البيئة الجديدة. |
| واجهة Vite تعمل لكن طلبات API تفشل | شغّل Backend على المنفذ المحدد، واضبط reverse proxy أو إعداد الاتصال حسب بيئتك. |
| فشل استعادة قاعدة البيانات | تأكد أنها قاعدة PostgreSQL فارغة وأن `psql` يستخدم نفس `DATABASE_URL`. |

## ما لا يوجد داخل أرشيف السورس

- `node_modules` وملفات الكاش ونتائج البناء: تُعاد عبر `pnpm install` و`pnpm run build`.
- ملفات `.env` والأسرار: أُزيلت عمدًا لحماية مفاتيح الاتصال والبريد والخدمات.
- سجل Git: احتفظ بمستودع Git منفصل إذا احتجت تاريخ التعديلات والفروع.