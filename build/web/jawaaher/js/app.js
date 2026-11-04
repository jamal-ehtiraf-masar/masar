/* ============================================================
   جواهر الكفاءة — المحرّك الرئيسي (الشاشات والتنقل)
   ============================================================ */

import { CONFIG, themeOf, difficultyOf, levelReward } from "./config.js";
import { Store } from "./store.js";
import { Bank, isLevelUnlocked, isChapterUnlocked, currentLevelRef } from "./bank.js";
import { Audio } from "./audio.js";

const root = document.getElementById("app");

const app = {
  bank: new Bank(),
  store: new Store(),
  audio: null,
  screen: "boot",
  _resizeHandler: null,
  _livesTimer: null,
  quiz: null,
};

/* ---------------- helpers ---------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function h(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (vals[i] != null ? vals[i] : ""), "");
}
/* «15 المطلوبة» من كل مرحلة (فصل): إتمامها وشرط فتح التي بعدها */
function requiredOf(ch) {
  return Math.min(CONFIG.requiredPerChapter || CONFIG.chapterUnlockLevels || 15, (ch && ch.levels && ch.levels.length) || 15);
}
/* مستوى البوابة (آخر مرحلة أو المطلوبة) — آمن لتحدي اليوم الذي بلا levels */
function isGateLevel(ch, lvIndex) {
  const n = (ch && ch.levels && ch.levels.length) || 0;
  if (!n) return false;
  return lvIndex === requiredOf(ch) || lvIndex === n;
}

/* ---------- لهب النار: لسان لهب متعرّج مدبّب (يمتد من الإطار إلى الخارج) ---------- */
const FLAME_BIG = "M50 2 C48.2 7.5 46.8 10.8 47.3 15 C44.4 12.6 42.2 14.2 42.5 18.4 C42.9 23.4 45.6 27.6 50 28.2 C54.4 27.6 57.1 23.4 57.5 18.4 C57.8 14.2 55.6 12.6 52.7 15 C53.2 10.8 51.8 7.5 50 2 Z";
const FLAME_SMALL = "M50 6 C48.6 10.5 47.4 13.2 47.8 17 C45.4 15 43.6 16.3 43.9 19.8 C44.4 23.8 46.8 27 50 27.4 C53.2 27 55.6 23.8 56.1 19.8 C56.4 16.3 54.6 15 52.2 17 C52.6 13.2 51.4 10.5 50 6 Z";
/* تدرّجات اللهب — تُحقن مرة واحدة في الخريطة */
const FIRE_DEFS = `<svg class="fire-defs" aria-hidden="true"><defs>
<linearGradient id="fireGradA" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ff8a00"/><stop offset=".5" stop-color="#ff5a00"/><stop offset="1" stop-color="#ff2400"/></linearGradient>
<linearGradient id="fireGradB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#fff27a"/><stop offset=".45" stop-color="#ffc400"/><stop offset="1" stop-color="#ff6a00"/></linearGradient>
</defs></svg>`;
function fireRingSVG() {
  let back = "";
  let front = "";
  for (let i = 0; i < 12; i++) {
    back += `<g transform="rotate(${i * 30} 50 50)"><path d="${FLAME_BIG}"/></g>`;
    front += `<g transform="rotate(${i * 30 + 15} 50 50)"><path d="${FLAME_SMALL}"/></g>`;
  }
  return `<svg class="fire-ring" viewBox="0 0 100 100" aria-hidden="true">` +
    `<g class="fire-back" fill="url(#fireGradA)">${back}</g>` +
    `<g class="fire-front" fill="url(#fireGradB)">${front}</g></svg>`;
}
function mount(html) {
  if (app._resizeHandler) { window.removeEventListener("resize", app._resizeHandler); app._resizeHandler = null; }
  if (app._livesTimer) { clearInterval(app._livesTimer); app._livesTimer = null; }
  root.innerHTML = html;
  return root;
}
function toast(msg, ms = 1700) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
/* صورة البروفيل: صورة مرفوعة (data URL) أو الرمز التعبيري */
function avatarHTML(p) {
  if (p && typeof p.photo === "string" && p.photo.indexOf("data:image") === 0) {
    return `<img class="av-img" src="${p.photo}" alt="" />`;
  }
  return esc((p && p.avatar) || "🧑‍🏫");
}
/* تقصّ الصورة مربّعًا 256px وتُحوّلها JPEG صغيرة تناسب التخزين المحلي */
function processProfilePhoto(file) {
  return new Promise((resolve) => {
    if (!file || String(file.type).indexOf("image/") !== 0) { resolve(null); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const S = 256;
        const c = document.createElement("canvas");
        c.width = S; c.height = S;
        const g = c.getContext("2d");
        const m = Math.min(img.width, img.height);
        g.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
        resolve(c.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}
function fmtTime(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function confetti(n = 60) {
  const colors = ["#ffcf3f", "#8a2be2", "#21c25e", "#ff5fa2", "#17c9c0", "#ff8a3c"];
  for (let i = 0; i < n; i++) {
    const c = document.createElement("div");
    c.className = "confetti"; c.style.left = Math.random() * 100 + "vw"; c.style.background = colors[i % colors.length];
    c.style.transform = `rotate(${Math.random() * 180}deg)`;
    document.body.appendChild(c);
    c.animate([{ transform: "translateY(-20px) rotate(0)", opacity: 1 },
      { transform: `translateY(105vh) rotate(${540 + Math.random() * 360}deg)`, opacity: 0.9 }],
      { duration: 2600 + Math.random() * 1600, easing: "cubic-bezier(.3,.6,.5,1)" });
    setTimeout(() => c.remove(), 4200);
  }
}

/* ---------------- مجموعة أيقونات SVG أصلية (بديل الإيموجي) ---------------- */
const _svg = (inner, extra = "") => `<svg viewBox="0 0 24 24" fill="none" ${extra}>${inner}</svg>`;
const ICONS = {
  heart: _svg('<path d="M12 20.6C11.6 20.6 3.8 15.9 2.3 11.5 1.1 8.2 3.2 5.1 6.4 5.2c1.8.1 3.4 1.1 5.6 3.2 2.2-2.1 3.8-3.1 5.6-3.2 3.2-.1 5.3 3 4.1 6.3C20.2 15.9 12.4 20.6 12 20.6z" fill="currentColor"/>'),
  star: _svg('<path d="M12 2.6l2.9 6 6.5.9-4.7 4.5 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.6 9.5l6.5-.9z" fill="currentColor"/>'),
  coin: _svg('<circle cx="12" cy="12" r="9" fill="currentColor"/><circle cx="12" cy="12" r="6" fill="none" stroke="rgba(90,55,0,.35)" stroke-width="1.6"/><circle cx="12" cy="12" r="2.1" fill="rgba(90,55,0,.35)"/>'),
  gem: _svg('<path d="M12 3l5 4.5-5 13-5-13z" fill="currentColor"/><path d="M7 7.5h10M12 3l0 17.5" stroke="rgba(0,0,0,.28)" stroke-width="1.1"/>'),
  sound: _svg('<path d="M4 9h3l5-4v14l-5-4H4z" fill="currentColor"/><path d="M15.4 8.6a5 5 0 0 1 0 6.8M18 6a8.6 8.6 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  mute: _svg('<path d="M4 9h3l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9.6l5 4.8M21 9.6l-5 4.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'),
  menu: _svg('<path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  back: _svg('<path d="M14.5 5l-7 7 7 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  play: _svg('<path d="M7.5 4.6l12 7.4-12 7.4z" fill="currentColor"/>'),
  lock: _svg('<rect x="5" y="10.6" width="14" height="9.4" rx="2.4" fill="currentColor"/><path d="M8.5 10.6V8.2a3.5 3.5 0 0 1 7 0v2.4" stroke="currentColor" stroke-width="2" fill="none"/>'),
  crown: _svg('<path d="M3.6 8.2l3.3 3.1L12 5.2l5.1 6.1 3.3-3.1-1.4 10.1H5z" fill="currentColor"/>'),
  trophy: _svg('<path d="M7 4h10v3.2a5 5 0 0 1-10 0z" fill="currentColor"/><path d="M7 5H4.5v1.4A3.6 3.6 0 0 0 8 10M17 5h2.5v1.4A3.6 3.6 0 0 1 16 10" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="10.4" y="11.4" width="3.2" height="4" fill="currentColor"/><rect x="7.4" y="15.4" width="9.2" height="3.2" rx="1" fill="currentColor"/>'),
  check: _svg('<path d="M5 12.5l4.5 4.5L19 6.5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
  calendar: _svg('<rect x="4" y="5.6" width="16" height="14.8" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10.4h16M8 3.6v4M16 3.6v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  home: _svg('<path d="M4 11.4L12 4l8 7.4V20H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.5 20v-5h5v5" fill="none" stroke="currentColor" stroke-width="1.8"/>'),
  map: _svg('<path d="M9 4L4 6v14l5-2 6 2 5-2V4l-5 2z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 4v14M15 6v14" stroke="currentColor" stroke-width="1.7"/>'),
  gear: _svg('<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.6v3M12 18.4v3M21.4 12h-3M5.6 12h-3M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1M18.6 18.6l-2.1-2.1M7.5 7.5L5.4 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  trash: _svg('<path d="M5 7h14M9.5 7V5.2h5V7M7 7l1 12.4h8L17 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'),
  book: _svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'),
  bulb: _svg('<path d="M12 3a6 6 0 0 0-3.4 10.9V16h6.8v-2.1A6 6 0 0 0 12 3z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M9.6 19h4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  timer: _svg('<circle cx="12" cy="13" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 13V9.2M9.6 3h4.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  skip: _svg('<path d="M6 5.5l9 6.5-9 6.5z" fill="currentColor"/><path d="M17.5 5.5v13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  divide: _svg('<path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="1.6" fill="currentColor"/><circle cx="12" cy="17" r="1.6" fill="currentColor"/>'),
  refresh: _svg('<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3M19.5 12a7.5 7.5 0 0 1-12.8 5.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="M17 3.4v3.7h-3.7M7 20.6v-3.7h3.7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>'),
  heartBroken: _svg('<path d="M12 20.6C11.6 20.6 3.8 15.9 2.3 11.5 1.1 8.2 3.2 5.1 6.4 5.2c1.8.1 3.4 1.1 5.6 3.2 2.2-2.1 3.8-3.1 5.6-3.2 3.2-.1 5.3 3 4.1 6.3C20.2 15.9 12.4 20.6 12 20.6z" fill="currentColor"/><path d="M13.8 5.8l-2.2 3.4h2.6l-2.4 3.8" fill="none" stroke="rgba(10,12,40,.6)" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>'),
  close: _svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  clock: _svg('<circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  users: _svg('<circle cx="9" cy="8.4" r="3.4" fill="currentColor"/><path d="M3.4 19.4c.5-3.2 2.8-4.8 5.6-4.8s5.1 1.6 5.6 4.8" fill="currentColor"/><circle cx="17" cy="9.2" r="2.6" fill="currentColor"/><path d="M15.2 14.7c2.6-.5 4.7 1 5.4 4.1" fill="currentColor"/>'),
  eye: _svg('<path d="M2.5 12S6 6.4 12 6.4 21.5 12 21.5 12 18 17.6 12 17.6 2.5 12 2.5 12z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/>'),
  chart: _svg('<path d="M5 19V11M11 19V6M17 19v-6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
};

/* ---------------- شعارات المناطق (SVG أبيض مميز لكل محور، بلا تكرار) ---------------- */
const REGION_EMBLEM = [
  _svg('<path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" fill="currentColor"/><rect x="9" y="17" width="6" height="1.8" rx="0.9" fill="currentColor"/><rect x="10" y="19.6" width="4" height="1.3" rx="0.6" fill="currentColor"/>'),
  _svg('<path d="M12 3.5v16.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M6 6.5h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M3 12.5l3-5 3 5z" fill="currentColor"/><path d="M15 12.5l3-5 3 5z" fill="currentColor"/><path d="M5 20.5h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  _svg('<path d="M7 3h7l4 4v14H7z" fill="currentColor"/><path d="M9.5 11h5M9.5 14h5M9.5 17h3" stroke="rgba(0,0,0,.32)" stroke-width="1.4" stroke-linecap="round"/>'),
  _svg('<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/>'),
  _svg('<path d="M12 3l6 8.5h-4l5 7.5H5l5-7.5H6z" fill="currentColor"/><rect x="11" y="19" width="2" height="2.4" rx="1" fill="currentColor"/>'),
  _svg('<path d="M4 21V9l4-2v14zM10 21V5l4 2v14zM16 21V8l4 2v11z" fill="currentColor"/>'),
  _svg('<circle cx="6" cy="6.5" r="2.2" fill="currentColor"/><circle cx="18" cy="17.5" r="2.2" fill="currentColor"/><path d="M7.8 8c6.4 0 3 9.5 9 9.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-dasharray="3 2.4" stroke-linecap="round"/>'),
  _svg('<path d="M3 5.2c4-2 8-2 9 0v13.6c-1-2-5-2-9 0z" fill="currentColor"/><path d="M21 5.2c-4-2-8-2-9 0v13.6c1-2 5-2 9 0z" fill="currentColor"/>'),
  _svg('<rect x="5" y="3" width="14" height="18" rx="2" fill="currentColor"/><rect x="8" y="6" width="8" height="3" rx="1" fill="rgba(0,0,0,.32)"/><circle cx="9" cy="13" r="1.25" fill="rgba(0,0,0,.38)"/><circle cx="12" cy="13" r="1.25" fill="rgba(0,0,0,.38)"/><circle cx="15" cy="13" r="1.25" fill="rgba(0,0,0,.38)"/><circle cx="9" cy="17" r="1.25" fill="rgba(0,0,0,.38)"/><circle cx="12" cy="17" r="1.25" fill="rgba(0,0,0,.38)"/><circle cx="15" cy="17" r="1.25" fill="rgba(0,0,0,.38)"/>'),
  _svg('<path d="M9.2 3h5.6v4l4.6 9.2A3 3 0 0 1 16.7 21H7.3a3 3 0 0 1-2.7-4.8z" fill="currentColor"/><path d="M7.4 15h9.2" stroke="rgba(0,0,0,.3)" stroke-width="1.5"/>'),
  _svg('<path d="M4 5h16v10.5H9.5L4 19z" fill="currentColor"/><path d="M8 9h8M8 12h5" stroke="rgba(0,0,0,.3)" stroke-width="1.4" stroke-linecap="round"/>'),
  _svg('<path d="M12 20C11.6 20 4 15.4 2.7 11.3 1.5 8 3.5 5 6.6 5.1c1.7.1 3.2 1 5.4 3 2.2-2 3.7-2.9 5.4-3 3.1-.1 5.1 2.9 3.9 6.2C20 15.4 12.4 20 12 20z" fill="currentColor"/><path d="M4 12h3.6l1.8-3 2.4 5 1.8-3H20" stroke="rgba(0,0,0,.35)" stroke-width="1.3" fill="none" stroke-linejoin="round"/>'),
  _svg('<path d="M3 19.5L10 5.5l4 7 2-3 5 10z" fill="currentColor"/><circle cx="17.4" cy="5.6" r="2" fill="currentColor"/>'),
  _svg('<path d="M2 19.5L9 6.5l4 7 2.4-3.4 6.6 9.4z" fill="currentColor"/><circle cx="6" cy="6" r="1.6" fill="currentColor"/>'),
  _svg('<path d="M4.5 21V8.5h2V5h2.2v3.5h2.6V5h2.2v3.5h2.6V5h2.2v3.5h2.2V21z" fill="currentColor"/><rect x="10" y="14" width="4" height="7" rx="1" fill="rgba(0,0,0,.34)"/>'),
];
function regionIcon(ci) { return REGION_EMBLEM[ci % REGION_EMBLEM.length] || ICONS.gem; }

/* ---------------- HUD ---------------- */
function hud() {
  const s = app.store;
  s.refreshLives();
  const av = avatarHTML(s.profile);
  return h`
    <div class="hud">
      <button class="avatar" id="hud-avatar" aria-label="الملف">${av}</button>
      <div class="title-block" id="hud-title-block">
        <div class="title">${esc(CONFIG.title)}</div>
        <div class="sub">${esc(s.profile.name || CONFIG.subtitle)}</div>
      </div>
      <div class="spacer"></div>
      <button class="iconbtn" id="hud-friends" aria-label="دائرة الأصدقاء" title="دائرة الأصدقاء">${ICONS.users}<span class="badge-red" id="hud-friends-badge" hidden>0</span></button>
      <div class="hud-counters">
        <span class="chip lives" title="الأرواح">${ICONS.heart}<span id="hud-lives">${s.lives}</span></span>
        <span class="chip stars" title="النجوم">${ICONS.star}<span id="hud-stars">${s.totalStars}</span></span>
        <span class="chip coins" title="النقاط">${ICONS.coin}<span id="hud-coins">${s.coins}</span></span>
        <span class="chip gems" title="الجواهر">${ICONS.gem}<span id="hud-gems">${s.gems}</span></span>
      </div>
      <button class="iconbtn sound" id="hud-sound" aria-label="الصوت">${s.settings.sound ? ICONS.sound : ICONS.mute}</button>
      <button class="iconbtn" id="hud-menu" aria-label="القائمة">${ICONS.menu}</button>
    </div>`;
}
function refreshHUD() {
  const s = app.store;
  s.refreshLives();
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  set("hud-stars", s.totalStars); set("hud-coins", s.coins); set("hud-gems", s.gems); set("hud-lives", s.lives);
}
/* شارة الإشعارات الاجتماعية: قلوب في البريد + طلبات صداقة معلّقة */
let _fbCache = { at: 0, n: -1 };
async function refreshFriendsBadge(force) {
  const s = app.store;
  const el = document.getElementById("hud-friends-badge");
  if (!el) return;
  if (!s.account || !s.account.token || app.screen === "entry") { el.hidden = true; return; }
  const now = Date.now();
  if (!force && now - _fbCache.at < 15000 && _fbCache.n >= 0) { el.textContent = _fbCache.n; el.hidden = _fbCache.n <= 0; return; }
  const res = await socialFetch("/api/social/friends?token=" + encodeURIComponent(s.account.token));
  if (!res || !res.ok) return;
  const n = (res.inboxLives || []).length + (res.requests || []).length;
  _fbCache = { at: now, n };
  el.textContent = n;
  el.hidden = n <= 0;
}

function wireHUD() {
  const av = document.getElementById("hud-avatar");
  if (av) av.addEventListener("click", () => { app.audio.play("tap"); openSettings(); });
  const tb = document.getElementById("hud-title-block");
  if (tb) tb.addEventListener("click", () => { app.audio.play("tap"); openSettings(); });
  const menu = document.getElementById("hud-menu");
  if (menu) menu.addEventListener("click", () => { app.audio.play("tap"); openSettings(); });
  const fr = document.getElementById("hud-friends");
  if (fr) {
    fr.addEventListener("click", () => { app.audio.play("tap"); openSocial(); });
    clearInterval(app._friendsBadgeTimer);
    refreshFriendsBadge();
    if (app.store.account && app.store.account.token) app._friendsBadgeTimer = setInterval(() => refreshFriendsBadge(true), 45000);
  }
  const snd = document.getElementById("hud-sound");
  if (snd) snd.addEventListener("click", () => {
    const v = !app.store.settings.sound;
    app.store.setSetting("sound", v);
    app.audio.setEnabled(v);
    snd.innerHTML = v ? ICONS.sound : ICONS.mute;
    if (v) app.audio.play("select");
    toast(v ? "🔊 الصوت مفعّل" : "🔇 الصوت مكتوم", 1100);
  });
  // تحديث دوري للأرواح
  if (app.store.lives < app.store.maxLives) {
    app._livesTimer = setInterval(() => {
      const before = app.store.lives;
      app.store.refreshLives();
      if (app.store.lives !== before) refreshHUD();
    }, 20000);
  }
}

/* شرط فتح الموسم الجديد: كل المستويات بنجمتين على الأقل */
function seasonEligible() {
  const ids = app.bank.allLevelIds();
  if (!ids.length) return false;
  const need = CONFIG.seasonUnlockStars || 2;
  return ids.every((id) => app.store.stars(id) >= need);
}
function seasonProgress() {
  const ids = app.bank.allLevelIds();
  const need = CONFIG.seasonUnlockStars || 2;
  const done = ids.reduce((n, id) => n + (app.store.stars(id) >= need ? 1 : 0), 0);
  return { done, total: ids.length, need };
}
function allLevelsPassed() {
  const ids = app.bank.allLevelIds();
  return ids.length > 0 && app.store.completedCount(ids) === ids.length;
}

/* ============================================================
   شاشة الدخول
   ============================================================ */
function renderEntry() {
  app.screen = "entry";
  const cur = currentLevelRef(app.bank, app.store);
  const started = app.store.totalStars > 0 || Object.keys(app.store.data.levels).length > 0;
  const dailyDone = app.store.dailyPlayedToday();

  mount(h`
    <div class="screen entry">
      <div class="crest"><span class="crest-ic">${ICONS.gem}</span><span class="crest-crown">${ICONS.crown}</span></div>
      <h1>${esc(CONFIG.title)}</h1>
      <div class="tagline">${esc(CONFIG.tagline)}</div>
      ${app.store.season > 1 ? `<div class="season-line">${ICONS.calendar} الموسم ${app.store.season}</div>` : ""}
      <div class="actions">
        ${started ? `<button class="btn green block" id="btn-continue">متابعة الرحلة</button>` : ""}
        <button class="btn block" id="btn-start">${started ? `الخريطة ${ICONS.map}` : `ابدأ اللعب ${ICONS.play}`}</button>
        <button class="btn blue block" id="btn-daily">تحدّي اليوم ${ICONS.calendar} ${dailyDone ? "(مُنجز)" : ""}</button>
        <button class="btn ghost block" id="btn-how">كيف ألعب؟</button>
        <button class="btn ghost block" id="btn-social">${ICONS.users} ${app.store.account.token ? "تقدّم الزملاء — " + esc(app.store.account.name || "") : "تقدّم الزملاء"}</button>
      </div>
    </div>`);

  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener("click", fn); };
  on("btn-start", () => { app.audio.play("button"); renderMap(); });
  on("btn-continue", () => { app.audio.play("button"); openPreview(cur.chapter.index, cur.level.index - 1); });
  on("btn-daily", () => { app.audio.play("button"); startDaily(); });
  on("btn-how", () => { app.audio.play("tap"); renderHow(); });
  on("btn-social", () => { app.audio.play("button"); openSocial(); });
}

/* ============================================================
   الخريطة
   ============================================================ */
/* ---- أشكال طبيعية أصلية (SVG) تُزرع على جانبي الطريق ---- */
const SCENERY_SVG = {
  tree: `<svg viewBox="0 0 64 84"><ellipse cx="32" cy="80" rx="15" ry="4" fill="rgba(0,0,0,.28)"/><rect x="28" y="52" width="8" height="26" rx="3" fill="#7a4a1e"/><circle cx="32" cy="34" r="20" fill="#2fa85c"/><circle cx="20" cy="42" r="14" fill="#268f4c"/><circle cx="44" cy="42" r="14" fill="#35bd68"/><circle cx="32" cy="26" r="15" fill="#41cf74"/></svg>`,
  pine: `<svg viewBox="0 0 64 84"><ellipse cx="32" cy="80" rx="14" ry="4" fill="rgba(0,0,0,.28)"/><rect x="29" y="60" width="6" height="18" rx="2" fill="#6b4318"/><path d="M32 6l16 26H16z" fill="#1f9c5a"/><path d="M32 24l20 30H12z" fill="#25b365"/><path d="M32 42l22 30H10z" fill="#2cc86f"/></svg>`,
  bush: `<svg viewBox="0 0 72 46"><ellipse cx="36" cy="42" rx="24" ry="4" fill="rgba(0,0,0,.25)"/><circle cx="20" cy="28" r="14" fill="#2ca85e"/><circle cx="38" cy="22" r="17" fill="#35c06d"/><circle cx="54" cy="30" r="13" fill="#2aa659"/><circle cx="30" cy="16" r="11" fill="#45d379"/></svg>`,
  rock: `<svg viewBox="0 0 64 42"><ellipse cx="32" cy="39" rx="24" ry="4" fill="rgba(0,0,0,.25)"/><path d="M8 38L20 12l14 6 8-10 14 30z" fill="#8a8fb0"/><path d="M20 12l14 6 4 20H10z" fill="#a2a8cc"/></svg>`,
  flower: `<svg viewBox="0 0 40 58"><path d="M20 54V26" stroke="#2c9c5a" stroke-width="3" stroke-linecap="round"/><circle cx="20" cy="18" r="6" fill="#ffd23f"/><circle cx="20" cy="9" r="6" fill="#ff7fb0"/><circle cx="29" cy="15" r="6" fill="#ff7fb0"/><circle cx="26" cy="26" r="6" fill="#ff8fbd"/><circle cx="14" cy="26" r="6" fill="#ff8fbd"/><circle cx="11" cy="15" r="6" fill="#ff7fb0"/></svg>`,
  crystal: `<svg viewBox="0 0 48 66"><ellipse cx="24" cy="62" rx="14" ry="4" fill="rgba(0,0,0,.25)"/><path d="M24 4l14 18-14 40L10 22z" fill="#66e8ff"/><path d="M24 4l14 18H10z" fill="#c2f6ff"/><path d="M24 4v58" stroke="rgba(255,255,255,.65)" stroke-width="1.5"/></svg>`,
  book: `<svg viewBox="0 0 64 54"><ellipse cx="32" cy="51" rx="20" ry="3.5" fill="rgba(0,0,0,.25)"/><path d="M6 12c10-6 20-6 26 0v32c-6-6-16-6-26 0z" fill="#ff6b6b"/><path d="M58 12c-10-6-20-6-26 0v32c6-6 16-6 26 0z" fill="#ff9090"/><path d="M32 12v32" stroke="#fff" stroke-width="2"/></svg>`,
  pencil: `<svg viewBox="0 0 64 64"><path d="M46 6l12 12-34 34-16 4 4-16z" fill="#ffd23f"/><path d="M52 12l-34 34-8 2 2-8 34-34z" fill="#ffb347"/><path d="M46 6l12 12-6 6-12-12z" fill="#ff8a3c"/><path d="M8 52l-4 8 8-4z" fill="#e6e6e6"/></svg>`,
  bridge: `<svg viewBox="0 0 96 44"><path d="M4 36c22-28 66-28 88 0" stroke="#b5793c" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M6 38h84" stroke="#8a5a28" stroke-width="5" stroke-linecap="round"/><path d="M26 24v14M48 16v22M70 24v14" stroke="#8a5a28" stroke-width="4"/></svg>`,
};

/* أشكال مميزة لكل سمة منطقة */
const THEME_SCENERY = {
  knowledge: ["tree", "book", "crystal", "bush", "pencil"],
  education: ["book", "tree", "crystal", "pencil", "flower"],
  psychology: ["pine", "tree", "bush", "flower", "rock"],
  didactics: ["pencil", "book", "rock", "bush", "crystal"],
  planning: ["book", "bush", "flower", "tree", "rock"],
  assessment: ["book", "flower", "tree", "bush", "pencil"],
  practice: ["tree", "bridge", "bush", "flower", "rock"],
  legislation: ["book", "rock", "tree", "bush", "crystal"],
  summit: ["pine", "rock", "tree", "bush", "pine"],
  finalfort: ["tree", "crystal", "flower", "bush", "rock"],
};

/* عناصر طبيعية موزّعة على طول مسار المحور (تبقى خلف الطريق والعقد) */
function sceneryHtml(ch, t, ci) {
  const pool = THEME_SCENERY[ch.theme] || ["tree", "bush", "flower", "rock"];
  const n = 8;
  let out = "";
  for (let k = 0; k < n; k++) {
    const side = k % 2 === 0 ? "right" : "left";
    const top = ((k + 0.65) / n) * 100;
    const size = 40 + ((ci * 7 + k * 13) % 26);
    const shape = pool[(ci * 2 + k) % pool.length];
    const off = 1 + ((k * 4 + ci) % 6);
    out += `<span class="scenery-item ${side}" style="top:${top.toFixed(1)}%;${side}:${off}%;width:${size}px;--dur:${5 + (k % 4)}s;animation-delay:${(k * 0.5).toFixed(1)}s">${SCENERY_SVG[shape]}</span>`;
  }
  return out;
}

function renderMap(scrollToChapter = null) {
  app.screen = "map";
  const s = app.store, bank = app.bank;
  const need = CONFIG.seasonUnlockStars || 2;
  const curRef = currentLevelRef(bank, s);
  const curLevelId = curRef.level.id;
  const justUnlocked = app._prevCurId && app._prevCurId !== curLevelId ? curLevelId : null;
  app._prevCurId = curLevelId;
  let chaptersHtml = FIRE_DEFS;
  let gi = 0; // مؤشر عالمي بالترتيب المرئي — يجعل تمويج الطريق متصلاً

  // تصاعديًا من الأسفل إلى الأعلى: نعكس ترتيب المحاور والمستويات
  [...bank.chapters].map((c, i) => ({ c, i })).reverse().forEach(({ c: ch, i: ci }) => {
    const t = themeOf(ch.theme);
    const unlocked = isChapterUnlocked(bank, s, ci);
    const doneIds = ch.levels.map((l) => l.id);
    const done = s.completedCount(doneIds);
    // «15 المطلوبة»: شرط إتمام الفصل وشرط فتح التالي — التقدّم يتجه نحوها
    const required = requiredOf(ch);
    const pct = Math.min(100, Math.round((done / required) * 100));
    const maxStars = required * 3;
    const chapterStars = Math.min(s.starsCount(doneIds), maxStars);
    const chapterComplete = done >= required;

    let rowsHtml = "";
    ch.levels.map((l, i) => ({ l, i })).reverse().forEach(({ l: lv, i: li }) => {
      const lvlUnlocked = unlocked && isLevelUnlocked(bank, s, ci, li);
      const stars = s.stars(lv.id);
      const completed = s.isCompleted(lv.id);
      const isCurrent = lvlUnlocked && !completed && curLevelId === lv.id;
      const needsStar = completed && stars < need;
      const isMilestone = (lv.globalIndex || lv.index) % 10 === 0;
      const x = 50 + 32 * Math.sin(gi * 0.72) + 8 * Math.sin(gi * 2.1) + 6 * Math.cos(gi * 0.38);
      const cls = ["level-node"];
      if (!lvlUnlocked) cls.push("locked");
      else if (completed) cls.push("completed");
      else if (isCurrent) cls.push("current");
      else cls.push("available");
      if (needsStar) cls.push("need-star");
      if (isMilestone && lvlUnlocked) cls.push("milestone");
      if (justUnlocked === lv.id) cls.push("just-unlocked");
      // النار على عقدة «15 المطلوبة» + آخر مرحلة في الفصل
      const isGate = lv.index === required || lv.index === ch.levels.length;
      if (isGate) cls.push("gate");
      let badge = "";
      if (!lvlUnlocked) badge = `<span class="badge lock">${ICONS.lock}</span>`;
      // شارات خارج القرص (فوق الإطار) — التاج والجواهر لتظهرا بوضوح
      let outBadge = "";
      if (lvlUnlocked && isMilestone) outBadge = `<span class="badge jewel">${ICONS.gem}</span>`;
      else if (lvlUnlocked && completed && stars === 3) outBadge = `<span class="badge crown">${ICONS.crown}</span>`;
      // شارة اللاعب: تظهر بجانب آخر مستوى وصل إليه (تُقلب لليسار قرب الحافة)
      let playerBadge = "";
      if (isCurrent) {
        const flip = x > 58;
        playerBadge = `<button class="player-badge ${flip ? "flip" : ""}" id="player-badge"
             style="${flip ? `right:calc(${(100 - x).toFixed(2)}% + 52px)` : `left:calc(${x.toFixed(2)}% + 52px)`}"
             aria-label="بطاقة الملف الشخصي"><span class="pb-arrow"></span><span class="pb-av">${avatarHTML(s.profile)}</span><span class="pb-name">${esc(s.profile.name)}</span></button>`;
      }
      rowsHtml += h`
        <div class="level-row">
          <div class="${cls.join(" ")}" data-ci="${ci}" data-li="${li}"
               title="${lv.name ? esc(lv.name) : ""}"
               style="left:${x.toFixed(2)}%;--n1:${t.n1};--n2:${t.n2}">
            <span class="node-shadow"></span>
            <span class="node-ring"></span>
            <div class="disc">
              <span class="gloss"></span>
              <span class="num">${lv.globalIndex || lv.index}</span>
              ${badge}
            </div>
            ${outBadge}
            ${isGate ? fireRingSVG() : ""}
            ${completed ? `<span class="stars">${[0, 1, 2].map((k) => `<i class="${k < stars ? "on" : ""}">${ICONS.star}</i>`).join("")}</span>` : ""}
            ${needsStar ? `<span class="need" title="تحتاج نجمة إضافية">${ICONS.star}</span>` : ""}
            ${isCurrent ? `<span class="start-tag">ابدأ<i>${ICONS.play}</i></span>` : ""}
          </div>
          ${playerBadge}
        </div>`;
      gi++;
    });

    chaptersHtml += h`
      <div class="chapter ${unlocked ? "" : "locked-chapter"}" id="chapter-${ci}" data-ci="${ci}"
           style="--sky1:${t.sky1 || t.a};--sky2:${t.sky2 || t.b};--hill:${t.hill || t.n2};--ra:${t.a};--rb:${t.b}">
        <div class="scenery" aria-hidden="true">${sceneryHtml(ch, t, ci)}</div>
        <div class="chapter-inner">
          <div class="chapter-banner" style="--ch-a:${t.a};--ch-b:${t.b}">
            <div class="ch-ic">${regionIcon(ci)}</div>
            <div class="ch-main">
              <div class="ch-top">
                <span class="ch-name">${esc(ch.title)}</span>
                <span class="ch-stars">${ICONS.star}<b>${chapterStars}</b>/${maxStars}</span>
              </div>
              <div class="ch-meta">${esc(ch.subject)} • ${ch.count} سؤال • ${ch.levels.length} مستوى • <b>المطلوب ${required}</b></div>
              <div class="ch-bar"><i style="width:${pct}%"></i></div>
            </div>
            <div class="ch-status ${chapterComplete ? "done" : ""} ${unlocked ? "" : "shut"}">
              ${!unlocked ? ICONS.lock : chapterComplete ? ICONS.check : `${Math.min(done, required)}/${required}`}
            </div>
          </div>
          <div class="chapter-path">${rowsHtml}</div>
        </div>
      </div>`;
  });

  const eligible = seasonEligible();
  const passed = allLevelsPassed();
  const prog = seasonProgress();
  const fabInner = eligible
    ? `${ICONS.trophy}<span class="fab-tx">ابدأ الموسم الجديد</span>`
    : passed
      ? `${ICONS.star}<span class="fab-tx">أكمل النجمة ${prog.need} (${prog.done}/${prog.total})</span>`
      : `${ICONS.play}<span class="fab-tx">${s.totalStars ? "متابعة" : "ابدأ"}</span>`;
  const fabCls = eligible || passed ? "" : "green";

  mount(h`
    <div class="screen map-screen">
      <div class="map-world" aria-hidden="true">
        <svg class="world-sky" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="wgSky" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#3b2b93"/>
              <stop offset="0.42" stop-color="#28308c"/>
              <stop offset="0.72" stop-color="#1f6f93"/>
              <stop offset="1" stop-color="#15a79b"/>
            </linearGradient>
            <linearGradient id="wgFar" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#5a4fb0"/><stop offset="1" stop-color="#332f7e"/>
            </linearGradient>
            <linearGradient id="wgMid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="#2f97a3"/><stop offset="1" stop-color="#1c6076"/>
            </linearGradient>
            <radialGradient id="wgSun" cx="0.5" cy="0.5" r="0.5">
              <stop offset="0" stop-color="#ffe9a8" stop-opacity="0.9"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="1440" height="900" fill="url(#wgSky)"/>
          <circle cx="1060" cy="210" r="260" fill="url(#wgSun)"/>
          <circle cx="1060" cy="210" r="66" fill="#fff2cd" opacity="0.9"/>
          <path d="M0 560 L230 360 L430 545 L650 315 L890 560 L1130 380 L1330 545 L1440 470 L1440 900 L0 900Z" fill="url(#wgFar)" opacity="0.72"/>
          <path d="M0 665 L265 470 L505 665 L765 440 L1045 665 L1305 500 L1440 625 L1440 900 L0 900Z" fill="url(#wgMid)" opacity="0.85"/>
        </svg>
        <svg class="world-hills" viewBox="0 0 1440 320" preserveAspectRatio="none">
          <path d="M0 150 C280 60 520 220 760 140 C1000 60 1240 200 1440 120 L1440 320 L0 320Z" fill="#12a05f" opacity="0.92"/>
          <path d="M0 215 C300 145 560 265 860 195 C1120 135 1320 235 1440 185 L1440 320 L0 320Z" fill="#0b7248"/>
        </svg>
        <span class="mw-cloud c1"></span>
        <span class="mw-cloud c2"></span>
        <span class="mw-cloud c3"></span>
        <span class="mw-spark"></span>
      </div>
      ${hud()}
      ${app.store.season > 1 ? `<div class="season-badge">الموسم ${app.store.season}</div>` : ""}
      <div class="map-wrap"><div class="map-scroll">
        ${chaptersHtml}
        <div class="map-end"></div>
        <svg id="world-path" class="world-path" preserveAspectRatio="none"></svg>
      </div></div>
      <button class="btn ${fabCls} continue-fab" id="fab-continue">${fabInner}</button>
    </div>`);

  wireHUD();
  const mapScroll = root.querySelector(".map-wrap");
  if (scrollToChapter != null) {
    const focusNode = document.getElementById("chapter-" + scrollToChapter);
    if (focusNode && mapScroll) mapScroll.scrollTop = Math.max(0, focusNode.offsetTop - 80);
  } else {
    /* الدخول الطبيعي: قفزة حتمية على عقدة المستوى الحالي وسط الشاشة (بلا توقيتات) */
    try {
      const li = Math.max(0, (curRef.level.index || 1) - 1);
      const node = root.querySelector(`.level-node[data-ci="${curRef.chapter.index}"][data-li="${li}"]`);
      let y = 0, el = node;
      while (el && el !== mapScroll) { y += el.offsetTop; el = el.offsetParent; }
      const target = node ? Math.max(0, y - mapScroll.clientHeight / 2 + node.offsetHeight / 2) : 0;
      if (node && mapScroll) {
        mapScroll.scrollTop = target;
        node.classList.add("focus-ring");
        setTimeout(() => node.classList.remove("focus-ring"), 1600);
      }
    } catch (_) {}
  }
  requestAnimationFrame(() => drawWorldPath());
  app._resizeHandler = () => drawWorldPath();
  window.addEventListener("resize", app._resizeHandler);

  root.querySelectorAll(".level-node").forEach((n) => {
    n.addEventListener("click", () => {
      const ci = +n.dataset.ci, li = +n.dataset.li;
      if (n.classList.contains("locked")) { app.audio.play("error"); toast("اجتز المستوى السابق لفتح هذا المستوى"); return; }
      app.audio.play("tap"); openPreview(ci, li);
    });
  });
  const pBadge = document.getElementById("player-badge");
  if (pBadge) pBadge.addEventListener("click", () => { app.audio.play("tap"); openPlayerCard(); });
  document.getElementById("fab-continue").addEventListener("click", () => {
    app.audio.play("button");
    if (eligible) { renderSeasonComplete(); return; }
    if (passed) { promptNextNeeded(); return; }
    const cur = currentLevelRef(app.bank, app.store);
    const node = document.getElementById("chapter-" + cur.chapter.index);
    if (node && !isChapterUnlocked(app.bank, app.store, cur.chapter.index)) { mapScroll.scrollTop = Math.max(0, node.offsetTop - 80); return; }
    centerOnNode(mapScroll, cur.chapter.index, cur.level.index - 1, () => openPreview(cur.chapter.index, cur.level.index - 1));
  });

  // احتفال فتح المستوى الجديد
  if (justUnlocked) {
    const jn = root.querySelector('.level-node[data-ci="' + curRef.chapter.index + '"][data-li="' + (curRef.level.index - 1) + '"]');
    if (jn) setTimeout(() => { jn.classList.add("pop"); sparkleAt(jn, 10); }, 300);
  }

  decorateMapRivals();
}

/* ---- منافسو الخريطة (على غرار كاندي كراش): أفاتار كل زميل عند عقدة وصله ---- */
let _peersCache = { at: 0, rows: [] };
async function fetchMapPeers(force) {
  const s = app.store;
  if (!s.account || !s.account.token) { _peersCache = { at: 0, rows: [] }; return _peersCache.rows; }
  const now = Date.now();
  if (!force && now - _peersCache.at < 8000) return _peersCache.rows;
  const res = await socialFetch("/api/social/list?token=" + encodeURIComponent(s.account.token));
  if (res && res.ok) _peersCache = { at: now, rows: res.peers || [] };
  return _peersCache.rows;
}
async function decorateMapRivals() {
  const s = app.store;
  if (!app.bank) return;
  const peers = await fetchMapPeers(false);
  if (!document.querySelector(".map-scroll")) return; // خرج المستخدم قبل وصول القائمة
  document.querySelectorAll(".rival-badge").forEach((b) => b.remove()); // تنظيف قبل إعادة الرسم
  const byId = {};
  app.bank.chapters.forEach((ch, ci) => ch.levels.forEach((lv, li) => { byId[lv.id] = { ci, li }; }));
  const placed = {};
  peers.forEach((p) => {
    if (!p || !p.visible || !p.pos || !p.pos.level || p.pos.season !== s.season) return;
    const at = byId[p.pos.level];
    if (!at) return;
    const node = document.querySelector(`.level-node[data-ci="${at.ci}"][data-li="${at.li}"]`);
    if (!node) return;
    const row = node.parentElement;
    if (!row) return;
    const k = placed[p.pos.level] || 0;
    placed[p.pos.level] = k + 1;
    const x = parseFloat(node.style.left) || 50;
    const rightSide = x <= 58; // يُقلب كما تُقلب بطاقة اللاعب — بعيدًا عن حافة الخريطة
    const b = document.createElement("button");
    b.className = "rival-badge";
    b.dataset.peer = p.name;
    if (rightSide) b.style.right = `calc(${(100 - x).toFixed(2)}% + 52px)`;
    else b.style.left = `calc(${x.toFixed(2)}% + 52px)`;
    if (k) b.style.marginTop = k * 40 + "px";
    b.innerHTML = `<span class="rb-av">${avatarHTML(p)}</span><span class="rb-name">${esc(p.name)}</span>`;
    b.title = p.stats ? `${p.name} — ⭐ ${p.totalStars} • ✅ ${p.done}/${p.totalLevels}` : p.name;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      app.audio.play("tap");
      openPeerProfile(p);
    });
    row.appendChild(b);
  });
}

/* بطاقة زميل من الخريطة: معلوماته + «أضفني كصديق» */
async function openPeerProfile(p) {
  if (!p || !p.name) return;
  const s = app.store;
  const ov = document.createElement("div");
  ov.className = "overlay center";
  document.body.appendChild(ov);
  let isFriend = false;
  if (s.account && s.account.token) {
    try {
      const fr = await socialFetch("/api/social/friends?token=" + encodeURIComponent(s.account.token));
      if (fr && fr.ok) {
        const key = (p.name || "").trim().toLowerCase();
        isFriend = (fr.friends || []).some((f) => f.key === key);
      }
    } catch (_) {}
  }
  const statsLine = !p.visible ? "أخفى تقدّمه" : !p.stats ? "يظهر دون أرقام" : `⭐ ${p.totalStars} • ✅ ${p.done}/${p.totalLevels} • موسم ${p.season}`;
  const render = (state) => {
    const btn = state === "friend"
      ? `<button class="btn green block" disabled>${ICONS.check} صديق في دائرتك</button>`
      : state === "accepted"
        ? `<button class="btn green block" disabled>${ICONS.check} صديق جديد ✓</button>`
        : state === "pending"
          ? `<button class="btn blue block" disabled>${ICONS.check} أُرسل طلب الصداقة</button>`
          : `<button class="btn blue block" id="pp-add">${ICONS.users} أضفني كصديق</button>`;
    ov.innerHTML = h`
      <div class="sheet">
        <div class="grab"></div>
        <div class="pp-head">
          <span class="pp-avatar">${avatarHTML(p)}</span>
          <div class="peer-info">
            <div class="pp-name">${esc(p.name)}</div>
            <div class="peer-sub">${statsLine}</div>
            ${p.lastPlayedAt ? `<div class="peer-sub">${ICONS.clock} ${arDate(p.lastPlayedAt)}</div>` : ""}
          </div>
        </div>
        <div class="row-btns" style="margin-top:14px">${btn}</div>
        <button class="btn ghost block" id="pp-close" style="margin-top:10px">إغلاق</button>
      </div>`;
    ov.querySelector("#pp-close").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
    const add = ov.querySelector("#pp-add");
    if (add) add.addEventListener("click", async () => {
      if (!s.account || !s.account.token) { app.audio.play("error"); toast("سجّل الدخول أولًا"); return; }
      app.audio.play("tap");
      add.disabled = true;
      const res = await socialFetch("/api/social/friend/request", {
        method: "POST",
        body: JSON.stringify({ token: s.account.token, name: p.name }),
      });
      if (res && res.ok) {
        app.audio.play("success");
        toast(res.accepted ? `صديق جديد: ${p.name} ✓` : `أُرسل طلب الصداقة إلى ${p.name} ⏳`);
        render(res.accepted ? "accepted" : "pending");
      } else {
        app.audio.play("error");
        toast((res && res.error) || "فشل الإرسال");
        render("idle");
      }
    });
  };
  render(isFriend ? "friend" : "idle");
}

/* يوسّط الخريطة على العقدة الهدف ثم ينفّذ then */
function centerOnNode(mapScroll, ci, li, then) {
  const node = document.querySelector(`.level-node[data-ci="${ci}"][data-li="${li}"]`);
  if (!node || !mapScroll) { if (then) then(); return; }
  const wr = mapScroll.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  const delta = (nr.top - wr.top) - (wr.height / 2 - nr.height / 2);
  mapScroll.scrollTo({ top: Math.max(0, mapScroll.scrollTop + delta), behavior: "smooth" });
  node.classList.add("focus-ring");
  setTimeout(() => node.classList.remove("focus-ring"), 1400);
  if (then) setTimeout(then, 420);
}

/* شرارات صغيرة حول عنصر (لجواهر + فتح المستوى) */
function sparkleAt(el, n = 8) {
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < n; i++) {
    const s = document.createElement("div");
    s.className = "spark";
    s.style.left = cx + "px"; s.style.top = cy + "px";
    s.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16">${ICONS.star.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</svg>`;
    document.body.appendChild(s);
    const a = (i / n) * Math.PI * 2, dist = 34 + Math.random() * 26;
    s.animate(
      [{ transform: "translate(-50%,-50%) scale(0.4)", opacity: 1 },
       { transform: `translate(calc(-50% + ${Math.cos(a) * dist}px), calc(-50% + ${Math.sin(a) * dist}px)) scale(1.1)`, opacity: 0 }],
      { duration: 750 + Math.random() * 400, easing: "cubic-bezier(.2,.7,.3,1)" });
    setTimeout(() => s.remove(), 1300);
  }
}

/* يرسم الطريق المتعرّج المتصل عبر كل عقد اللعبة (SVG عالمي واحد) */
function drawWorldPath() {
  const scroll = document.querySelector(".map-scroll");
  const svg = document.getElementById("world-path");
  if (!scroll || !svg) return;
  const W = scroll.offsetWidth, H = scroll.offsetHeight;
  if (!W || !H) return;
  const base = scroll.getBoundingClientRect();
  const nodes = [...scroll.querySelectorAll(".level-node")];
  if (!nodes.length) return;
  const pts = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.left - base.left + r.width / 2, y: r.top - base.top + r.height / 2 };
  });
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const seg = (i) => {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    return ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  };
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) d += seg(i);

  /* المسار المُجتاز (أحمر): مقاطع الطريق بين المستويات التي اجتازها المستخدم */
  const N = pts.length;
  let lo = N - 1;
  while (lo >= 0 && nodes[lo].classList.contains("completed")) lo--;
  const start = lo + 1; // أول مستوى مكتمل من جهة البداية
  let dRed = "";
  if (start < N - 1) {
    dRed = `M ${pts[start].x.toFixed(1)} ${pts[start].y.toFixed(1)}`;
    for (let i = start; i < N - 1; i++) dRed += seg(i);
  }

  svg.innerHTML = `
    <path class="road-edge" d="${d}"></path>
    <path class="road-base" d="${d}"></path>
    <path class="road-top" d="${d}"></path>
    ${dRed ? `<path class="road-red" d="${dRed}"></path>` : ""}
    <path class="road-dash" d="${d}"></path>`;
}

/* ============================================================
   المعاينة
   ============================================================ */
function openPreview(chapterIndex, levelIndex) {
  const ch = app.bank.chapters[chapterIndex];
  const lv = ch.levels[levelIndex];
  const stars = app.store.stars(lv.id);
  const best = app.store.getLevel(lv.id);
  const diff = difficultyOf(levelIndex, ch.levels.length);
  const rw = levelReward(levelIndex);
  const t = themeOf(ch.theme);
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = h`
    <div class="sheet preview" style="--ra:${t.a};--rb:${t.b}">
      <div class="grab"></div>
      <div class="pv-head">
        <div class="pv-ic">${ICONS.play}</div>
        <div class="pv-titles">
          <h2>${esc(ch.title)}</h2>
          <div class="sub">${lv.name ? esc(lv.name) + " • " : ""}المستوى ${lv.globalIndex || lv.index} • ${esc(ch.subject)}</div>
        </div>
      </div>
      <div class="pv-stars">${[0, 1, 2].map((i) => `<span class="pv-star ${i < stars ? "on" : ""}">★</span>`).join("")}</div>
      <div class="stat-grid">
        <div class="stat"><div class="v">${lv.questions.length}</div><div class="k">أسئلة</div></div>
        <div class="stat"><div class="v" style="color:${diff.color}">${levelIndex + 1 === requiredOf(ch) || levelIndex + 1 === ch.levels.length ? "🔥 " : ""}${diff.label}</div><div class="k">الصعوبة</div></div>
        <div class="stat"><div class="v">${best ? best.bestPct + "%" : "—"}</div><div class="k">أفضل نتيجة</div></div>
      </div>
      <div class="pv-rewards">
        <span class="reward-pill">${ICONS.coin} حتى ${rw.coins}</span>
        <span class="reward-pill">${ICONS.gem} ${rw.gems}</span>
        <span class="reward-pill">${ICONS.star} 3</span>
      </div>
      <div class="row-btns">
        <button class="btn ghost" id="pv-close" style="flex:1">إغلاق</button>
        <button class="btn green" id="pv-start" style="flex:2">ابدأ المستوى</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  ov.querySelector("#pv-close").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
  ov.querySelector("#pv-start").addEventListener("click", () => { app.audio.play("button"); ov.remove(); startAdventure(chapterIndex, levelIndex); });
}

/* بطاقة اللاعب — تُفتح عند الضغط على شارته بجانب آخر مستوى */
function arDate(ts) {
  try {
    return new Date(ts).toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" });
  } catch (e) {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function openPlayerCard() {
  const s = app.store, bank = app.bank;
  const p = s.profile;
  const allIds = bank.chapters.flatMap((ch) => ch.levels.map((l) => l.id));
  const done = s.completedCount(allIds);
  const total = allIds.length;
  const cur = currentLevelRef(bank, s);
  const ov = document.createElement("div");
  ov.className = "overlay center";
  ov.innerHTML = h`
    <div class="sheet player-card">
      <div class="pc-topbar">
        <button class="iconbtn" id="pc-back" aria-label="العودة إلى الخريطة">${ICONS.back}</button>
        <span class="pc-title">ملفي الشخصي</span>
        <span class="pc-spacer"></span>
      </div>
      <div class="pc-head">
        <div class="pc-avatar">${avatarHTML(p)}</div>
        <div class="pc-name">${esc(p.name)}</div>
        <div class="pc-sub">الموسم ${s.season} • المستوى ${cur.level.globalIndex || cur.level.index} • ${esc(cur.chapter.subject)}</div>
      </div>
      <div class="stat-grid">
        <div class="stat"><div class="v" style="color:#f59e0b">${s.totalStars}</div><div class="k">نجوم</div></div>
        <div class="stat"><div class="v" style="color:#facc15">${done}/${total}</div><div class="k">مستوى</div></div>
        <div class="stat"><div class="v" style="color:#86efac">${s.coins}</div><div class="k">عملات</div></div>
        <div class="stat"><div class="v" style="color:#67e8f9">${s.gems}</div><div class="k">جواهر</div></div>
      </div>
      <div class="pc-dates">
        <div class="pc-row">${ICONS.calendar}<span>بدأ في: ${arDate(p.createdAt || Date.now())}</span></div>
        <div class="pc-row">${ICONS.clock}<span>آخر نشاط: ${arDate(p.lastPlayedAt || Date.now())}</span></div>
      </div>
      <div class="row-btns">
        <button class="btn ghost" id="pc-close" style="flex:1">${ICONS.back} عودة للخريطة</button>
        <button class="btn green" id="pc-edit" style="flex:1">تعديل الملف</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  ov.querySelector("#pc-back").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
  ov.querySelector("#pc-close").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
  ov.querySelector("#pc-edit").addEventListener("click", () => { app.audio.play("button"); ov.remove(); openSettings(); });
}

/* المستويات التي تحتاج نجمة إضافية — يبدأ اللعب من أولها تلقائيًا */
function neededLevels() {
  const need = CONFIG.seasonUnlockStars || 2;
  const list = [];
  app.bank.chapters.forEach((ch) => {
    ch.levels.forEach((lv, li) => {
      if (app.store.isCompleted(lv.id) && app.store.stars(lv.id) < need) {
        list.push({ ch, lv, li, stars: app.store.stars(lv.id) });
      }
    });
  });
  return list;
}

/* نافذة تأكيد بسيطة: "موافق" ينقل اللاعب تلقائيًا للمستوى الناقص */
function promptNextNeeded() {
  const list = neededLevels();
  const need = CONFIG.seasonUnlockStars || 2;
  if (!list.length) { toast("🎉 لا توجد مستويات ناقصة"); return; }
  const e = list[0];
  const ov = document.createElement("div");
  ov.className = "overlay center";
  ov.innerHTML = h`
    <div class="sheet">
      <h2>${ICONS.star} تحتاج النجمة ${need}</h2>
      <div class="sub">
        المستوى <b>${e.lv.globalIndex || e.lv.index}</b> — ${esc(e.ch.title)}<br>
        متبقٍّ <b>${list.length}</b> مستوى يحتاج نجمة إضافية.
      </div>
      <div class="row-btns">
        <button class="btn ghost" id="pn-later" style="flex:1">لاحقًا</button>
        <button class="btn green" id="pn-ok" style="flex:1.6">موافق — العب الآن ${ICONS.play}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (ev) => { if (ev.target === ov) ov.remove(); });
  ov.querySelector("#pn-later").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
  ov.querySelector("#pn-ok").addEventListener("click", () => {
    ov.remove();
    app.audio.play("button");
    startAdventure(e.ch.index, e.li);
  });
}

/* ============================================================
   بدء الاختبارات
   ============================================================ */
function consumeLifeOrDialog() {
  app.store.refreshLives();
  if (app.store.lives > 0) { app.store.useLife(); return true; }
  showNoLives();
  return false;
}

function startAdventure(chapterIndex, levelIndex) {
  if (!consumeLifeOrDialog()) return;
  const ch = app.bank.chapters[chapterIndex];
  const lv = ch.levels[levelIndex];
  app.quiz = {
    mode: "adventure", chapterIndex, levelIndex, chapter: ch, level: lv,
    questions: lv.questions, levelId: lv.id, title: ch.title,
    i: 0, correct: 0, selected: null, answered: false, _score: 0,
    timePerQuestion: CONFIG.timer.enabled ? CONFIG.timer.secondsPerQuestion : 0,
    usedBoosters: {},
  };
  renderQuiz();
}

function startDaily() {
  const all = app.bank.allQuestions();
  if (!all.length) { toast("لا توجد أسئلة متاحة"); return; }
  if (!consumeLifeOrDialog()) return;
  const n = Math.min(CONFIG.daily.questionsPerDay, all.length);
  const shuffled = all.slice().sort(() => Math.random() - 0.5).slice(0, n);
  app.quiz = {
    mode: "daily", chapterIndex: 0, levelIndex: 0,
    chapter: { icon: "📅", title: "تحدّي اليوم", theme: "summit" },
    level: { id: "daily", index: 1 },
    questions: shuffled, levelId: "daily_" + new Date().toISOString().slice(0, 10),
    title: "تحدّي اليوم", i: 0, correct: 0, selected: null, answered: false, _score: 0,
    timePerQuestion: CONFIG.daily.timePerQuestion, usedBoosters: {},
  };
  renderQuiz();
}

/* ============================================================
   شاشة الاختبار
   ============================================================ */
function renderQuiz() {
  app.screen = "quiz";
  const q = app.quiz;
  const total = q.questions.length;
  const item = q.questions[q.i];
  const t = themeOf(q.chapter.theme);

  let options = item.options.map((opt, idx) => ({ text: opt, key: CONFIG.optionKeys[idx] || "؟", orig: idx }));
  if (CONFIG.forceFifthOption && options.length < 5) {
    options.push({ text: CONFIG.fifthOptionLabel, key: CONFIG.optionKeys[options.length] || "هـ", orig: options.length });
  }
  const correctUi = options.findIndex((o) => o.orig === item.correctIndex);
  q._options = options; q._correctUi = correctUi;
  q.selected = null; q.answered = false; q._timeout = false;

  const optsHtml = options.map((o, ui) => h`
      <button class="option" data-ui="${ui}"><span class="key">${esc(o.key)}</span><span class="txt">${esc(o.text)}</span></button>`).join("");

  const scenarioHtml = item.situation ? h`<div class="scenario"><div class="q-badge">${ICONS.book} السياق المهني</div>${esc(item.situation)}</div>` : "";

  const timerChip = q.timePerQuestion > 0 ? `<span class="chip timer" id="q-timer">${ICONS.timer}<span id="q-timerval">${q.timePerQuestion}</span></span>` : "";
  const timerBar = q.timePerQuestion > 0 ? `<div class="timer-bar"><i id="q-timerbar"></i></div>` : "";

  const b = CONFIG.boosters;
  const bIcon = { fifty: ICONS.divide, hint: ICONS.bulb, skip: ICONS.skip };
  const bCls = (k) => (q.usedBoosters[k] ? " used" : "");
  const boostersHtml = h`
    <div class="boosters">
      <button class="booster${bCls("fifty")}" data-b="fifty"><span class="bi">${bIcon.fifty}</span><span>${esc(b.fifty.label)}</span><span class="bc">${ICONS.coin}${b.fifty.cost}</span></button>
      <button class="booster${bCls("hint")}" data-b="hint"><span class="bi">${bIcon.hint}</span><span>${esc(b.hint.label)}</span><span class="bc">${ICONS.coin}${b.hint.cost}</span></button>
      <button class="booster${bCls("skip")}" data-b="skip"><span class="bi">${bIcon.skip}</span><span>${esc(b.skip.label)}</span><span class="bc">${ICONS.coin}${b.skip.cost}</span></button>
    </div>`;

  mount(h`
    <div class="screen quiz">
      <div class="quiz-top">
        <button class="iconbtn" id="q-back" aria-label="إنهاء">${ICONS.close}</button>
        <div class="info">
          <div class="line1">${isGateLevel(q.chapter, q.level.index) ? "🔥 " : ""}${esc(q.chapter.title)}${q.mode === "daily" ? "" : q.level.name ? " — " + esc(q.level.name) : " — مستوى " + (q.level.globalIndex || q.level.index)}</div>
          <div class="line2">السؤال ${q.i + 1} من ${total} • ${ICONS.check} ${q.correct} صحيحة</div>
        </div>
        ${timerChip}
        <span class="chip coins">${ICONS.trophy}<span id="q-score">${q._score || 0}</span></span>
      </div>
      ${timerBar}
      <div class="progress"><i id="q-progress" style="width:${(q.i / total) * 100}%"></i></div>
      <div class="quiz-body">
        ${scenarioHtml}
        <div class="question-text">${esc(item.text)}</div>
        ${boostersHtml}
        <div class="options" id="q-options">${optsHtml}</div>
      </div>
      <div class="feedback" id="q-feedback"></div>
      <div class="quiz-foot">
        <button class="btn ghost" id="q-quit" style="flex:1">خروج</button>
        <button class="btn green" id="q-confirm" style="flex:2" disabled>تأكيد الإجابة</button>
      </div>
    </div>`);

  const optionsEl = document.getElementById("q-options");
  optionsEl.querySelectorAll(".option").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (app.quiz.answered) return;
      app.audio.play("select");
      optionsEl.querySelectorAll(".option").forEach((x) => x.classList.remove("selected"));
      btn.classList.add("selected");
      app.quiz.selected = +btn.dataset.ui;
      document.getElementById("q-confirm").disabled = false;
    });
  });

  document.getElementById("q-confirm").addEventListener("click", () => onConfirm(false));
  document.getElementById("q-back").addEventListener("click", quitQuiz);
  document.getElementById("q-quit").addEventListener("click", quitQuiz);

  root.querySelectorAll(".booster").forEach((el) => {
    el.addEventListener("click", () => useBooster(el.dataset.b, el));
  });

  startTimer();
}

function startTimer() {
  const q = app.quiz;
  if (q.timerId) { clearInterval(q.timerId); q.timerId = null; }
  if (!q.timePerQuestion) return;
  q.timeLeft = q.timePerQuestion;
  const tick = () => {
    if (q.answered) { clearInterval(q.timerId); q.timerId = null; return; }
    q.timeLeft--;
    const chip = document.getElementById("q-timer");
    const bar = document.getElementById("q-timerbar");
    if (chip) {
      const v = document.getElementById("q-timerval");
      if (v) v.textContent = Math.max(0, q.timeLeft);
      else chip.textContent = Math.max(0, q.timeLeft);
      chip.classList.toggle("warn", q.timeLeft <= 10 && q.timeLeft > 5);
      chip.classList.toggle("danger", q.timeLeft <= 5);
    }
    if (bar) bar.style.width = Math.max(0, (q.timeLeft / q.timePerQuestion) * 100) + "%";
    if (q.timeLeft <= 0) {
      clearInterval(q.timerId); q.timerId = null;
      if (!q.answered) { q._timeout = true; onConfirm(true); }
    }
  };
  q.timerId = setInterval(tick, 1000);
}

function clearTimer() { const q = app.quiz; if (q && q.timerId) { clearInterval(q.timerId); q.timerId = null; } }

function useBooster(kind, el) {
  const q = app.quiz;
  if (q.answered || q.usedBoosters[kind]) return;
  const cfg = CONFIG.boosters[kind];
  if (!cfg) return;
  if (app.store.coins < cfg.cost) { app.audio.play("error"); toast("🪙 نقاط غير كافية"); return; }
  if (!app.store.spendCoins(cfg.cost)) return;
  q.usedBoosters[kind] = true;
  el.classList.add("used");
  refreshHUD();

  const optionsEl = document.getElementById("q-options");
  const all = [...optionsEl.querySelectorAll(".option")];
  const wrongs = all.filter((b) => +b.dataset.ui !== q._correctUi && !b.classList.contains("removed"));

  if (kind === "fifty") {
    app.audio.play("tap");
    wrongs.slice(0, 2).forEach((b) => b.classList.add("removed"));
  } else if (kind === "hint") {
    app.audio.play("tap");
    const first = wrongs.slice(0, 1);
    first.forEach((b) => b.classList.add("removed"));
    const keep = all.find((b) => +b.dataset.ui === q._correctUi);
    if (keep) keep.classList.add("hinted");
  } else if (kind === "skip") {
    app.audio.play("tap");
    q.selected = -2; // مؤشر التخطي
    q.answered = true;
    optionsEl.querySelectorAll(".option").forEach((b) => b.classList.add("disabled"));
    const item = q.questions[q.i];
    const fb = document.getElementById("q-feedback");
    fb.className = "feedback show";
    fb.innerHTML = h`<div class="fb-title">${ICONS.skip} تم تخطّي السؤال</div>
      <div class="fb-exp"><span class="lbl">الإجابة الصحيحة:</span> ${esc(q._options[q._correctUi] ? q._options[q._correctUi].text : "")}</div>`;
    const conf = document.getElementById("q-confirm");
    conf.disabled = false; conf.textContent = q.i + 1 >= q.questions.length ? "عرض النتيجة" : "السؤال التالي";
    conf.classList.remove("green"); conf.classList.add("blue");
  }
}

function onConfirm(force) {
  const q = app.quiz;
  if (q.answered) {
    if (q.timerId) clearInterval(q.timerId);
    q.i++;
    if (q.i >= q.questions.length) finishQuiz();
    else renderQuiz();
    return;
  }
  if (q.selected == null && !force) return;
  q.answered = true;
  if (q.timerId) { clearInterval(q.timerId); q.timerId = null; }

  const optionsEl = document.getElementById("q-options");
  const btns = optionsEl.querySelectorAll(".option");
  const isCorrect = q.selected === q._correctUi && q.selected >= 0;

  btns.forEach((b) => {
    b.classList.add("disabled");
    const ui = +b.dataset.ui;
    if (ui === q._correctUi) b.classList.add("correct");
    else if (ui === q.selected) b.classList.add("wrong");
  });

  const item = q.questions[q.i];
  let award = 0;
  if (isCorrect) { q.correct++; award = 10; app.audio.play("success"); }
  else app.audio.play("error");

  const fb = document.getElementById("q-feedback");
  const correctText = q._options[q._correctUi] ? q._options[q._correctUi].text : "";
  const exp = item.explanation && item.explanation.trim() ? item.explanation : "";
  const title = q._timeout ? "انتهى الوقت!" : isCorrect ? "إجابة صحيحة! (+10)" : "إجابة خاطئة";
  fb.className = "feedback show " + (isCorrect ? "ok" : "bad");
  fb.innerHTML = h`
    <div class="fb-title">${title}</div>
    ${!isCorrect ? `<div class="fb-exp"><span class="lbl">الإجابة الصحيحة:</span> ${esc(correctText)}</div>` : ""}
    ${exp ? `<div class="fb-exp" style="margin-top:6px"><span class="lbl">التعليل:</span> ${esc(exp)}</div>` : ""}
    ${item.source ? `<div class="fb-exp" style="margin-top:6px;opacity:.7;font-size:12px">${ICONS.book} ${esc(item.source)}</div>` : ""}`;

  q._score = (q._score || 0) + award;
  document.getElementById("q-score").textContent = q._score;
  document.getElementById("q-progress").style.width = ((q.i + 1) / q.questions.length) * 100 + "%";

  const conf = document.getElementById("q-confirm");
  conf.disabled = false;
  conf.textContent = q.i + 1 >= q.questions.length ? "عرض النتيجة" : "السؤال التالي";
  conf.classList.remove("green"); conf.classList.add("blue");
}

function quitQuiz() {
  app.audio.play("button");
  const ov = document.createElement("div");
  ov.className = "overlay center";
  ov.innerHTML = h`
    <div class="sheet">
      <h2>إنهاء الاختبار؟</h2>
      <div class="sub">سيُفقد تقدّمك في هذا المستوى، ولا تُسترد الحياة المستهلكة.</div>
      <div class="row-btns">
        <button class="btn ghost" id="quit-no" style="flex:1">متابعة اللعب</button>
        <button class="btn" id="quit-yes" style="flex:1">خروج</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector("#quit-no").addEventListener("click", () => ov.remove());
  ov.querySelector("#quit-yes").addEventListener("click", () => { ov.remove(); clearTimer(); app.quiz.mode === "daily" ? renderEntry() : renderMap(app.quiz.chapterIndex); });
}

/* ============================================================
   النتائج
   ============================================================ */
function starsForPct(pct) {
  return pct >= CONFIG.starThresholds.three ? 3 : pct >= CONFIG.starThresholds.two ? 2 : pct >= CONFIG.starThresholds.one ? 1 : 0;
}

function finishQuiz() {
  const q = app.quiz;
  const total = q.questions.length;
  const correct = q.correct;
  const pct = Math.round((correct / total) * 100);
  const stars = starsForPct(pct);
  const passed = pct >= CONFIG.passPercent;

  if (q.mode === "daily") {
    const firstToday = !app.store.dailyPlayedToday();
    const coins = correct * CONFIG.coins.perCorrect + (firstToday ? CONFIG.daily.bonusCoins : 0);
    const gems = firstToday ? CONFIG.daily.bonusGems : 0;
    const streak = passed ? (app.store.daily.streak || 0) + 1 : 0;
    app.store.addCoins(coins); app.store.addGems(gems);
    app.store.recordDaily({ pct, streak });
    renderResults({ mode: "daily", total, correct, wrong: total - correct, pct, stars, passed, coins, gems, streak });
    return;
  }

  const levelId = q.levelId;
  const prevStars = app.store.stars(levelId);
  const firstClear = passed && !app.store.isCompleted(levelId);
  const gainedStars = Math.max(0, stars - prevStars);
  const coins = gainedStars * CONFIG.coins.perStar + (firstClear ? CONFIG.coins.levelClear + correct * CONFIG.coins.perCorrect : 0);
  const gems = firstClear && pct === 100 ? CONFIG.gems.perfectLevel : 0;
  app.store.recordLevel(levelId, { pct, score: q._score || 0, stars, passed, coins, gems });
  pushProgress();

  // احتفال قصير عند إكمال كل مستويات المحور
  const ch = app.bank.chapters[q.chapterIndex];
  if (ch && ch.levels.every((l) => app.store.isCompleted(l.id))) {
    app._celebrated = app._celebrated || new Set();
    const key = app.store.season + ":" + q.chapterIndex;
    if (!app._celebrated.has(key)) {
      app._celebrated.add(key);
      setTimeout(() => { confetti(70); app.audio.play("success"); toast(`🎉 أكملتَ محور «${ch.title}»`); }, 400);
    }
  }

  if (seasonEligible()) {
    renderSeasonComplete({ total, correct, wrong: total - correct, pct, stars, passed, coins, gems });
    return;
  }
  renderResults({ mode: "adventure", chapterIndex: q.chapterIndex, levelIndex: q.levelIndex, total, correct, wrong: total - correct, pct, stars, passed, coins, gems });
}

function renderResults(r) {
  app.screen = "results";

  let next = null;
  if (r.mode === "adventure") {
    const ch = app.bank.chapters[r.chapterIndex];
    if (r.levelIndex + 1 < ch.levels.length) next = { ci: r.chapterIndex, li: r.levelIndex + 1 };
    else if (r.chapterIndex + 1 < app.bank.chapters.length) next = { ci: r.chapterIndex + 1, li: 0 };
  }
  const nextLv = next ? app.bank.chapters[next.ci].levels[next.li] : null;

  const isDaily = r.mode === "daily";
  const needNext = !isDaily && r.passed && allLevelsPassed() && !seasonEligible() && neededLevels().length > 0;
  const title = r.stars === 3 ? "ممتاز! أداء استثنائي 🏆" : r.passed ? "أحسنت! 🎉" : "لم تجتز بعد 💪";
  const hint = isDaily
    ? `نتيجة تحدّي اليوم • السلسلة: ${r.streak || 0} 🔥`
    : r.passed
      ? r.stars === 3 ? "ثلاث نجوم كاملة! أنت سفير الكفاءة." : "يمكنك إعادة المحاولة لنيل النجوم الثلاث."
      : `تحتاج ${CONFIG.passPercent}% على الأقل للنجاح.`;

  mount(h`
    <div class="screen results">
      <h2>${title}</h2>
      <div class="hint">${esc(hint)}</div>
      <div class="big-stars">
        ${[0, 1, 2].map((i) => `<div class="big-star ${i < r.stars ? "on" : ""}" data-i="${i}">★</div>`).join("")}
      </div>
      <div class="result-score">${r.pct}%</div>
      <div class="result-grid">
        <div class="stat"><div class="v">✅ ${r.correct}</div><div class="k">صحيحة</div></div>
        <div class="stat"><div class="v">❌ ${r.wrong}</div><div class="k">خاطئة</div></div>
        <div class="stat"><div class="v">${r.total}</div><div class="k">الأسئلة</div></div>
      </div>
      ${r.coins || r.gems ? `<div class="rewards-row">
        ${r.coins ? `<span class="reward-pill">${ICONS.coin} +${r.coins}</span>` : ""}
        ${r.gems ? `<span class="reward-pill">${ICONS.gem} +${r.gems}</span>` : ""}
      </div>` : ""}
      <div class="actions">
        ${!isDaily && r.passed && next && !needNext ? `<button class="btn green block" id="res-next">${nextLv && nextLv.name ? "التالي: " + esc(nextLv.name) : "المستوى التالي"} ${ICONS.play}</button>` : ""}
        ${!isDaily && needNext ? `<button class="btn green block" id="res-needed">${ICONS.star} اذهب للمستوى الناقص ${ICONS.play}</button>` : ""}
        ${!isDaily ? `<button class="btn ${r.passed && next ? "ghost" : "green"} block" id="res-retry">إعادة المحاولة</button>` : ""}
        ${isDaily ? `<button class="btn green block" id="res-again">محاولة أخرى</button>` : ""}
        <button class="btn ghost block" id="res-map">${isDaily ? `القائمة ${ICONS.home}` : `الخريطة ${ICONS.map}`}</button>
      </div>
    </div>`);

  root.querySelectorAll(".big-star.on").forEach((s, i) => (s.style.animationDelay = i * 0.28 + "s"));
  if (r.passed) {
    setTimeout(() => { app.audio.play(r.stars === 3 ? "victory" : "complete"); if (r.stars >= 2) confetti(r.stars === 3 ? 90 : 45); }, 300);
  } else app.audio.play("defeat");

  const nextBtn = document.getElementById("res-next");
  if (nextBtn)
    nextBtn.addEventListener("click", () => {
      app.audio.play("button");
      if (!isLevelUnlocked(app.bank, app.store, next.ci, next.li)) { toast("🔒 أكمل المستوى أولاً"); return; }
      startAdventure(next.ci, next.li);
    });
  const retry = document.getElementById("res-retry");
  if (retry) retry.addEventListener("click", () => { app.audio.play("button"); startAdventure(r.chapterIndex, r.levelIndex); });
  const neededBtn = document.getElementById("res-needed");
  if (neededBtn) neededBtn.addEventListener("click", () => { app.audio.play("button"); promptNextNeeded(); });
  const again = document.getElementById("res-again");
  if (again) again.addEventListener("click", () => { app.audio.play("button"); startDaily(); });
  document.getElementById("res-map").addEventListener("click", () => { app.audio.play("button"); isDaily ? renderEntry() : renderMap(r.chapterIndex); });
}

/* ============================================================
   إكمال الموسم (New Game+)
   ============================================================ */
function renderSeasonComplete(r) {
  app.screen = "seasonComplete";
  const s = app.store;
  const season = s.season;

  mount(h`
    <div class="screen results season-complete">
      <div class="crest">${ICONS.trophy}</div>
      <h2>أكملتَ الموسم ${season}!</h2>
      <div class="hint">حصلتَ على ${CONFIG.seasonUnlockStars} ${ICONS.star} على الأقل في كل المستويات — أنت سفير الكفاءة المهنية.</div>
      <div class="big-stars">
        ${[0, 1, 2].map((i) => `<div class="big-star on" data-i="${i}">${ICONS.star}</div>`).join("")}
      </div>
      <div class="result-grid">
        <div class="stat"><div class="v">${ICONS.star} ${s.totalStars}</div><div class="k">نجوم الموسم</div></div>
        <div class="stat"><div class="v">${ICONS.coin} ${s.coins}</div><div class="k">النقاط</div></div>
        <div class="stat"><div class="v">${ICONS.gem} ${s.gems}</div><div class="k">الجواهر</div></div>
      </div>
      <div class="actions">
        <button class="btn green block" id="sc-new">ابدأ الموسم ${season + 1} ${ICONS.refresh}</button>
        <button class="btn ghost block" id="sc-map">تصفّح الخريطة ${ICONS.map}</button>
      </div>
    </div>`);

  setTimeout(() => { app.audio.play("victory"); confetti(140); }, 250);
  document.querySelectorAll(".season-complete .big-star").forEach((el, i) => (el.style.animationDelay = (i * 0.25) + "s"));

  document.getElementById("sc-new").addEventListener("click", () => {
    app.audio.play("button");
    const next = app.store.startNewSeason();
    toast(`بدأ الموسم ${next}! جميع المراحل أُعيدت — بالتوفيق`);
    renderMap();
  });
  document.getElementById("sc-map").addEventListener("click", () => { app.audio.play("button"); renderMap(); });
}

/* ============================================================
   الأرواح
   ============================================================ */
function showNoLives() {
  const s = app.store;
  const refresh = () => {
    s.refreshLives();
    const row = document.querySelector("#lives-hearts");
    if (row) row.innerHTML = Array.from({ length: s.maxLives }, (_, i) => `<span class="heart ${i < s.lives ? "on" : ""}">${ICONS.heart}</span>`).join("");
    const cnt = document.querySelector("#lives-count");
    if (cnt) cnt.textContent = s.lives > 0 ? `لديك ${s.lives} أرواح` : `الروح التالية خلال ${fmtTime(s.timeToNextLife())}`;
  };
  const ov = document.createElement("div");
  ov.className = "overlay center";
  ov.innerHTML = h`
    <div class="sheet">
      <h2>نفدت الأرواح ${ICONS.heartBroken}</h2>
      <div class="sub">انتظر إعادة التعبئة أو املأ الأرواح بالجواهر.</div>
      <div class="hearts-row" id="lives-hearts"></div>
      <div class="lives-count" id="lives-count"></div>
      <div class="row-btns">
        <button class="btn ghost" id="nl-close" style="flex:1">لاحقاً</button>
        <button class="btn blue" id="nl-ask" style="flex:1.4">${ICONS.users} اطلب من الأصدقاء</button>
        <button class="btn" id="nl-fill" style="flex:1.4">إعادة التعبئة (${ICONS.gem} ${app.store.maxLives})</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  refresh();
  const iv = setInterval(refresh, 1000);
  const cleanup = () => { clearInterval(iv); ov.remove(); };
  ov.querySelector("#nl-close").addEventListener("click", cleanup);
  ov.querySelector("#nl-ask").addEventListener("click", async () => {
    if (!s.account || !s.account.token) { app.audio.play("error"); toast("سجّل الدخول أولًا لطلب أرواح من أصدقائك"); return; }
    app.audio.play("tap");
    const res = await socialFetch("/api/social/lives/ask", {
      method: "POST",
      body: JSON.stringify({ token: s.account.token }),
    });
    if (res && res.ok) {
      app.audio.play("success");
      toast(res.told ? `أُرسل طلبك إلى ${res.told} صديق ❤️` : "لا أصدقاء لديك بعد — أضفهم من «تقدّم الزملاء»");
    } else {
      app.audio.play("error");
      toast((res && res.error) || "تعذّر إرسال الطلب");
    }
  });
  ov.querySelector("#nl-fill").addEventListener("click", () => {
    const cost = app.store.maxLives;
    if (app.store.gems < cost) { app.audio.play("error"); toast("جواهر غير كافية"); return; }
    app.store.addGems(-cost); app.store.addLives(app.store.maxLives);
    app.audio.play("success"); cleanup(); refreshHUD(); toast("تمت إعادة تعبئة الأرواح");
  });
}

/* ============================================================
   الإعدادات / الملف
   ============================================================ */
/* ============================================================
   المجتمع — حسابات المعلمين: تقدّم كل أستاذ يظهر للآخر
   وفق إعدادات الخصوصية الخاصة به
   ============================================================ */
const SOCIAL_API = location.protocol === "file:" ? "http://localhost:8123" : location.origin;

async function socialFetch(pathname, opts) {
  try {
    const timeout = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
    const r = await fetch(SOCIAL_API + pathname, Object.assign({ headers: { "Content-Type": "application/json" }, signal: timeout }, opts || {}));
    return await r.json();
  } catch (_) {
    return { error: "تعذّر الاتصال بالخادم" };
  }
}

let _pushTimer = null;
let _pushChain = Promise.resolve();
function pushProgress(immediate) {
  const s = app.store;
  if (!s.account.token) return Promise.resolve(null);
  const run = () => {
    const ids = app.bank ? app.bank.chapters.flatMap((ch) => ch.levels.map((l) => l.id)) : [];
    // سلسلة الدفعات: لا يُرسَل دفعتان معًا حتى لا تتداخل ترتيبات الحالة على الخادم
    _pushChain = _pushChain.catch(() => {}).then(() =>
      socialFetch("/api/social/push", {
        method: "POST",
        body: JSON.stringify({
          token: s.account.token,
          state: {
            name: s.account.name || s.profile.name,
            season: s.season,
            totalStars: s.totalStars,
            coins: s.coins,
            gems: s.gems,
            done: ids.length ? s.completedCount(ids) : 0,
            totalLevels: ids.length,
            lastLevel: s.data.lastLevel || null,
            avatar: s.profile.avatar || "🧑‍🏫",
            photo: typeof s.profile.photo === "string" && s.profile.photo.indexOf("data:image") === 0 && s.profile.photo.length <= 45000 ? s.profile.photo : null,
            social: {
              visible: s.settings.social.visible !== false,
              showStats: s.settings.social.showStats !== false,
            },
          },
        }),
      })
    );
    return _pushChain;
  };
  clearTimeout(_pushTimer);
  if (immediate) return run();
  _pushTimer = setTimeout(run, 1200);
  return Promise.resolve(null);
}

async function openSocial() {
  const s = app.store;
  let _socLast = null;
  const ov = document.createElement("div");
  ov.className = "overlay";
  const wire = () => {
    const close = ov.querySelector("#soc-close");
    if (close) close.addEventListener("click", () => { app.audio.play("tap"); ov.remove(); refreshFriendsBadge(true); if (app.screen === "map") decorateMapRivals(); });
    if (s.account.token) {
      ov.querySelector("#soc-refresh").addEventListener("click", () => { app.audio.play("tap"); render(); });
      ov.querySelector("#soc-logout").addEventListener("click", () => {
        app.audio.play("tap");
        s.setAccount(null, null);
        toast("تم تسجيل الخروج — يُعاد التعريف تلقائيًا عند الفتح من تطبيق مسار احتراف");
        render();
      });
    }
  };
  const render = async () => {
    try {
      await renderInner();
    } catch (e) {
      console.error("social render failed:", e);
      ov.innerHTML = `<div class="sheet"><div class="grab"></div><h2>تعذّر فتح المجتمع</h2><div class="sub">${esc(String(e))}</div><button class="btn ghost block" id="soc-close">إغلاق</button></div>`;
      wire();
    }
  };
  const renderInner = async () => {
    const sheetEl = ov.querySelector(".sheet");
    const saveScroll = sheetEl ? sheetEl.scrollTop : 0;
    const acc = s.account;
    let list = null;
    let fr = null;
    if (acc.token) {
      await pushProgress(true);
      const res = await socialFetch("/api/social/list?token=" + encodeURIComponent(acc.token));
      list = res && res.ok ? res : null;
      fr = await socialFetch("/api/social/friends?token=" + encodeURIComponent(acc.token));
      if (!fr || !fr.ok) fr = null;
    }
    const peers = list ? list.peers || [] : [];
    const friends = fr ? fr.friends || [] : [];
    const requests = fr ? fr.requests || [] : [];
    const inbox = fr ? fr.inboxLives || [] : [];
    const friendSet = new Set(friends.map((f) => f.key));
    /* معطيات آخر رسم — للتحديث الذاتي بلا قفزة إلزامية */
    _socLast = JSON.stringify({ f: friends.map((x) => x.key).sort(), r: requests.map((x) => x.name || x.key).sort(), b: inbox.map((x) => x.name || x.key).sort() });
    ov.innerHTML = h`
      <div class="sheet">
        <div class="grab"></div>
        <h2>تقدّم الزملاء ${ICONS.users} <span class="live-dot" title="تحديث تلقائي كل 30 ثانية"></span></h2>
        ${acc.token ? `` : `<div class="sub">يتم التعريف تلقائيًا باسمك عند فتح اللعبة من تطبيق «مسار احتراف».</div>`}
        ${acc.token ? `
          <div class="peer-list">
            ${peers.length ? peers.map((p) => `
              <div class="menu-row peer-row">
                <span class="mi">${p.visible ? (p.stats ? "🧑‍🏫" : "👁") : "🔒"}</span>
                <div class="peer-info">
                  <div class="peer-name">${esc(p.name)}</div>
                  <div class="peer-sub">${!p.visible ? "أخفى تقدّمه" : !p.stats ? "يظهر دون أرقام" : `⭐ ${p.totalStars} • ✅ ${p.done}/${p.totalLevels} • موسم ${p.season}`}</div>
                </div>
                ${friendSet.has((p.name || "").toLowerCase()) ? `<button class="btn sm blue" data-heart="${esc(p.name)}">${ICONS.heart} أرسل</button>` : ""}
              </div>`).join("") : `<div class="sub">لا زملاء بعد — افتح اللعبة من تطبيق مسار احتراف على جهاز آخر.</div>`}
          </div>
          <h2 style="margin-top:10px;font-size:18px">دائرة الأصدقاء ${ICONS.heart}</h2>
          <div class="sub">أرسل قلبًا لصديق فمعاناته تنتعش — الأرواح لا تُخصم منك، طلب واحد يكفي للمساعدة.</div>
          <div class="menu-list">
            ${requests.length ? requests.map((r) => `
              <div class="menu-row peer-row">
                <span class="mi">📩</span>
                <div class="peer-info">
                  <div class="peer-name">${esc(r.name || "")}</div>
                  <div class="peer-sub">يريد إضافتك صديقًا</div>
                </div>
                <button class="btn sm blue" data-acc="${esc((r.name || "").toLowerCase())}">قبول</button>
                <button class="btn sm ghost" data-rej="${esc((r.name || "").toLowerCase())}">رفض</button>
              </div>`).join("") : ""}
            ${friends.length ? friends.map((f) => `
              <div class="menu-row peer-row">
                <span class="mi">${f.asksMe ? "❤️" : "🧑‍🏫"}</span>
                <div class="peer-info">
                  <div class="peer-name">${esc(f.name)}</div>
                  <div class="peer-sub">${f.asksMe ? "يطلب منك قلبًا" : (f.lastLevelLabel ? esc(f.lastLevelLabel) : "في دائرتك")}</div>
                </div>
                <button class="btn sm blue" data-send="${esc(f.key)}">${ICONS.heart} أرسل</button>
                <button class="btn sm ghost" data-del="${esc(f.key)}" title="إزالة صديق">✕</button>
              </div>`).join("") : `<div class="sub">لا أصدقاء بعد — أضف صديقًا بالاسم أدناه.</div>`}
          </div>
          <div class="row-btns">
            <input class="field" id="fr-add-name" maxlength="24" placeholder="اسم صديق جديد" style="flex:1;min-width:0" />
            <button class="btn sm blue" id="fr-add" style="flex:none">${ICONS.users} إضافة</button>
          </div>
          <div class="menu-list">
            <div class="menu-row" id="soc-ask"><span class="mi">${ICONS.heart}</span><span>اطلب أرواحًا من كل أصدقائك</span><span class="spacer"></span><span class="val">${friends.length} صديق</span></div>
            <div class="menu-row" id="soc-collect" ${inbox.length ? "" : 'style="opacity:.55;pointer-events:none"'}><span class="mi">${ICONS.heart}</span><span>اجمع الأرواح المُهدَاة إليك</span><span class="spacer"></span><span class="val">${inbox.length}</span></div>
            <div class="menu-row" id="soc-refresh"><span class="mi">${ICONS.refresh}</span><span>تحديث القائمة</span></div>
            <div class="menu-row" id="soc-logout"><span class="mi">${ICONS.back}</span><span>تسجيل الخروج المؤقت</span></div>
          </div>
        ` : `
          <div class="sub">يتم التعريف تلقائيًا باسمك عند فتح اللعبة من تطبيق «مسار احتراف».</div>
        `}
        <button class="btn ghost block" id="soc-close">إغلاق</button>
      </div>`;
    const sh2 = ov.querySelector(".sheet");
    if (sh2 && saveScroll) sh2.scrollTop = saveScroll;
    wire();
    /* دائرة الأصدقاء — ربط الأحداث */
    ov.querySelectorAll("[data-acc],[data-rej]").forEach((b) => b.addEventListener("click", async () => {
      const from = b.dataset.acc || b.dataset.rej;
      if (!from) return;
      app.audio.play("tap");
      const res = await socialFetch("/api/social/friend/respond", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, from, accept: !!b.dataset.acc }),
      });
      toast(res && res.ok ? (b.dataset.acc ? `صديق جديد: ${from} ✓` : "رفض الطلب") : ((res && res.error) || "فشل"));
      await render();
    }));
    ov.querySelectorAll("[data-heart]").forEach((b) => b.addEventListener("click", async () => {
      const name = b.dataset.heart;
      if (!name) return;
      app.audio.play("tap");
      const res = await socialFetch("/api/social/lives/send", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, name }),
      });
      if (res && res.ok) {
        app.audio.play("success");
        b.disabled = true;
        b.innerHTML = `${ICONS.check} تم`;
        toast(res.sent ? `أُرسل قلب إلى ${name} ❤️` : "قلبك السابق ما زال عنده — انتظر ثم أعد الإرسال");
      } else {
        app.audio.play("error");
        toast((res && res.error) || "فشل الإرسال");
      }
    }));
    ov.querySelectorAll("[data-send]").forEach((b) => b.addEventListener("click", async () => {
      const name = b.dataset.send;
      if (!name) return;
      app.audio.play("tap");
      const res = await socialFetch("/api/social/lives/send", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, name }),
      });
      if (res && res.ok) { app.audio.play("success"); toast(res.sent ? "أُرسل قلب ❤️" : "قلب سابق لم ينته بعد — انتظر قليلاً"); }
      else toast((res && res.error) || "فشل الإرسال");
      await render();
    }));
    ov.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      const name = b.dataset.del;
      if (!name) return;
      app.audio.play("tap");
      const res = await socialFetch("/api/social/friend/remove", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, name }),
      });
      toast(res && res.ok ? "أُزيل من دائرتك" : ((res && res.error) || "فشل"));
      await render();
    }));
    const frName = ov.querySelector("#fr-add-name");
    const frAdd = ov.querySelector("#fr-add");
    if (frAdd) frAdd.addEventListener("click", async () => {
      const name = (frName.value || "").trim().toLowerCase();
      if (!name) { toast("اكتب اسم صديق أولًا"); return; }
      app.audio.play("tap");
      const res = await socialFetch("/api/social/friend/request", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, name }),
      });
      if (res && res.ok) {
        app.audio.play("success");
        toast(res.accepted ? "صديق جديد في دائرتك ✓" : "أُرسل طلب الصداقة ⏳");
        frName.value = "";
      } else toast((res && res.error) || "فشل الإرسال");
      await render();
    });
    const askRow = ov.querySelector("#soc-ask");
    if (askRow) askRow.addEventListener("click", async () => {
      app.audio.play("tap");
      const res = await socialFetch("/api/social/lives/ask", {
        method: "POST",
        body: JSON.stringify({ token: acc.token }),
      });
      if (res && res.ok) { app.audio.play("success"); toast(res.told ? `أُرسل طلبك إلى ${res.told} صديق ❤️` : "لا أصدقاء لديك بعد"); }
      else toast((res && res.error) || "تعذّر الطلب");
    });
    const collectRow = ov.querySelector("#soc-collect");
    if (collectRow) collectRow.addEventListener("click", async () => {
      app.audio.play("tap");
      const res = await socialFetch("/api/social/lives/collect", {
        method: "POST",
        body: JSON.stringify({ token: acc.token, lives: s.lives, maxLives: s.maxLives }),
      });
      if (res && res.ok) {
        if (res.added) { app.store.addLives(res.added); app.audio.play("success"); refreshHUD(); }
        toast(res.added ? `جمعت ${res.added} أرواح ❤️` : "بريدك فارغ الآن");
      } else toast((res && res.error) || "تعذّر الجمع");
      await render();
    });
  };
  document.body.appendChild(ov);
  await render();
  /* تحديث ذاتي كل 30 ثانية — يظهر الصديق/الطلب/بريد الأرواح الجديد وحدهما دون لمس.
     لا يقاطع كتابة المستخدم ولاتريده إن لم يتغير شيء (مقارنة بصمة الحالة). */
  const _socPoll = setInterval(async () => {
    if (!document.body.contains(ov)) { clearInterval(_socPoll); return; }
    const ae = document.activeElement;
    if (ae && ov.contains(ae) && /INPUT|TEXTAREA/.test(ae.tagName)) return;
    const prev = _socLast;
    try { await render(); } catch (_) {}
    if (_socLast && prev && _socLast === prev) return; // لا تغيير
    app.audio.play("tap"); // نبضة صغيرة للوافد الجديد
  }, 30000);
}

function openSettings() {
  const s = app.store;
  const avatars = ["🧑‍🏫", "👩‍🏫", "🧑‍🎓", "👨‍🎓", "🦉", "🐯", "🦊", "🐼"];
  let chosenAvatar = s.profile.avatar;
  let chosenPhoto = typeof s.profile.photo === "string" && s.profile.photo.indexOf("data:image") === 0 ? s.profile.photo : null;
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = h`
    <div class="sheet">
      <div class="grab"></div>
      <h2>الملف والإعدادات ${ICONS.gear}</h2>
      <div class="sub">${esc(s.profile.name)} • ${ICONS.star}${s.totalStars} • ${ICONS.coin}${s.coins} • ${ICONS.gem}${s.gems}</div>
      <input class="field" id="set-name" maxlength="24" value="${esc(s.profile.name)}" placeholder="اسمك" />
      <div class="avatar-grid" id="set-avatars">
        ${avatars.map((a) => `<button class="avatar-opt ${!chosenPhoto && a === chosenAvatar ? "sel" : ""}" data-a="${a}">${a}</button>`).join("")}
        <button type="button" class="avatar-opt photo-add" id="set-photo-pick">
          <span class="pa-ic">📷</span><span class="pa-t">أضف صورتي</span>
        </button>
      </div>
      <input type="file" id="set-photo-file" accept="image/*" hidden />
      <div class="menu-list">
        <div class="menu-row"><span class="mi">${s.settings.sound ? ICONS.sound : ICONS.mute}</span><span>الأصوات</span><span class="spacer"></span><span class="switch ${s.settings.sound ? "on" : ""}" id="set-sound"></span></div>
        <div class="menu-row"><span class="mi">${ICONS.heart}</span><span>الأرواح</span><span class="spacer"></span><span class="val">${s.lives}/${s.maxLives}</span></div>
        <div class="menu-row" id="set-vis"><span class="mi">${ICONS.eye}</span><span>تقدّمي مرئي للزملاء</span><span class="spacer"></span><span class="switch ${s.settings.social.visible !== false ? "on" : ""}"></span></div>
        <div class="menu-row" id="set-stats"><span class="mi">${ICONS.chart}</span><span>إظهار أرقامي</span><span class="spacer"></span><span class="switch ${s.settings.social.showStats !== false ? "on" : ""}"></span></div>
        <div class="menu-row" id="set-peers"><span class="mi">${ICONS.users}</span><span>تقدّم الزملاء</span><span class="spacer"></span><span class="val">${s.account.token ? esc(s.account.name || "") : "بدون حساب"}</span></div>
        <div class="menu-row" id="set-reset"><span class="mi">${ICONS.trash}</span><span>تصفير التقدّم</span><span class="spacer"></span><span class="val">حذف كل شيء</span></div>
      </div>
      <button class="btn green block" id="set-save">حفظ وإغلاق</button>
    </div>`;
  document.body.appendChild(ov);

  const addBtn = ov.querySelector("#set-photo-pick");
  const syncPhoto = () => {
    addBtn.classList.toggle("sel", !!chosenPhoto);
    addBtn.innerHTML = chosenPhoto
      ? `<img class="av-img" src="${chosenPhoto}" alt="" /><span class="pa-t">غيّر صورتي</span><span class="pa-del" id="set-photo-del" aria-label="حذف الصورة">🗑</span>`
      : `<span class="pa-ic">📷</span><span class="pa-t">أضف صورتي</span>`;
    ov.querySelectorAll(".avatar-opt:not(.photo-add)").forEach((x) => x.classList.toggle("sel", !chosenPhoto && x.dataset.a === chosenAvatar));
  };
  syncPhoto();
  ov.querySelectorAll(".avatar-opt:not(.photo-add)").forEach((b) => b.addEventListener("click", () => {
    app.audio.play("tap");
    chosenAvatar = b.dataset.a;
    chosenPhoto = null;
    syncPhoto();
  }));
  addBtn.addEventListener("click", (e) => {
    if (e.target.closest("#set-photo-del")) { app.audio.play("tap"); chosenPhoto = null; syncPhoto(); return; }
    app.audio.play("tap");
    ov.querySelector("#set-photo-file").click();
  });
  ov.querySelector("#set-photo-file").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const data = await processProfilePhoto(f);
    if (!data) { toast("تعذّرت قراءة الصورة"); return; }
    chosenPhoto = data;
    syncPhoto();
    app.audio.play("success");
    toast("تم اختيار الصورة ✓");
  });
  ov.querySelector("#set-sound").addEventListener("click", (e) => {
    const v = !s.settings.sound; s.setSetting("sound", v); app.audio.setEnabled(v);
    e.currentTarget.classList.toggle("on", v);
    app.audio.play(v ? "select" : "tap");
  });
  ov.querySelector("#set-vis").addEventListener("click", (e) => {
    const v = !(s.settings.social.visible !== false);
    s.setSetting("social", Object.assign({}, s.settings.social, { visible: v }));
    e.currentTarget.querySelector(".switch").classList.toggle("on", v);
    app.audio.play(v ? "select" : "tap");
    pushProgress(true);
  });
  ov.querySelector("#set-stats").addEventListener("click", (e) => {
    const v = !(s.settings.social.showStats !== false);
    s.setSetting("social", Object.assign({}, s.settings.social, { showStats: v }));
    e.currentTarget.querySelector(".switch").classList.toggle("on", v);
    app.audio.play(v ? "select" : "tap");
    pushProgress(true);
  });
  ov.querySelector("#set-peers").addEventListener("click", () => { app.audio.play("button"); ov.remove(); openSocial(); });
  ov.querySelector("#set-reset").addEventListener("click", () => {
    if (confirm("سيتم حذف كل التقدّم. متأكد؟")) { s.reset(); app.audio.setEnabled(s.settings.sound); ov.remove(); renderEntry(); }
  });
  ov.querySelector("#set-save").addEventListener("click", () => {
    const name = ov.querySelector("#set-name").value.trim() || "متدرّب الكفاءة";
    s.setProfile({ name, avatar: chosenAvatar, photo: chosenPhoto });
    app.audio.play("button"); ov.remove(); refreshHUD();
    pushProgress();
    const subEl = document.querySelector(".hud .sub"); if (subEl) subEl.textContent = name;
    const avEl = document.getElementById("hud-avatar"); if (avEl) avEl.innerHTML = avatarHTML(s.profile);
    document.querySelectorAll(".player-badge .pb-av").forEach((el) => { el.innerHTML = avatarHTML(s.profile); });
    document.querySelectorAll(".player-badge .pb-name").forEach((el) => { el.textContent = name; });
  });
}

/* ============================================================
   كيف ألعب
   ============================================================ */
function renderHow() {
  const ov = document.createElement("div");
  ov.className = "overlay center";
  ov.innerHTML = h`
    <div class="sheet">
      <h2>كيف ألعب؟ ${ICONS.play}</h2>
      <div class="sub how-text" style="line-height:2">
        • اختر مستوى من الخريطة وابدأ اللعب (تُستهلك روح ${ICONS.heart} لكل محاولة).<br>
        • أجب قبل انتهاء المؤقّت ${ICONS.timer}، فانتهاء الوقت = إجابة خاطئة.<br>
        • كل إجابة صحيحة = 10 نقاط ${ICONS.coin}. اجمع ${CONFIG.passPercent}% للنجاح.<br>
        • النجوم: ${CONFIG.starThresholds.one}% ${ICONS.star} • ${CONFIG.starThresholds.two}% ${ICONS.star}${ICONS.star} • ${CONFIG.starThresholds.three}% ${ICONS.star}${ICONS.star}${ICONS.star}.<br>
        • استعمل المعزّزات: حذف خيارين ${ICONS.divide}، تلميح ${ICONS.bulb}، تخطّي ${ICONS.skip}.<br>
        • اجتز ${CONFIG.chapterUnlockLevels} مستويات لفتح الفصل التالي.<br>
        • لفتح <b>موسم جديد</b> ${ICONS.calendar}: احصل على ${CONFIG.seasonUnlockStars} ${ICONS.star} على الأقل في <b>كل</b> المستويات.<br>
        • لا تنسَ «تحدّي اليوم» ${ICONS.calendar} لمكافآت إضافية.
      </div>
      <button class="btn block" id="how-close">فهمت، هيا بنا!</button>
    </div>`;
  document.body.appendChild(ov);
  ov.querySelector("#how-close").addEventListener("click", () => { app.audio.play("tap"); ov.remove(); });
}

/* ============================================================
   التهيئة
   ============================================================ */
async function init() {
  app.audio = new Audio(app.store.settings.sound);
  app.store.refreshLives();
  try {
    await app.bank.load();
    if (!app.bank.chapters.length) throw new Error("بنك الأسئلة لا يحوي موضوعات صالحة");
  } catch (e) {
    mount(h`
      <div class="screen entry">
        <div class="crest">⚠️</div>
        <h1>تعذّر التحميل</h1>
        <div class="tagline">${esc(e.message || "خطأ غير معروف")}</div>
        <button class="btn" onclick="location.reload()">إعادة المحاولة</button>
      </div>`);
    return;
  }
  renderEntry();
  app.audio.preload();
  await appIdentityFromLink();
}

/* هوية «مسار احتراف»: يفتح التطبيق اللعبة بـ ?u=<اسم المسجل الأول>
   فتعرّف نفسها تلقائيًا على الخادم — دون أي تسجيل داخل اللعبة. */
async function appIdentityFromLink() {
  const m = /[?&]u=([^&]+)/.exec(location.search);
  if (!m) return null;
  let name = "";
  try { name = decodeURIComponent(m[1]).trim(); } catch (_) { return null; }
  if (name.length < 2) return null;
  const s = app.store;
  if (s.account.token && (s.account.name || "").toLowerCase() === name.toLowerCase()) return s.account;
  const res = await socialFetch("/api/social/app-login", { method: "POST", body: JSON.stringify({ name: name }) });
  if (res && res.ok) {
    s.setAccount(res.name, res.token);
    renderEntry(); // تحديث شاشة الافتتاح باسم الحساب
    pushProgress(true); // مزامنة تقدّمك الحالي فورًا
    return s.account;
  }
  if (res && res.error) toast(res.error);
  return null;
}

init();

window.JAWAAHER = app;
app.pushProgress = pushProgress;
app.openSocial = openSocial;
app.decorateMapRivals = decorateMapRivals;
app.fetchMapPeers = fetchMapPeers;
