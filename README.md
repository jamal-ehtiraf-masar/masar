# مسار Ehtiraf — خادم سحابي (Render + Supabase)

خادم Node خالص (بلا أي تبعيات npm) للعبة «مسار Ehtiraf».

- التخزين الدائم: **Supabase Storage** (حاويتا `data` و`uploads`) — مجاني تماماً.
- بدون مفاتيح Supabase: يعمل الوضع المحلي بالملفات كما كان (توافق تام).
- الواجهة (Flutter web build) في `build/web`.

## التشغيل
```
npm start
```

## متغيرات البيئة
| المتغير | الوظيفة |
|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | تفعيل التخزين السحابي (توضع في لوحة Render فقط) |
| `GOOGLE_CLIENT_IDS`, `FB_APP_ID`, `FB_APP_SECRET`, `FB_CLIENT_TOKEN` | تسجيل الدخول الاجتماعي |
| `ADMIN_NAME` | اسم حساب المالك |
| `PORT` | المنفذ (Render يضبطه تلقائياً) |
