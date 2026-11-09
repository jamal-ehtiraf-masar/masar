/* ============================================================
   جواهر الكفاءة — تحميل بنك الأسئلة وبناء المستويات
   ============================================================ */

import { CONFIG, CHAPTERS } from "./config.js";

/* رقعة عشوائية مزروعة لضمان ثبات المستويات بين الجلسات */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(arr, seed) {
  const rnd = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* أرقام هندية عربية للترقيم داخل اسم المحور الفرعي («النمو ٢») */
const arNum = (n) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[d]);

export class Bank {
  constructor() {
    this.bySubject = new Map();
    this.chapters = [];
    this.ready = false;
    this.totalQuestions = 0;
  }

  /* ---- كاش محلي: اللعبة تُفتح فوراً من الذاكرة بلا انتظار الشبكة ---- */
  static get CACHE_KEY() { return "masar_bank_cache_v1"; }
  static get CACHE_TTL() { return 48 * 3600 * 1000; } /* تحديث خلفي كل 48 ساعة */

  _readCache() {
    try {
      const raw = localStorage.getItem(Bank.CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data) return parsed;
    } catch (_) {}
    return null;
  }

  _saveCache(data) {
    try {
      localStorage.setItem(
        Bank.CACHE_KEY,
        JSON.stringify({ t: Date.now(), data }),
      );
    } catch (_) {} /* تجاوز سعة التخزين بهدوء — اللعبة تعمل بكاش الذاكرة الحالي */
  }

  /* جلب البنك من الشبكة — يجرّب المصادر بالترتيب مع مهلة 25 ثانية للمصدر */
  async _fetchFromNetwork() {
    const paths = [
      ...(CONFIG.bankCdnPaths || []),
      CONFIG.bankPath,
      CONFIG.bankFallbackPath,
    ].filter(Boolean);
    let lastErr = null;
    for (const p of paths) {
      try {
        const ctrl =
          typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), 25000) : null;
        const r = await fetch(p, ctrl ? { signal: ctrl.signal } : {});
        if (timer) clearTimeout(timer);
        if (r.ok) {
          const data = await r.json();
          if (data && typeof data === "object") return data;
          lastErr = new Error("بنك غير صالح أو فارغ");
          continue;
        }
        lastErr = new Error("تعذّر تحميل بنك الأسئلة (" + r.status + ")");
      } catch (e) {
        lastErr = e;
      }
    }
    return null;
  }

  /* تحديث خلفي هادئ: يعمل بعد فتح اللعبة، لا يعطّل الجلسة الحالية */
  async _refreshInBackground() {
    try {
      const data = await this._fetchFromNetwork();
      if (data) this._saveCache(data);
    } catch (_) {}
  }

  async load() {
    /* 1) كاش محلي موجود؟ افتح فوراً ثم حدّث خلفياً عند انتهاء مدة الصلاحية */
    const cached = this._readCache();
    if (cached) {
      this._digest(cached.data);
      if (Date.now() - (cached.t || 0) > Bank.CACHE_TTL) {
        this._refreshInBackground();
      }
      if (this.chapters.length) return this;
      /* كاش تالف/فارغ → تابع للشبكة */
    }

    /* 2) أول فتح (بلا كاش): جلب فوري من أسرع مصدر متاح */
    const data = await this._fetchFromNetwork();
    if (!data) {
      throw new Error(
        "تعذّر تحميل بنك الأسئلة — تأكد من اتصالك بالإنترنت وأعد المحاولة",
      );
    }
    this._digest(data);
    this._saveCache(data);
    return this;
  }

  /* بناء الخريطة والمستويات من بيانات البنك الخام */
  _digest(data) {
    const group = data[CONFIG.bankGroup] || data[Object.keys(data)[0]] || [];

    this.bySubject.clear();
    let idx = 0;
    for (const q of group) {
      if (!q || !q.subject || !Array.isArray(q.options)) continue;
      /* مرشّح سلامة: استبعد الأسئلة الفاسدة (خيارات شاذة العدد — كانت أوزار تححق 4) */
      if (q.options.length < 2 || q.options.length > 6) continue;
      if (!(q.correctIndex >= 0 && q.correctIndex < q.options.length)) continue;
      if (!this.bySubject.has(q.subject)) this.bySubject.set(q.subject, []);
      this.bySubject
        .get(q.subject)
        .push(Object.assign({ _i: idx++ }, q));
    }
    this.totalQuestions = idx;

    this._buildChapters();
    this.ready = true;
  }

  _buildChapters() {
    const Q = CONFIG.questionsPerLevel; // عدد الأسئلة لكل مستوى
    const L = CONFIG.levelsPerChapter; // عدد المستويات لكل فصل (ثابت)
    const built = [];
    CHAPTERS.forEach((c, si) => {
      const pool = this.bySubject.get(c.subject) || [];
      if (!pool.length) return; // موضوع بلا أسئلة لا يولّد فصولًا
      const P = Math.max(1, Math.min(c.parts || 1, pool.length)); // أجزاء الموضوع على الخريطة
      const shuffled = seededShuffle(pool, 1000 + si * 97);
      const allAxes = c.axes || [];
      // توزيع المحاور الفرعية على الأجزاء عند توفّر كفاية (≥3 لكل جزء)، وإلا يتناوبها كاملًا كل جزء
      const sliced = allAxes.length >= P * 3;
      for (let p = 0; p < P; p++) {
        // قطعة أسئلة متصلة من الخلط المشترك — الأجزاء متنافية لا تتكرر بينها
        const slice = shuffled.slice(
          Math.floor((p * pool.length) / P),
          Math.floor(((p + 1) * pool.length) / P),
        );
        if (!slice.length) continue;
        const axes = sliced
          ? allAxes.slice(
              Math.floor((p * allAxes.length) / P),
              Math.floor(((p + 1) * allAxes.length) / P),
            )
          : allAxes;
        const title = p > 0 ? `${c.title} (${arNum(p + 1)})` : c.title;
        // بناء L مستوى ثابتًا، كل مستوى Q سؤالًا مع تدوير عند القلّة (wraparound)
        // اسم المحور الفرعي يتناوب على مستويات الفصل ويُرقّم عند تكراره
        const axisParts = axes.length ? Math.ceil(L / axes.length) : 0;
        const levels = [];
        for (let li = 0; li < L; li++) {
          const questions = [];
          for (let k = 0; k < Q; k++) {
            questions.push(slice[(li * Q + k) % slice.length]);
          }
          const axis = axes.length ? axes[li % axes.length] : null;
          const part = axes.length ? Math.floor(li / axes.length) + 1 : 0;
          levels.push({
            index: li + 1,
            name: axis ? (axisParts > 1 ? `${axis} ${arNum(part)}` : axis) : null,
            questions,
          });
        }
        built.push({
          si, p,
          ch: {
            subject: c.subject,
            title,
            icon: c.icon,
            theme: c.theme,
            questions: slice,
            count: slice.length,
            levels,
          },
        });
      }
    });
    // الترتيب على الشريط بجولات: أجزاء الموضوع الواحد غير متتابعة
    // الجولة ١ = الجزء الأول من كل الموضوعات، ثم الجزء الثاني… فلا تتجاور أجزاء موضوع واحد
    const rounds = built.reduce((m, b) => Math.max(m, b.p + 1), 1);
    const ordered = [];
    for (let p = 0; p < rounds; p++) {
      for (const b of built) if (b.p === p) ordered.push(b);
    }
    // الترقيم النهائي بعد الترتيب (المعرّفات والمؤشرات)
    this.chapters = ordered
      .map((b, ci) => {
        const ch = b.ch;
        ch.index = ci;
        ch.levels.forEach((lv, li) => {
          lv.id = `c${ci}_l${li + 1}`;
          lv.chapterIndex = ci;
        });
        return ch;
      })
      .filter((ch) => ch.count > 0);
    // ترقيم عالمي متصل تراكميًا عبر كل الفصول
    let g = 0;
    this.chapters.forEach((ch) => {
      ch.levels.forEach((lv) => { lv.globalIndex = ++g; });
    });
  }

  allLevelIds() {
    return this.chapters.flatMap((c) => c.levels.map((l) => l.id));
  }

  allQuestions() {
    return this.chapters.flatMap((c) => c.questions);
  }
}

/* ---------- منطق الفتح ---------- */
export function isLevelUnlocked(bank, store, chapterIndex, levelIndex) {
  const ch = bank.chapters[chapterIndex];
  if (!ch) return false;
  if (levelIndex === 0) return true;
  const prev = ch.levels[levelIndex - 1];
  return store.isCompleted(prev.id);
}

export function isChapterUnlocked(bank, store, chapterIndex) {
  if (chapterIndex === 0) return true;
  const prevCh = bank.chapters[chapterIndex - 1];
  if (!prevCh) return true;
  const ids = prevCh.levels.map((l) => l.id);
  return store.completedCount(ids) >= Math.min(CONFIG.chapterUnlockLevels, ids.length);
}

/* أول مستوى غير مكتمل (المستوى الحالي) */
export function currentLevelRef(bank, store) {
  for (const ch of bank.chapters) {
    for (const lv of ch.levels) {
      if (!store.isCompleted(lv.id)) {
        return { chapter: ch, level: lv };
      }
    }
  }
  const lastCh = bank.chapters[bank.chapters.length - 1];
  const lastLv = lastCh.levels[lastCh.levels.length - 1];
  return { chapter: lastCh, level: lastLv };
}
