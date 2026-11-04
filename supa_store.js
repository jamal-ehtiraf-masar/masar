// supa_store.js — طبقة تخزين دائمة فوق Supabase Storage (مجاني بلا بطاقة)
// تُفعَّل تلقائياً عند وجود SUPABASE_URL + SUPABASE_SERVICE_KEY في البيئة.
// بلا مفاتيح → ترجع الخادم لسلوك الملفات المحلية كما هو (توافق تام).
'use strict';

const fs = require('fs');
const path = require('path');

const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DATA_BUCKET = 'data';
const UPLOAD_BUCKET = 'uploads';

const enabled = () => !!(SUPA_URL && SUPA_KEY);

const H = () => ({ apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` });

// ---------- مساعدات كائنات Storage ----------
async function objGetJSON(bucket, name) {
  try {
    const r = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${name}`, {
      headers: H(),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function objPutJSON(bucket, name, obj) {
  try {
    await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${name}`, {
      method: 'PUT',
      headers: { ...H(), 'Content-Type': 'application/json', 'x-upsert': 'true' },
      body: JSON.stringify(obj),
    });
  } catch (e) {
    console.error(`[store] فشل حفظ ${name}:`, e.message);
  }
}

async function objList(bucket, prefix) {
  try {
    const r = await fetch(`${SUPA_URL}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...H(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: prefix || '' }),
    });
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// ---------- ملفات الحالة (ذاكرة-أولاً + مزامنة سائبة) ----------
// مراكز JSON الدائمة تُحمَّل كاملةً عند الإقلاع، وبعدها يقرؤها الخادم من الذاكرة
// المتزامنة (صفر أثر أداء)، وترتد الكتابات إلى Storage في الخلفية.
const mem = new Map();

const STATE_FILES = [
  'masar_social.json',
  'rooms_data.json',
  'app_config.json',
  'card_comments.json',
  'rooms_chat.json',
];

// جلب كائن حالة: يفرّق بين «غير موجود» (طبيعي — أول إقلاع) و«عطل حقيقي» (يُعاد المحاولة).
async function fetchStateObj(bucket, name) {
  const r = await fetch(`${SUPA_URL}/storage/v1/object/${bucket}/${name}`, {
    headers: H(),
  });
  if (r.ok) return { ok: true, data: await r.json() };
  if (r.status === 400 || r.status === 404) return { ok: true, data: null };
  throw new Error('HTTP ' + r.status);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function readJson(name, fallback) {
  if (mem.has(name)) return mem.get(name);
  return fallback;
}

function writeJson(name, obj) {
  mem.set(name, obj);
  if (enabled()) {
    objPutJSON(DATA_BUCKET, name, obj); // خلفية — لا تحجب الاستجابة
  } else {
    // توافق محلي: إلى القرص كما كان الخادم يفعل
    try {
      const p = path.join(__dirname, name);
      fs.writeFileSync(p + '.tmp', JSON.stringify(obj), 'utf8');
      fs.renameSync(p + '.tmp', p);
    } catch {}
  }
}

async function initState() {
  for (const n of STATE_FILES) {
    if (enabled()) {
      // حماية البيانات الحياتية: إن تعذر الوصول للسحابة عند الإقلاع نعيد المحاولة
      // حتى 60 مرة (3 دقائق) — ولا نبدأ أبداً بحالة فارغة قد تُستبدل بالبيانات القديمة.
      let v = null;
      let lastErr = null;
      for (let i = 0; i < 60; i++) {
        try {
          v = (await fetchStateObj(DATA_BUCKET, n)).data;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          console.error(`[store] محاولة ${i + 1}/60 لجلب ${n} فشلت: ${e.message}`);
          await delay(3000);
        }
      }
      if (lastErr) {
        console.error(
          `[store] تعذّر جلب ${n} من السحابة بعد كل المحاولات — إيقاف آمن قبل أي كتابة.`
        );
        process.exit(1); // Render يعيد التشغيل تلقائياً
      }
      if (v !== null && typeof v === 'object') mem.set(n, v);
    } else {
      try {
        const p = path.join(__dirname, n);
        if (fs.existsSync(p)) mem.set(n, JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch {}
    }
  }
}

// ---------- ملفات الرفع (uploads) ----------
const LOCAL_UPLOAD_DIR = path.join(__dirname, 'uploads');
let uploadNames = null; // Set | null — null يعني الوضع المحلي (أُقرأ يدويًا)

async function initUploads() {
  if (!enabled()) return;
  for (let i = 0; i < 10; i++) {
    try {
      const rows = await objList(UPLOAD_BUCKET, '');
      uploadNames = new Set((rows || []).map((x) => x.name).filter(Boolean));
      console.log(`[store] uploads: ${uploadNames.size} ملفاً في السحابة`);
      return;
    } catch {
      await delay(3000);
    }
  }
  uploadNames = new Set();
}

function localPathOf(name) {
  return path.join(LOCAL_UPLOAD_DIR, path.basename(name));
}

// حفظ — نمط callback متوافق مع الاستدعاء الأصلي (fs.writeFile)
function putUpload(name, buf, cb) {
  if (!enabled()) {
    fs.writeFile(localPathOf(name), buf, cb);
    return;
  }
  fetch(`${SUPA_URL}/storage/v1/object/${UPLOAD_BUCKET}/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { ...H(), 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
    body: buf,
  })
    .then((r) => {
      if (r.ok) {
        if (uploadNames) uploadNames.add(name);
        cb(null);
      } else {
        r.text().then((t) => cb(new Error(`HTTP ${r.status}: ${t.slice(0, 160)}`)));
      }
    })
    .catch(cb);
}

// قراءة — تعيد Buffer أو null (ثم يخطّها الخادم للاستجابة بنفسه)
async function getUpload(name) {
  if (!enabled()) {
    try {
      return fs.readFileSync(localPathOf(name));
    } catch {
      return null;
    }
  }
  try {
    const r = await fetch(
      `${SUPA_URL}/storage/v1/object/${UPLOAD_BUCKET}/${encodeURIComponent(name)}`,
      { headers: H() }
    );
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

// عدّاد لوحة الإدارة — متزامن من الذاكرة (يتوفر من وضعين)
function countUploads() {
  if (!enabled()) {
    try {
      return fs.readdirSync(LOCAL_UPLOAD_DIR).length;
    } catch {
      return 0;
    }
  }
  return uploadNames ? uploadNames.size : 0;
}

// ---------- بنوك الأسئلة (banks) ----------
// كانت على سطح المكتب خارج التطبيق؛ في السحابة تصبح كائنات في data/banks/
let banksCache = new Map();

async function initBanks() {
  if (!enabled()) return;
  try {
    const rows = await objList(DATA_BUCKET, 'banks/');
    for (const row of rows || []) {
      const name = String(row.name || '').replace(/^banks\//, '');
      if (!name || !name.toLowerCase().endsWith('.json')) continue;
      const v = await objGetJSON(DATA_BUCKET, `banks/${name}`);
      if (v !== null) banksCache.set(name, v);
    }
    console.log(`[store] banks: ${banksCache.size} بنكاً`);
  } catch {}
}

function listBankNames() {
  if (!enabled()) {
    try {
      return fs
        .readdirSync(BANKS_EXTERNAL_DIR_FALLBACK())
        .filter((f) => /^[A-Za-z0-9._-]+\.json$/i.test(f));
    } catch {
      return [];
    }
  }
  return [...banksCache.keys()];
}

function BANKS_EXTERNAL_DIR_FALLBACK() {
  // يُستواح فقط في الوضع المحلي بلا مفاتيح — مطابق للسلوك الأصلي
  try {
    // eslint-disable-next-line no-eval
    return require('path').join(process.cwd(), 'banks');
  } catch {
    return path.join(process.cwd(), 'banks');
  }
}

function getBank(name) {
  if (!enabled()) {
    try {
      return JSON.parse(
        fs.readFileSync(
          path.join(
            (process.env.EXTERNAL_QUESTION_BANKS_DIR ||
              BANKS_EXTERNAL_DIR_FALLBACK()),
            name
          ),
          'utf8'
        )
      );
    } catch {
      return null;
    }
  }
  return banksCache.has(name) ? banksCache.get(name) : null;
}

function putBank(name, data) {
  if (!enabled()) {
    try {
      const dir =
        process.env.EXTERNAL_QUESTION_BANKS_DIR || BANKS_EXTERNAL_DIR_FALLBACK();
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, name);
      fs.writeFileSync(p + '.tmp', JSON.stringify(data), 'utf8');
      fs.renameSync(p + '.tmp', p);
    } catch {}
    return;
  }
  banksCache.set(name, data);
  objPutJSON(DATA_BUCKET, `banks/${name}`, data);
}

function countBanks() {
  if (!enabled()) return listBankNames().length;
  return banksCache.size;
}

// ---------- الإقلاع ----------
async function init() {
  if (enabled()) {
    console.log('[store] وضع السحابة: Supabase Storage مفعّل ✓');
  } else {
    console.log('[store] وضع محلي: بلا SUPABASE_URL/KEY — كل شيء على القرص');
  }
  await initState();
  await initUploads();
  await initBanks();
}

module.exports = {
  enabled,
  init,
  readJson,
  writeJson,
  putUpload,
  getUpload,
  countUploads,
  listBankNames,
  getBank,
  putBank,
  countBanks,
};
