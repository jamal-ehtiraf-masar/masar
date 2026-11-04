/* ============================================================
   جواهر الكفاءة — حفظ التقدّم (localStorage)
   ============================================================ */

import { CONFIG } from "./config.js";

const KEY = "jawaaher_progress_v1";

const DEFAULT = {
  version: 1,
  coins: 0,
  gems: 0,
  totalStars: 0,
  levels: {}, // levelId -> { stars, bestPct, bestScore, attempts, completed }
  lastLevel: null,
  settings: { sound: true, music: false, social: { visible: true, showStats: true, joinGroup: false } },
  lives: { count: 5, updatedAt: 0 },
  profile: { name: "متدرّب الكفاءة", avatar: "🧑‍🏫", photo: null, createdAt: Date.now(), lastPlayedAt: Date.now() },
  account: { name: null, token: null }, // حساب المجتمع على الخادم (مزامنة التقدّم)
  daily: { last: null, streak: 0, bestPct: 0 },
  season: 1, // الموسم الحالي (New Game+)
  seasons: [], // أرشيف المواسم المكتملة
  createdAt: Date.now(),
};

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

export class Store {
  constructor() {
    this.data = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return deepClone(DEFAULT);
      const parsed = JSON.parse(raw);
      return Object.assign(deepClone(DEFAULT), parsed, {
        settings: Object.assign(deepClone(DEFAULT.settings), parsed.settings || {}),
        lives: Object.assign(deepClone(DEFAULT.lives), parsed.lives || {}),
        profile: Object.assign(deepClone(DEFAULT.profile), parsed.profile || {}),
        account: Object.assign(deepClone(DEFAULT.account), parsed.account || {}),
        daily: Object.assign(deepClone(DEFAULT.daily), parsed.daily || {}),
        levels: parsed.levels || {},
        seasons: parsed.seasons || [],
      });
    } catch (e) {
      console.warn("Store load failed, resetting:", e);
      return deepClone(DEFAULT);
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn("Store save failed:", e);
    }
    return this;
  }

  reset() {
    this.data = deepClone(DEFAULT);
    this.save();
    return this;
  }

  /* ---- المستويات ---- */
  getLevel(levelId) {
    return this.data.levels[levelId] || null;
  }

  recordLevel(levelId, { pct, score, stars, passed, coins, gems }) {
    const cur = this.data.levels[levelId] || {
      stars: 0,
      bestPct: 0,
      bestScore: 0,
      attempts: 0,
      completed: false,
    };
    const prevStars = cur.stars || 0;
    const improved = stars > prevStars;
    const gainedStars = Math.max(0, stars - prevStars);

    cur.attempts = (cur.attempts || 0) + 1;
    cur.bestPct = Math.max(cur.bestPct || 0, pct);
    cur.bestScore = Math.max(cur.bestScore || 0, score);
    cur.stars = Math.max(prevStars, stars);
    cur.completed = cur.completed || !!passed;

    this.data.levels[levelId] = cur;

    if (gainedStars > 0) this.data.totalStars += gainedStars;
    this.data.coins += coins || 0;
    this.data.gems += gems || 0;
    this.data.lastLevel = levelId;
    if (!this.data.profile.createdAt) this.data.profile.createdAt = Date.now();
    this.data.profile.lastPlayedAt = Date.now();
    this.save();

    return { improved, gainedStars, coins: coins || 0, gems: gems || 0, best: cur };
  }

  /* ---- مساعدات ---- */
  isCompleted(levelId) {
    const l = this.getLevel(levelId);
    return !!(l && l.completed);
  }

  stars(levelId) {
    const l = this.getLevel(levelId);
    return l ? l.stars || 0 : 0;
  }

  completedCount(levelIds) {
    return levelIds.reduce((n, id) => n + (this.isCompleted(id) ? 1 : 0), 0);
  }

  starsCount(levelIds) {
    return levelIds.reduce((n, id) => n + this.stars(id), 0);
  }

  setSetting(k, v) {
    this.data.settings[k] = v;
    this.save();
  }

  /* ---- النقاط والجواهر ---- */
  addCoins(n) {
    this.data.coins = Math.max(0, this.data.coins + n);
    this.save();
    return this.data.coins;
  }
  spendCoins(n) {
    if (this.data.coins < n) return false;
    this.data.coins -= n;
    this.save();
    return true;
  }
  addGems(n) {
    this.data.gems = Math.max(0, this.data.gems + n);
    this.save();
  }

  /* ---- الأرواح ---- */
  regenMs() {
    return (CONFIG.lives.regenMinutes || 15) * 60 * 1000;
  }
  refreshLives() {
    const max = CONFIG.lives.max || 5;
    const now = Date.now();
    const l = this.data.lives;
    if (!l.updatedAt) l.updatedAt = now;
    if (l.count >= max) {
      l.updatedAt = now;
      return max;
    }
    const gained = Math.floor((now - l.updatedAt) / this.regenMs());
    if (gained > 0) {
      l.count = Math.min(max, l.count + gained);
      l.updatedAt = l.count >= max ? now : l.updatedAt + gained * this.regenMs();
      this.save();
    }
    return l.count;
  }
  get lives() {
    return this.data.lives.count;
  }
  get maxLives() {
    return CONFIG.lives.max || 5;
  }
  timeToNextLife() {
    const max = CONFIG.lives.max || 5;
    if (this.data.lives.count >= max) return 0;
    const next = this.data.lives.updatedAt + this.regenMs();
    return Math.max(0, next - Date.now());
  }
  useLife() {
    this.refreshLives();
    if (this.data.lives.count <= 0) return false;
    this.data.lives.count -= 1;
    if (this.data.lives.count === (CONFIG.lives.max || 5) - 1) {
      this.data.lives.updatedAt = Date.now();
    }
    this.save();
    return true;
  }
  addLives(n) {
    const max = CONFIG.lives.max || 5;
    this.data.lives.count = Math.min(max, this.data.lives.count + n);
    this.save();
  }

  /* ---- الملف الشخصي ---- */
  get profile() {
    return this.data.profile;
  }
  setProfile(p) {
    this.data.profile = Object.assign(this.data.profile, p);
    this.save();
  }

  /* ---- حساب المجتمع (خادم المزامنة) ---- */
  get account() {
    return this.data.account || { name: null, token: null };
  }
  setAccount(name, token) {
    this.data.account = { name: name || null, token: token || null };
    this.save();
  }

  /* ---- تحدّي اليوم ---- */
  get daily() {
    return this.data.daily;
  }
  dailyPlayedToday() {
    const today = new Date().toISOString().slice(0, 10);
    return this.data.daily.last === today;
  }
  recordDaily({ pct, streak }) {
    const today = new Date().toISOString().slice(0, 10);
    this.data.daily.last = today;
    this.data.daily.streak = streak;
    this.data.daily.bestPct = Math.max(this.data.daily.bestPct || 0, pct);
    this.save();
  }

  get settings() {
    return this.data.settings;
  }
  get coins() {
    return this.data.coins;
  }
  get gems() {
    return this.data.gems;
  }
  get totalStars() {
    return this.data.totalStars;
  }

  /* ---- المواسم (New Game+) ---- */
  get season() {
    return this.data.season || 1;
  }
  get seasons() {
    return this.data.seasons || [];
  }
  /* يبدأ موسمًا جديدًا: يؤرشف الموسم الحالي، يصفّر تقدّم المستويات والنجوم،
     ويُبقي النقاط والجواهر والملف الشخصي والإعدادات والأرواح. */
  startNewSeason() {
    this.data.seasons.push({
      season: this.data.season || 1,
      stars: this.data.totalStars || 0,
      coins: this.data.coins || 0,
      gems: this.data.gems || 0,
      finishedAt: Date.now(),
    });
    this.data.season = (this.data.season || 1) + 1;
    this.data.levels = {};
    this.data.lastLevel = null;
    this.data.totalStars = 0;
    this.save();
    return this.data.season;
  }
}
