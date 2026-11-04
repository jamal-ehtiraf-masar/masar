const http = require('http');
const https = require('https');
// طبقة التخزين الدائم — Supabase Storage في السحابة، أو الملفات المحلية (توافق تام).
const store = require('./supa_store');
let remoteManifestCache = { t: 0, data: null };
const FOLDER_SLUGS = {
  'التشريع المدرسي': 'tachrii_madrasii',
  'التنشيط التربوي': 'tanshit_tarbawi',
  'خطاطات ذهنية': 'khatatat_dhihniya',
  'دورات تكوينية': 'dawrat_takwiniya',
  'ديداكتيك الرياضيات': 'didactique_maths',
  'ديداكتيك اللغة الأمازيغية': 'didactique_amazigh',
  'ديداكتيك اللغة العربية': 'didactique_arabe',
  'ديداكتيك اللغة الفرنسية': 'didactique_francais',
  'ديداكتيك النشاط العلمي': 'didactique_science',
  'علوم التربية': 'ouloum_tarbiya',
  'مؤسسات الريادة': 'mouassasat_riyada',
  'مراسلات ومذكرات': 'murasilat_mudhakkirat',
  'مشروع المؤسسة المندمج': 'mashroua_muassasa',
  'التعليم الثانوي بسلكيه': 'taalim_thaanawi',
  'بنك الاسئلة': 'bank_asila',
};
// إصدارات ملفات المراجعة على GitHub Releases — تُجرَّب بالترتيب.
// الأول هو النسخة النهائية (مجلد «ملفات التطبيق نهائي»)، والثاني إصدار قديم
// يخدم الملفات غير الموجودة في النسخة النهائية (مثل بنك الأسئلة).
const RELEASE_BASES = [
  'https://github.com/fahdzoubayr-creator/masar/releases/download/review-files-v3/',
  'https://github.com/fahdzoubayr-creator/masar/releases/download/review-files-v1/',
];
const RELEASE_BASE = RELEASE_BASES[0];
function releaseUrlsFor(pdfPath) {
  const m = String(pdfPath).replace(/^\/+/, '').match(/^assets(?:\/assets)?\/review_files\/([^/]+)\/(.+)$/);
  if (!m) return null;
  const slug = FOLDER_SLUGS[m[1]];
  if (!slug) return null;
  return RELEASE_BASES.map((b) => b + slug + '__' + m[2]);
}
function releaseUrlFor(pdfPath) {
  const list = releaseUrlsFor(pdfPath);
  return list ? list[0] : null;
}
const PNG_ZOOM = 2.5;
const pageJobs = new Map();
function toCloudFiles(entries, pagesBase) {
  return entries
    .filter((e) => e && typeof e.pdf === 'string')
    .map((e) => ({
      path: e.pdf,
      name: e.name || e.pdf,
      url: releaseUrlFor(e.pdf) || pagesBase + e.pdf.replace(/^\/+/, '').replace(/^assets\//, 'assets/assets/'),
    }));
}
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===== .env — أسرار محلية، الملف مستثنى من git =====
// يقرأ server.js القيم التالية بالترتيب: متغير البيئة الحقيقي ثم .env
// (قيمة المتغير البيئة الحقيقية تتقدم دائمًا على ملف .env).
(function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (val && !process.env[key]) process.env[key] = val;
    }
  } catch {
    // لا .env — تُستخدم متغيرات البيئة فقط.
  }
})();

const ROOT = path.join(__dirname, 'build', 'web');
const PORT = Number(process.env.PORT) || 8123;
// بنوك أسئلة اللعبة/الكويز تعيش خارج التطبيق (مجلد «أسئلة المحاور» على سطح المكتب).
// يمكن تجاوزها بمتغير البيئة EXTERNAL_QUESTION_BANKS_DIR.
const EXTERNAL_QUESTION_BANKS_DIR =
  process.env.EXTERNAL_QUESTION_BANKS_DIR ||
  path.join('C:', 'Users', 'JAMAL', 'Desktop', 'أسئلة المحاور', 'بنك_اللعبة');

/**
 * مزوّدو توليد الأسئلة — بالترتيب. كلهم OpenAI-compatible،
 * والمفتاح يأتي من متغير البيئة ثم .env. المزوّد بلا مفتاح يُتجاهل.
 * عند 429 ينتقل quiz_from_pdf.py تلقائيًا إلى المزوّد التالي.
 */
const LLM_PROVIDERS = [
  { id: 'groq', keyEnv: 'GROQ_API_KEY' },
  { id: 'gemini', keyEnv: 'GEMINI_API_KEY' },
  { id: 'github', keyEnv: 'GITHUB_TOKEN' },
];

/** معرّفات المزوّدين الذين توفّر لهم مفاتيح. */
const activeProviders = () =>
  LLM_PROVIDERS.filter((p) => (process.env[p.keyEnv] || '').trim()).map(
    (p) => p.id
  );

/** خطأ مفهوم عندما لا يوجد أي مفتاح. */
const noProviderError = () => ({
  error: 'NO_LLM_KEY',
  detail: 'set at least one of: ' +
    LLM_PROVIDERS.map((p) => p.keyEnv).join(', ') +
    ' (in .env or the environment)',
  providers: activeProviders(),
});

// ===== الملفات المرفوعة (صور/مستندات) — خارج مجلد البناء كي لا تُمسح عند إعادة البناء =====
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/** الحد الأقصى لحجم الملف المرفق (20 ميغابايت). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** الامتدادات المسموحة للمرفقات — صور ومستندات فقط (بلا فيديو). */
const ALLOWED_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'jpe', 'gif', 'webp', 'bmp'];
const ALLOWED_DOC_EXTS = [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'rtf',
];
const ALLOWED_ATTACHMENT_EXTS = [...ALLOWED_IMAGE_EXTS, ...ALLOWED_DOC_EXTS];

// ===== سجل القاعات الدائم (يُحفظ على القرص ويُحمَّل عند الإقلاع) =====
const DATA_FILE = path.join(__dirname, 'rooms_data.json');

/** مدة صلاحية القاعة غير المستخدمة: تُحذف تلقائياً بعد 30 يوماً بلا دخول. */
const ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.rtf': 'application/rtf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ===== مخزن حسابات لعبة جواهر الكفاءة — مزامنة التقدّم بين الأجهزة =====
// البيانات في masar_social.json بجانب الخادم (مُضافة إلى .gitignore).
// الـ PIN يُخزَّن مُجزّأً بملح عشوائي، ولا تُقبل أي بيانات غير محدّدة الحقول.
const SOCIAL_FILE = path.join(__dirname, 'masar_social.json');
function socialLoad() {
  if (store.enabled()) {
    return store.readJson('masar_social.json', null) || { accounts: {}, sessions: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(SOCIAL_FILE, 'utf8'));
  } catch (_) {
    return { accounts: {}, sessions: {} };
  }
}
function socialSave(db) {
  if (store.enabled()) {
    store.writeJson('masar_social.json', db);
    return;
  }
  try {
    fs.writeFileSync(SOCIAL_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(SOCIAL_FILE + '.tmp', SOCIAL_FILE);
  } catch (_) {}
}
function socialHash(pin, salt) {
  return crypto.createHash('sha256').update(salt + ':' + pin).digest('hex');
}

// ===== RBAC — أدوار المستخدمين (user | admin) =====
// الجديد دائمًا «user». ترقية إلى «admin» بطريقتين:
//   1) ADMIN_NAME في .env: قائمة أسماء مفصولة بفواصل تُرفع تلقائيًا عند الدخول/التسجيل.
//   2) يدويًا في masar_social.json: "role": "admin" داخل الحساب (بلا خطر —PIN يظل حارسه).
function socialRoleOf(nameKey, acc) {
  if (acc && acc.role === 'admin') return 'admin';
  const adminNames = String(process.env.ADMIN_NAME || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (adminNames.includes(String(nameKey || '').toLowerCase())) return 'admin';
  return 'user';
}

// ===== الأمان — جلسات موقّعة بلا IP + تحديد المعدل + سجل التدقيق =====
// (1) الجلسات غير مرتبطة بـIP إطلاقًا: الرمز (v2) توقيع HMAC-SHA256 على
//     حمولة {k: الحساب, exp: انتهاء} — لا حالة في الذاكرة/الملف، يعمل عبر
//     الجيوب والراوترات المتغيرة. التوقيع من SESSION_SECRET في .env.
// (2) العقد الدلالية (handlers) عديمة الحالة: كل طلب يقرأ الملف ويكتب ذرّياً
//     (tmp+rename) — آمنة للطلبات المتوازية من عناوين متعددة.
const SESSION_SECRET = String(
  process.env.SESSION_SECRET ||
    crypto
      .createHash('sha256')
      .update('masar-v2:' + String(process.env.ADMIN_PASS || ''))
      .digest('hex')
);
const SOCIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 يومًا — تُصحّح تلقائيًا بإعادة الدخول

// بوابة المالِك الصامتة: إن طابق الاسم المُرسَل في خانة «الاسم» بالتسجيل
// الرمز السرّي للمالِك (ADMIN_GATE_CODE في .env — لا يظهر في شيفرة التطبيق
// إطلاقًا) منحَت الخادم جلسة حساب الإدارة مباشرة: الاسم المُرسَل لا يُنشئ
// به حسابًا ولا يُسجَّل في سجل التدقيق (كتابة الرمز نفسه محظورة) — يُخزَّن
// المفتاح الرسمي لحساب الإدارة (ADMIN_NAME) بدلاً منه. الرمز شقيق لوحة
// ADMIN_PASS افتراضيًا (كلمة سر لوحة الويب) لصلاحية دورة مفاتيح واحدة.
const ADMIN_GATE_CODE = String(
  process.env.ADMIN_GATE_CODE || process.env.ADMIN_PASS || ''
).trim();
function adminGateOf(name) {
  if (!ADMIN_GATE_CODE) return false;
  // مقارنة زمنية ثابتة (timing-safe) عبر بصمات — بلا تسريب طول/محتوى.
  const a = crypto.createHash('sha256').update(String(name || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(ADMIN_GATE_CODE, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ===== التحقق من هويات المزوّدين (Google/Facebook) — التهيئة عبر .env =====
// GOOGLE_CLIENT_IDS: هويات عميل OAuth المسموح بها (Android + Web مفصولة بفواصل).
// FB_APP_ID / FB_APP_SECRET: من لوحة مطوّري Facebook (تستعمل لفحص التوكنات).
const GOOGLE_CLIENT_IDS = String(process.env.GOOGLE_CLIENT_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const FB_APP_ID = String(process.env.FB_APP_ID || '').trim();
const FB_APP_SECRET = String(process.env.FB_APP_SECRET || '').trim();

// التحقق من بطاقة Google (idToken) عبر نقطة tokeninfo الرسمية:
// يُعاد { ok, name, email } أو { ok: false, error }.
async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_IDS.length) {
    return { ok: false, error: 'التحقق عبر Google غير مهيأ على الخادم — راجع GOOGLE_CLIENT_IDS في .env' };
  }
  let info = null;
  try {
    const r = await fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(idToken || '')),
      { signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return { ok: false, error: 'بطاقة Google غير صالحة أو انتهت صلاحيتها' };
    info = await r.json();
  } catch (_) {
    return { ok: false, error: 'تعذّر التحقق مع Google — تحقق من اتصال الخادم بالإنترنت' };
  }
  // الجمهور (aud) يجب أن يكون بحدٍّ من هويات العميل المعلنة في .env.
  const aud = String(info.aud || '');
  if (!GOOGLE_CLIENT_IDS.includes(aud)) {
    return { ok: false, error: 'بطاقة Google لعميل غير معتمد (aud)' };
  }
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    return { ok: false, error: 'بريد Google غير مكتمل التحقق' };
  }
  return {
    ok: true,
    name: String(info.name || '').trim(),
    email: String(info.email || '').trim(),
    id: String(info.sub || aud),
  };
}

// التحقق من بطاقة Facebook (access token) عبر نقطة debug_token الرسمية:
// تتحقق من الصلاحية والربط بتطبيقنا، ثم يجلب الملف الشخصي من Graph API.
async function verifyFacebookToken(accessToken) {
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return { ok: false, error: 'التحقق عبر Facebook غير مهيأ على الخادم — راجع FB_APP_ID/FB_APP_SECRET في .env' };
  }
  const appToken = FB_APP_ID + '|' + FB_APP_SECRET;
  let dbg = null;
  try {
    const r = await fetch(
      'https://graph.facebook.com/debug_token?input_token=' + encodeURIComponent(String(accessToken || '')) +
        '&access_token=' + encodeURIComponent(appToken),
      { signal: AbortSignal.timeout(10000) }
    );
    dbg = await r.json();
  } catch (_) {
    return { ok: false, error: 'تعذّر التحقق مع Facebook — تحقق من اتصال الخادم بالإنترنت' };
  }
  const data = dbg && dbg.data ? dbg.data : null;
  if (!data || data.is_valid !== true) {
    return { ok: false, error: 'بطاقة Facebook غير صالحة أو انتهت صلاحيتها' };
  }
  if (String(data.app_id || '') !== FB_APP_ID) {
    return { ok: false, error: 'بطاقة Facebook لتطبيق آخر (app_id)' };
  }
  let me = null;
  try {
    const r2 = await fetch(
      'https://graph.facebook.com/me?fields=id,name,email&access_token=' + encodeURIComponent(String(accessToken || '')),
      { signal: AbortSignal.timeout(10000) }
    );
    me = await r2.json();
  } catch (_) {
    return { ok: false, error: 'تعذّر جلب بيانات الملف الشخصي من Facebook' };
  }
  if (!me || !me.name) return { ok: false, error: 'لم يرد اسم من Facebook — وافق على صلاحية الملف الشخصي' };
  return { ok: true, name: String(me.name).trim(), email: String(me.email || '').trim(), id: String(me.id) };
}

// تنفيذ بوابة المالِك: تُرجع ردًّا جاهزًا (200) عند المطابقة أو null للمتابعة.
function adminGateReply(res, req) {
  const db = socialLoad();
  const adminKey = String(process.env.ADMIN_NAME || '').trim().toLowerCase();
  if (!adminKey || !db.accounts[adminKey]) {
    db.accounts[adminKey] = {
      name: String(process.env.ADMIN_NAME || '').trim(),
      salt: '',
      pinHash: '',
      provisioned: true,
      createdAt: new Date().toISOString(),
      state: {},
    };
  }
  db.accounts[adminKey].role = 'admin';
  socialSave(db);
  auditLogin('admin-gate', adminKey, req, true);
  const token = socialIssueToken(adminKey, SOCIAL_TTL_MS);
  return json(res, 200, {
    ok: true,
    token: token,
    name: db.accounts[adminKey].name || process.env.ADMIN_NAME,
    role: 'admin',
  });
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// إصدار رمز جلسة موقّع (مثل JWT مصغّر) — الحساب + انتهاء فقط، بلا IP.
function socialIssueToken(nameKey, ttlMs) {
  const payload = b64url(
    JSON.stringify({ k: nameKey, n: crypto.randomBytes(6).toString('hex'), exp: Date.now() + (ttlMs || SOCIAL_TTL_MS) })
  );
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return 'v2.' + payload + '.' + sig;
}

// التحقق من الرموز الموقّعة + دعم الرموز القديمة (جدول sessions).
function socialTokenKey(token, db) {
  const t = String(token || '');
  if (t.startsWith('v2.')) {
    const parts = t.split('.');
    if (parts.length !== 3) return undefined;
    const expected = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(parts[1])
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const a = Buffer.from(parts[2]);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
    try {
      const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
      if (!payload || !payload.k || Date.now() > Number(payload.exp)) return undefined;
      return String(payload.k);
    } catch (_) {
      return undefined;
    }
  }
  return db && db.sessions ? db.sessions[t] : undefined;
}

// (3) تحديد المعدل حسب عنوان IP — نوافذ ثابتة في الذاكرة مع تنظيف دوري.
//     يحمي دخول/تسجيل/لوحة الإدارة من سحب القوة (brute force) دون عزير
//     المستخدمين المشروعين (النوافذ قصيرة وعالية السقف).
const rateBuckets = new Map(); // key "bucket|ip" -> {count, resetAt}
let rateJanitorAt = 0;
function rateLimit(req, bucket, opts) {
  const win = opts.windowMs || 60 * 1000;
  const max = opts.max || 15;
  const now = Date.now();
  if (now - rateJanitorAt > 5 * 60 * 1000) {
    rateJanitorAt = now;
    for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
  }
  const key = bucket + '|' + clientIpOf(req);
  const b = rateBuckets.get(key);
  if (!b || b.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + win });
    return null;
  }
  if (b.count >= max) {
    return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  }
  b.count++;
  return null;
}

function clientIpOf(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  if (xf) {
    const first = xf.split(',')[0].trim();
    if (first) return first;
  }
  const xr = String(req.headers['x-real-ip'] || '').trim();
  if (xr) return xr;
  const raw = (req.socket && req.socket.remoteAddress) || 'unknown';
  return raw.replace(/^::ffff:/i, '') || 'unknown';
}

// (4) سجل تدقيق الولوج: كل نجاح/فشل دخول يُدوَّن في ملف NDJSON بجانب
//     الخادم + آخر 20 محاولة تُحفظ في الحساب نفسه (لا تُعاقب تغيّر IP).
const AUDIT_LOGIN_FILE = path.join(__dirname, 'masar_login_audit.log');
function auditLogin(kind, accountKey, req, ok, extra) {
  try {
    const ip = clientIpOf(req);
    const ua = String((req.headers['user-agent'] || '').slice(0, 160));
    const rec = {
      at: new Date().toISOString(),
      kind,
      account: String(accountKey || '').slice(0, 64),
      ip,
      ua,
      ok: !!ok,
    };
    if (extra) rec.note = String(extra).slice(0, 120);
    fs.appendFileSync(AUDIT_LOGIN_FILE, JSON.stringify(rec) + '\n');
  } catch (_) {}
}

function auditPersist(db, accountKey, req, note) {
  const acc = db && db.accounts && db.accounts[accountKey];
  if (!acc) return;
  const list = Array.isArray(acc.loginAudit) ? acc.loginAudit : [];
  list.push({
    ip: clientIpOf(req),
    ua: String((req.headers['user-agent'] || '').slice(0, 120)),
    at: new Date().toISOString(),
    note: String(note || '').slice(0, 80),
  });
  acc.loginAudit = list.slice(-20);
}


// ===== إعدادات التطبيق عن بعد (Remote Config) + لوحة التحكم =====
// الملف app_config.json بجانب الخادم — تحرّه لوحة الويب، ويقرؤه التطبيق
// من /api/app-config (عام، بلا سر). أي مفتاح غائب يعود لقيمته الافتراضية.
const APP_CONFIG_FILE = path.join(__dirname, 'app_config.json');
const APP_CONFIG_DEFAULT = {
  version: 1,
  updatedAt: 0,
  maintenance: {
    enabled: false,
    message: 'التطبيق في صيانة قصيرة — جرّب بعد قليل.',
  },
  forceUpdate: {
    enabled: false,
    minVersion: '0.0.0',
    message: 'يتوفر إصدار جديد — حدّث التطبيق للمتابعة.',
    url: '',
  },
  announcement: { enabled: false, title: '', message: '', id: 0 },
  features: {
    review: true,
    quiz: true,
    jawaaher: true,
    mindMaps: true,
    liveRooms: true,
    history: true,
    friends: true,
  },
  ads: { enabled: false, label: '', url: '' },
  monetization: { enabled: false, label: '', url: '' },
};
function appConfigLoad() {
  let obj = {};
  if (store.enabled()) {
    obj = store.readJson('app_config.json', {}) || {};
  } else {
    try {
      obj = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf8')) || {};
    } catch (_) {}
  }
  // دمج عميق بمستوى واحد — القيم جزئية في الملف لا تُسقط باقي الأقسام.
  const cfg = {};
  for (const k of Object.keys(APP_CONFIG_DEFAULT)) {
    const d = APP_CONFIG_DEFAULT[k];
    const v = obj && obj[k];
    if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
      cfg[k] = Object.assign({}, d, v && typeof v === 'object' ? v : {});
    } else {
      cfg[k] = v === undefined ? d : v;
    }
  }
  return cfg;
}
function appConfigSave(cfg) {
  if (store.enabled()) {
    store.writeJson('app_config.json', cfg);
    return;
  }
  const tmp = APP_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg), 'utf8');
  fs.renameSync(tmp, APP_CONFIG_FILE);
}
// تعقيم ما تصل به اللوحة قبل حفظه — حقول معروفة فقط وأنواع صحيحة.
function appConfigSanitize(input) {
  if (!input || typeof input !== 'object') return null;
  const cfg = appConfigLoad();
  const boolOf = (v, d) => (typeof v === 'boolean' ? v : d);
  const strOf = (v, d, max) =>
    typeof v === 'string' ? v.slice(0, max) : d;
  const numOf = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  cfg.maintenance = {
    enabled: boolOf(input.maintenance && input.maintenance.enabled, cfg.maintenance.enabled),
    message: strOf(input.maintenance && input.maintenance.message, cfg.maintenance.message, 300),
  };
  cfg.forceUpdate = {
    enabled: boolOf(input.forceUpdate && input.forceUpdate.enabled, cfg.forceUpdate.enabled),
    minVersion: strOf(input.forceUpdate && input.forceUpdate.minVersion, cfg.forceUpdate.minVersion, 20),
    message: strOf(input.forceUpdate && input.forceUpdate.message, cfg.forceUpdate.message, 300),
    url: strOf(input.forceUpdate && input.forceUpdate.url, cfg.forceUpdate.url, 300),
  };
  cfg.announcement = {
    enabled: boolOf(input.announcement && input.announcement.enabled, cfg.announcement.enabled),
    title: strOf(input.announcement && input.announcement.title, cfg.announcement.title, 80),
    message: strOf(input.announcement && input.announcement.message, cfg.announcement.message, 500),
    id: numOf(input.announcement && input.announcement.id, Date.now()),
  };
  cfg.features = Object.assign({}, cfg.features);
  for (const k of Object.keys(cfg.features)) {
    cfg.features[k] = boolOf(
      input.features ? input.features[k] : undefined,
      cfg.features[k]
    );
  }
  cfg.ads = {
    enabled: boolOf(input.ads && input.ads.enabled, cfg.ads.enabled),
    label: strOf(input.ads && input.ads.label, cfg.ads.label, 80),
    url: strOf(input.ads && input.ads.url, cfg.ads.url, 300),
  };
  cfg.monetization = {
    enabled: boolOf(input.monetization && input.monetization.enabled, cfg.monetization.enabled),
    label: strOf(input.monetization && input.monetization.label, cfg.monetization.label, 80),
    url: strOf(input.monetization && input.monetization.url, cfg.monetization.url, 300),
  };
  cfg.version = 1;
  cfg.updatedAt = Date.now();
  return cfg;
}
// بيانات دخول الإدارة من .env فقط — لا افتراضية خاملة.
const ADMIN_USER = String(process.env.ADMIN_USER || 'admin');
const ADMIN_PASS = String(process.env.ADMIN_PASS || '');
const ADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 ساعة
const adminSessions = new Map(); // token -> expiry(ms)
function adminSessionSweep() {
  const now = Date.now();
  for (const [t, exp] of adminSessions) {
    if (exp <= now) adminSessions.delete(t);
  }
}
function adminAuth(req) {
  const h = String(req.headers.authorization || '');
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) return false;
  const exp = adminSessions.get(m[1]);
  if (!exp || exp <= Date.now()) {
    adminSessions.delete(m[1]);
    return false;
  }
  return true;
}
// قراءة JSON كبيرة من قراءة العاديّة (بنوك الأسئلة قد تتجاوز 64KB).
function readJsonBodyBig(req, capBytes) {
  const cap = capBytes || 4 * 1024 * 1024;
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > cap) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(d)); } catch (_) { resolve(null); }
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(d)); } catch (_) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

const handler = async (req, res) => {
  try {
    const ref = String(req.headers.referer || '-');
    fs.appendFileSync(
      path.join(__dirname, 'requests.log'),
      new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' ref=' + ref + '\n'
    );
  } catch (_) {}
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    urlPath = '/';
  }

  // ===== CORS — التطبيق الويب منشور على GitHub Pages (نطاق مختلف عن الخادم) =====
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-file-name'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  // استجابة مسبقة (preflight) لطلبات CORS من متصفح الويب (رفع الملفات مثلاً).
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // نقطة فحص صحة (health) لاستضافة Render — يجب أن تعيد 200.
  if (req.method === 'GET' && urlPath === '/health') {
    return json(res, 200, { ok: true });
  }

  // ===== بنوك أسئلة اللعبة/الكويز — تُقرأ من مجلد خارجي على سطح المكتب =====
  //   GET /api/question-banks/game_challenges.json
  // المجلد الخارجي أولًا، ثم نسخة داخل التطبيق كاحتياط.
  if (req.method === 'GET' && urlPath.startsWith('/api/question-banks/')) {
    const name = path.basename(urlPath.slice('/api/question-banks/'.length));
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
      return json(res, 400, { error: 'اسم ملف غير صالح' });
    }
    // الوضع السحابي: البنوك كائنات في Supabase data/banks.
    if (store.enabled()) {
      const bank = store.getBank(name);
      if (!bank) return json(res, 404, { error: 'البنك غير موجود' });
      const bodyBuf = Buffer.from(JSON.stringify(bank), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': bodyBuf.length,
        'Cache-Control': 'no-cache',
      });
      return res.end(bodyBuf);
    }
    const external = path.join(EXTERNAL_QUESTION_BANKS_DIR, name);
    const fallback = path.join(ROOT, 'assets', 'assets', 'banks', name);
    const filePath = fs.existsSync(external)
      ? external
      : fs.existsSync(fallback)
        ? fallback
        : null;
    if (!filePath) {
      return json(res, 404, { error: 'البنك غير موجود' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': fs.statSync(filePath).size,
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // ===== حسابات جواهر الكفاءة: تسجيل/دخول/دفع التقدّم/قائمة الزملاء =====
  // كل أستاذ يقرر في إعداداته: هل يظهر تقدّمه (visible)؟ وهل تُعرض الأرقام (showStats)؟
  if (req.method === 'POST' && urlPath === '/api/social/register') {
    const body = await readJsonBody(req);
    // بوابة المالِك: الاسم = الرمز السرّي → جلسة حساب الإدارة مباشرة ( эффективно).
    if (adminGateOf(String((body && body.name) || ''))) return adminGateReply(res, req);
    // تحديد المعدل حسب IP — يحمي الاحتياط من سحب القوة دون إزعاج المشروعين.
    const limited = rateLimit(req, 'auth', { windowMs: 60 * 1000, max: 15 });
    if (limited) {
      res.setHeader('Retry-After', String(limited));
      auditLogin('register', String((body && body.name) || '').toLowerCase(), req, false, 'rate-limited');
      return json(res, 429, { error: 'محاولات كثيرة — انتظر ' + limited + ' ثانية' });
    }
    const name = String((body && body.name) || '').trim();
    const pin = String((body && body.pin) || '');
    if (name.length < 2 || name.length > 24) return json(res, 400, { error: 'الاسم من 2 إلى 24 حرفًا' });
    if (!/^[0-9\u0600-\u06FF]{4,6}$/.test(pin)) return json(res, 400, { error: 'الرمز 4–6 أرقام' });
    const db = socialLoad();
    const key = name.toLowerCase();
    if (db.accounts[key]) return json(res, 409, { error: 'الاسم محجوز — سجّل الدخول' });
    const salt = crypto.randomBytes(8).toString('hex');
    db.accounts[key] = {
      name: name,
      salt: salt,
      pinHash: socialHash(pin, salt),
      createdAt: new Date().toISOString(),
      // RBAC: كل التسجيلات الجديدة دورها «user» افتراضيًا (الترقية عبر .env/يدويًا).
      role: 'user',
      state: {},
    };
    const role = socialRoleOf(key, db.accounts[key]);
    if (role === 'admin') db.accounts[key].role = 'admin'; // تثبيت ترقية .env على الحساب
    auditPersist(db, key, req, 'register');
    socialSave(db);
    auditLogin('register', key, req, true);
    // جلسة موقّعة (HMAC) بلا حالة ولا ارتباط بالـIP — 30 يومًا.
    const token = socialIssueToken(key, SOCIAL_TTL_MS);
    return json(res, 200, { ok: true, token: token, name: name, role: role });
  }

  if (req.method === 'POST' && urlPath === '/api/social/login') {
    const body = await readJsonBody(req);
    const limited = rateLimit(req, 'auth', { windowMs: 60 * 1000, max: 15 });
    if (limited) {
      res.setHeader('Retry-After', String(limited));
      auditLogin('login', String((body && body.name) || '').toLowerCase(), req, false, 'rate-limited');
      return json(res, 429, { error: 'محاولات كثيرة — انتظر ' + limited + ' ثانية' });
    }
    const name = String((body && body.name) || '').trim();
    const pin = String((body && body.pin) || '');
    const db = socialLoad();
    const acc = db.accounts[name.toLowerCase()];
    if (!acc || acc.pinHash !== socialHash(pin, acc.salt)) {
      auditLogin('login', name.toLowerCase(), req, false, 'bad-credentials');
      return json(res, 401, { error: 'اسم أو رمز غير صحيح' });
    }
    auditLogin('login', name.toLowerCase(), req, true);
    auditPersist(db, name.toLowerCase(), req, 'login');
    const role = socialRoleOf(name.toLowerCase(), acc);
    if (role === 'admin') db.accounts[name.toLowerCase()].role = 'admin'; // تثبيت ترقية .env
    socialSave(db);
    // جلسة موقّعة بلا حالة ولا ارتباط بالـIP — تجرّ تبديل الجيوب/الشبكة دون انقطاع.
    const token = socialIssueToken(name.toLowerCase(), SOCIAL_TTL_MS);
    return json(res, 200, { ok: true, token: token, name: acc.name, role: role });
  }

  // دخول تلقائي بهوية «مسار احتراف»: التسجيل الأول في التطبيق يكفي،
  // فلا تسجيل داخل اللعبة إطلاقًا — يُنشأ الحساب صامتًا عند أول فتح بـ ?u=<الاسم>.
  // الحسابات المسجّلة برمز خاص (طريقة قديمة) محميّة ولا تُفتح بالاسم وحده.
  if (req.method === 'POST' && urlPath === '/api/social/app-login') {
    const body = await readJsonBody(req);
    // بوابة المالِك الصامتة (نفس منطق التسجيل) — تتحقق قبل أي إنشاء حساب.
    if (adminGateOf(String((body && body.name) || ''))) return adminGateReply(res, req);
    const limited = rateLimit(req, 'auth', { windowMs: 60 * 1000, max: 15 });
    if (limited) {
      res.setHeader('Retry-After', String(limited));
      auditLogin('app-login', String((body && body.name) || '').toLowerCase(), req, false, 'rate-limited');
      return json(res, 429, { error: 'محاولات كثيرة — انتظر ' + limited + ' ثانية' });
    }
    const name = String((body && body.name) || '').trim();
    if (name.length < 2 || name.length > 24) return json(res, 400, { error: 'الاسم من 2 إلى 24 حرفًا' });
    const db = socialLoad();
    const key = name.toLowerCase();
    const acc = db.accounts[key];
    if (acc && acc.pinHash) return json(res, 409, { error: 'هذا الاسم مسجّل برمز خاص' });
    if (!acc) {
      db.accounts[key] = {
        name: name,
        salt: '',
        pinHash: '',
        provisioned: true,
        createdAt: new Date().toISOString(),
        state: {},
      };
    }
    const role = socialRoleOf(key, db.accounts[key]);
    if (role === 'admin') db.accounts[key].role = 'admin';
    auditPersist(db, key, req, 'app-login');
    socialSave(db);
    auditLogin('app-login', key, req, true);
    // جلسة موقّعة بلا حالة ولا ارتباط بالـIP.
    const token = socialIssueToken(key, SOCIAL_TTL_MS);
    return json(res, 200, { ok: true, token: token, name: db.accounts[key].name || name, role: role });
  }

  // دخول عبر مزوّد اجتماعي (Google/Facebook) — التطبيق يرسل بطاقة المزوّد
  // بعد نافذته، ويُتحقق منها مع المصدر هنا (مصدر الحقيقة: الخادم) ثم
  // تُنشأ/تُربط جاسية «مسار احتراف» وتُصدر جلسة موقّعة بنفس شكل app-login.
  if (req.method === 'POST' && urlPath === '/api/social/oauth-login') {
    const body = await readJsonBody(req);
    const limited = rateLimit(req, 'auth', { windowMs: 60 * 1000, max: 10 });
    if (limited) {
      res.setHeader('Retry-After', String(limited));
      auditLogin('oauth-login', String((body && body.provider) || '?'), req, false, 'rate-limited');
      return json(res, 429, { error: 'محاولات كثيرة — انتظر ' + limited + ' ثانية' });
    }
    const provider = String((body && body.provider) || '').trim().toLowerCase();
    const idToken = String((body && body.idToken) || '').trim();
    if (provider !== 'google' && provider !== 'facebook') {
      return json(res, 400, { error: 'مزوّد غير مدعوم' });
    }
    if (!idToken || idToken.length < 20) {
      return json(res, 400, { error: 'بطاقة التحقق غير موجودة — أعد المحاولة' });
    }
    const profile =
      provider === 'google'
        ? await verifyGoogleIdToken(idToken)
        : await verifyFacebookToken(idToken);
    if (!profile || profile.ok !== true) {
      auditLogin('oauth-login', provider, req, false, 'bad-token');
      return json(res, 401, { error: (profile && profile.error) || 'بطاقة المزوّد غير صالحة' });
    }
    // الاسم: من المزوّد أولاً ثم ما أرسله التطبيق (إسقاط فارغ) — بصياغة
    // النظام نفسه (2..24 حرفًا). البريد الفارغ مقبول (الخصوصية).
    let name = String(profile.name || '').trim();
    if (name.length < 2 && String(body.name || '').trim().length >= 2) {
      name = String(body.name).trim();
    }
    if (name.length > 24) name = name.slice(0, 24).trim();
    if (name.length < 2 || name.length > 24) {
      return json(res, 400, { error: 'اسم المزوّد غير صالح — اختر الاسم من واجهة التطبيق' });
    }
    const db = socialLoad();
    const key = name.toLowerCase();
    const acc = db.accounts[key];
    if (acc && acc.pinHash) {
      return json(res, 409, { error: 'هذا الاسم محجوز بحساب برمز خاص — استعمل دخول الاسم أو حسابًا آخر عبر مزوّدك' });
    }
    if (!acc) {
      db.accounts[key] = {
        name: name,
        salt: '',
        pinHash: '',
        provisioned: true,
        createdAt: new Date().toISOString(),
        state: {},
      };
    }
    // ربط هوية المزوّد المُتحقَّق منها بالحساب (يموّه التخريب بالاسم).
    db.accounts[key].provider = provider;
    db.accounts[key].providerId = profile.id;
    if (profile.email) db.accounts[key].verifiedEmail = profile.email;
    const role = socialRoleOf(key, db.accounts[key]);
    if (role === 'admin') db.accounts[key].role = 'admin';
    auditPersist(db, key, req, 'oauth-' + provider);
    socialSave(db);
    auditLogin('oauth-login', key, req, true);
    const token = socialIssueToken(key, SOCIAL_TTL_MS);
    return json(res, 200, {
      ok: true,
      token: token,
      name: db.accounts[key].name || name,
      role: role,
      email: profile.email || '',
    });
  }

  // GET /api/social/whoami — دور الحساب الحالي (RBAC): من التوكن في الاستعلام/الترويسة.
  if (req.method === 'GET' && urlPath === '/api/social/whoami') {
    const token =
      new URL(req.url, 'http://localhost').searchParams.get('token') ||
      String((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const db = socialLoad();
    const key = socialTokenKey(token, db);
    const acc = key && db.accounts[key];
    if (!acc) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    return json(res, 200, {
      ok: true,
      name: acc.name,
      role: socialRoleOf(key, acc),
    });
  }

  if (req.method === 'POST' && urlPath === '/api/social/push') {
    const body = await readJsonBody(req);
    const token = String((body && body.token) || '');
    const db = socialLoad();
    const key = socialTokenKey(token, db);
    if (!key || !db.accounts[key]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const st = (body && body.state) || {};
    const social = (st.social && typeof st.social === 'object') ? st.social : {};
    db.accounts[key].state = {
      name: String(st.name || db.accounts[key].name).slice(0, 24),
      season: Math.max(1, Math.min(999, Number(st.season) || 1)),
      totalStars: Math.max(0, Number(st.totalStars) || 0),
      coins: Math.max(0, Number(st.coins) || 0),
      gems: Math.max(0, Number(st.gems) || 0),
      done: Math.max(0, Number(st.done) || 0),
      totalLevels: Math.max(0, Number(st.totalLevels) || 0),
      lastLevel: String(st.lastLevel || '').slice(0, 64),
      lastLevelLabel: String(st.lastLevelLabel || '').slice(0, 80),
      avatar: String(st.avatar || '🧑‍🏫').slice(0, 16),
      photo: (typeof st.photo === 'string' && st.photo.indexOf('data:image/') === 0 && st.photo.length <= 45000) ? st.photo : null,
      lastPlayedAt: new Date().toISOString(),
      social: {
        visible: social.visible !== false,
        showStats: social.showStats !== false,
      },
    };
    socialSave(db);
    return json(res, 200, { ok: true });
  }

  // قائمة الزملاء: من أخفى (visible=false) يظهر اسمه وسطر «أخفى تقدّمه» فقط،
  // ومن ظهر دون showStats يظهر اسمه دون أي أرقام.
  if (req.method === 'GET' && urlPath === '/api/social/list') {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const db = socialLoad();
    const me = socialTokenKey(token, db);
    if (!me) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const peers = Object.keys(db.accounts)
      .filter((k) => k !== me)
      .map((k) => {
        const a = db.accounts[k];
        const st = a.state || {};
        const vis = !st.social || st.social.visible !== false;
        const stats = !st.social || st.social.showStats !== false;
        return {
          name: st.name || a.name,
          visible: vis,
          stats: vis && stats,
          avatar: vis ? (st.avatar || '🧑‍🏫') : null,
          photo: vis ? (st.photo || null) : null,
          pos: vis && st.lastLevel ? { level: st.lastLevel, season: st.season || 1 } : null,
          season: vis && stats ? st.season : null,
          totalStars: vis && stats ? st.totalStars : null,
          coins: vis && stats ? st.coins : null,
          gems: vis && stats ? st.gems : null,
          done: vis && stats ? st.done : null,
          totalLevels: vis && stats ? st.totalLevels : null,
          lastPlayedAt: vis && stats ? (st.lastPlayedAt || null) : null,
        };
      });
    return json(res, 200, { ok: true, me: db.accounts[me].name, peers: peers });
  }

  // تقدّم اللعبة باسم الحساب (لقراءة Flutter دون رمز): يعيد حالة «جواهر الكفاءة»
  if (req.method === 'GET' && urlPath === '/api/social/progress') {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').searchParams.get('name') || '').trim().toLowerCase();
    const db = socialLoad();
    const acc = db.accounts[name];
    if (!acc || !acc.state) return json(res, 200, { ok: true, exists: false });
    const st = acc.state;
    return json(res, 200, {
      ok: true,
      exists: true,
      name: st.name || acc.name,
      season: st.season || 1,
      totalStars: st.totalStars || 0,
      coins: st.coins || 0,
      gems: st.gems || 0,
      done: st.done || 0,
      totalLevels: st.totalLevels || 0,
      lastLevel: st.lastLevel || null,
      lastLevelLabel: st.lastLevelLabel || null,
      avatar: st.avatar || '🧑‍🏫',
      photo: st.photo || null,
      lastPlayedAt: st.lastPlayedAt || null,
    });
  }

  // ================================================================
  // ===== دائرة الأصدقاء: طلبات صداقة + إرسال/مطالبة أرواح (قلوب) ====
  // مثل Candy Crush: صديق يرسل قلبًا مجانًا، والأسفل لديك بريد قلوب
  // تُطالب منه. القلوب لا تُخصم من المرسل — ليست عملة، بل مساعدة.
  // ================================================================
  const FRIEND_SEND_COOLDOWN = 30 * 60 * 1000; // قلب لكل صديق كل 30 دقيقة
  const FRIEND_ASK_COOLDOWN = 60 * 60 * 1000;  // طلب أرواح جماعي كل ساعة
  const FRIEND_TTL = 72 * 60 * 60 * 1000;      // انتهاء القلوب/الطلبات بعد 72 ساعة

  // تهيئة حقول الأصدقاء لحساب إن لم توجد (legacy accounts)
  function friendEnsure(db, key) {
    const a = db.accounts[key];
    if (!a) return null;
    if (!Array.isArray(a.friends)) a.friends = [];
    if (!Array.isArray(a.friendRequests)) a.friendRequests = [];
    if (!Array.isArray(a.livesInbox)) a.livesInbox = [];
    if (!Array.isArray(a.lifeRequests)) a.lifeRequests = [];
    if (!a.livesSentAt || typeof a.livesSentAt !== 'object') a.livesSentAt = {};
    const now = Date.now();
    // تنظيف انتهاء الصلاحية
    a.friendRequests = a.friendRequests.filter((r) => r && now - (r.at || 0) < FRIEND_TTL);
    a.livesInbox = a.livesInbox.filter((r) => r && now - (r.at || 0) < FRIEND_TTL);
    a.lifeRequests = a.lifeRequests.filter((r) => r && now - (r.at || 0) < FRIEND_TTL);
    a.friends = a.friends.filter((k) => db.accounts[k]);
    return a;
  }

  function friendPeerView(db, key) {
    const a = db.accounts[key];
    if (!a) return null;
    const st = a.state || {};
    return {
      name: st.name || a.name,
      avatar: st.avatar || '🧑‍🏫',
      photo: st.photo || null,
      season: st.season || 1,
      lastLevel: st.lastLevel || null,
      lastLevelLabel: st.lastLevelLabel || null,
      lastPlayedAt: st.lastPlayedAt || null,
    };
  }

  // قائمتُ الأصدقاء + الطلبات الواردة + بريد القلوب + من يطلب مني قلبًا
  if (req.method === 'GET' && urlPath === '/api/social/friends') {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const db = socialLoad();
    const me = socialTokenKey(token, db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const a = friendEnsure(db, me);
    const now = Date.now();
    const friends = a.friends.map((k) => {
      const peer = friendPeerView(db, k) || { name: db.accounts[k] ? db.accounts[k].name : k, avatar: '🧑‍🏫' };
      const last = a.livesSentAt[k] || 0;
      const remaining = Math.max(0, FRIEND_SEND_COOLDOWN - (now - last));
      const asksMe = a.lifeRequests.some((r) => r.from === k);
      return Object.assign(peer, { key: k, remainingMs: remaining, asksMe: asksMe });
    });
    const requests = a.friendRequests
      .filter((r) => db.accounts[r.from])
      .map((r) => Object.assign({ at: r.at }, friendPeerView(db, r.from) || { name: r.from }));
    const inboxLives = a.livesInbox
      .filter((r) => db.accounts[r.from])
      .map((r) => Object.assign({ at: r.at }, friendPeerView(db, r.from) || { name: r.from }));
    socialSave(db);
    return json(res, 200, {
      ok: true,
      me: (db.accounts[me].state && db.accounts[me].state.name) || db.accounts[me].name,
      friends,
      requests,
      inboxLives,
      sendCooldownMs: FRIEND_SEND_COOLDOWN,
      askCooldownMs: FRIEND_ASK_COOLDOWN,
    });
  }

  // إرسال طلب صداقة بالاسم
  if (req.method === 'POST' && urlPath === '/api/social/friend/request') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const target = String((body && body.name) || '').trim().toLowerCase();
    const targetKey = target in db.accounts ? target : null;
    if (!targetKey) return json(res, 404, { error: 'لا يوجد حساب بهذا الاسم' });
    if (targetKey === me) return json(res, 400, { error: 'لا يمكنك إضافة نفسك' });
    const a = friendEnsure(db, me);
    const t = friendEnsure(db, targetKey);
    if (a.friends.indexOf(targetKey) !== -1) return json(res, 400, { error: 'أصدقاء بالفعل' });
    if (a.friendRequests.some((r) => r.from === targetKey)) {
      // الطرف الآخر طلبني قبلاً — قبول مباشر
      a.friendRequests = a.friendRequests.filter((r) => r.from !== targetKey);
      a.friends.push(targetKey);
      t.friends.push(me);
      socialSave(db);
      return json(res, 200, { ok: true, accepted: true });
    }
    if (t.friendRequests.some((r) => r.from === me)) return json(res, 200, { ok: true, pending: true });
    t.friendRequests.push({ from: me, at: Date.now() });
    socialSave(db);
    return json(res, 200, { ok: true, pending: true });
  }

  // قبول / رفض طلب صداقة
  if (req.method === 'POST' && urlPath === '/api/social/friend/respond') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const from = String((body && body.from) || '').trim().toLowerCase();
    const accept = !!(body && body.accept);
    const a = friendEnsure(db, me);
    if (!db.accounts[from]) return json(res, 404, { error: 'الحساب غير موجود' });
    a.friendRequests = a.friendRequests.filter((r) => r.from !== from);
    if (accept) {
      const t = friendEnsure(db, from);
      if (a.friends.indexOf(from) === -1) a.friends.push(from);
      if (t.friends.indexOf(me) === -1) t.friends.push(me);
    }
    socialSave(db);
    return json(res, 200, { ok: true });
  }

  // إزالة صديق (من الطرفين)
  if (req.method === 'POST' && urlPath === '/api/social/friend/remove') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const other = String((body && body.name) || '').trim().toLowerCase();
    const a = friendEnsure(db, me);
    a.friends = a.friends.filter((k) => k !== other);
    if (db.accounts[other]) {
      const t = friendEnsure(db, other);
      t.friends = t.friends.filter((k) => k !== me);
    }
    socialSave(db);
    return json(res, 200, { ok: true });
  }

  // طلب أرواح جماعي: تنبيه كل الأصدقاء
  if (req.method === 'POST' && urlPath === '/api/social/lives/ask') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const a = friendEnsure(db, me);
    const now = Date.now();
    const lastAsk = (a.lifeRequestsMeta && a.lifeRequestsMeta.lastAskAt) || 0;
    if (now - lastAsk < FRIEND_ASK_COOLDOWN) {
      return json(res, 429, { error: 'انتظر ' + Math.ceil((FRIEND_ASK_COOLDOWN - (now - lastAsk)) / 60000) + ' دقيقة قبل طلب آخر' });
    }
    let told = 0;
    for (const k of a.friends) {
      const t = friendEnsure(db, k);
      if (!t) continue;
      t.lifeRequests = t.lifeRequests.filter((r) => r.from !== me);
      t.lifeRequests.push({ from: me, at: now });
      told++;
    }
    a.lifeRequestsMeta = { lastAskAt: now };
    socialSave(db);
    return json(res, 200, { ok: true, told });
  }

  // إرسال قلب: لصديق واحد أو للجميع (all=true) — لا يخصم من المرسل
  if (req.method === 'POST' && urlPath === '/api/social/lives/send') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const a = friendEnsure(db, me);
    const all = !!(body && body.all);
    const one = String((body && body.name) || '').trim().toLowerCase();
    const targets = all ? a.friends.slice() : (a.friends.indexOf(one) !== -1 ? [one] : []);
    if (!all && !targets.length) return json(res, 404, { error: 'هذا المستخدم ليس في دائرة أصدقائك' });
    const now = Date.now();
    let sent = 0;
    const skipped = [];
    for (const k of targets) {
      const t = friendEnsure(db, k);
      if (!t) continue;
      const last = a.livesSentAt[k] || 0;
      if (now - last < FRIEND_SEND_COOLDOWN) { skipped.push(k); continue; }
      t.livesInbox = t.livesInbox.filter((r) => r.from !== me); // قلب واحد معلّق بحد أقصى لكل صديق
      t.livesInbox.push({ from: me, at: now });
      t.lifeRequests = t.lifeRequests.filter((r) => r.from !== me); // يغطي طلباته برسالة قلب
      a.livesSentAt[k] = now;
      sent++;
    }
    socialSave(db);
    return json(res, 200, {
      ok: true,
      sent,
      remainingMs: skipped.length ? Math.max(0, FRIEND_SEND_COOLDOWN - (now - (a.livesSentAt[skipped[0]] || 0))) : 0,
    });
  }

  // مطالبة بريد القلوب: تحويل الأقلوب إلى قلوب حقيقية حتى الامتلاء
  if (req.method === 'POST' && urlPath === '/api/social/lives/collect') {
    const body = await readJsonBody(req);
    const db = socialLoad();
    const me = socialTokenKey(String((body && body.token) || ''), db);
    if (!me || !db.accounts[me]) return json(res, 401, { error: 'سجّل الدخول أولًا' });
    const a = friendEnsure(db, me);
    const maxLives = Math.max(1, Number((body && body.maxLives) || 5));
    const have = Math.max(0, Number((body && body.lives) || 0));
    let room = Math.max(0, maxLives - have);
    const keep = [];
    let added = 0;
    for (const item of a.livesInbox) {
      if (room > 0) { added++; room--; }
      else keep.push(item);
    }
    a.livesInbox = keep;
    socialSave(db);
    return json(res, 200, { ok: true, added, remaining: keep.length });
  }

  // ================================================================
  // ===== حضور المستخدمين (Presence) — عدّاد المتصلين الآن ====
  // ================================================================
  //
  // يسجّل كل جهاز الفضاء الذي دخله (بطاقة من لوحة التحضير)، ويُرجع
  // عدد الحاضرين في كل فضاء. السجلات تنتهي تلقائياً بعد PRESENCE_TTL
  // ثانية فيُحذف المستخدم المتوقف أو المُغلق لل��browser فورياً.
  if (req.method === 'GET' && urlPath === '/api/presence/counts') {
    return json(res, 200, { ok: true, counts: presenceCounts() });
  }

  if (req.method === 'POST' && urlPath === '/api/presence/heartbeat') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id) return json(res, 400, { error: 'معرّف مطلوب' });
    const space = String(body.space || 'lobby').trim().slice(0, 40);
    presence.set(id, { space, ts: Date.now() });
    presencePrune();
    return json(res, 200, { ok: true, counts: presenceCounts() });
  }

  if (req.method === 'POST' && urlPath === '/api/presence/leave') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (id) presence.delete(id);
    return json(res, 200, { ok: true, counts: presenceCounts() });
  }

  // رابط تحميل تطبيق الأندرويد — يقرأ آخر APK مبني من مجلد البناء مباشرة،
  // فلا حاجة لنسخ الملف يدوياً بعد كل بناء.
  //   http://<ip>:8123/download-app            ← الهواتف الحديثة (arm64)
  //   http://<ip>:8123/download-app?arch=armeabi ← الهواتف القديمة قبل 2018 تقريباً
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (urlPath === '/download-app' || urlPath === '/app-release.apk')) {
    const wantOld = new URL(req.url, 'http://localhost')
      .searchParams.get('arch') === 'armeabi';
    const apkPath = path.join(__dirname,
      'build', 'app', 'outputs', 'flutter-apk',
      wantOld ? 'app-armeabi-v7a-release.apk' : 'app-arm64-v8a-release.apk');
    if (!fs.existsSync(apkPath)) {
      return json(res, 404, { error: 'لم يُبنَ التطبيق بعد — نفّذ flutter build apk --split-per-abi' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': fs.statSync(apkPath).size,
      'Content-Disposition':
        `attachment; filename="masar-app${wantOld ? '-old' : ''}.apk"`,
      'Cache-Control': 'no-cache',
    });
    return fs.createReadStream(apkPath).pipe(res);
  }

  // ===== خدمة توكنات LiveKit — مفاتيح الإنتاج في متغيرات البيئة فقط =====
  // التطبيق لا يحمل أي سر؛ يطلب توكنه من هنا، والخادم هو من يوقّعه.
  if (urlPath.startsWith('/api/livekit')) {
    return handleLiveKitApi(req, res, urlPath);
  }

  // تحويل صفحات المتصفح من HTTP إلى HTTPS — لأن الميكروفون والكاميرا
  // محجوبان على http غير المشفّر. يُطبَّق على صفحة القاعات فقط (وليس على
  // /ws أو /uploads أو /api التي يعتمد عليها تطبيق الهاتف ويبقى عليها HTTP).
  // لا يُطبَّق عند وجود وسيط TLS (مثل Render/Cloudflare) — هناك HTTPS
  // يُدار خارجياً ولا يُعاد توجيه إليه.
  const behindProxy = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  if (
    false &&
    req.method === 'GET' &&
    !behindProxy &&
    !req.socket.encrypted &&
    (urlPath === '/' || urlPath === '/index.html')
  ) {
    const host = String(req.headers.host || `localhost:${HTTPS_PORT}`);
    const hostname = host.split(':')[0];
    res.writeHead(302, {
      Location: `https://${hostname}:${HTTPS_PORT}/`,
    });
    return res.end();
  }

  // ===== واجهة القاعات (HTTP) =====
  if (req.method === 'GET' && urlPath === '/api/rooms') {
    const viewerName =
      new URL(req.url, 'http://localhost').searchParams.get('name') || '';
    const viewerStage = normalizeStage(
      new URL(req.url, 'http://localhost').searchParams.get('stage') || ''
    );
    const viewerKey = viewerName.trim().toLowerCase();
    // عدد الحاضرين الفعلي لكل قاعة من خادم البث — أفضل جهد عند تعذره.
    let lkCounts = new Map();
    try {
      if (lkConfigured()) {
        const lr = await lkTwirp('ListRooms', {});
        for (const r of (lr && lr.rooms) || []) {
          lkCounts.set(
            String(r.name || ''),
            Number(r.numParticipants ?? r.num_participants ?? 0)
          );
        }
      }
    } catch {}
    const roomsList = [];
    for (const [id, room] of roomRegistry) {
      // عزل صارم للمراحل: عند اختيار مرحلة تُعرض قاعات تلك المرحلة فقط،
      // ولا تظهر القاعات القديمة بلا مرحلة في القوائم المرتبة.
      if (viewerStage && room.stage !== viewerStage) continue;
      // القاعات الخاصة (رمز الدعوة) تظهر للجميع في القائمة لكن رمزها
      // لا يُكشف إلا لأصحابها (المنشئ/المنسقون) — الدخول يبقى محمياً بالرمز.
      const isMember =
        !!viewerKey &&
        (room.creatorKey === viewerKey ||
          room.coordinators.some((c) => c.key === viewerKey));
      roomsList.push({
        ...roomInfo(id, room, isMember),
        participants: lkCounts.get(lkRoomName(room.name)) ?? 0,
      });
    }
    roomsList.sort((a, b) => b.createdAt - a.createdAt);
    return json(res, 200, { rooms: roomsList });
  }
  if (req.method === 'GET' && urlPath === '/api/rooms/by-code') {
    const code =
      (new URL(req.url, 'http://localhost').searchParams.get('code') || '')
        .trim()
        .toUpperCase();
    const viewerStage = normalizeStage(
      new URL(req.url, 'http://localhost').searchParams.get('stage') || ''
    );
    if (!code) return json(res, 400, { error: 'أدخل رمز الدعوة.' });
    let found = null;
    for (const room of roomRegistry.values()) {
      if (room.access === 'code' && room.inviteCode === code) {
        found = room;
        break;
      }
    }
    if (!found) {
      return json(res, 404, {
        error: 'لا توجد قاعة بهذا الرمز — تأكد من الرمز أو اطلبه من المنسق.',
      });
    }
    if (viewerStage && found.stage && found.stage !== viewerStage) {
      return json(res, 404, {
        error: 'هذه القاعة من مرحلة تعليمية أخرى — أدخل رمز قاعة من مرحلتك.',
      });
    }
    return json(res, 200, {
      room: {
        id: found.id,
        name: found.name,
        creatorName: found.creatorName,
        access: found.access,
        stage: found.stage || '',
      },
    });
  }
  // ===== شات القاعات على الخادم: التاريخ المشترك (آخر 15 يوماً) =====

  // GET /api/room-chat?room=<code> — يعيد رسائل القاعة (أقدمها أولاً).
  if (req.method === 'GET' && urlPath === '/api/room-chat') {
    const key = chatKeyOf(
      new URL(req.url, 'http://localhost').searchParams.get('room')
    );
    if (!key) return json(res, 400, { error: 'أدخل رمز القاعة.' });
    const arr = roomChats.get(key) || [];
    return json(res, 200, {
      messages: arr.map((m) => ({
        m: String(m.m || ''),
        s: String(m.s || ''),
        i: String(m.i || ''),
        t: String(m.t || ''),
        ms: Number(m.ms) || 0,
      })),
    });
  }

  // POST /api/room-chat — ينشر رسالة {"room","mid","name","identity","text"}.
  if (req.method === 'POST' && urlPath === '/api/room-chat') {
    const body = await readBody(req);
    const key = chatKeyOf(body.room);
    const mid = String(body.mid || '').trim().slice(0, 40);
    const sender = String(body.name || '').trim().slice(0, 48);
    const senderId = String(body.identity || '').trim().slice(0, 64);
    const text = String(body.text || '').trim().slice(0, CHAT_MAX_TEXT);
    if (!key) return json(res, 400, { error: 'أدخل رمز القاعة.' });
    if (!mid || !sender || !text) {
      return json(res, 400, { error: 'الرسالة ناقصة.' });
    }
    let arr = roomChats.get(key) || [];
    // نفس الرسالة (نفس mid) لا تُكرَّر مهما تكرر الإرسال.
    arr = arr.filter((m) => m.m !== mid);
    arr.push({ m: mid, s: sender, i: senderId, t: text, ms: Date.now() });
    roomChats.set(key, chatPrune(arr));
    chatSaveSoon();
    return json(res, 200, { ok: true });
  }

  // ===== تعليقات تطوير البطاقات الست =====

  // POST /api/card-comment {"card","name","text"} — ملاحظة عضو (≤40 كلمة).
  if (req.method === 'POST' && urlPath === '/api/card-comment') {
    const body = await readBody(req);
    const card = String(body.card || '').trim().slice(0, 24);
    const name = String(body.name || 'زائر').trim().slice(0, 48);
    const text = String(body.text || '').trim().slice(0, 400);
    if (!CARD_KEYS.includes(card)) {
      return json(res, 400, { error: 'بطاقة غير معروفة.' });
    }
    if (!text) return json(res, 400, { error: 'التعليق فارغ.' });
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > 40) {
      return json(res, 400, { error: 'الحد الأقصى 40 كلمة — اختصر قليلاً.' });
    }
    cardComments.push({ card, name, text, ms: Date.now() });
    cardCommentsSaveSoon();
    return json(res, 200, { ok: true });
  }

  // GET /api/card-comments — كل الملاحظات (للمالك عند التطوير).
  if (req.method === 'GET' && urlPath === '/api/card-comments') {
    const card = chatKeyOf(
      new URL(req.url, 'http://localhost').searchParams.get('card')
    );
    const list = card
      ? cardComments.filter((c) => c.card === card)
      : cardComments;
    return json(res, 200, { comments: list });
  }

  // ===== لوحة التحكم — إعدادات التطبيق عن بعد =====

  // GET /api/app-config — عام للتطبيق (بلا سر): الإعدادات الحالية.
  if (req.method === 'GET' && urlPath === '/api/app-config') {
    return json(res, 200, { ok: true, config: appConfigLoad() });
  }

  // POST /api/admin/login — توكن جلسة 12 ساعة.
  // مساران: (أ) ADMIN_USER/ADMIN_PASS من .env — (ب) حساب إدارة اجتماعي:
  // {name, pin} مع دور admin (RBAC) — يسمح للمالك بالدخول بحسابه هو نفسه.
  if (req.method === 'POST' && urlPath === '/api/admin/login') {
    const body = await readJsonBody(req);
    // تحديد المعدل حسب IP — كل صيغة دخول إداري فوق 8 محاولات/دقيقة تُرَدّ.
    const limited = rateLimit(req, 'admin-login', { windowMs: 60 * 1000, max: 8 });
    if (limited) {
      res.setHeader('Retry-After', String(limited));
      auditLogin('admin-login', 'panel-attempt', req, false, 'rate-limited');
      return json(res, 429, { error: 'محاولات كثيرة — انتظر ' + limited + ' ثانية' });
    }
    adminSessionSweep();
    // مسار (ب): حساب اجتماعي بدور admin.
    if (body && body.name !== undefined && body.pin !== undefined) {
      const name = String(body.name || '').trim();
      const pin = String(body.pin || '');
      const db = socialLoad();
      const key = name.toLowerCase();
      const acc = db.accounts[key];
      if (
        !acc ||
        acc.pinHash !== socialHash(pin, acc.salt) ||
        socialRoleOf(key, acc) !== 'admin'
      ) {
        auditLogin('admin-login', key, req, false, 'bad-credentials');
        return json(res, 401, { error: 'بيانات الإدارة غير صحيحة.' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      adminSessions.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
      auditLogin('admin-login', key, req, true);
      console.log(`[admin] دخول إداري اجتماعي: ${acc.name}`);
      return json(res, 200, {
        ok: true,
        token,
        role: 'admin',
        via: 'account',
        expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
      });
    }
    // مسار (أ): بيانات ROOT من .env.
    if (!ADMIN_PASS) {
      return json(res, 500, { error: '.env ناقص: ADMIN_PASS غير مضبوط.' });
    }
    if (
      String(body && body.user) !== ADMIN_USER ||
      String(body && body.pass) !== ADMIN_PASS
    ) {
      auditLogin('admin-login', 'root', req, false, 'bad-credentials');
      return json(res, 401, { error: 'اسم المستخدم أو كلمة المرور خاطئة.' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    auditLogin('admin-login', 'root', req, true);
    console.log(`[admin] دخول ناجح (${new Date().toLocaleString()})`);
    return json(res, 200, {
      ok: true,
      token,
      expiresAt: Date.now() + ADMIN_TOKEN_TTL_MS,
    });
  }

  // POST /api/admin/config — حفظ الإعدادات (يجيزها التعقيم قبل الكتابة).
  if (req.method === 'POST' && urlPath === '/api/admin/config') {
    if (!adminAuth(req)) return json(res, 401, { error: 'غير مصرح.' });
    const body = await readJsonBody(req);
    const cfg = appConfigSanitize(body && body.config);
    if (!cfg) return json(res, 400, { error: 'إعدادات غير صالحة.' });
    appConfigSave(cfg);
    console.log('[admin] تحديث الإعدادات — حفظ في app_config.json');
    return json(res, 200, { ok: true, config: cfg });
  }

  // GET /api/admin/stats — إحصائيات مبسطة من مخازن الخادم الفعلية.
  if (req.method === 'GET' && urlPath === '/api/admin/stats') {
    if (!adminAuth(req)) return json(res, 401, { error: 'غير مصرح.' });
    const db = socialLoad();
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    let accountsNew7d = 0;
    for (const k of Object.keys(db.accounts || {})) {
      const a = db.accounts[k];
      const t = Date.parse(a && a.createdAt) || 0;
      if (t >= week) accountsNew7d++;
    }
    let banks = store.enabled()
      ? store.countBanks()
      : (() => {
          try {
            return fs
              .readdirSync(EXTERNAL_QUESTION_BANKS_DIR)
              .filter((f) => /^[A-Za-z0-9._-]+\.json$/.test(f)).length;
          } catch (_) {
            return 0;
          }
        })();
    let uploads = store.enabled()
      ? store.countUploads()
      : (() => {
          try {
            return fs.readdirSync(UPLOAD_DIR).length;
          } catch (_) {
            return 0;
          }
        })();
    let chatRooms = 0;
    let chatMessages = 0;
    for (const arr of roomChats.values()) {
      chatRooms++;
      chatMessages += arr.length;
    }
    return json(res, 200, {
      ok: true,
      uptimeSec: Math.floor(process.uptime()),
      accounts: Object.keys(db.accounts || {}).length,
      accountsNew7d,
      rooms: roomRegistry.size,
      chatRooms,
      chatMessages,
      comments: cardComments.length,
      banks,
      uploads,
    });
  }

  // GET /api/admin/banks — قائمة بنوك الأسئلة الخارجية.
  if (req.method === 'GET' && urlPath === '/api/admin/banks') {
    if (!adminAuth(req)) return json(res, 401, { error: 'غير مصرح.' });
    // الوضع السحابي: القائمة من Supabase data/banks.
    if (store.enabled()) {
      const out = store.listBankNames().map((f) => {
        const v = store.getBank(f);
        return { name: f, bytes: JSON.stringify(v || {}).length, updatedAt: 0 };
      });
      return json(res, 200, { ok: true, dir: 'supabase://data/banks', banks: out });
    }
    const out = [];
    try {
      for (const f of fs.readdirSync(EXTERNAL_QUESTION_BANKS_DIR)) {
        if (!/^[A-Za-z0-9._-]+\.json$/.test(f)) continue;
        const p = path.join(EXTERNAL_QUESTION_BANKS_DIR, f);
        const st = fs.statSync(p);
        out.push({ name: f, bytes: st.size, updatedAt: st.mtimeMs });
      }
    } catch (_) {}
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return json(res, 200, { ok: true, dir: EXTERNAL_QUESTION_BANKS_DIR, banks: out });
  }

  // POST /api/admin/bank/upload {"name","data"} — رفع/تحديث بنك JSON.
  if (req.method === 'POST' && urlPath === '/api/admin/bank/upload') {
    if (!adminAuth(req)) return json(res, 401, { error: 'غير مصرح.' });
    const body = await readJsonBodyBig(req, 4 * 1024 * 1024);
    const name = path.basename(String((body && body.name) || ''));
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) {
      return json(res, 400, { error: 'الاسم: أحرف/أرقام/نقطة_شرطة مع .json' });
    }
    if (!body || !('data' in body) || typeof body.data !== 'object') {
      return json(res, 400, { error: 'المحتوى JSON غير صالح.' });
    }
    try {
      const p = path.join(EXTERNAL_QUESTION_BANKS_DIR, name);
      if (!path.resolve(p).startsWith(path.resolve(EXTERNAL_QUESTION_BANKS_DIR))) {
        return json(res, 400, { error: 'مسار غير مسموح.' });
      }
      if (!fs.existsSync(EXTERNAL_QUESTION_BANKS_DIR)) {
        fs.mkdirSync(EXTERNAL_QUESTION_BANKS_DIR, { recursive: true });
      }
      if (store.enabled()) {
        store.putBank(name, body.data);
        console.log(`[admin] بنك مرفوع: ${name}`);
        return json(res, 200, { ok: true, name });
      }
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(body.data), 'utf8');
      fs.renameSync(tmp, p);
      console.log(`[admin] بنك مرفوع: ${name}`);
      return json(res, 200, { ok: true, name });
    } catch (e) {
      return json(res, 500, { error: 'فشل الحفظ: ' + e.message });
    }
  }

  if (req.method === 'POST' && urlPath === '/api/rooms') {
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const creatorName = String(body.creatorName || 'مستخدم').trim();
    const access = body.access === 'code' ? 'code' : 'public';
    const stage = normalizeStage(String(body.stage || ''));
    if (!name) return json(res, 400, { error: 'أدخل اسم القاعة.' });
    for (const room of roomRegistry.values()) {
      if (room.name.trim().toLowerCase() === name.toLowerCase()) {
        return json(res, 409, { error: 'يوجد قاعة بهذا الاسم بالفعل — اختر اسماً آخر.' });
      }
    }
    const id = createRoomId();
    const room = {
      id,
      name,
      creatorName,
      creatorKey: creatorName.toLowerCase(),
      coordinators: [{ name: creatorName, key: creatorName.toLowerCase() }],
      createdAt: Date.now(),
      access,
      lastUsedAt: Date.now(),
    };
    if (stage) room.stage = stage;
    if (access === 'code') room.inviteCode = createInviteCode();
    roomRegistry.set(id, room);
    saveRegistry();
    console.log(
      `[room-created] ${id} «${name}» بقيادة ${creatorName} (${
        access === 'code' ? `خاصة بالرمز ${room.inviteCode}` : 'عامة'
      })`
    );
    return json(res, 201, {
      room: { id, name, access, inviteCode: room.inviteCode },
    });
  }
  if (req.method === 'DELETE' && urlPath.startsWith('/api/rooms/')) {
    const key = decodeURIComponent(urlPath.slice('/api/rooms/'.length));
    const queryName =
      new URL(req.url, 'http://localhost').searchParams.get('name') || '';
    // نقبل المعرّف الداخلي أو رمز الدعوة أو اسم القاعة — العميل لا
    // يملك بالضرورة المعرّف الداخلي للقاعة.
    let foundId = null;
    let room = null;
    if (roomRegistry.has(key)) {
      foundId = key;
      room = roomRegistry.get(key);
    } else {
      const upKey = key.trim().toUpperCase();
      const lowKey = key.trim().toLowerCase();
      for (const [rid, r] of roomRegistry) {
        if (
          (r.inviteCode && r.inviteCode === upKey) ||
          String(r.name || '')
            .trim()
            .toLowerCase() === lowKey
        ) {
          foundId = rid;
          room = r;
          break;
        }
      }
    }
    if (!foundId || !room)
      return json(res, 404, { error: 'القاعة غير موجودة.' });
    if (queryName.trim().toLowerCase() !== room.creatorKey) {
      return json(res, 403, {
        error: 'يمكن للمنشئ حذف القاعة فقط.',
      });
    }
    // قاعدة صارمة: الحذف الفوري متاح دون خمسة أعضاء. عند خمسة
    // فأكثر يُرفض الحذف — على المنسق التسليم والمغادرة فقط.
    // العدّ الأول من اتصالات هذه القاعة تحديداً (دقيق لغرفتها)،
    // وإن لم تسجّل اتصالات نرجع لعدّ خادم البث شرط عدم تداخل أسماء.
    const sockSet = rooms.get(foundId);
    const occupants = sockSet ? sockSet.size : 0;
    let blockedByLive = false;
    try {
      if (occupants === 0 && lkConfigured()) {
        const rn = lkRoomName(room.name);
        const sameKeyCount = [...roomRegistry.values()].filter(
          (r) => lkRoomName(r.name) === rn
        ).length;
        if (sameKeyCount === 1) {
          const lr = await lkTwirp('ListRooms', {});
          const live = ((lr && lr.rooms) || []).find(
            (x) => String(x.name || '') === rn
          );
          const cnt = live
            ? Number(live.numParticipants ?? live.num_participants ?? 0)
            : 0;
          if (cnt >= 5) blockedByLive = true;
        }
      }
    } catch {}
    if (occupants >= 5 || blockedByLive) {
      return json(res, 403, {
        error:
          'القاعة فيها ٥ أعضاء فأكثر — لا يمكن حذفها. سلّم التنسيق ثم غادر.',
      });
    }
    roomRegistry.delete(foundId);
    const set = rooms.get(foundId);
    if (set && set.size > 0) {
      broadcast(foundId, { type: 'room-deleted' });
      for (const c of [...set]) disconnect(c);
    } else {
      rooms.delete(foundId);
      voiceRooms.delete(foundId);
      roomHosts.delete(foundId);
      chatLogs.delete(foundId);
      chatHistory.delete(foundId);
    }
    saveRegistry();
    console.log(`[room-deleted] ${foundId} «${room.name}»`);
    return json(res, 200, { ok: true });
  }

  // ===== رفع ملف مرفق (صورة/مستند) — بلا فيديو =====
  if (req.method === 'POST' && urlPath === '/api/chat-file') {
    const declaredLength = Number(req.headers['content-length']) || 0;
    if (declaredLength > MAX_ATTACHMENT_BYTES) {
      return json(res, 413, {
        error: `حجم الملف يتجاوز الحد المسموح (${MAX_ATTACHMENT_BYTES / 1024 / 1024} ميغابايت).`,
      });
    }
    const rawName = String(req.headers['x-file-name'] || 'file');
    let fileName = 'file';
    try {
      fileName = decodeURIComponent(rawName);
    } catch {
      /* تجاهل الأسماء غير الصالحة */
    }
    const mime = String(req.headers['content-type'] || '')
      .toLowerCase()
      .split(';')[0]
      .trim();

    // رفض الفيديو/الصوت صراحةً حتى لو عُدّل الامتداد.
    if (/^(video|audio)\//.test(mime)) {
      return json(res, 415, {
        error: 'الفيديو والصوت غير مدعومين — الصور والمستندات فقط.',
      });
    }

    const ext = path.extname(fileName).toLowerCase().replace('.', '');
    if (!ALLOWED_ATTACHMENT_EXTS.includes(ext)) {
      return json(res, 415, {
        error:
          'الملفات المسموحة: صور (PNG/JPG/JFIF/GIF/WebP/BMP) ومستندات (PDF/Word/Excel/PowerPoint/نصية). الفيديو غير مدعوم.',
      });
    }

    const chunks = [];
    let received = 0;
    let aborted = false;
    req.on('data', (c) => {
      received += c.length;
      if (received > MAX_ATTACHMENT_BYTES) {
        aborted = true;
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return json(res, 400, { error: 'الملف فارغ.' });
      const safeBase = path
        .basename(fileName)
        .replace(/[^A-Za-z0-9._()\u0600-\u06FF -]/g, '_')
        .slice(0, 80);
      const stored = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safeBase}`;
      store.putUpload(stored, buf, (err) => {
        if (err) {
          console.error(`[upload-error] ${err.message}`);
          return json(res, 500, { error: 'تعذّر حفظ الملف على الخادم.' });
        }
        console.log(
          `[upload] ${stored} (${buf.length} bytes, ${mime || 'unknown'})`
        );
        return json(res, 200, {
          url: '/uploads/' + stored,
          name: fileName,
          size: buf.length,
          mime,
        });
      });
    });
    req.on('error', () => {
      /* تجاهل — غالباً إلغاء من العميل أو تجاوز الحجم */
    });
    return;
  }

  // ===== خدمة الملفات المرفوعة =====
  if (urlPath.startsWith('/uploads/')) {
    const rel = urlPath.slice('/uploads/'.length);
    const safe = path.basename(rel);
    const filePath = path.join(UPLOAD_DIR, safe);
    if (!filePath.startsWith(UPLOAD_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    // الوضع السحابي: الرفع في Supabase — نجلب المخزن ونخطه مباشرة.
    if (store.enabled()) {
      store
        .getUpload(safe)
        .then((buf) => {
          if (!buf) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          const mime =
            MIME[path.extname(safe).toLowerCase()] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': mime });
          return res.end(buf);
        })
        .catch(() => {
          res.writeHead(500);
          return res.end('Error');
        });
      return;
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        return res.end('Not Found');
      }
      const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      return fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // ===== توليد كويز من ملف الدرس (PDF -> Groq -> 70 سؤالاً) =====
  if (req.method === 'POST' && urlPath === '/api/quiz/generate-from-pdf') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {}
      const rawPath = typeof payload.path === 'string' ? payload.path : '';
      const payloadUrl = typeof payload.url === 'string' ? payload.url : '';
      if (!rawPath && !payloadUrl) return json(res, 400, { error: 'path أو url مطلوب' });
      let rel = rawPath;
      let remoteUrl = '';
      if (payloadUrl) {
        // قراءة PDF من GitHub سحابياً — نطاقات مسموحة فقط
        try {
          remoteUrl = decodeURIComponent(payloadUrl);
        } catch {
          remoteUrl = payloadUrl;
        }
        const ok = /^https:\/\/([a-z0-9.-]+\.github\.io|raw\.githubusercontent\.com|github\.com|codeload\.github\.com)\//i.test(remoteUrl);
        if (!ok) return json(res, 403, { error: 'نطاق غير مسموح' });
        rel = typeof rawPath === 'string' ? rawPath : '';
      }
      try {
        rel = decodeURIComponent(String(rel || '').replace(/^\/+/, ''));
      } catch {}
      rel = rel.replace(/^assets\/assets\//, 'assets/');
      if (rel && !/^assets\/review_files\/.+\.pdf$/i.test(rel)) {
        rel = 'assets/review_files/' + rel.replace(/^assets\//, '');
      }
      const baseDir = path.join(__dirname, 'assets', 'review_files');
      const pdfFile = rel ? path.normalize(path.join(__dirname, rel)) : null;
      if (!remoteUrl) {
        if (!pdfFile || !pdfFile.startsWith(baseDir) || !pdfFile.toLowerCase().endsWith('.pdf')) {
          return json(res, 403, { error: 'مسار غير مسموح' });
        }
      }
      const providers = activeProviders();
      if (!providers.length) return json(res, 503, noProviderError());
      const proceed = () => {
        // بلا كاش دائم: كل محاولة توليد جديدة ببذرة مختلفة.
        const genDir = path.join(__dirname, 'assets', 'banks', 'generated');
        fs.mkdirSync(genDir, { recursive: true });
        const stamp =
          Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        const seed = crypto.randomInt(1, 0x7fffffff);
        const outFile = path.join(genDir, 'gen_' + stamp + '.json');
        const { spawn } = require('child_process');
        const scriptArgs = [path.join(__dirname, 'tools', 'quiz_from_pdf.py')];
        if (remoteUrl) {
          scriptArgs.push('--url', remoteUrl);
          if (pdfFile) scriptArgs.push('--pdf', pdfFile);
        } else {
          scriptArgs.push('--pdf', pdfFile);
        }
        scriptArgs.push(
          '--seed', String(seed),
          '--subject', String(payload.subject || ''),
          '--out', outFile
        );
        if (typeof payload.sub === 'string' && payload.sub.trim()) {
          scriptArgs.push('--sub', payload.sub.trim());
        }
        if (typeof payload.sourceName === 'string' && payload.sourceName.trim()) {
          scriptArgs.push('--source-name', payload.sourceName.trim());
        }
        // مفاتيح المزوّدين كلها موروثة من process.env (المحمَّلة من .env)
        const proc = spawn('python', scriptArgs, {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
        });
        let errTxt = '';
        const killer = setTimeout(() => proc.kill(), 480000);
        proc.stdout.on('data', () => {});
        proc.stderr.on('data', (d) => {
          errTxt += d.toString();
          if (errTxt.length > 8000) errTxt = errTxt.slice(-4000);
        });
        proc.on('error', (e) => {
          errTxt += String(e);
        });
        proc.on('close', (code) => {
          clearTimeout(killer);
          if (code === 0 && fs.existsSync(outFile)) {
            try {
              const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
              console.log('[quiz-gen] ' + (remoteUrl || rel) + ' seed=' + seed + ' -> ' + j.count + 'q via ' + providers.join(','));
              return json(res, 200, { cached: false, seed, providers, ...j });
            } catch (e) {
              errTxt += String(e);
            }
          }
          console.error('[quiz-gen-fail] code=' + code + ' ' + errTxt.slice(-400));
          return json(res, 502, {
            error: 'GENERATION_FAILED',
            detail: errTxt.slice(-180),
          });
        });
      };

      if (remoteUrl) return proceed();
      fs.stat(pdfFile, (err, st) => {
        if (err || !st.isFile()) return json(res, 404, { error: 'الملف غير موجود' });
        proceed();
      });
    });
    return;
  }

  // ===== التوليد المتدرج: دفعة أولى فورية + استكمال بالخلفية =====
  // POST /api/quiz/start-from-pdf  -> أول 4 أسئلة خلال ثوانٍ + jobId
  // GET  /api/quiz/job/<jobId>     -> حالة المهمة وأسئلة ما بعد الدفعة الأولى
  const quizJobs =
    global.__quizJobs || (global.__quizJobs = new Map());

  if (req.method === 'POST' && urlPath === '/api/quiz/start-from-pdf') {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(body || '{}');
      } catch {}
      const rawPath = typeof payload.path === 'string' ? payload.path : '';
      let payloadUrl = typeof payload.url === 'string' ? payload.url : '';
      if (!rawPath && !payloadUrl) return json(res, 400, { error: 'path أو url مطلوب' });
      let remoteUrl = '';
      if (payloadUrl) {
        try {
          remoteUrl = decodeURIComponent(payloadUrl);
        } catch {
          remoteUrl = payloadUrl;
        }
        const ok = /^https:\/\/([a-z0-9.-]+\.github\.io|raw\.githubusercontent\.com|github\.com|codeload\.github\.com)\//i.test(remoteUrl);
        if (!ok) return json(res, 403, { error: 'نطاق غير مسموح' });
      }
      let rel = rawPath;
      try {
        rel = decodeURIComponent(String(rel || '').replace(/^\/+/, ''));
      } catch {}
      rel = rel.replace(/^assets\/assets\//, 'assets/');
      if (rel && !/^assets\/review_files\/.+\.pdf$/i.test(rel)) {
        rel = 'assets/review_files/' + rel.replace(/^assets\//, '');
      }
      const baseDir = path.join(__dirname, 'assets', 'review_files');
      const pdfFile = rel ? path.normalize(path.join(__dirname, rel)) : null;
      if (!remoteUrl) {
        if (!pdfFile || !pdfFile.startsWith(baseDir) || !pdfFile.toLowerCase().endsWith('.pdf')) {
          return json(res, 403, { error: 'مسار غير مسموح' });
        }
      }
      const jobProviders = activeProviders();
      if (!jobProviders.length) return json(res, 503, noProviderError());

      const crypto = require('crypto');
      const jobId =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const jobDir = path.join(__dirname, 'assets', 'banks', 'generated_jobs');
      fs.mkdirSync(jobDir, { recursive: true });
      const fFirst = path.join(jobDir, jobId + '.first.json');
      const fRest = path.join(jobDir, jobId + '.rest.json');
      const fFull = path.join(jobDir, jobId + '.full.json');
      const seed = crypto.randomInt(1, 0x7fffffff);

      const { spawn } = require('child_process');
      const scriptArgs = [
        path.join(__dirname, 'tools', 'quiz_from_pdf.py'),
        '--seed', String(seed),
        '--subject', String(payload.subject || ''),
        '--count', '50',
        '--phrase-correct', '15',
        '--first-count', '4',
        '--out-first', fFirst,
        '--out-rest', fRest,
        '--out', fFull,
      ];
      if (typeof payload.sub === 'string' && payload.sub.trim()) {
        scriptArgs.push('--sub', payload.sub.trim());
      }
      if (typeof payload.sourceName === 'string' && payload.sourceName.trim()) {
        scriptArgs.push('--source-name', payload.sourceName.trim());
      }
      if (remoteUrl) scriptArgs.push('--url', remoteUrl);
      else scriptArgs.push('--pdf', pdfFile);
      // مفاتيح المزوّدين كلها موروثة من process.env (المحمَّلة من .env)
      const proc = spawn('python', scriptArgs, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
      });
      let errTxt = '';
      proc.stderr.on('data', (d) => {
        errTxt += d.toString();
        if (errTxt.length > 4000) errTxt = errTxt.slice(-2000);
      });
      proc.on('close', () => {
        quizJobs.set(jobId, {
          done: true,
          ok: fs.existsSync(fFull),
          endedAt: Date.now(),
        });
        setTimeout(() => {
          quizJobs.delete(jobId);
          const fProg = path.join(jobDir, jobId + '.progress.json');
          [fFirst, fRest, fFull, fProg].forEach((f) => fs.unlink(f, () => {}));
        }, 1800000).unref();
      });
      quizJobs.set(jobId, { proc });

      // ردّ فوري بمعرّف المهمة فقط: التوليد يجري في الخلفية والواجهة
      // تستعلم من /api/quiz/job/<id> كل ثانيتين. لا انتظار إطلاقاً،
      // فيفتح الكويز في أقل من ثانية.
      console.log('[quiz-start] ' + jobId + ' dispatched');
      return json(res, 200, {
        jobId,
        questions: [],
        hasMore: true,
        state: 'working',
      });
    });
    return;
  }

  const mJob = urlPath.match(/^\/api\/quiz\/job\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && mJob) {
    const jobId = mJob[1];
    const jobDir = path.join(__dirname, 'assets', 'banks', 'generated_jobs');
    const fRest = path.join(jobDir, jobId + '.rest.json');
    const fFull = path.join(jobDir, jobId + '.full.json');
    const fFirst = path.join(jobDir, jobId + '.first.json');
    const fProg = path.join(jobDir, jobId + '.progress.json');
    const ent = quizJobs.get(jobId);
    const alive = !!(ent && !ent.done && ent.proc && ent.proc.exitCode == null);

    const readJson = (f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    };

    // 1) انتهى التوليد: المصدر النهائي.
    if (fs.existsSync(fRest)) {
      const j = readJson(fRest);
      if (j) {
        return json(res, 200, { state: 'done', questions: j.questions || [] });
      }
    }
    if (fs.existsSync(fFull)) {
      return json(res, 200, { state: 'done', questions: [] });
    }

    // 2) ما زال يولّد: نقدّم كل ما وصل حتى الآن (بثّ تدريجي).
    const prog = fs.existsSync(fProg) ? readJson(fProg) : null;
    const first = fs.existsSync(fFirst) ? readJson(fFirst) : null;
    const acc = (first && first.questions) || [];
    if (prog && prog.questions) acc.push(...prog.questions);
    const known =
      acc.length || alive || fs.existsSync(fProg) || fs.existsSync(fFirst);
    if (known) {
      return json(res, 200, {
        state: acc.length ? 'working' : alive ? 'working' : 'error',
        questions: acc,
        hasMore: true,
      });
    }
    return json(res, 404, { error: 'JOB_NOT_FOUND' });
  }

  // بث ملف مراجعة عبر السيرفر كوسيط ? روابط Releases لا ترسل ترويسات
  // CORS فيرفضها متصفح الويب، لذا نجلب البايتات نحن ونعيد بثها.
  if (req.method === 'GET' && urlPath.startsWith('/api/review-files/file')) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'طلب غير صالح' });
    }
    let target = '';
    try {
      target = decodeURIComponent(parsed.searchParams.get('path') || '');
    } catch {}
    if (!/^assets\/(?:assets\/)?review_files\/.+\.pdf$/i.test(target)) {
      return json(res, 400, { error: 'مسار غير مدعوم' });
    }
    const done404 = () => json(res, 404, { error: 'الملف غير موجود' });
    const CACHE_DIR = path.join(__dirname, 'assets', 'review_files_cache');

    // 1) تحديد مصدر الملف: رابط إصدار، مسار مسطح، أو محلي
    let remoteUrls = releaseUrlsFor(target);
    let remoteUrl = remoteUrls ? remoteUrls[0] : '';
    let cacheKey = '';
    if (remoteUrls) {
      cacheKey = path.basename(remoteUrl);
    } else {
      const flatMatch = target.replace(/^\/+/, '').match(
        /assets(?:\/assets)?\/review_files\/([a-z0-9_]+)__(\d+)\.pdf$/i
      );
      if (flatMatch) {
        remoteUrls = RELEASE_BASES.map((b) => b + flatMatch[1] + '__' + flatMatch[2] + '.pdf');
        remoteUrl = remoteUrls[0];
        cacheKey = flatMatch[1] + '__' + flatMatch[2] + '.pdf';
      } else {
        const bare = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '_');
        const bareMatch = bare.match(/^([a-z0-9_]+)__\d+\.pdf$/i);
        if (bareMatch) {
          remoteUrls = RELEASE_BASES.map((b) => b + bare);
          remoteUrl = remoteUrls[0];
          cacheKey = bare;
        }
      }
    }

    // يخدم ملف PDF محليًا مع ترويسات CORS (يعيد res أو false).
    const servePdfFile = (file) => {
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) return false;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': st.size,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        return fs.createReadStream(file).pipe(res);
      } catch (_) {
        return false;
      }
    };

    const BAKED_DIR = path.join(__dirname, 'assets', 'review_baked_cache');

    // يبني PDF صفحاته صور (MuPDF) فيُعرض بشكل صحيح في pdf.js، ثم يخدمه.
    // لو تعذّر البناء يُخدم الملف الأصلي كما هو.
    const bakeAndServe = (cacheKey, sourceFile) => {
      const safe = cacheKey.replace(/[^a-zA-Z0-9._-]/g, '_');
      const bakedPdf = path.join(BAKED_DIR, safe);
      if (fs.existsSync(bakedPdf)) return servePdfFile(bakedPdf);
      try { fs.mkdirSync(BAKED_DIR, { recursive: true }); } catch {}
      const { spawn } = require('child_process');
      const proc = spawn('python', [
        path.join(__dirname, 'tools', 'review_to_baked_pdf.py'),
        '--pdf', sourceFile,
        '--out', bakedPdf,
        '--zoom', '1.5',
        '--quality', '60',
        '--max-side', '1400',
      ], { windowsHide: true });
      const killer = setTimeout(() => proc.kill(), 180000);
      proc.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0 && fs.existsSync(bakedPdf)) return servePdfFile(bakedPdf);
        return servePdfFile(sourceFile) || done404();
      });
      proc.on('error', () => {
        clearTimeout(killer);
        return servePdfFile(sourceFile) || done404();
      });
    };

    // ينزّل الملف كاملاً إلى الكاش ثم يستدعي cb(نجاح؟).
    // urls: رابط واحد أو قائمة روابط تُجرَّب بالترتيب.
    const downloadTo = (urls, dest, cb) => {
      const list = Array.isArray(urls) ? urls : [urls];
      const go = (u, tries) => {
        if (tries > 5) return cb(false);
        https.get(u, { headers: { 'User-Agent': 'masar-server' } }, (r) => {
          if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume(); return go(r.headers.location, tries + 1);
          }
          if (r.statusCode !== 200) {
            r.resume();
            // جرّب الرابط التالي (إصدار قديم) قبل الفشل النهائي.
            const next = list[list.indexOf(u) + 1];
            if (next) return go(next, 0);
            return cb(false);
          }
          try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch {}
          const tmp = dest + '.part';
          const w = fs.createWriteStream(tmp);
          w.on('finish', () => fs.rename(tmp, dest, () => cb(true)));
          w.on('error', () => { try { fs.unlink(tmp, () => {}); } catch {} cb(false); });
          r.pipe(w);
        }).on('error', () => {
          const next = list[list.indexOf(u) + 1];
          if (next) return go(next, 0);
          cb(false);
        });
      };
      go(list[0], 0);
    };

    // 2) خدمة من الكاش المحلي + بناء نسخة صور
    if (cacheKey) {
      const safe = cacheKey.replace(/[^a-zA-Z0-9._-]/g, '_');
      const cacheFile = path.join(CACHE_DIR, safe);
      if (fs.existsSync(cacheFile)) return bakeAndServe(cacheKey, cacheFile);
      return downloadTo(remoteUrls, cacheFile, (ok) => {
        if (ok && fs.existsSync(cacheFile)) return bakeAndServe(cacheKey, cacheFile);
        return done404();
      });
    }

    // 3) ملف محلي فقط
    try {
      const localFile = path.join(__dirname, target);
      if (fs.statSync(localFile).isFile()) return servePdfFile(localFile) || done404();
    } catch (_) {}
    return done404();
  }

  // محوّل صفحات-PNG للمراجع (MuPDF): يحرّر العارض المتصفح من تشكيل الحروف
  // العربية بصيغة pdf.js التي تفسد الملفات غير المضمّنة الخط.
  if (req.method === 'GET' && urlPath.startsWith('/api/review-files/meta')) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'طلب غير صالح' });
    }
    let target = '';
    try {
      target = decodeURIComponent(parsed.searchParams.get('path') || '');
    } catch {}
    if (!/^assets\/(?:assets\/)?review_files\/.+\.pdf$/i.test(target)) {
      return json(res, 400, { error: 'مسار غير مدعوم' });
    }
    const done404 = () => json(res, 404, { error: 'الملف غير موجود' });
    const CACHES = {
      pdf: path.join(__dirname, 'assets', 'review_files_cache'),
      png: path.join(__dirname, 'assets', 'review_pages_cache'),
    };

    // تحديد الملف المصدر بنفس منطق /api/review-files/file
    let cacheKey = '';
    let localSource = '';
    {
      let remoteUrl = releaseUrlFor(target);
      if (remoteUrl) {
        cacheKey = path.basename(remoteUrl);
      } else {
        const flat = target.replace(/^\/+/, '').match(
          /assets(?:\/assets)?\/review_files\/([a-z0-9_]+)__(\d+)\.pdf$/i
        );
        if (flat) {
          cacheKey = flat[1] + '__' + flat[2] + '.pdf';
        } else {
          const bare = path.basename(target);
          if (bare) {
            const safeBare = bare.replace(/[^a-zA-Z0-9._-]/g, '_');
            if (/^([a-z0-9_]+)__\d+\.pdf$/i.test(safeBare)) cacheKey = safeBare;
          }
        }
      }
      localSource = path.join(__dirname, target);
    }

    const base = (cacheKey || path.basename(localSource)).replace(/\.pdf$/i, '');
    const pngDir = path.join(CACHES.png, base);
    const metaFile = path.join(pngDir, 'meta.json');

    const srcFile = cacheKey ? path.join(CACHES.pdf, cacheKey) : localSource;
    const genMeta = (cb) => {
      const { spawn } = require('child_process');
      const proc = spawn('python', [
        path.join(__dirname, 'tools', 'review_to_png.py'),
        '--pdf', srcFile,
        '--out', pngDir,
        '--zoom', String(PNG_ZOOM),
        '--meta-only',
      ], { windowsHide: true });
      const killer = setTimeout(() => proc.kill(), 30000);
      proc.on('close', (code) => {
        clearTimeout(killer);
        cb(code === 0);
      });
      proc.on('error', () => { clearTimeout(killer); cb(false); });
    };

    const respond = () => {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        let ready = false;
        try {
          ready = (fs.readdirSync(pngDir) || []).filter((f) => /^p\d+\.png$/.test(f)).length >= meta.pages;
        } catch (_) {}
        return json(res, 200, { mode: 'png', zoom: meta.zoom, pages: meta.pages, ready: !!ready, natural: meta.natural });
      } catch (_) {
        return json(res, 200, { mode: 'pdf' });
      }
    };

    const srcExists = (() => {
      try {
        return fs.statSync(srcFile).isFile();
      } catch {
        return false;
      }
    })();
    if (!srcExists) return done404();
    if (!fs.existsSync(metaFile)) {
      return genMeta((ok) => {
        if (!ok) return json(res, 200, { mode: 'pdf' });
        respond();
      });
    }
    return respond();
  }

  // خدمة صورة صفحة معينة للمرجع.
  if (req.method === 'GET' && urlPath.startsWith('/api/review-files/page')) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'طلب غير صالح' });
    }
    let target = '';
    let p = 1;
    try {
      target = decodeURIComponent(parsed.searchParams.get('path') || '');
      p = parseInt(parsed.searchParams.get('p') || '1', 10);
    } catch {}
    if (!/^assets\/(?:assets\/)?review_files\/.+\.pdf$/i.test(target) || !(p >= 1 && p <= 9999)) {
      return json(res, 400, { error: 'معاملات غير صالحة' });
    }
    const CACHE_PDF = path.join(__dirname, 'assets', 'review_files_cache');
    let cacheKey = '';
    {
      let remoteUrl = releaseUrlFor(target);
      if (remoteUrl) cacheKey = path.basename(remoteUrl);
      else {
        const flat = target.replace(/^\/+/, '').match(/assets(?:\/assets)?\/review_files\/([a-z0-9_]+)__(\d+)\.pdf$/i);
        if (flat) cacheKey = flat[1] + '__' + flat[2] + '.pdf';
        else {
          const safeBare = path.basename(target).replace(/[^a-zA-Z0-9._-]/g, '_');
          if (/^([a-z0-9_]+)__\d+\.pdf$/i.test(safeBare)) cacheKey = safeBare;
        }
      }
    }
    const localSource = path.join(__dirname, target);
    const srcFile = cacheKey ? path.join(CACHE_PDF, cacheKey) : localSource;
    const base = (cacheKey || path.basename(localSource)).replace(/\.pdf$/i, '');
    const pngDir = path.join(__dirname, 'assets', 'review_pages_cache', base);
    const pngFile = path.join(pngDir, `p${String(p).padStart(2, '0')}.png`);

    const streamPage = () => {
      try {
        const st = fs.statSync(pngFile);
        if (!st.isFile()) return false;
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': st.size,
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*',
        });
        fs.createReadStream(pngFile).pipe(res);
        return true;
      } catch (_) {
        return false;
      }
    };

    if (streamPage()) return;

    // الصفحة غير موجودة: نرسمها وحدها عند الطلب (مع قفل يمنع تكرار نفس الصفحة).
    try {
      if (!fs.statSync(srcFile).isFile()) {
        return json(res, 404, { error: 'الملف غير موجود' });
      }
    } catch (_) {
      return json(res, 404, { error: 'الملف غير موجود' });
    }

    const jobKey = base + '#' + p;
    let job = pageJobs.get(jobKey);
    if (!job) {
      job = new Promise((resolve) => {
        const { spawn } = require('child_process');
        const proc = spawn('python', [
          path.join(__dirname, 'tools', 'review_to_png.py'),
          '--pdf', srcFile,
          '--out', pngDir,
          '--zoom', String(PNG_ZOOM),
          '--page', String(p),
        ], { windowsHide: true });
        const killer = setTimeout(() => proc.kill(), 60000);
        const finish = () => { clearTimeout(killer); pageJobs.delete(jobKey); resolve(); };
        proc.on('close', finish);
        proc.on('error', finish);
      });
      pageJobs.set(jobKey, job);
    }
    job.then(() => {
      if (streamPage()) return;
      return json(res, 500, { error: 'تعذّر توليد الصفحة' });
    });
    return;
  }

  // قائمة ملفات المراجعة من القرص مباشرة — بديل عندما يكون المانيفست قديماً أو غير متاح
  if (req.method === 'GET' && urlPath.startsWith('/api/review-files/list')) {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://localhost');
    } catch {
      return json(res, 400, { error: 'طلب غير صالح' });
    }
    let folder = '';
    try {
      folder = decodeURIComponent(parsed.searchParams.get('folder') || '');
    } catch {}
    const safe = folder.replace(/[\/\\]/g, '').trim();
    if (!safe) return json(res, 400, { error: 'folder مطلوب' });
    const dir = path.join(__dirname, 'assets', 'review_files', safe);
    fs.readdir(dir, (err, entries) => {
      if (err) entries = [];
      const files = (entries || [])
        .filter((f) => f.toLowerCase().endsWith('.pdf'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((f) => ({
          path: `assets/review_files/${safe}/${f}`,
          name: f.replace(/\.pdf$/i, ''),
          url: releaseUrlFor(`assets/review_files/${safe}/${f}`),
        }));
      const done = (files) => {
        console.log(`[review-files] ${safe} -> ${files.length} pdf`);
        return json(res, 200, { files });
      };
      if (files.length > 0) return done(files);
      // لا ملفات محلية؟ اسأل المانيفست السحابي في GitHub (مصدر الملفات الرسمي).
      const PAGES_BASE = 'https://fahdzoubayr-creator.github.io/masar/';
      const SOURCES = [
        // ????? ??????? ????? ? ???? ?? ????? ????? ??? ?????? ????? ??? ??????.
        'https://raw.githubusercontent.com/fahdzoubayr-creator/masar/main/assets/assets/review_files/manifest.json',
        PAGES_BASE + 'assets/assets/review_files/manifest.json',
      ];
      if (remoteManifestCache.data && Date.now() - remoteManifestCache.t < 300000) {
        return done(toCloudFiles(remoteManifestCache.data[safe] || [], PAGES_BASE));
      }
      const tryFetch = (i) => {
        if (i >= SOURCES.length) return done([]);
        https
          .get(SOURCES[i], { headers: { 'User-Agent': 'masar-server' } }, (r) => {
            let b = '';
            r.on('data', (c) => (b += c));
            r.on('end', () => {
              if (r.statusCode !== 200) {
                console.warn('[review-files] source', i, 'status', r.statusCode);
                return tryFetch(i + 1);
              }
              try {
                const m = JSON.parse(b);
                remoteManifestCache = { t: Date.now(), data: m };
                return done(toCloudFiles(m[safe] || [], PAGES_BASE));
              } catch (e) {
                console.warn('[review-files] parse error', e.message);
                return tryFetch(i + 1);
              }
            });
          })
          .on('error', (e) => {
            console.warn('[review-files] fetch error', e.message);
            tryFetch(i + 1);
          });
      };
      tryFetch(0);
    });
    return;
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';
  // أسماء الأصول العربية تُخزَّن مشفّرة على القرص (ترميز URL) في build/web —
  // نجرّب المسار المفكوك ثم المسار الخام (المشفر) عند خدمة الملفات الثابتة.
  const rawPath = new URL(req.url, 'http://localhost').pathname;
  const candidates = [urlPath];
  if (rawPath && rawPath !== urlPath) candidates.push(rawPath);
  for (const candidate of candidates) {
    let filePath = path.join(ROOT, candidate);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        // [masar-jawaaher-embed] حقن الدمج عند خدمة index.html
        if (ext === '.html' && path.basename(filePath).toLowerCase() === 'index.html') {
          const html = fs.readFileSync(filePath, 'utf8');
          if (html.indexOf('masar-jawaaher-embed') === -1) {
            const patched = injectJawaaherEmbed(html);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Content-Length': Buffer.byteLength(patched),
              'Cache-Control': 'no-cache',
            });
            return res.end(patched);
          }
        }
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    } catch (_) {
      // جرّب المرشح التالي
    }
  }
  res.writeHead(404);
  return res.end('Not Found');
};

// خادم HTTP (للأجهزة التي لا تصل إلى HTTPS ولتطبيق الهاتف).

// ===== [masar-jawaaher-embed] دمج لعبة «جواهر الكفاءة» داخل التطبيق =====
// يُحقن الشريط البرمجي في أي index.html يُخدَم، حتى لا يختفي الدمج بعد
// إعادة البناء أو استبدال index.html. المصدر: tools/jawaaher_embed/.
const JAWAAHER_EMBED_PATH = path.join(
  __dirname,
  'tools',
  'jawaaher_embed',
  'jawaaher_embed.html',
);
let jawaaherEmbedSnippet;
function getJawaaherEmbedSnippet() {
  if (jawaaherEmbedSnippet !== undefined) return jawaaherEmbedSnippet;
  try {
    jawaaherEmbedSnippet = fs.readFileSync(JAWAAHER_EMBED_PATH, 'utf8');
  } catch {
    jawaaherEmbedSnippet = '';
  }
  return jawaaherEmbedSnippet;
}
function injectJawaaherEmbed(html) {
  if (!html || html.indexOf('masar-jawaaher-embed') !== -1) return html;
  const snippet = getJawaaherEmbedSnippet();
  if (!snippet) return html;
  const anchor = '<script src="flutter_bootstrap.js" async></script>';
  const i = html.indexOf(anchor);
  if (i !== -1) return html.slice(0, i) + snippet + '\n  ' + html.slice(i);
  const j = html.lastIndexOf('</body>');
  return j !== -1 ? html.slice(0, j) + snippet + '\n' + html.slice(j) : html;
}
// ===== [/masar-jawaaher-embed] =====

const server = http.createServer(handler);

// ===== خادم إشارات WebSocket (نقل رسائل الغرفة فقط — لا يمرر الصوت/الفيديو) =====
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** الغرف: room -> Set<client> */
const rooms = new Map();

/** حالة القاعات الصوتية: room -> { host, queue: [], speakers: [], muted: [] } */
const voiceRooms = new Map();

/** مشرف كل قاعة (فيديو أو صوتي): room -> peerId — قاعة واحدة لا تتضمن أكثر من مشرف. */
const roomHosts = new Map();

/** سجل رسائل الدردشة لإيصالات الوصول/القراءة: room -> Map<msgId, senderPeerId> */
const chatLogs = new Map();

/** سجل رسائل الدردشة للوافدين الجدد: room -> [message...] (آخر 100 رسالة). */
const chatHistory = new Map();

/** الحد الأقصى لرسائل السجل المرسلة لمن يدخل القاعة. */
const CHAT_HISTORY_LIMIT = 100;

function pushChatHistory(room, message) {
  if (!chatHistory.has(room)) chatHistory.set(room, []);
  const list = chatHistory.get(room);
  list.push(message);
  if (list.length > CHAT_HISTORY_LIMIT) list.splice(0, list.length - CHAT_HISTORY_LIMIT);
}

/** سجل القاعات الدائم (يُحفظ على القرص ويُحمَّل عند الإقلاع):
 *  roomId -> { id, name, creatorName, creatorKey,
 *              coordinators: [{name, key}], createdAt,
 *              access: 'public'|'code', inviteCode, lastUsedAt }
 *  القاعات الخاصة (رمز الدعوة) تبقى مسجلة لصاحبها حتى تُحذف تلقائياً
 *  بعد 30 يوماً من آخر دخول. */
const roomRegistry = new Map();

let roomSeq = 0;
function createRoomId() {
  roomSeq += 1;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `R${s}${roomSeq.toString(36).toUpperCase()}`;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** يولّد رمز دعوة فريداً (6 أحرف) للقاعات الخاصة. */
function createInviteCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let s = '';
    for (let i = 0; i < 6; i++) {
      s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    let clash = false;
    for (const room of roomRegistry.values()) {
      if (room.inviteCode === s) {
        clash = true;
        break;
      }
    }
    if (!clash) return s;
  }
  return `INV${Date.now().toString(36).toUpperCase()}`;
}

// ===== شات القاعات الدائم على الخادم (آخر 15 يوماً لكل قاعة) =====
// يُخزَّن في rooms_chat.json بجانب الخادم. التنسيق:
// { "rooms": { "<مفتاح قاعة صغير>": [ {m,s,i,t,ms} ] } }
const CHAT_FILE = path.join(__dirname, 'rooms_chat.json');
const CHAT_TTL_MS = 15 * 24 * 60 * 60 * 1000; // 15 يوماً — تُحذف الأقدم تلقائياً
const CHAT_MAX_PER_ROOM = 500; // أقصى رسائل محفوظة لكل قاعة
const CHAT_MAX_TEXT = 2000; // أقصى طول لرسالة الشات
const roomChats = new Map(); // chatKey -> [{m,s,i,t,ms}]
let chatSaveTimer = null;

/** يوحّد مفتاح قاعة الشات (بنفس نظام توكنات LiveKit: صغير ومنجز). */
function chatKeyOf(room) {
  return String(room || '').trim().slice(0, 64).toLowerCase();
}

/** يشطّ رسائل قاعة: يحذف المتجاوزة عمرها 15 يوماً ويبقي آخر 500. */
function chatPrune(list) {
  const cutoff = Date.now() - CHAT_TTL_MS;
  return list.filter((m) => Number(m.ms) >= cutoff).slice(-CHAT_MAX_PER_ROOM);
}

/** يحمّل تاريخ الشات من القرص عند الإقلاع. */
function chatLoad() {
  try {
    const data = store.enabled()
      ? store.readJson('rooms_chat.json', null)
      : JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
    if (store.enabled() && !data) return; // لا شات بعد — نبدأ فارغين
    const rooms = data && typeof data.rooms === 'object' ? data.rooms : {};
    for (const [key, arr] of Object.entries(rooms)) {
      if (Array.isArray(arr) && arr.length) roomChats.set(key, chatPrune(arr));
    }
    console.log(`[chat] load ${roomChats.size} room(s) history from ${CHAT_FILE}`);
  } catch {
    // لا يوجد ملف شات بعد — نبدأ فارغاً.
  }
};

/** يكتب ملف الشات على القرص فوراً. */
function chatSaveNow() {
  try {
    const rooms = {};
    for (const [key, arr] of roomChats.entries()) {
      const pruned = chatPrune(arr);
      if (pruned.length) rooms[key] = pruned;
      else roomChats.delete(key);
    }
    const payload = { rooms };
    if (store.enabled()) {
      store.writeJson('rooms_chat.json', payload);
      return;
    }
    fs.writeFileSync(CHAT_FILE, JSON.stringify(payload), 'utf8'); // مضغوط — لا فراغات
  } catch (e) {
    console.error('[chat] فشل حفظ الشات:', e.message);
  }
};

/** يجمّع الكتابات — القرص يُلمس مرة كل ثانيتين مهما توالت الإرسال. */
function chatSaveSoon() {
  if (chatSaveTimer) return;
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    chatSaveNow();
  }, 2000);
}

/** تنقية دورية كل 30 دقيقة: تنتهي الرسائل القديمة وتفرغ المفاتيح. */
function chatSweep() {
  let changed = false;
  for (const [key, arr] of roomChats.entries()) {
    const pruned = chatPrune(arr);
    if (pruned.length !== arr.length) changed = true;
    if (pruned.length) roomChats.set(key, pruned);
    else roomChats.delete(key);
  }
  if (changed) chatSaveNow();
}

/** يحمّل السجل الدائم من القرص عند إقلاع الخادم. */
function loadRegistry() {  try {
    const data = store.enabled()
      ? store.readJson('rooms_data.json', null)
      : JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (store.enabled() && !data) return; // لا سجل بعد — نبدأ فارغين
    const rooms = Array.isArray(data.rooms) ? data.rooms : [];
    let maxSeq = 0;
    for (const r of rooms) {
      if (!r || !r.id) continue;
      const access = r.access === 'code' ? 'code' : 'public';
      roomRegistry.set(r.id, {
        id: r.id,
        name: String(r.name || 'قاعة'),
        creatorName: String(r.creatorName || 'مستخدم'),
        creatorKey: String(
          r.creatorKey || String(r.creatorName || '').toLowerCase()
        ),
        coordinators: Array.isArray(r.coordinators) ? r.coordinators : [],
        createdAt: Number(r.createdAt) || Date.now(),
        access,
        stage: normalizeStage(String(r.stage || '')),
        inviteCode: access === 'code' ? String(r.inviteCode || '') : undefined,
        lastUsedAt: Number(r.lastUsedAt) || Date.now(),
      });
      const idSuffix = r.id.replace(/^R[A-Z0-9]{5}/, '');
      const seq = parseInt(idSuffix, 36);
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
    roomSeq = maxSeq;
    console.log(`[registry] load ${roomRegistry.size} room(s) from ${DATA_FILE}`);
  } catch (_) {
    // لا يوجد ملف سجل بعد — نبدأ بسجل فارغ.
  }
}

// ===== تعليقات تطوير البطاقات الست (ملاحظات الأعضاء — كلٌّ بحد 40 كلمة) =====
// تُخزَّن في card_comments.json: [ {card,name,text,ms} ]
const CARD_COMMENTS_FILE = path.join(__dirname, 'card_comments.json');
const CARD_KEYS = [
  'review',
  'quiz',
  'jawaaher',
  'history',
  'mindMaps',
  'liveRoom',
];
const cardComments = [];
let cardCommentsSaveTimer = null;

function cardCommentsLoad() {
  try {
    const arr = store.enabled()
      ? store.readJson('card_comments.json', null)
      : JSON.parse(fs.readFileSync(CARD_COMMENTS_FILE, 'utf8'));
    if (store.enabled() && !arr) return; // لا تعليقات بعد — نبدأ فارغين
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && e.card && e.text) cardComments.push(e);
      }
    }
    console.log(`[cards] load ${cardComments.length} comment(s)`);
  } catch {
    // لا يوجد ملف بعد — نبدأ فارغين.
  }
}

function cardCommentsSaveNow() {
  try {
    // حد التخزين الكلي: آخر 2000 تعليق فقط تكفي — الأقدم يزول من الطرف.
    while (cardComments.length > 2000) cardComments.shift();
    if (store.enabled()) {
      store.writeJson('card_comments.json', cardComments);
      return;
    }
    fs.writeFileSync(
      CARD_COMMENTS_FILE,
      JSON.stringify(cardComments),
      'utf8'
    );
  } catch (e) {
    console.error('[cards] فشل حفظ التعليقات:', e.message);
  }
}

function cardCommentsSaveSoon() {
  if (cardCommentsSaveTimer) return;
  cardCommentsSaveTimer = setTimeout(() => {
    cardCommentsSaveTimer = null;
    cardCommentsSaveNow();
  }, 2000);
}

/** يحفظ السجل الدائم على القرص (بعد أي إنشاء/حذف/تغيير). */
function saveRegistry() {  try {
    const rooms = [];
    for (const r of roomRegistry.values()) {
      rooms.push({
        id: r.id,
        name: r.name,
        creatorName: r.creatorName,
        creatorKey: r.creatorKey,
        coordinators: r.coordinators,
        createdAt: r.createdAt,
        access: r.access,
        stage: r.stage || '',
        inviteCode: r.inviteCode,
        lastUsedAt: r.lastUsedAt,
      });
    }
    const payload = { rooms };
    if (store.enabled()) {
      store.writeJson('rooms_data.json', payload);
      return;
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('[registry] فشل حفظ السجل:', e.message);
  }
}

/** يحدّث زمن آخر استخدام للقاعة (عند كل دخول ناجح). */
function touchRoom(id) {
  const room = roomRegistry.get(id);
  if (!room) return;
  room.lastUsedAt = Date.now();
  saveRegistry();
}

/** يحذف تلقائياً القاعات غير المستخدمة منذ 30 يوماً. */
function cleanupExpiredRooms() {
  const now = Date.now();
  let removed = 0;
  for (const [id, room] of roomRegistry) {
    const lastUse = room.lastUsedAt || room.createdAt || now;
    if (now - lastUse <= ROOM_TTL_MS) continue;
    const days = Math.floor((now - lastUse) / (24 * 60 * 60 * 1000));
    console.log(
      `[room-expired] ${id} «${room.name}» — غير مستخدمة منذ ${days} يوماً — حُذفت تلقائياً`
    );
    roomRegistry.delete(id);
    const set = rooms.get(id);
    if (set && set.size > 0) {
      broadcast(id, { type: 'room-deleted' });
      for (const c of [...set]) disconnect(c);
    } else {
      rooms.delete(id);
      voiceRooms.delete(id);
      roomHosts.delete(id);
      chatLogs.delete(id);
      chatHistory.delete(id);
    }
    removed++;
  }
  if (removed > 0) saveRegistry();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

// ================================================================
// ============ حضور المستخدمين (Presence) — عدّاد المتصلين ======
// ================================================================
//
// يسجّل كل جهاز الفضاء الذي دخله (بطاقة من لوحة التحضير)، ويُرجع عدد
// الحاضرين في كل فضاء لعرضه أسفل البطاقات. السجلات تنتهي تلقائياً بعد
// PRESENCE_TTL ثانية فيُحذف المستخدم المتوقف أو المُغلق لل��browser فوراً.
const PRESENCE_TTL = 70 * 1000;
const presence = new Map(); // id -> { space, ts }

function presencePrune() {
  const now = Date.now();
  for (const [id, rec] of presence) {
    if (now - rec.ts > PRESENCE_TTL) presence.delete(id);
  }
}

function presenceCounts() {
  presencePrune();
  const counts = {};
  for (const rec of presence.values()) {
    const s = String(rec.space || 'lobby');
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

// ================================================================
// ==================== LiveKit (إنتاج) ===========================
// ================================================================

/** إعدادات LiveKit — لا قيم افتراضية للأسرار: تُقرأ من البيئة حصراً. */
const LK = {
  apiKey: process.env.LIVEKIT_API_KEY || '',
  apiSecret: process.env.LIVEKIT_API_SECRET || '',
  url: process.env.LIVEKIT_URL || '',
  roomPrefix: process.env.LIVEKIT_ROOM_PREFIX || 'Ehtiraf_',
  maxParticipants: Number(process.env.LIVEKIT_MAX_PARTICIPANTS) || 50,
  /** حد الكاميرات المتزامنة في القاعة (1-2 وفق اشتراطات المشروع). */
  maxCameras: Math.min(2, Math.max(1, Number(process.env.MAX_CAMERA_PUBLISHERS) || 2)),
};

const lkConfigured = () => !!(LK.apiKey && LK.apiSecret);

/** خزان مقاعد المنسق: اسم القاعة → لحظة آخر حجز. أول رقية لقاعة
 * فارغة تحجز المقعد عشر ثوانٍ لتفادي سباق توكني نافذتين متزامنتين. */
const coordSlot = new Map();
const COORD_SLOT_TTL = 10;

// === عنوان LiveKit الذكي: يستكشف عنوان الجهاز LAN الحالي عند كل استعمال ===
// عنوان الجهاز يتغير مع DHCP؛ لا يجوز تثبيته. المتغير LIVEKIT_URL يقبل:
//   ws://<ip>:<port>   عنوان صريح (يتقدم على الكشف)
//   ws://AUTO:<port>   كشف تلقائي للعنوان الحالي (المنفذ الافتراضي 7880)
//   فارغ               كشف تلقائي كامل
const osModule = require('os');

/** عنوان IPv4 الحقيقي للجهاز على الشبكة — يفضل 192.168/10/172 ثم اسم منفذ شبكي مألوف. */
function lanIp() {
  const v4 = [];
  for (const [name, addrs] of Object.entries(osModule.networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        v4.push({ name, addr: a.address });
      }
    }
  }
  const rank = (x) => {
    const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.addr);
    return priv ? 0 : 1;
  };
  v4.sort((a, b) => rank(a) - rank(b));
  return v4.length ? v4[0].addr : '127.0.0.1';
}

/** عنوان LiveKit الفعلي في هذه اللحظة — يُحسب عند كل استعمال. */
function lkUrl() {
  const raw = String(process.env.LIVEKIT_URL || '').trim();
  const m = raw.match(/^wss?:\/\/(?:AUTO|auto|0\.0\.0\.0)(:\d+)?$/);
  if (m) return `ws://${lanIp()}${m[1] || ':7880'}`;
  if (raw) return raw;
  return `ws://${lanIp()}:7880`;
}

const b64urlJson = (obj) =>
  Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

/** يوقّع توكن HS256 بنفس صيغة LiveKit. */
function lkSign(payload) {
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64urlJson(payload);
  const sig = crypto
    .createHmac('sha256', LK.apiSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** يتحقق من توكن صادر عن هذا الخادم ويعيد حمولته أو null. */
function lkVerify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto
    .createHmac('sha256', LK.apiSecret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** ينظّف اسم القاعة المنطقي ويضيف البادئة — المرجعية للخادم لا للعميل. */
// صيغة التحويل الصوتي المطابقة لعميل Flutter في audio_room_config.dart
const AR_TRANS = {
  'ا': 'a', 'أ': 'a', 'إ': 'i', 'آ': 'aa', 'ء': 'a', 'ئ': 'y', 'ؤ': 'w',
  'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'dh', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh',
  'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh',
  'ف': 'f', 'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n',
  'ه': 'h', 'و': 'w', 'ي': 'y', 'ى': 'a', 'ة': 'h',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '\u064B': '', '\u064C': '', '\u064D': '', '\u064E': '',
  '\u064F': '', '\u0650': '', '\u0651': '', '\u0652': '',
  '\u0640': '', '\u0670': '',
};

// FNV-1a 32-bit — مطابق لـ _stableHash في العميل.
function stableHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h = (h ^ (c & 0xff)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
    h = (h ^ (c >> 8)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * ينظّف اسم القاعة المنطقي ويضيف البادئة — المرجعية للخادم لا للعميل.
 * التحويل الصوتي يمنع انهيار الأسماء العربية إلى محرف واحد (تسرب صوت
 * سابق)، والهَشّ الثابت يضمن فريدية اسمن مختلفين.
 */
function sanitizeRoomName(input) {
  const raw = String(input || '').trim();
  let cleaned = '';
  for (const ch of raw) {
    if (Object.prototype.hasOwnProperty.call(AR_TRANS, ch)) cleaned += AR_TRANS[ch];
    else if (/[A-Za-z0-9_-]/.test(ch)) cleaned += ch;
    else cleaned += '_';
  }
  cleaned = cleaned.replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'Room';
  if (/[^\x00-\x7F]/.test(raw)) {
    if (cleaned.length > 54) cleaned = cleaned.slice(0, 54);
    cleaned = `${cleaned}-h${stableHash(raw)}`;
  }
  return cleaned;
}
/** اسم القاعة خادم البث. متكافئ: الاسم المهيّأ مسبقاً (بنية
 * `Ehtiraf_...`) يعاد كما هو فلا تتضاعف البادئة عملياً. */
const lkRoomName = (logical) => {
  const s = String(logical || '');
  if (LK.roomPrefix && s.startsWith(LK.roomPrefix)) return s;
  return LK.roomPrefix + sanitizeRoomName(s);
};

/** حد معدل بسيط: 30 طلب توكن في الدقيقة لكل عنوان IP. */
const tokenRate = new Map();
function tokenRateLimited(ip) {
  const now = Date.now();
  const arr = (tokenRate.get(ip) || []).filter((t) => now - t < 60000);
  if (arr.length >= 30) {
    tokenRate.set(ip, arr);
    return true;
  }
  arr.push(now);
  tokenRate.set(ip, arr);
  if (tokenRate.size > 5000) tokenRate.clear();
  return false;
}

async function handleLiveKitApi(req, res, urlPath) {
  // فحص جاهزية الخدمة.
  if (req.method === 'GET' && urlPath === '/api/livekit/health') {
    return json(res, 200, { ok: true, configured: lkConfigured() });
  }

  if (!lkConfigured()) {
    return json(res, 503, { error: 'خدمة القاعات غير مهيأة على الخادم بعد.' });
  }

  // إصدار توكن انضمام — البديل الآمن للتوقيع داخل التطبيق.
  if (req.method === 'POST' && urlPath === '/api/livekit/token') {
    const ip = req.socket.remoteAddress || '?';
    if (tokenRateLimited(ip)) {
      return json(res, 429, { error: 'طلبات كثيرة — أعد المحاولة بعد قليل.' });
    }
    const body = await readBody(req);
    let logicalRoom = String(body.room || '').trim().slice(0, 64);
    const name = String(body.name || '').trim().slice(0, 48) || '?????';
    // توحيد مفتاح الغرفة: أي كود محلي/رمز دعوة/معرف دليل يُترجم إلى
    // اسم القاعة المنشورة — حتى يجتمع المنشئ والمنضم في نفس الغرفة.
    try {
      const raw = logicalRoom;
      const norm = (s) => String(s || '').trim().toLowerCase();
      let stripped = raw.startsWith('Ehtiraf_') ? raw.slice(8) : raw;
      if (stripped.endsWith('_Open')) stripped = stripped.slice(0, -5);
      for (const r of roomRegistry.values()) {
        if (
          norm(raw) === norm(r.name) ||
          raw === r.id ||
          raw === `dir_${r.id}` ||
          (r.inviteCode && r.inviteCode === raw.toUpperCase()) ||
          norm(stripped) === norm(r.name) ||
          // مطابقة تحويلية تامة: كود «قاعة مفتوحة» اشتقّه العميل من
          // الاسم العربي (`Ehtiraf_<تحويلي+هَشّ>_Open`) يُقارن ضد
          // sanitize الاسم المنشور نفسه — تطابق يضمن الفريدية بالهَشّ.
          (r.access !== 'code' &&
            norm(stripped) === norm(sanitizeRoomName(r.name)) &&
            stripped.length > 0)
        ) {
          logicalRoom = r.name;
          break;
        }
      }
    } catch {}
    let role = body.role === 'coordinator' ? 'coordinator' : 'member';
    if (!logicalRoom) {
      return json(res, 400, { error: '??? ?????? ?????.', });
    }
    // مصدر الحقيقة: القاعة المنشورة ملك لمنشئها وحده. إن طلب دور
    // المنسق لقاعة منشورة يملكها غيره نُنزَّله عضواً — لا نجمان.
    if (role === 'coordinator') {
      try {
        const rn = lkRoomName(logicalRoom);
        const viewerKey = String(body.name || '').trim().toLowerCase();
        for (const r of roomRegistry.values()) {
          if (lkRoomName(r.name) === rn && r.creatorKey !== viewerKey) {
            role = 'member';
            break;
          }
        }
      } catch {}
    }
    // قاعدة «أول من يدخل يدير» على الخادم أيضاً: عضو يطلب قاعة غير
    // خاصة (غير منشورة برمز) ليست فيها أحد يُرقّى منسقاً — كي تتطابق
    // الحقيقة الخادمية (توكن المنسق) مع ما تعرضه الواجهة، فتنجح إجراءاته
    // الإشرافية (كتم/طرد) دون فشل صامت.
    //
    // **حجز المقعد**: أول ترقية لقاعة فارغة تحجز «مقعد المنسق» عشر
    // ثوانٍ — يمنع نافذتين فُتحتا بفارق لحظات من حصولهما معاً على
    // توكني منسق (سباق التوكنات قبل تسجيل اتصال الأولى في LiveKit).
    const now2 = Math.floor(Date.now() / 1000);
    for (const [k, v] of coordSlot) {
      if (now2 - v > COORD_SLOT_TTL) coordSlot.delete(k);
    }
    if (role === 'coordinator') {
      // **منحة «منسق» صارمة على القاعات المفتوحة** (غير المنشورة): وجود
      // حاضرين حقيقيين يعني أن المنصب مأخوذ — المتأخر «منسق» يُنزَل
      // عضواً. وكذلك مقعد محجوز حديثاً (سباق استعلامين متتاليين).
      // مالك قاعة منشورة وحده يُعفى — قيد التسجيل حاجزه سلفاً.
      try {
        const rn = lkRoomName(logicalRoom);
        const viewerKey = String(body.name || '').trim().toLowerCase();
        const owned = [...roomRegistry.values()].find(
          (r) => lkRoomName(r.name) === rn && r.creatorKey === viewerKey
        );
        if (!owned) {
          const codeOwned = [...roomRegistry.values()].find(
            (r) => lkRoomName(r.name) === rn && r.access === 'code'
          );
          if (!codeOwned) {
            let occupied = false;
            const rooms = JSON.parse(await lkTwirp('ListRooms', {})).rooms || [];
            const live = rooms.find((r) => r.name === rn);
            if (live) {
              let count = Number(live.numParticipants ?? live.num_participants ?? 0);
              // العدد الحقيقي — عدّاد القاعة يظل عالقاً بعد مغادرة حاضرين.
              try {
                const ps = JSON.parse(
                  await lkTwirp('ListParticipants', { room: rn })
                ).participants || [];
                count = ps.length;
              } catch {}
              if (count > 0) occupied = true;
            }
            if (!occupied) {
              const slot = coordSlot.get(rn) || 0;
              if (now2 - slot <= COORD_SLOT_TTL) occupied = true;
            }
            if (occupied) role = 'member';
            else coordSlot.set(rn, now2); // أول منسق يدخل يحجز المقعد
          }
        }
      } catch {}
    }
    if (role !== 'coordinator') {
      try {
        const rn = lkRoomName(logicalRoom);
        const registered = [...roomRegistry.values()].find(
          (r) => lkRoomName(r.name) === rn && r.access === 'code'
        );
        if (!registered) {
          const rooms = JSON.parse(await lkTwirp('ListRooms', {})).rooms || [];
          const live = rooms.find((r) => r.name === rn);
          let count = live
            ? Number(live.numParticipants ?? live.num_participants ?? 0)
            : 0;
          if (live && count > 0) {
            // عدّاد القاعة خادع — يظل عالقاً بعد مغادرة حاضرين. الحقيقة
            // هي قائمة المشاركين الفعلية فقط، وإلا لن يرقى «أول من
            // يدخل» منسقاً أبداً بعد أول استخدام للقاعة.
            try {
              const ps = JSON.parse(
                await lkTwirp('ListParticipants', { room: rn })
              ).participants || [];
              count = ps.length;
            } catch {}
          }
          if (!live || count === 0) {
            const slot = coordSlot.get(rn) || 0;
            if (now2 - slot > COORD_SLOT_TTL) {
              role = 'coordinator';
              coordSlot.set(rn, now2);
            }
          }
        }
      } catch {}
    }
    const identity = `${role === 'coordinator' ? 'c' : 'm'}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const ttl = 6 * 3600;
    const payload = {
      exp: now + ttl,
      nbf: now - 10,
      iat: now,
      iss: LK.apiKey,
      sub: identity,
      name,
      metadata: JSON.stringify({ role }),
      video: {
        room: lkRoomName(logicalRoom),
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        roomConfig: { maxParticipants: LK.maxParticipants },
      },
    };
    return json(res, 200, {
      url: lkUrl(),
      token: lkSign(payload),
      room: payload.video.room,
      identity,
      expiresIn: ttl,
    });
  }

  // إجراءات إشرافية (كتم/طرد): تتطلب توكن منسق صادراً من هذا الخادم
  // لنفس القاعة — التوقيع يثبت الصدور، والحمولة تثبت الدور.
  if (
    req.method === 'POST' &&
    (urlPath === '/api/livekit/admin/mute' ||
      urlPath === '/api/livekit/admin/remove')
  ) {
    const body = await readBody(req);
    const claims = lkVerify(body.token);
    const targetRoom = lkRoomName(String(body.room || ''));
    const identity = String(body.identity || '').slice(0, 128);
    if (!claims || !claims.video || claims.video.room !== targetRoom) {
      return json(res, 403, { error: 'توكن غير صالح لهذه القاعة.' });
    }
    let role = 'member';
    try {
      role = JSON.parse(claims.metadata || '{}').role || 'member';
    } catch {}
    if (role !== 'coordinator') {
      return json(res, 403, { error: 'الإجراء متاح للمنسق فقط.' });
    }
    if (!identity) return json(res, 400, { error: 'معرف المشارك مطلوب.' });
    try {
      if (urlPath.endsWith('/mute')) {
        await lkTwirp('MutePublishedTrack', {
          room: targetRoom,
          identity,
          muted: true,
        });
      } else {
        await lkTwirp('RemoveParticipant', { room: targetRoom, identity });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, {
        error: 'تعذر تنفيذ الإجراء على خادم البث.',
        detail: String((e && e.message) || e).slice(0, 300),
      });
    }
  }

  return json(res, 404, { error: 'غير موجود.' });
}

/**
 * نداء Twirp إلى RoomService عبر HTTPS — يُستخدم للكتم والطرد
 * وحدّ الكاميرات، بتوكن إداري قصير العمر يوقّعه الخادم نفسه.
 */
function lkTwirp(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const lkBase = lkUrl();
    const hostPart = lkBase.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    const host = hostPart.split(':')[0];
    const port = Number(hostPart.split(':')[1]) || 443;
    // ws:// محلي يعني HTTP عادي — wss:// فقط يستخدم TLS.
    const transport = lkBase.startsWith('ws://') ? http : https;
    const adminToken = lkSign({
      exp: Math.floor(Date.now() / 1000) + 120,
      iss: LK.apiKey,
      sub: 'masar_backend',
      video: Object.assign(
        {
          roomAdmin: true,
          roomCreate: true,
          roomList: true,
          roomRecord: true,
        },
        // **شرط LiveKit**: ListParticipants/الإجراءات الإشرافية تتطلب
        // صلاحِيةِ إدارةٍ «مُقيَّدة بقاعتها» — الصلاحِية العليا بلا نطاق
        // ترُجع 401 صامتاً (ظَهر من التجارب الحِية طوال جلسة اليوم).
        bodyObj && bodyObj.room
          ? { room: String(bodyObj.room) }
          : {}
      ),
    });
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const r2 = transport.request(
      {
        host,
        port,
        path: `/twirp/livekit.RoomService/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${adminToken}`,
          'Content-Length': data.length,
        },
        timeout: 8000,
      },
      (resp) => {
        const chunks = [];
        resp.on('data', (c) => chunks.push(c));
        resp.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            resolve(text);
          } else {
            reject(new Error(`HTTP ${resp.statusCode}: ${text.slice(0, 300)}`));
          }
        });
      }
    );
    r2.on('error', reject);
    r2.on('timeout', () => r2.destroy(new Error('timeout')));
    r2.end(data);
  });
}

/**
 * **شطر الشبح الدوري**: قاعة عدّها الحقيقي صفر (العدّاد `numParticipants`
 * الشبحي يبقى عالقاً في LiveKit 1.13) وعمرها تجاوز دقيقتين تُحذَر — فلا
 * تبقى سجل «مستعمل» يظنها دخولِهم أن «المنصب مأخوذ» حكماً العضوية
 * فتنتظر بكيني «أول من يدخل يدير» بلا محافحة.
 */
const GHOST_MIN_AGE_MS = 120 * 1000;
const GHOST_SWEEP_INTERVAL_MS = 60 * 1000;
let ghostSweepRunning = false;
async function sweepGhostRooms() {
  if (ghostSweepRunning || !lkConfigured()) return;
  ghostSweepRunning = true;
  try {
    const rooms = JSON.parse(await lkTwirp('ListRooms', {})).rooms || [];
    for (const room of rooms) {
      const name = String(room.name || '');
      if (!name.startsWith(LK.roomPrefix)) continue; // قاعاتنا فقط
      const createdMs = Number(
        room.creationTimeMs ?? room.creation_time_ms ?? 0
      );
      if (!createdMs || Date.now() - createdMs < GHOST_MIN_AGE_MS) continue;
      let realCount;
      try {
        const ps = JSON.parse(
          await lkTwirp('ListParticipants', { room: name })
        ).participants || [];
        realCount = ps.length;
      } catch {
        continue; // القاعة أُغلقت ربما
      }
      if (realCount === 0) {
        try {
          await lkTwirp('DeleteRoom', { room: name });
          console.log(`[ghost-sweep] deleted empty room ${name}`);
        } catch {}
      }
    }
  } catch {} finally {
    ghostSweepRunning = false;
  }
}
setInterval(sweepGhostRooms, GHOST_SWEEP_INTERVAL_MS);

/**
 * مراقبة حد الكاميرات: لا يبثّ صورته أكثر من LK.maxCameras مشاركين
 * في القاعة الواحدة — أولوية للمنسق ثم الأقدم دخولاً، ويُكتم بثّ
 * الزوائد خادمياً (إنفاذ حقيقي لا اعتماداً على واجهة التطبيق).
 */
let camSweepRunning = false;
async function sweepCameraLimits() {
  if (camSweepRunning || !lkConfigured()) return;
  camSweepRunning = true;
  try {
    const rooms = JSON.parse(await lkTwirp('ListRooms', {})).rooms || [];
    for (const room of rooms) {
      const name = room.name || '';
      if (!name.startsWith(LK.roomPrefix)) continue; // قاعاتنا فقط
      let participants = [];
      try {
        const out = await lkTwirp('ListParticipants', { room: name });
        participants = JSON.parse(out).participants || [];
      } catch {
        continue; // القاعة أُغلقت ربما
      }
      const publishers = [];
      for (const p of participants) {
        const hasCam = (p.tracks || []).some(
          (t) => t.type === 'VIDEO' && !t.muted
        );
        if (hasCam) publishers.push(p);
      }
      if (publishers.length <= LK.maxCameras) continue;

      const roleOf = {};
      publishers.forEach((p) => {
        try {
          roleOf[p.identity] =
            (JSON.parse(p.metadata || '{}').role) || 'member';
        } catch {
          roleOf[p.identity] = 'member';
        }
      });
      publishers.sort((a, b) => {
        const ra = roleOf[a.identity] === 'coordinator' ? 0 : 1;
        const rb = roleOf[b.identity] === 'coordinator' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (a.joinedAt || 0) - (b.joinedAt || 0);
      });

      for (const p of publishers.slice(LK.maxCameras)) {
        for (const t of p.tracks || []) {
          if (t.type === 'VIDEO' && !t.muted) {
            await lkTwirp('MutePublishedTrack', {
              room: name,
              identity: p.identity,
              trackSid: t.sid,
              muted: true,
            }).catch(() => {});
          }
        }
        console.log(`[livekit] camera-limit enforced in ${name} on ${p.identity}`);
      }
    }
  } catch {
    // خادم البث غير متاح مؤقتاً — نحاول في الدورة التالية بصمت.
  } finally {
    camSweepRunning = false;
  }
}
setInterval(sweepCameraLimits, 60 * 1000).unref();

// ================================================================
// ================== /LiveKit (إنتاج) ============================
// ================================================================


function roomInfo(id, room, includeInviteCode) {
  const set = rooms.get(id);
  const participants = [];
  if (set) {
    for (const c of set) {
      participants.push({
        name: c.name,
        isCoordinator: !!c.isCoordinator,
        isCreator: !!c.isCreator,
        isMonitor: !!c.isMonitor,
      });
    }
  }
  const info = {
    id,
    name: room.name,
    creatorName: room.creatorName,
    coordinators: room.coordinators.map((c) => c.name),
    activeCount: set ? set.size : 0,
    participants,
    createdAt: room.createdAt,
    access: room.access || 'public',
    stage: room.stage || '',
  };
  if (room.access === 'code' && includeInviteCode) {
    info.inviteCode = room.inviteCode;
  }
  return info;
}

/** المراحل التعليمية المعتمدة للقاعات — أي قيمة أخرى تُعدّ بلا مرحلة. */
const ROOM_STAGES = ['primary', 'middle', 'secondary'];
function normalizeStage(value) {
  return ROOM_STAGES.includes(value) ? value : '';
}

function sendFrame(socket, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, buf]));
}

function broadcast(room, message, except) {
  const set = rooms.get(room);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const client of set) {
    if (client === except) continue;
    sendFrame(client.socket, payload);
  }
}

function findClient(room, peerId) {
  const set = rooms.get(room);
  if (!set) return null;
  for (const client of set) {
    if (client.peerId === peerId) return client;
  }
  return null;
}

// المراقب لا يُكتم ولا يُنزع ولا يُطرد — صفته محصّنة.
function isImmune(room, peerId) {
  const c = findClient(room, peerId);
  return !!c && (c.isCoordinator || c.isCreator || c.isMonitor);
}

function isImmuneName(room, nameKey) {
  const set = rooms.get(room);
  if (!set) return false;
  for (const c of set) {
    if (c.nameKey === nameKey && (c.isCoordinator || c.isCreator || c.isMonitor)) {
      return true;
    }
  }
  return false;
}

function handleMessage(client, msg) {
  if (!msg || typeof msg !== 'object') return;
  const room = msg.room;

  switch (msg.type) {
    case 'join': {
      client.room = room;
      client.peerId = msg.peerId;
      client.name = String(msg.name || '').trim();
      client.mode = msg.mode || 'video';
      client.role = msg.role || 'participant';
      // المراقب: صلاحية كاملة — يدخل أي قاعة بلا قيود الازدواج ولا يُكتم ولا يُطرد.
      client.isMonitor = msg.isMonitor === true;
      const nameKey = client.name.toLowerCase();
      client.nameKey = nameKey;
      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);

      // لا يمكن الدخول إلى قاعة غير مسجلة في السجل الدائم.
      const reg = roomRegistry.get(room);
      if (!reg) {
        console.log(`[join-rejected] ${client.name} — قاعة غير موجودة (${room})`);
        return sendFrame(client.socket, JSON.stringify({
          type: 'join-error',
          message: 'هذه القاعة غير موجودة أو حُذفت — أنشئ قاعة جديدة من القائمة.',
        }));
      }

      // القاعات الخاصة تتطلب رمز الدعوة الصحيح — المراقب يتجاوز هذا القيد.
      if (reg.access === 'code' && !client.isMonitor) {
        const sent = String(msg.inviteCode || '').trim().toUpperCase();
        if (sent !== reg.inviteCode) {
          console.log(`[join-rejected] ${client.name} — رمز دعوة خاطئ لـ ${room}`);
          return sendFrame(client.socket, JSON.stringify({
            type: 'join-error',
            message: 'رمز الدعوة غير صحيح — اطلب رمز الدعوة من منسّق القاعة.',
          }));
        }
      }

      // منع الدخول المزدوج: الاسم الموجود فعلاً في القاعة لا يدخل مرة ثانية.
      // المراقب يتجاوز هذا القيد — يدخل للمراقبة حتى لو وُجد اسم مشابه.
      if (nameKey && !client.isMonitor) {
        for (const c of set) {
          if (String(c.name || '').trim().toLowerCase() === nameKey) {
            console.log(`[join-rejected] ${client.name} — الاسم موجود بالفعل في ${room}`);
            return sendFrame(client.socket, JSON.stringify({
              type: 'join-error',
              message: 'هذا الاسم موجود بالفعل في القاعة — يُسمح بدخول واحد فقط لكل شخص.',
            }));
          }
        }
      }

      // القاعة لا تتضمن أكثر من مشرف واحد (المنشّط الأول فقط) — للحالة الصوتية القديمة.
      if (client.role === 'host') {
        const existingHost = roomHosts.get(room);
        if (existingHost && existingHost !== client.peerId) {
          console.log(`[join-rejected] ${client.name} — القاعة لها مشرف بالفعل (${room})`);
          return sendFrame(client.socket, JSON.stringify({
            type: 'join-error',
            message: 'هذه القاعة لها مشرف (منشّط) بالفعل — لا يمكن الدخول بصفة منشّط، أدخل كمشارك.',
          }));
        }
      }

      // صفة المنسق تأتي من سجل القاعة (بالاسم الموثّق من الحساب).
      client.isCoordinator = reg.coordinators.some((c) => c.key === nameKey);
      client.isCreator = nameKey === reg.creatorKey;

      set.add(client);

      // سجّل آخر استخدام للقاعة (لمنع الحذف التلقائي بعد 30 يوماً).
      touchRoom(room);

      if (client.role === 'host' && !roomHosts.has(room)) {
        roomHosts.set(room, client.peerId);
      }

      console.log(`[join] ${client.name} (${client.peerId}) دخل غرفة ${room} (${client.mode}) — الحاضرون: ${set.size}`);

      // حالة القاعة الصوتية (تستخدم أيضاً لإدارة المايك في القاعات الموحّدة).
      let vstate = voiceRooms.get(room);
      if (!vstate) {
        vstate = { host: null, queue: [], speakers: [], muted: [] };
        voiceRooms.set(room, vstate);
      }
      if (!vstate.host && client.role === 'host') vstate.host = client.peerId;

      // أرسل للوافد قائمة الحاضرين ليبدأ الاتصال بهم جميعاً.
      const members = [];
      for (const c of set) {
        if (c !== client && c.peerId) {
          members.push({
            peerId: c.peerId,
            name: c.name,
            isCoordinator: !!c.isCoordinator,
            isCreator: !!c.isCreator,
            isMonitor: !!c.isMonitor,
          });
        }
      }
      sendFrame(client.socket, JSON.stringify({ type: 'members', members }));

      // أرسل للوافد صفته في القاعة (مراقب/منسق/منشئ/حاضر).
      sendFrame(client.socket, JSON.stringify({
        type: 'your-role',
        isCoordinator: client.isCoordinator,
        isCreator: client.isCreator,
        isMonitor: client.isMonitor,
        room: {
          id: reg.id,
          name: reg.name,
          creatorName: reg.creatorName,
          coordinators: reg.coordinators.map((c) => c.name),
        },
      }));

      // أرسل للوافد سجل الرسائل السابقة في القاعة.
      const history = chatHistory.get(room);
      if (history && history.length > 0) {
        sendFrame(client.socket, JSON.stringify({
          type: 'chat-history',
          messages: history,
        }));
      }

      // أبلغ الحاضرين القدامى بوجود وافد جديد.
      broadcast(room, {
        type: 'peer-joined',
        peerId: client.peerId,
        name: client.name,
        isCoordinator: client.isCoordinator,
        isCreator: client.isCreator,
        isMonitor: client.isMonitor,
      }, client);

      // أرسل حالة القاعة الصوتية الحالية للوافد الجديد.
      sendFrame(client.socket, JSON.stringify({
        type: 'room-state',
        host: vstate.host,
        queue: vstate.queue,
        speakers: vstate.speakers,
        muted: vstate.muted,
      }));
      break;
    }
    case 'hand-raise': {
      console.log(`[hand-raise] ${client.name} (${client.peerId}) في ${room} | coord=${client.isCoordinator} | الحاضرون: ${rooms.get(room)?.size}`);
      const vstate = voiceRooms.get(room);
      if (!vstate) break;
      if (!vstate.queue.includes(client.peerId)) vstate.queue.push(client.peerId);
      broadcast(room, { type: 'queue-updated', queue: vstate.queue });
      break;
    }
    case 'cancel-hand': {
      const vstate = voiceRooms.get(room);
      if (!vstate) break;
      vstate.queue = vstate.queue.filter((id) => id !== client.peerId);
      broadcast(room, { type: 'queue-updated', queue: vstate.queue });
      break;
    }
    case 'grant-mic': {
      console.log(`[grant-mic] ${client.name} (coord=${client.isCoordinator}) -> ${msg.to} في ${room} | الحاضرون: ${rooms.get(room)?.size}`);
      const vstate = voiceRooms.get(room);
      if (!vstate || !client.isCoordinator) break;
      const target = msg.to;
      vstate.queue = vstate.queue.filter((id) => id !== target);
      if (!vstate.speakers.includes(target)) vstate.speakers.push(target);
      broadcast(room, { type: 'mic-granted', peerId: target, by: client.peerId });
      broadcast(room, { type: 'queue-updated', queue: vstate.queue });
      break;
    }
    case 'revoke-mic': {
      console.log(`[revoke-mic] ${client.name} (coord=${client.isCoordinator}) -> ${msg.to} في ${room} | الحاضرون: ${rooms.get(room)?.size}`);
      const vstate = voiceRooms.get(room);
      if (!vstate || !client.isCoordinator) break;
      const target = msg.to;
      if (isImmune(room, target)) break; // المراقب (والمنسّقون) لا يُنزعون.
      vstate.speakers = vstate.speakers.filter((id) => id !== target);
      broadcast(room, { type: 'mic-revoked', peerId: target, by: client.peerId });
      break;
    }
    case 'mute-speaker': {
      const vstate = voiceRooms.get(room);
      if (!vstate || !client.isCoordinator) break;
      const target = msg.to;
      if (isImmune(room, target)) break; // المراقب لا يُكتم.
      if (!vstate.muted.includes(target)) vstate.muted.push(target);
      broadcast(room, { type: 'mic-muted', peerId: target, by: client.peerId });
      break;
    }
    case 'unmute-speaker': {
      const vstate = voiceRooms.get(room);
      if (!vstate || !client.isCoordinator) break;
      const target = msg.to;
      vstate.muted = vstate.muted.filter((id) => id !== target);
      broadcast(room, { type: 'mic-unmuted', peerId: target, by: client.peerId });
      break;
    }
    case 'promote-coordinator': {
      const reg = roomRegistry.get(room);
      if (!reg || !client.isCoordinator) break;
      const target = String(msg.to || '').trim();
      const targetKey = target.toLowerCase();
      if (!targetKey || targetKey === client.nameKey) break;
      if (isImmuneName(room, targetKey)) break; // المراقب لا يُرقّى ولا يُنزع.
      if (!reg.coordinators.some((c) => c.key === targetKey)) {
        reg.coordinators.push({ name: target, key: targetKey });
      }
      saveRegistry();
      console.log(`[promote] ${target} أصبح منسقاً في ${room} (بواسطة ${client.name})`);
      broadcast(room, { type: 'coordinator-added', name: target });
      // إن كان الهدف متصلاً الآن: حدّث صفته فوراً.
      const set = rooms.get(room);
      if (set) for (const c of set) {
        if (c.nameKey === targetKey) {
          c.isCoordinator = true;
          sendFrame(c.socket, JSON.stringify({
            type: 'your-role',
            isCoordinator: true,
            isCreator: c.isCreator,
            isMonitor: c.isMonitor,
          }));
        }
      }
      break;
    }
    case 'remove-coordinator': {
      const reg = roomRegistry.get(room);
      if (!reg || !client.isCoordinator) break;
      const target = String(msg.to || '').trim();
      const targetKey = target.toLowerCase();
      if (!targetKey || targetKey === reg.creatorKey) break; // المنشئ لا يُنزع.
      if (isImmuneName(room, targetKey)) break; // المراقب لا يُنزع.
      const idx = reg.coordinators.findIndex((c) => c.key === targetKey);
      if (idx < 0) break;
      reg.coordinators.splice(idx, 1);
      saveRegistry();
      console.log(`[demote] ${target} لم يعد منسقاً في ${room} (بواسطة ${client.name})`);
      broadcast(room, { type: 'coordinator-removed', name: target });
      const set = rooms.get(room);
      if (set) for (const c of set) {
        if (c.nameKey === targetKey) {
          c.isCoordinator = false;
          sendFrame(c.socket, JSON.stringify({
            type: 'your-role',
            isCoordinator: false,
            isCreator: c.isCreator,
            isMonitor: c.isMonitor,
          }));
        }
      }
      break;
    }
    case 'kick': {
      const set2 = rooms.get(room);
      if (!set2 || !client.isCoordinator) break;
      const targetPeerId = String(msg.to || '');
      let target = null;
      for (const c of set2) if (c.peerId === targetPeerId) target = c;
      if (!target || isImmune(room, targetPeerId)) break; // المراقب لا يُطرد.
      console.log(`[kick] ${target.name} طُرد من ${room} (بواسطة ${client.name})`);
      sendFrame(target.socket, JSON.stringify({
        type: 'kicked',
        by: client.name,
        message: 'تم طردك من القاعة بواسطة المنسق.',
      }));
      disconnect(target);
      break;
    }
    case 'delete-room': {
      const reg = roomRegistry.get(room);
      if (!reg || reg.creatorKey !== client.nameKey) break;
      roomRegistry.delete(room);
      saveRegistry();
      const set3 = rooms.get(room);
      if (set3 && set3.size > 0) {
        console.log(`[delete-room] ${room} «${reg.name}» — غادر الجميع (بواسطة ${client.name})`);
        broadcast(room, { type: 'room-deleted' });
        for (const c of [...set3]) disconnect(c);
      } else {
        rooms.delete(room);
        voiceRooms.delete(room);
        roomHosts.delete(room);
        chatLogs.delete(room);
        chatHistory.delete(room);
      }
      break;
    }
    case 'reaction': {
      broadcast(room, {
        type: 'reaction',
        peerId: client.peerId,
        name: client.name,
        reaction: msg.reaction,
      }, client);
      break;
    }
    case 'offer':
    case 'answer':
    case 'candidate': {
      const target = findClient(room, msg.to);
      if (!target) {
        console.log(`[!] ${msg.type} إلى ${msg.to} غير موجود في ${room}`);
        return;
      }
      console.log(`[${msg.type}] ${client.peerId} -> ${msg.to} في ${room}`);
      const rawSdp = String((msg.sdp && msg.sdp.sdp) || '');
      if (rawSdp) {
        const mAudio = (rawSdp.match(/^m=audio\b/gm) || []).length;
        const mVideo = (rawSdp.match(/^m=video\b/gm) || []).length;
        const mApp = (rawSdp.match(/^m=application\b/gm) || []).length;
        const sendDirs = (rawSdp.match(/^a=sendrecv|^a=sendonly|^a=recvonly|^a=inactive/gm) || []);
        const rtcpFb = (rawSdp.match(/^a=rtcp-mux/gm) || []).length;
        console.log(`[SDP-${msg.type}] m=audio:${mAudio} m=video:${mVideo} m=application:${mApp} dirs=[${sendDirs.join(',')}] rtcp-mux:${rtcpFb} len:${rawSdp.length}`);
      }
      const relay = {
        type: msg.type,
        from: client.peerId,
        name: client.name,
        to: msg.to,
      };
      if (msg.sdp) relay.sdp = msg.sdp;
      if (msg.candidate) relay.candidate = msg.candidate;
      sendFrame(target.socket, JSON.stringify(relay));
      break;
    }
    case 'chat': {
      const msgId = String(msg.msgId || '').trim();
      const recipients = Math.max(0, (rooms.get(room)?.size || 1) - 1);
      console.log(`[chat] ${client.name} -> ${room} | المستقبلون: ${recipients} | نص: ${String(msg.text || '').slice(0, 40)}`);
      const payload = {
        type: 'chat',
        from: client.peerId,
        name: client.name,
        text: String(msg.text || ''),
        at: msg.at || Date.now(),
      };
      if (msgId) payload.msgId = msgId;
      if (msg.replyTo) payload.replyTo = msg.replyTo;
      if (Array.isArray(msg.attachments)) {
        payload.attachments = msg.attachments
          .filter((a) => a && typeof a === 'object')
          .map((a) => {
            const url = String(a.url || '');
            // نسمح فقط بالملفات المرفوعة على خادمنا — الأسماء قد تحوي
            // أحرفاً عربية ومسافات وأقواساً (نفس القاعدة التي يطبّقها الرفع).
            if (!/^\/uploads\/[A-Za-z0-9._()\u0600-\u06FF -]+$/.test(url)) return null;
            return {
              type: a.type === 'photo' ? 'photo' : 'document',
              name: String(a.name || 'ملف').slice(0, 100),
              url,
              sizeText: String(a.sizeText || '').slice(0, 20),
            };
          })
          .filter(Boolean);
      }
      broadcast(room, payload, client);
      // احفظ الرسالة في سجل القاعة ليراها من يدخل لاحقاً.
      pushChatHistory(room, payload);
      // سجّل الرسالة لإيصالات الوصول/القراءة، وأكّد للمرسل.
      if (msgId) {
        if (!chatLogs.has(room)) chatLogs.set(room, new Map());
        chatLogs.get(room).set(msgId, client.peerId);
        const recipients = Math.max(0, (rooms.get(room)?.size || 1) - 1);
        sendFrame(client.socket, JSON.stringify({
          type: 'chat-ack',
          msgId,
          delivered: recipients,
        }));
      }
      break;
    }
    case 'chat-receipt': {
      const senderId = chatLogs.get(room)?.get(String(msg.msgId || ''));
      if (senderId && senderId !== client.peerId) {
        const target = findClient(room, senderId);
        if (target) {
          sendFrame(target.socket, JSON.stringify({
            type: 'chat-receipt',
            msgId: msg.msgId,
            status: msg.status === 'read' ? 'read' : 'delivered',
          }));
        }
      }
      break;
    }
    case 'typing': {
      broadcast(room, {
        type: 'typing',
        from: client.peerId,
        name: client.name,
        active: !!msg.active,
      }, client);
      break;
    }
    case 'chat-edit': {
      const editId = String(msg.msgId || '');
      const history = chatHistory.get(room);
      if (history) {
        const hit = history.find((h) => String(h.msgId || '') === editId);
        if (hit) hit.text = String(msg.text || '');
      }
      broadcast(room, {
        type: 'chat-edit',
        msgId: msg.msgId,
        text: String(msg.text || ''),
      }, client);
      break;
    }
    case 'chat-delete': {
      const delId = String(msg.msgId || '');
      chatLogs.get(room)?.delete(delId);
      const history = chatHistory.get(room);
      if (history) {
        const idx = history.findIndex((h) => String(h.msgId || '') === delId);
        if (idx >= 0) history.splice(idx, 1);
      }
      broadcast(room, { type: 'chat-delete', msgId: msg.msgId }, client);
      break;
    }
    case 'chat-reaction': {
      broadcast(room, {
        type: 'chat-reaction',
        msgId: msg.msgId,
        from: client.peerId,
        name: client.name,
        reaction: msg.reaction,
      }, client);
      break;
    }
    case 'media-state': {
      console.log(`[media-state] ${client.name} (${client.peerId}) video=${msg.videoOn} audio=${msg.audioOn} في ${room}`);
      broadcast(room, {
        type: 'media-state',
        from: client.peerId,
        videoOn: msg.videoOn,
        audioOn: msg.audioOn,
      }, client);
      break;
    }
    case 'rtc-error': {
      console.log(`[rtc-error] ${client.peerId} [${msg.context}] ${msg.error}`);
      break;
    }
    case 'leave':
      disconnect(client);
      break;
    default:
      break;
  }
}

function disconnect(client) {
  if (!client.room) return;
  const set = rooms.get(client.room);
  if (set) {
    set.delete(client);
    // المشرف غادر — تسمح القاعة لمشرف جديد بتولي المنصب.
    if (roomHosts.get(client.room) === client.peerId) roomHosts.delete(client.room);
    if (set.size === 0) {
      rooms.delete(client.room);
      voiceRooms.delete(client.room);
      roomHosts.delete(client.room);
      chatLogs.delete(client.room);
      chatHistory.delete(client.room);
    } else {
      // في القاعات الصوتية: أزل المغادر من القائمة والمتحدثين والكتم.
      const vstate = voiceRooms.get(client.room);
      if (vstate) {
        vstate.queue = vstate.queue.filter((id) => id !== client.peerId);
        vstate.speakers = vstate.speakers.filter((id) => id !== client.peerId);
        vstate.muted = vstate.muted.filter((id) => id !== client.peerId);
        if (vstate.host === client.peerId) vstate.host = null;
        broadcast(client.room, { type: 'queue-updated', queue: vstate.queue });
      }
    }
    broadcast(client.room, { type: 'peer-left', peerId: client.peerId }, client);
  }
  client.room = null;
  try {
    client.socket.end();
  } catch (_) {}
}

function attachClient(socket) {
  const client = { socket, room: null, peerId: null, name: null };
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) break;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) break;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) break;

      const mask = masked
        ? buffer.subarray(offset, offset + 4)
        : null;
      const payload = Buffer.from(
        buffer.subarray(offset + maskLen, offset + maskLen + len)
      );
      buffer = buffer.slice(offset + maskLen + len);

      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }

      if (opcode === 8) {
        // close
        try {
          socket.write(Buffer.from([0x88, 0x00]));
        } catch (_) {}
        socket.end();
        disconnect(client);
        return;
      } else if (opcode === 9) {
        // ping -> pong
        try {
          const header = Buffer.from([0x8a, payload.length]);
          socket.write(Buffer.concat([header, payload]));
        } catch (_) {}
      } else if (opcode === 10) {
        // pong: ignore
      } else if (opcode === 1) {
        // text
        try {
          handleMessage(client, JSON.parse(payload.toString('utf8')));
        } catch (_) {}
      }
    }
  });

  socket.on('close', () => disconnect(client));
  socket.on('error', () => disconnect(client));
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  attachClient(socket);
}

server.on('upgrade', handleUpgrade);

// تحميل السجل الدائم وحذف القاعات المنتهية (بعد 30 يوماً بلا استخدام) —
// عند الإقلاع ثم بشكل دوري كل ساعة.
// في الوضع السحابي: ننتظر أولاً تحميل الحالة الكاملة من Supabase، ثم نفتح المنفذ
// حتى لا يخدم الخادم أي طلب قبل وصول البيانات.
(async () => {
  await store.init();
  loadRegistry();
  chatLoad();
  cardCommentsLoad();
  cleanupExpiredRooms();
  setInterval(cleanupExpiredRooms, 60 * 60 * 1000);
setInterval(chatSweep, 30 * 60 * 1000);

// يعرض عناوين LAN الحالية عند الإقلاع — عنوان الجهاز قد يتغير تلقائياً
// (DHCP)، فمن المهم معرفة الرابط الجديد لفتح الويب من الأجهزة الأخرى.
function logLanAddresses() {
  const net = require('os').networkInterfaces();
  const v4 = [];
  for (const iface of Object.values(net)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) v4.push(addr.address);
    }
  }
  if (v4.length === 0) return;
  console.log('==========================================================');
  console.log('  افتح التطبيق من هاتفك/حاسوب آخر عبر:');
  for (const ip of v4) {
    console.log(`    https://${ip}:${HTTPS_PORT}/  (أو http://${ip}:${PORT}/)`);
  }
  console.log('==========================================================');
}

server.listen(PORT, () => {
  if (fs.existsSync(ROOT)) {
    console.log(`Serving ${ROOT} at http://localhost:${PORT}`);
  } else {
    console.log(
      `[static] مجلد ${ROOT} غير موجود — يُخدم فقط /api و/ws و/uploads (التطبيق منشور على GitHub Pages).`
    );
  }
  console.log(`WebSocket signaling ready at ws://localhost:${PORT}/ws`);
  logLanAddresses();
});

// خادم HTTPS اختياري — يعمل عند وجود شهادة ذاتية في مجلد certs.
// يُستخدم للمتصفحات (المايك والكاميرا ممنوعان على http غير المشفّر).
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const httpsServer = https.createServer(
    {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    },
    handler
  );
  httpsServer.on('upgrade', handleUpgrade);
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`[HTTPS] Serving ${ROOT} at https://localhost:${HTTPS_PORT}`);
    console.log(`[HTTPS] WebSocket signaling ready at wss://localhost:${HTTPS_PORT}/ws`);
    logLanAddresses();
  });
} else {
  console.log('[HTTPS] غير مفعّل — لا توجد شهادة في مجلد certs (https://...:8443).');
}
})();
