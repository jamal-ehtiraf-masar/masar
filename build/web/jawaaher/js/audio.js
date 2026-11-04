/* ============================================================
   جواهر الكفاءة — مدير الأصوات
   يعتمد على Web Audio API (decodeAudioData) ليتجاوز مشكلة
   Content-Type، مع بديل عبر عنصر <audio>.
   يستعمل ملفات الأصوات الموجودة مسبقاً في المشروع.
   ============================================================ */

const BASE = "/assets/assets/sounds/";

const SOUNDS = {
  tap: "tap.wav",
  button: "button_tap.wav",
  select: "select.wav",
  success: "success.wav",
  complete: "complete.wav",
  victory: "victory.wav",
  error: "error.wav",
  defeat: "defeat.wav",
};

export class Audio {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.gain = null;
    this.buffers = new Map();
    this.loading = new Map();
    this.fallback = new Map();
    this.volume = 0.75;
    this.usingFallback = false;
  }

  _newCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      const ctx = new AC();
      const gain = ctx.createGain();
      gain.gain.value = this.volume;
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.gain = gain;
      return ctx;
    } catch (_) {
      return null;
    }
  }

  _ctx() {
    if (this.ctx) return this.ctx;
    return this._newCtx();
  }

  /** يحمّل الملف ويفكّ ترميزه إلى AudioBuffer */
  _load(name) {
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name));
    if (this.loading.has(name)) return this.loading.get(name);
    const file = SOUNDS[name];
    if (!file) return Promise.resolve(null);
    const p = (async () => {
      try {
        const res = await fetch(BASE + file, { cache: "force-cache" });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const ab = await res.arrayBuffer();
        const ctx = this._ctx();
        if (!ctx) return null;
        const buf = await ctx.decodeAudioData(ab.slice(0));
        this.buffers.set(name, buf);
        return buf;
      } catch (e) {
        console.warn("[audio] تعذّر فك ترميز", name, e && e.message);
        return null;
      }
    })();
    this.loading.set(name, p);
    return p;
  }

  /** تحميل مسبق لكل الأصوات */
  preload(names) {
    (names || Object.keys(SOUNDS)).forEach((n) => this._load(n));
  }

  _playBuffer(buf) {
    if (!this.ctx || !buf) return false;
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.gain);
      src.start(0);
      return true;
    } catch (_) {
      return false;
    }
  }

  _playFallback(name) {
    const file = SOUNDS[name];
    if (!file) return;
    try {
      if (!this.fallback.has(name)) {
        const a = new window.Audio(BASE + file);
        a.preload = "auto";
        a.volume = this.volume;
        this.fallback.set(name, a);
      }
      const a = this.fallback.get(name);
      a.currentTime = 0;
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => {});
    } catch (_) {}
  }

  play(name) {
    if (!this.enabled) return;
    const ctx = this._ctx();
    // استئناف السياق بعد أول تفاعل من المستخدم
    if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});

    const buf = this.buffers.get(name);
    if (buf) {
      this._playBuffer(buf);
      return;
    }
    // لم يُحمّل بعد: نحمّله ثم نشغّله، ونسقط للبديل عند الفشل
    if (ctx) {
      this._load(name).then((b) => {
        if (b) {
          if (this.enabled) this._playBuffer(b);
        } else {
          this._playFallback(name);
        }
      });
    } else {
      this._playFallback(name);
    }
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (v && this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }
}
