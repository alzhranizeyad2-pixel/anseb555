'use strict';
// Anseb v3 — إضافة Stremio: تجمع النسخ من Torrentio / Comet / StremThru Torz وغيرها،
// تطابق الترجمة (SubDL / SubSource / OpenSubtitles) وتربطها بالنسخة مباشرة. بدون مكتبات خارجية — Node 18+.
const http = require('http'), zlib = require('zlib'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const WEB = path.join(__dirname, '..', 'frontend');
const UA = 'Anseb/3.0';
const DEBRID = ['realdebrid', 'alldebrid', 'premiumize', 'torbox', 'debridlink'];
const DEFAULT_ADDONS = 'Torrentio|https://torrentio.strem.fun';
// اسم العرض للمصدر (Torz قديم = StremThru)
const srcLabel = (n) => (/^torz$|stremthru/i.test(n) ? 'StremThru' : n);
const hostName = (h) => (/stremthru/.test(h) ? 'StremThru' : /comet/.test(h) ? 'Comet' : /torrentio/.test(h) ? 'Torrentio' : /mediafusion/.test(h) ? 'MediaFusion' : /stremio\.homes/.test(h) ? 'OpenSubtitles Homes' : h.split('.').slice(-2, -1)[0]);

const LANGS = {
  ar: { n: 'Arabic', iso3: 'ara', ss: 'arabic', flags: ['🇸🇦', '🇦🇪', '🇪🇬'], words: ['arabic', 'ara', 'arab', 'عربي'], codes: ['ar', 'ara', 'arabic'] },
  en: { n: 'English', iso3: 'eng', ss: 'english', flags: ['🇬🇧', '🇺🇸'], words: ['english', 'eng'], codes: ['en', 'eng', 'english'] },
  fr: { n: 'French', iso3: 'fre', ss: 'french', flags: ['🇫🇷'], words: ['french', 'fre', 'fra'], codes: ['fr', 'fre', 'fra', 'french'] },
  es: { n: 'Spanish', iso3: 'spa', ss: 'spanish', flags: ['🇪🇸', '🇲🇽'], words: ['spanish', 'spa'], codes: ['es', 'spa', 'spanish'] },
  tr: { n: 'Turkish', iso3: 'tur', ss: 'turkish', flags: ['🇹🇷'], words: ['turkish', 'tur'], codes: ['tr', 'tur', 'turkish'] },
  hi: { n: 'Hindi', iso3: 'hin', ss: 'hindi', flags: ['🇮🇳'], words: ['hindi', 'hin'], codes: ['hi', 'hin', 'hindi'] },
};

// ---------- أدوات عامة ----------
const STOP = ['the', 'and', 'subtitles', 'sub', 'subs', 'eng', 'ara', 'ar', 'en', 'arabic', 'english', 'srt', 'mkv', 'mp4'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff+]+/g, ' ').trim();
const toks = (s) => new Set(norm(s).split(' ').filter((t) => t.length > 1 && !STOP.includes(t)));
const cleanRel = (s) => String(s || '').replace(/^[^\w\u0600-\u06ff\[(]+/, '').replace(/\.(mkv|mp4|avi|srt|zip)$/i, '').trim();
const b64u = (s) => Buffer.from(s).toString('base64url');
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function safeUrl(u) {
  try {
    const x = new URL(String(u).trim().replace(/^stremio:\/\//i, 'https://'));
    if (x.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(x.hostname)) return null;
    return x.origin + x.pathname.replace(/\/(manifest\.json|configure)\/?$/i, '').replace(/\/$/, '');
  } catch (e) { return null; }
}
function parseList(str) {
  return String(str || '').split('\n').map((x) => {
    x = x.trim(); if (!x) return null;
    const i = x.indexOf('|'); let n = '', u = x;
    if (i > 0 && !/^(https?|stremio):/i.test(x.slice(0, i))) { n = x.slice(0, i).trim(); u = x.slice(i + 1); }
    const url = safeUrl(u); if (!url) return null;
    const host = new URL(url).hostname;
    return { name: srcLabel(n || hostName(host)), url };
  }).filter(Boolean);
}
async function req(url, opt, ms) {
  const c = new AbortController(), id = setTimeout(() => c.abort(), ms || 10000);
  try {
    const r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, opt && opt.headers), signal: c.signal }));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally { clearTimeout(id); }
}
const getJSON = async (url, headers, ms) => (await req(url, { headers }, ms)).json();
async function getBuf(url, headers, ms) {
  const b = Buffer.from(await (await req(url, { headers }, ms || 15000)).arrayBuffer());
  if (b.length > 8e6) throw new Error('الملف كبير');
  return b;
}

// كاش بسيط بمدة صلاحية
const cache = new Map();
const remember = (k, v, max) => { cache.set(k, { t: Date.now(), v }); if (cache.size > (max || 400)) cache.delete(cache.keys().next().value); return v; };
const recall = (k, ttl) => { const h = cache.get(k); return h && Date.now() - h.t < (ttl || 600000) ? h.v : null; };

// ---------- تحليل أسماء النسخ ----------
const PLAT_ID = 'nf|amzn|dsnp|hmax|max|atvp|hulu|pcok|pmtp|stan|crav|mubi|crit|sho|cr|funi|dcu|hbo';
const PLAT_LONG = 'netflix|amazon|disney|appletv|peacock|paramount|hbomax|itunes';
const PLAT_RE = new RegExp('\\b(' + PLAT_ID + '|' + PLAT_LONG + ')[ ._-]?web(?:[ ._-]?(?:dl|rip))?\\b|\\bweb(?:[ ._-]?(?:dl|rip))?[ ._-](' + PLAT_ID + ')\\b|\\b(nf|netflix|amzn|amazon|dsnp|disney|hmax|atvp|appletv|hulu|pcok|peacock|pmtp|paramount)\\b');
const PLATN = { netflix: 'nf', amazon: 'amzn', disney: 'dsnp', appletv: 'atvp', peacock: 'pcok', paramount: 'pmtp', hbomax: 'hmax', max: 'hmax', hbo: 'hmax', itunes: 'it' };
function platOf(t) { const m = String(t).toLowerCase().match(PLAT_RE), p = (m && (m[1] || m[2] || m[3])) || ''; return PLATN[p] || p; }
function parse(text) {
  const t = String(text).toLowerCase(), has = (re) => re.test(t);
  const res = has(/2160p|\b4k\b|\buhd\b/) ? 2160 : has(/1080p|1080i/) ? 1080 : has(/720p/) ? 720 : has(/480p|576p|\bpal\b|\bntsc\b|xvid|divx|dvd-?rip|\bdvd\b/) ? 480 : 0;
  const source = has(/remux/) ? 'remux' : has(/blu-?ray|bdrip|brrip|\bbd(?:25|50)\b/) ? 'bluray' : has(/web-?dl/) ? 'web-dl' : has(/web-?rip|\bweb\b/) ? 'webrip' : has(/hdtv|pdtv|dsr\b|tv-?rip|sat-?rip|dvb-?rip|\btvrip\b/) ? 'hdtv' : has(/\bcam\b|\bts\b|telesync|hdcam|dvdscr|\bscr\b|screener|workprint|hdts/) ? 'cam' : has(/dvd-?rip|dvd-?r\b|\bdvd\b/) ? 'dvd' : has(/hdrip/) ? 'webrip' : '';
  const hdr = has(/\bdv\b|dolby.?vision|dovi/) ? (has(/hdr/) ? 'DV+HDR' : 'DV') : has(/hdr10\+/) ? 'HDR10+' : has(/hdr/) ? 'HDR' : '';
  const codec = has(/xvid|divx/) ? 'xvid' : has(/av1/) ? 'av1' : has(/x265|hevc|h\.?265/) ? 'hevc' : has(/x264|h\.?264|avc/) ? 'x264' : '';
  const atmos = has(/atmos/);
  const audio = atmos ? 'Atmos' : has(/truehd/) ? 'TrueHD' : has(/dts-?(hd|x)|dts:?x/) ? 'DTS-HD' : has(/ddp|dd\+|e-?ac-?3/) ? 'DD+' : has(/\bdd\b|ac-?3/) ? 'DD' : has(/aac/) ? 'AAC' : '';
  const ch = (t.match(/\b(7\.1|5\.1|2\.0)\b/) || [])[1] || '';
  const sz = t.match(/(\d+(?:\.\d+)?)\s*(gb|mb)/);
  const size = sz ? (sz[2] === 'gb' ? +sz[1] : +sz[1] / 1024) : 0;
  const se = t.match(/(?:👤|seeders?:?)\s*(\d+)/);
  const fp = t.match(/\b(23\.976|24|25|29\.97|30)\s?fps\b/);
  return { res, source, hdr, codec, atmos, audio, ch, size, seeders: se ? +se[1] : 0, plat: /web/.test(source) ? platOf(t) : '', fps: fp ? +fp[1] : /\bpal\b/.test(t) ? 25 : 0 };
}
// الترجمة المدمجة: yes = مذكورة صراحة في اسم النسخة، maybe = Multi subs، no = غير مذكورة
function embeddedSub(text, lang) {
  const L = LANGS[lang] || LANGS.ar, t = String(text).toLowerCase();
  if (L.flags.some((f) => text.includes(f)) || new RegExp('(?:^|[^a-z])(?:' + L.words.join('|') + ')(?:[^a-z]|$)', 'i').test(t)) return 'yes';
  return /multi[ ._-]?subs?|msubs?|\bmulti\b|dual/.test(t) ? 'maybe' : 'no';
}
const ED_RE = /\b(extended|unrated|uncut|director'?s?[ .]?cut|theatrical|imax|remaster(?:ed)?|final[ .]?cut|special[ .]?edition|open[ .]?matte)\b/gi;
const GROUP_ALIAS = { yify: 'yts' };
const groupOf = (rel) => {
  let s = String(rel);
  if (/\[(?:yts(?:\.\w+)?|yify)\]/i.test(s)) return 'yts';
  s = s.replace(/(?:\s*[\[(][^\])]*[\])])+\s*$/, '');
  const m = s.match(/-([a-z0-9]+)(?:\.[a-z0-9]{2,4})?\s*$/i), g = m ? m[1].toLowerCase() : '';
  return /^(\d{3,4}p|x26[45]|hevc|web|dl|rip|mkv|mp4|srt)$/.test(g) ? '' : GROUP_ALIAS[g] || g;
};
// كلمات العنوان فقط (بدون مصطلحات تقنية) — تكشف ترجمة لعنوان مختلف
const TECH = /\b(2160p|1080p|1080i|720p|480p|576p|4k|uhd|web|dl|webrip|rip|bluray|blu|ray|bdrip|brrip|remux|hdtv|dvd|x264|x265|h|264|265|hevc|avc|av1|hdr|hdr10|dv|dovi|dolby|vision|atmos|ddp|dd|aac|ac3|eac3|dts|hd|ma|x|truehd|flac|opus|10bit|8bit|proper|repack|multi|dual|audio|subs?|hybrid|extended|unrated|uncut|directors?|cut|theatrical|imax|remastered|amzn|nf|dsnp|hmax|atvp|hulu|pcok|pmtp|netflix|amazon|disney|max|ch)\b/g;
function coreToks(t, group) {
  const g = String(t).toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').replace(TECH, ' ').replace(/\b\d{1,2}\b/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ');
  const set = toks(g); if (group) set.delete(group); return set;
}
// قراءة رقم الموسم/الحلقة بكل الصيغ الشائعة: S01E06 · S01 EP06 · 1x06 · Season 1 Episode 6 · E06-E07 · - 06 [anime]
function parseSE(t) {
  t = String(t);
  let m = t.match(/\bs(\d{1,2})[ ._-]{0,2}(?:e|ep|episode)[ ._-]?(\d{1,3})(?:[ ._-]?(?:-|e|ep)[ ._-]?(\d{1,3}))?(?!\d)/i)
    || t.match(/\bseason[ ._-]?(\d{1,2})[ ._,-]{0,3}(?:e|ep|episode)[ ._-]?(\d{1,3})(?!\d)/i)
    || t.match(/(?:^|[^\d])(\d{1,2})x(\d{2,3})(?:-(?:\d{1,2}x)?(\d{2,3}))?(?!\d)/i);
  if (m) return { s: +m[1], e: +m[2], e2: m[3] ? +m[3] : 0, abs: false, pack: false };
  m = t.match(/\b(?:ep|episode|e)[ ._-]?(\d{1,4})(?!\d)/i) || t.match(/(?:^|[\]\)\s._-])-[ ._]?(\d{2,4})(?:v\d)?[ ._]?(?:[\[(.]|$)/);
  const sm = t.match(/\bseason[ ._-]?(\d{1,2})\b/i) || t.match(/\bs(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)[ ._-]season\b/i);
  if (m) return { s: sm ? +sm[1] : null, e: +m[1], e2: 0, abs: !sm && +m[1] >= 50, pack: false };
  if (sm) return { s: +sm[1], e: null, e2: 0, abs: false, pack: true };
  return { s: null, e: null, e2: 0, abs: false, pack: false };
}
// هل رقم الحلقة المطلوب ضمن ما تغطيه هذه الترجمة؟ (يدعم الحلقات المزدوجة E01-E02 وحزم المواسم)
function seOk(i, s, e) {
  if (s != null && i.s != null && +s !== i.s) return false;
  if (e != null && i.e != null && !i.abs) { const hi = i.e2 && i.e2 > i.e && i.e2 - i.e < 4 ? i.e2 : i.e; if (+e < i.e || +e > hi) return false; }
  return true;
}
// مجموعة النسخة: آخر -GROUP أو [Group] في البداية (أنمي) 
const leadGroup = (rel) => { const m = String(rel).match(/^\[([^\]]{2,24})\]/); return m && !/^\d{3,4}p$|^(?:web|bd|dvd|hdtv)/i.test(m[1]) ? m[1].toLowerCase().replace(/[^a-z0-9]/g, '') : ''; };
function relInfo(rel) {
  const t = cleanRel(rel), p = parse(t), se = parseSE(t);
  const y = t.match(/(?:^|[^\d])((?:19|20)\d{2})(?!\d)/);
  const ed = new Set((t.match(ED_RE) || []).map((x) => x.toLowerCase().replace(/[^a-z]/g, '')));
  const group = groupOf(t) || leadGroup(t);
  const core = coreToks(t, group);
  // اسم بلا أي معلومة تقنية (شائع في المسلسلات القديمة): لا نحكم عليه بالتطابق بل نعدّه «غير معروف»
  const bare = !p.source && !p.res && !p.codec && !group && !p.plat && !p.fps;
  return Object.assign(p, { s: se.s, e: se.e, e2: se.e2, abs: se.abs, pack: se.pack, year: y ? +y[1] : 0, group, ed, tokens: toks(t), core, bare });
}
// اسم الملف الأنسب من وصف النسخة: filename ثم سطر 📂/📄 ثم أول سطر يشبه اسم إصدار ثم السطر الأول
function pickRel(x) {
  const bh = x.behaviorHints && x.behaviorHints.filename;
  if (bh) return cleanRel(bh);
  const lines = [x.title, x.description].filter(Boolean).join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const strip = (l) => l.replace(/^[^\w؀-ۿ\[(]+/, '').replace(/\s*(?:\/|\|).*$/, '').trim();
  const pick = lines.find((l) => /^[📂📁📄🎞🎬💿]/u.test(l) && looksRel(strip(l))) || lines.find((l) => looksRel(strip(l))) || lines[0] || '';
  return cleanRel(strip(pick));
}

// ---------- مطابقة الترجمة مع النسخة (0-100) ----------
const SRC_FAM = { remux: 'disc', bluray: 'disc', 'web-dl': 'web', webrip: 'web', hdtv: 'tv', dvd: 'dvd', cam: 'cam', '': '' };
function srcSim(a, b) {
  if (!a || !b) return 0.5;
  if (a === b) return 1;
  if (SRC_FAM[a] === SRC_FAM[b]) return a === 'web-dl' || b === 'web-dl' ? 0.85 : 0.9;
  return SRC_FAM[a] === 'tv' || SRC_FAM[b] === 'tv' ? 0.4 : 0.3;
}
const codecFam = (c) => (c === 'x264' ? 'avc' : c);
function jaccard(a, b) { let i = 0; a.forEach((t) => b.has(t) && i++); return i / (a.size + b.size - i || 1); }
// ---------- مطابقة نصية «ضبابية» (Fuzzy / Noise) ----------
function lev(a, b) {
  if (a === b) return 0; if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[b.length];
}
const tokSim = (x, y) => (x === y ? 1 : Math.min(x.length, y.length) < 4 ? 0 : 1 - lev(x, y) / Math.max(x.length, y.length));
// تشابه مجموعتي كلمات يتسامح مع الأخطاء الإملائية والجمع/المفرد وعلامات الترقيم (simpsons ≈ simpson, homers ≈ homer)
function fuzzyJaccard(a, b) {
  let inter = 0; const used = new Set();
  a.forEach((x) => { let best = 0, bj = null; b.forEach((y) => { if (used.has(y)) return; const v = tokSim(x, y); if (v > best) { best = v; bj = y; } }); if (best >= 0.78) { inter += best; used.add(bj); } });
  return inter / (a.size + b.size - inter || 1);
}
// ضجيج الترجمة: إعلانات وأسماء مواقع وأرصدة تُحذف قبل التحليل
const AD_RE = /(?:www\.|https?:\/\/|\.(?:com|net|org|co)\b|opensubtitles|subscene|addic7ed|podnapisi|yifysubtitles|advertis|sync(?:ed)?\s*(?:&|and|by)|subtitles?\s*(?:by|downloaded|provided)|translated\s*by|ترجمة\s*:|ترجمه\s*:|تعديل\s*:|توقيت\s*:|تحميل\s*من|الإعلان|اعلان)/i;
function stripNoise(text) {
  return String(text).replace(/\r/g, '').split(/\n{2,}/).filter((b) => { const lines = b.split('\n'); const t = lines.slice(2).join(' '); return !(t && t.length < 220 && AD_RE.test(t)); }).join('\n\n');
}
const eq3 = (x, y, hit, miss) => (!x || !y ? 0.6 : x === y ? hit : miss);
// نموذج «احتمال تطابق التوقيت»: ما يحدد التزامن هو المصدر (قرص/ويب/تلفزيون) والمنصة والـ fps والنسخة، لا اسم المجموعة وحده.
// WEB-DL من نفس المنصة يتشاركان نفس الملف الأصلي غالباً حتى لو اختلفت المجموعة.
function fit(a, b) {
  if (a.s != null && b.s != null && a.s !== b.s) return { pct: 0 };
  if (a.e != null && b.e != null && !(b.abs || a.abs) && !seOk(b, a.s, a.e)) return { pct: 0 };
  const absPen = (a.abs || b.abs) && a.e !== b.e ? 0.6 : 1; // ترقيم مطلق (أنمي/كرتون): لا نقطعها بل نخفّض الثقة
  const sameGrp = !!(a.group && a.group === b.group), sim = srcSim(a.source, b.source);
  const platKnown = !!(a.plat && b.plat), platSame = platKnown && a.plat === b.plat, platDiff = platKnown && !platSame;
  const edSame = [...a.ed].sort().join() === [...b.ed].sort().join();
  const fpsBad = !!(a.fps && b.fps && Math.abs(a.fps - b.fps) > 0.5), yearBad = !!(a.year && b.year && Math.abs(a.year - b.year) > 1);
  const fam = SRC_FAM[a.source] || SRC_FAM[b.source], famDiff = SRC_FAM[a.source] && SRC_FAM[b.source] && SRC_FAM[a.source] !== SRC_FAM[b.source];
  let S;
  if (a.source === 'cam' || b.source === 'cam') S = a.source === b.source ? 0.5 : 0.1;
  else if (famDiff) S = sim;
  else if (sameGrp) S = sim >= 0.9 ? 0.95 : 0.88;
  else if (fam === 'web') S = platSame ? 0.86 : platDiff ? 0.45 : 0.68;
  else if (fam === 'disc') S = a.source === b.source ? 0.82 : 0.78;
  else if (fam === 'tv') S = sameGrp ? 0.8 : 0.62;
  else if (fam === 'dvd') S = fpsBad ? 0.4 : 0.72; // أقراص DVD لنفس المنطقة تتشارك التوقيت غالباً
  else S = 0.5;
  if (!famDiff && (!a.source || !b.source)) S = Math.min(S, sameGrp ? 0.82 : 0.55);
  if (fam === 'web' && platDiff) S = Math.min(S, 0.5); // منصتان مختلفتان = ملف أصلي مختلف
  if (!edSame) S *= 0.5;
  if (fpsBad) S *= 0.55;
  if (yearBad) S *= 0.1;
  const D = (eq3(a.res, b.res, 1, 0.35) + eq3(codecFam(a.codec), codecFam(b.codec), 1, 0.45)) / 2;
  const T = a.core.size && b.core.size ? fuzzyJaccard(a.core, b.core) : 0.7;
  let pct = Math.round(100 * (0.85 * S + 0.08 * D + 0.07 * T));
  if (a.core.size >= 2 && b.core.size >= 2 && T < 0.25) pct = Math.round(pct * 0.85); // عنوان مختلف الشكل
  pct = Math.max(0, Math.min(100, Math.round(pct * absPen)));
  const exact = !!(sameGrp && sim >= 0.85 && (!b.res || a.res === b.res) && !platDiff && edSame && !fpsBad && !yearBad && pct >= 90);
  return { pct: exact ? 100 : Math.min(pct, 97), exact };
}
const qual = (x) => (x.trusted ? 3 : 0) + Math.min(5, Math.log10(1 + (x.dl || 0)) * 1.5) - (x.machine ? 15 : 0) - (x.hi ? 4 : 0);
function rankSubs(a, subs) {
  const out = [];
  for (const x of subs) {
    const b = x.info || (x.info = relInfo(x.rel));
    const r = x.hash ? { pct: 100, exact: true } : !x.rel ? { pct: null, exact: false } : b.bare ? (seOk(b, a.s, a.e) ? { pct: null, exact: false } : { pct: 0 }) : fit(a, b);
    if (r.pct === 0) continue;
    out.push({ x, pct: r.pct, exact: r.exact, rank: (r.pct == null ? 20 : r.pct) + qual(x) });
  }
  return out.sort((p, q) => q.rank - p.rank);
}

// ---------- تحليل توقيت الترجمة (بصمة الزمن) ----------
// نقرأ أزمنة ظهور الأسطر ونقارنها بترجمة «مرجعية» مطابقة للنسخة: تطابق الأزمنة = نفس القطعة والـ fps.
function parseSrt(text) {
  const st = [], en = [], re = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/g;
  const ms = (h, m, s_, f) => (((+h || 0) * 60 + +m) * 60 + +s_) * 1000 + +String(f).padEnd(3, '0');
  let m; while ((m = re.exec(text))) { st.push(ms(m[1], m[2], m[3], m[4])); en.push(ms(m[5], m[6], m[7], m[8])); }
  return { st, en };
}
function sigOf(p) {
  if (p.st.length < 20) return null;
  const st = p.st.slice().sort((a, b) => a - b);
  // آخر سطر «حقيقي»: نتجاهل ذيل الأرصدة/الإعلانات المنفصل بفجوة طويلة (>6 دقائق) عن بقية الحوار
  let k = st.length - 1; while (k > 10 && st[k] - st[k - 1] > 360000) k--;
  const ends = p.en.slice().sort((a, b) => a - b), last = k === st.length - 1 ? Math.max.apply(null, p.en.slice(-5)) : Math.min(ends[ends.length - 1], st[k] + 8000);
  return { n: st.length, st, first: st[0], last };
}
const RATIOS = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25, 30 / 29.97, 29.97 / 30];
function overlap(a, b, r, off, tol) { // نسبة أسطر a التي لها سطر مقابل في b بعد تحويله
  let j = 0, hit = 0;
  for (let i = 0; i < a.n; i++) {
    while (j < b.n - 1 && b.st[j] * r + off < a.st[i] - tol) j++;
    if (Math.abs(b.st[j] * r + off - a.st[i]) <= tol) hit++;
  }
  const p0 = 1 - Math.exp((-2 * tol * a.n) / Math.max(1, a.last - a.first)); // احتمال التطابق بالصدفة
  return Math.max(0, (hit / Math.min(a.n, b.n) - p0) / (1 - p0));
}
// مدرّج تكراري لفروق الأزمنة (مثل الارتباط المتبادل): يلتقط إزاحة ثابتة حتى لو اختلفت أول الأسطر أو زادت مقدمة
function histOffset(a, b, r, win, bin) {
  const as = a.st, bs = b.st, nb = Math.ceil((2 * win) / bin) + 1, h = new Int32Array(nb);
  let lo = 0;
  for (let j = 0; j < bs.length; j++) {
    const t = bs[j] * r;
    while (lo < as.length && as[lo] < t - win) lo++;
    for (let k = lo; k < as.length && as[k] <= t + win; k++) h[((as[k] - t + win) / bin) | 0]++;
  }
  let bi = 0, bv = -1, tot = 0;
  for (let i = 0; i < nb; i++) { const v = h[i] + (i ? h[i - 1] : 0) + (i < nb - 1 ? h[i + 1] : 0); tot += v; if (v > bv) { bv = v; bi = i; } }
  const bg = tot / nb, z = (bv - bg) / Math.sqrt(bg + 1), center = (bi + 0.5) * bin - win, d = [];
  let p = 0;
  for (let j = 0; j < bs.length; j++) {
    const t = bs[j] * r + center;
    while (p < as.length - 1 && as[p + 1] <= t) p++;
    const q = p + 1 < as.length && Math.abs(as[p + 1] - t) < Math.abs(as[p] - t) ? p + 1 : p, df = as[q] - bs[j] * r;
    if (Math.abs(df - center) <= bin * 1.5) d.push(df);
  }
  d.sort((x, y) => x - y);
  return { off: d.length ? d[d.length >> 1] : center, z, n: d.length };
}
// انحراف خطي بسرعة غير معروفة (ليست من جدول النسب): مسح خشن للنسبة ثم تدقيق بثلثي البداية والنهاية
function driftFit(a, b) {
  const n = b.st.length; if (n < 60) return null;
  const sub = { st: b.st.filter((_, i) => i % 3 === 0) };
  let r0 = 0, bz = 0;
  for (let r = 0.965; r <= 1.0351; r += 0.0006) { const h = histOffset(a, sub, r, 90000, 500); if (h.z > bz) { bz = h.z; r0 = r; } }
  if (bz < 8) return null;
  const b2 = b.st.map((v) => v * r0), k = Math.floor(n / 3), p1 = { st: b2.slice(0, k) }, p2 = { st: b2.slice(n - k) };
  const h1 = histOffset(a, p1, 1, 8000, 200), h2 = histOffset(a, p2, 1, 8000, 200);
  if (h1.z < 6 || h2.z < 6) return null;
  const t1 = p1.st[k >> 1], t2 = p2.st[k >> 1]; if (t2 - t1 < 600000) return null;
  const slope = (h2.off - h1.off) / (t2 - t1), r = r0 * (1 + slope);
  return r < 0.9 || r > 1.1 ? null : { r, off: h1.off - slope * t1 };
}
function timingFit(a, b) {
  if (!a || !b) return null;
  const sync = overlap(a, b, 1, 0, 800), sync3 = overlap(a, b, 1, 0, 300);
  const q = (r, off) => 0.5 * overlap(a, b, r, off, 800) + 0.5 * overlap(a, b, r, off, 300);
  let best = { r: 1, off: 0, q: 0.5 * sync + 0.5 * sync3 };
  const cand = [[1, a.st[0] - b.st[0]], [1, a.st[a.n - 1] - b.st[b.n - 1]]];
  for (const r of RATIOS) {
    const h = histOffset(a, b, r, 60000, 250); if (h.z >= 3) cand.push([r, h.off]);
    if (r !== 1) cand.push([r, 0], [r, a.st[0] - b.st[0] * r], [r, a.st[a.n - 1] - b.st[b.n - 1] * r]);
  }
  const tryC = (r, off) => { if (Math.abs(off) > 120000 || (r === 1 && off === 0)) return; const v = q(r, off); if (v > best.q + 0.02) best = { r, off: Math.round(off), q: v }; };
  for (const [r, off] of cand) tryC(r, off);
  if (best.q < 0.4) { const dr = driftFit(a, b); if (dr) tryC(dr.r, dr.off); } // آخر مرحلة: لا شيء نجح، نجرّب انحرافاً غير معروف
  const score = overlap(a, b, best.r, best.off, 800), changed = best.r !== 1 || best.off !== 0;
  const tight = changed ? overlap(a, b, best.r, best.off, 300) - sync3 : 0;
  return { sync, score, r: best.r, off: best.off, fixable: changed && score >= 0.5 && (score - sync >= 0.3 || (tight >= 0.25 && sync3 < 0.6)) };
}
// آخر سطر يجب أن يقارب مدة الفيلم (ترجمة نسخة ممدودة أو ناقصة تنكشف هنا)
// المسلسلات: مدة Cinemeta تشمل الإعلانات أحياناً (30 د لحلقة 22 د) فنتساهل أكثر
const runtimeFit = (g, min, series) => { if (!min || !g) return 1; const d = g.last / (min * 60000); return d > (series ? 1.22 : 1.12) ? 0.55 : d < (series ? 0.45 : 0.55) ? 0.6 : 1; };
// طبقة المدة: درجة 0..1 لقرب آخر سطر من المدة المتوقعة (تُستخدم عند غياب أي مرجع توقيت)
function durScore(g, min, series) {
  if (!g || !min) return null;
  const d = g.last / (min * 60000), lo = series ? 0.7 : 0.82, hi = series ? 1.03 : 1.02;
  if (d >= lo && d <= hi) return 1;
  return Math.max(0, 1 - Math.min(Math.abs(d - (d < lo ? lo : hi)) / 0.25, 1));
}
const median = (a) => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const fmtT = (v) => { v = Math.max(0, Math.round(v)); const p = (n, l) => String(n).padStart(l, '0'); return `${p(Math.floor(v / 36e5), 2)}:${p(Math.floor(v / 6e4) % 60, 2)}:${p(Math.floor(v / 1e3) % 60, 2)},${p(v % 1e3, 3)}`; };
const shiftSrt = (t, r, off) => t.replace(/(\d+):(\d{2}):(\d{2})[,.](\d{3})/g, (_, h, m, s_, f) => fmtT((((+h * 60 + +m) * 60 + +s_) * 1000 + +f) * r + off));

// ---------- ZIP + ترميز النصوص ----------
function unzip(buf) {
  const out = []; let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const n = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (/\/$/.test(name) || usize > 5e6 || off + 30 > buf.length || buf.readUInt32LE(off) !== 0x04034b50) continue;
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(ds, ds + csize);
    try { const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null; if (data) out.push({ name, data }); } catch (e) { /* ملف تالف */ }
  }
  return out;
}
function pickSub(files, s, e) {
  const subs = files.filter((f) => /\.(srt|vtt)$/i.test(f.name) && !/__MACOSX/.test(f.name));
  if (!subs.length) return null;
  const biggest = (l) => l.reduce((a, b) => (b.data.length > a.data.length ? b : a));
  if (s && e) {
    const S = +s, E = +e, re = new RegExp('s0?' + S + '[ ._-]?e0?' + E + '(?!\\d)|\\b0?' + S + 'x0?' + E + '\\b|\\b' + S + String(E).padStart(2, '0') + '\\b', 'i');
    const hit = subs.filter((f) => re.test(f.name));
    return hit.length ? biggest(hit) : subs.length === 1 ? subs[0] : null; // حزمة موسم بدون الحلقة المطلوبة = لا نخمّن
  }
  return biggest(subs);
}
function decodeText(buf, lang) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { /* ليس UTF-8 */ }
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  const cp = { ar: 'windows-1256', tr: 'windows-1254' }[lang] || 'windows-1252';
  try { return new TextDecoder(cp).decode(buf); } catch (e) { return buf.toString('latin1'); }
}

// إصلاح نص عربي مكسور بسبب ترميز مزدوج (UTF-8 قُرئ كأنه Latin-1/CP1252 ثم حُفظ من جديد)
const CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
function fixMojibake(text) {
  const hits = (text.slice(0, 20000).match(/[ØÙ][\u0080-¿‘-›ŒœŠšŸŽžƒˆ˜€™]/g) || []).length;
  if (hits < 15) return text;
  try {
    const bytes = Uint8Array.from(Array.from(text, (ch) => { const c = ch.codePointAt(0); if (c < 256) return c; if (CP1252[c] != null) return CP1252[c]; throw new Error('x'); }));
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[؀-ۿ]/.test(fixed) ? fixed : text;
  } catch (e) { return text; }
}
// إحصاءات محتوى الترجمة: نسبة الحروف العربية، علامات الاستفهام (ترميز تالف)، عدد الأحرف
function contentStats(text) {
  const body = text.split(/\r?\n/).filter((l) => l && !/-->/.test(l) && !/^\d+$/.test(l.trim())).join('\n').replace(/<[^>]+>|\{[^}]*\}/g, '');
  const letters = (body.match(/\p{L}/gu) || []).length, ar = (body.match(/[؀-ۿ]/g) || []).length, lat = (body.match(/[A-Za-z]/g) || []).length;
  const bad = (body.match(/[?�]/g) || []).length;
  return { letters, total: letters + bad, ar: letters ? ar / letters : 0, lat: letters ? lat / letters : 0, qm: bad / (letters + bad + 1) };
}
// معامل جودة المحتوى (1 = سليم): لغة خاطئة، ترميز تالف، أو ترجمة شحيحة الأسطر
function contentFactor(g, lang, rt) {
  const q = g && g.q; if (!q || q.total < 50) return 1;
  let f = 1;
  if (lang === 'ar') { if (q.ar < 0.3) f *= 0.1; else if (q.ar < 0.6) f *= 0.5; }
  if (q.qm > 0.2) f *= 0.2;
  if (rt && g.n && g.n / rt < 1.5) f *= 0.6;
  return f;
}
const MACHINE = /\b(ai[ ._-]?(?:translated|generated)|machine[ ._-]?translat\w*|google[ ._-]?translat\w*|auto[ ._-]?(?:translat\w*|generated)|mtl)\b/i;
const FORCED = /\b(forced|foreign[ ._-]?(?:parts?|only))\b/i;
// RTL: نضيف علامة اتجاه لأسطر عربية تبدأ برمز/رقم/شرطة حتى لا تنقلب علامات الترقيم في المشغّل
function rtlFix(t) {
  return t.split(/\r?\n/).map((l) => {
    if (!l || /-->/.test(l) || /^\d+$/.test(l.trim()) || !/[؀-ۿ]/.test(l)) return l;
    const m = l.match(/^((?:\s*(?:<[^>]+>|\{[^}]*\}))*\s*)([\s\S]*)$/), body = m[2];
    return !body || /^[؀-ۿ‏‫]/.test(body) ? l : m[1] + '‏' + body;
  }).join('\n');
}
function safeFetchUrl(u) {
  try {
    const x = new URL(String(u));
    if (x.protocol !== 'https:' || x.username || x.password || !x.hostname.includes('.') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(x.hostname)) return null;
    return x.href;
  } catch (e) { return null; }
}

// ---------- مصادر الترجمة ----------
const looksRel = (s) => s && s.length > 8 && /\d{3,4}p|web|blu-?ray|hdtv|x26[45]|hevc|\b(19|20)\d{2}\b|s\d{1,2}e\d{1,3}/i.test(s);
// أفضل ترجمة أولاً ثم أفضل ترجمة من مزوّد آخر ثم الباقي: بدائل متنوعة بدل ثلاث نسخ من نفس المصدر
function pickSubs(ranked, n) {
  n = n || 3; const ok = ranked.filter((r) => r.tm !== 'junk').filter((r, i) => i === 0 || r.pct == null || r.pct >= 50), out = ok.slice(0, 1), prov = new Set(out.map((r) => r.x.prov));
  for (const r of ok.slice(1)) if (out.length < n && !prov.has(r.x.prov)) { out.push(r); prov.add(r.x.prov); }
  for (const r of ok.slice(1)) if (out.length < n && !out.includes(r)) out.push(r);
  return out;
}
function relOfAddonSub(x) {
  const direct = x.release || x.releaseName || x.title || x.name || x.label || x.filename || '';
  if (looksRel(direct)) return String(direct);
  try { const seg = decodeURIComponent(new URL(x.url).pathname.split('/').pop() || '').replace(/\.(srt|vtt|ass|zip)$/i, ''); return looksRel(seg) ? seg : ''; } catch (e) { return ''; }
}
async function addonSubs(list, type, id, lang, ex) {
  const L = LANGS[lang];
  const r = await Promise.allSettled(list.map(async (a) => {
    const d = await getJSON(`${a.url}/subtitles/${type}/${encodeURIComponent(id)}${ex ? '/' + ex : ''}.json`, {}, 7000);
    return (d.subtitles || []).filter((x) => x.url && L.codes.includes(String(x.lang || '').toLowerCase().split(/[\s\-_\[(]/)[0]))
      .map((x) => ({ prov: a.name, rel: relOfAddonSub(x), url: x.url }));
  }));
  return r.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
}
async function subsSubdl(key, imdb, s, e, lang, mk) {
  const q = new URLSearchParams({ api_key: key, imdb_id: imdb, languages: lang.toUpperCase(), subs_per_page: '30', type: s ? 'tv' : 'movie' });
  if (s) { q.set('season_number', s); q.set('episode_number', e); }
  const d = await getJSON('https://api.subdl.com/api/v1/subtitles?' + q, {}, 9000);
  if (d.status === false) throw new Error(d.error || 'SubDL');
  return (d.subtitles || []).filter((x) => x.url).map((x) => ({ prov: 'SubDL', rel: x.release_name || x.name || '', url: mk('subdl', String(x.url).replace(/^\//, ''), s, e), hi: !!x.hi }));
}
const ss = (key, p) => getJSON('https://api.subsource.net/api/v1' + p, { 'X-API-Key': key }, 9000);
const arr = (d) => (Array.isArray(d) ? d : d && (d.data || d.results || d.subtitles || d.items)) || [];
async function subsSubsource(key, imdb, s, e, lang, mk) {
  const list = arr(await ss(key, '/movies/search?searchType=imdb&imdb=' + imdb));
  const item = (s && list.find((x) => +x.season === +s)) || list[0];
  if (!item) return [];
  const mid = item.movieId != null ? item.movieId : item.id;
  const rows = arr(await ss(key, '/subtitles?movieId=' + encodeURIComponent(mid) + '&language=' + LANGS[lang].ss + '&limit=100'));
  return rows.map((x) => {
    const id = x.subtitleId != null ? x.subtitleId : x.id, ri = x.releaseInfo || x.release_info || x.releaseName || x.release || '';
    return id == null ? null : { prov: 'SubSource', rel: Array.isArray(ri) ? ri.join(' ') : String(ri), url: mk('subsource', String(id), s, e), hi: !!(x.hearingImpaired || x.hearing_impaired) };
  }).filter(Boolean);
}
const osSession = new Map();
async function osAuth(c) {
  const h = { 'Api-Key': c.kOs, 'Content-Type': 'application/json', 'User-Agent': UA }, base = { url: 'https://api.opensubtitles.com/api/v1', h };
  if (!c.osUser || !c.osPass) return base;
  const k = sha(c.kOs + '|' + c.osUser + '|' + c.osPass), hit = osSession.get(k);
  if (hit && Date.now() - hit.t < 72e6) return hit.v;
  const d = await (await req('https://api.opensubtitles.com/api/v1/login', { method: 'POST', headers: h, body: JSON.stringify({ username: c.osUser, password: c.osPass }) }, 9000)).json();
  const v = { url: d.base_url ? 'https://' + d.base_url + '/api/v1' : base.url, h: Object.assign({}, h, { Authorization: 'Bearer ' + d.token }) };
  osSession.set(k, { t: Date.now(), v }); return v;
}
async function subsOs(c, imdb, s, e, lang, mk, hash) {
  const a = await osAuth(c), q = new URLSearchParams({ languages: lang, order_by: 'download_count' });
  if (s) { q.set('parent_imdb_id', imdb.replace('tt', '')); q.set('season_number', s); q.set('episode_number', e); } else q.set('imdb_id', imdb.replace('tt', ''));
  if (hash) q.set('moviehash', hash);
  const d = await getJSON(a.url + '/subtitles?' + q, a.h, 9000);
  return (d.data || []).map((x) => {
    const t = x.attributes || {}, f = (t.files || [])[0] || {};
    return f.file_id ? { prov: 'OpenSubtitles', rel: t.release || f.file_name || '', url: mk('os', String(f.file_id), s, e), hi: !!t.hearing_impaired, machine: !!(t.machine_translated || t.ai_translated), trusted: !!t.from_trusted, dl: t.download_count || 0, hash: !!t.moviehash_match } : null;
  }).filter(Boolean);
}
// تجميع كل الترجمات المتاحة للعنوان (مع كاش)
async function collectSubs(c, type, imdb, s, e, lang, ctx, hash, fname, vsize) {
  const mk = (p, ref, ss_, ee) => `${ctx.base}/c/${ctx.tok}/sub/${p}/${b64u(ref)}.srt${ss_ ? `?s=${ss_}&e=${ee}` : ''}`;
  const id = s ? `${imdb}:${s}:${e}` : imdb;
  const ck = 'subs' + sha([id, lang, c.kSubdl, c.kSubsource, c.kOs, c.osUser, c.osv3, c.subs, hash, vsize, fname, ctx.tok].join('|'));
  const hit = recall(ck, 600000); if (hit) return hit;
  const jobs = [];
  const extra = parseList(c.subs).concat(c.osv3 === false ? [] : [{ name: 'OpenSubtitles v3', url: 'https://opensubtitles-v3.strem.io' }]);
  const ex = new URLSearchParams(); if (hash) ex.set('videoHash', hash); if (vsize) ex.set('videoSize', vsize); if (fname) ex.set('filename', fname);
  if (extra.length) jobs.push(addonSubs(extra, type, id, lang, ex.toString()));
  if (c.kSubdl) jobs.push(subsSubdl(c.kSubdl, imdb, s, e, lang, mk));
  if (c.kSubsource) jobs.push(subsSubsource(c.kSubsource, imdb, s, e, lang, mk));
  if (c.kOs) jobs.push(subsOs(c, imdb, s, e, lang, mk, hash));
  const r = await Promise.allSettled(jobs), seen = new Set(), all = [];
  for (const x of r.flatMap((y) => (y.status === 'fulfilled' ? y.value : []))) {
    if (!x.url || seen.has(x.url)) continue; seen.add(x.url);
    if (FORCED.test(x.rel || '')) continue; // ترجمة الأجزاء الأجنبية فقط
    if (MACHINE.test(x.rel || '')) x.machine = true;
    if (s) { const i = relInfo(x.rel); if (!seOk(i, s, e)) continue; x.info = i; }
    all.push(x);
  }
  return remember(ck, all);
}
// تنزيل الترجمة وتحويلها إلى SRT بترميز UTF-8
async function fetchSubFile(c, prov, ref, s, e) {
  let buf;
  if (prov === 'subdl') { if (!/^[\w\-./]+$/.test(ref) || ref.includes('..')) throw new Error('bad ref'); buf = await getBuf('https://dl.subdl.com/' + ref); }
  else if (prov === 'subsource') { if (!/^\d+$/.test(ref) || !c.kSubsource) throw new Error('bad ref'); buf = await getBuf('https://api.subsource.net/api/v1/subtitles/' + ref + '/download', { 'X-API-Key': c.kSubsource }, 20000); }
  else if (prov === 'os') {
    if (!/^\d+$/.test(ref) || !c.kOs) throw new Error('bad ref');
    const a = await osAuth(c), d = await (await req(a.url + '/download', { method: 'POST', headers: a.h, body: JSON.stringify({ file_id: +ref, sub_format: 'srt' }) }, 12000)).json();
    if (!d.link) throw new Error(d.message || 'OpenSubtitles: لا يوجد رابط تنزيل');
    buf = await getBuf(d.link);
  } else if (prov === 'u') { const u = safeFetchUrl(ref); if (!u) throw new Error('bad ref'); buf = await getBuf(u); }
  else throw new Error('provider');
  return unpack(buf, c, s, e);
}
function unpack(buf, c, s, e) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  if (buf[0] === 0x50 && buf[1] === 0x4b) { const f = pickSub(unzip(buf), s, e); if (!f) throw new Error('لا توجد ترجمة مطابقة داخل الأرشيف'); buf = f.data; }
  const text = fixMojibake(decodeText(buf, c.lang || 'ar'));
  if (!/-->/.test(text)) throw new Error('الملف ليس ترجمة صالحة');
  return text;
}

async function subText(c, x, s, e) {
  const m = String(x.url).match(/\/sub\/(subdl|subsource|os|u)\/([\w-]+)\.srt/);
  return m ? fetchSubFile(c, m[1], Buffer.from(m[2], 'base64url').toString(), s, e) : unpack(await getBuf(x.url), c, s, e);
}
async function loadSig(c, x, s, e) {
  const k = 'sig' + sha(x.url), hit = recall(k, 18e5); if (hit) return hit;
  const text = stripNoise(await subText(c, x, s, e)), g = sigOf(parseSrt(text));
  if (!g) return null;
  g.q = contentStats(text); return remember(k, g, 300);
}
const proxied = (ctx, url, s, e) => (url.startsWith(ctx.base + '/c/') ? url : `${ctx.base}/c/${ctx.tok}/sub/u/${b64u(url)}.srt${s ? `?s=${s}&e=${e}` : ''}`);
const wOf = (r) => (r.pct == null ? 0.3 : r.pct / 100) + (r.x.trusted ? 0.2 : 0) + Math.log10(1 + (r.x.dl || 0)) / 10;
// الطبقة العميقة: ننزّل أفضل المرشحين (بدون OpenSubtitles API لحماية حصة التنزيل) ونقارن توقيتهم
// 1) مرجع قوي: ترجمة مطابقة للاسم  2) إجماع: أكبر مجموعة ترجمات متطابقة التوقيت  3) فحص المحتوى والمدة
async function timingRank(c, groups, meta, ctx, s, e, poolGroups) {
  const lang = LANGS[c.lang] ? c.lang : 'ar', pool = new Map();
  (poolGroups || groups).forEach((g) => g.subs.forEach((r) => { if ((r.x.prov !== 'OpenSubtitles' || c.osDeep || r.x.hash) && r.x.url && (!pool.has(r.x.url) || (pool.get(r.x.url).pct || 0) < (r.pct || 0))) pool.set(r.x.url, r); }));
  const sig = new Map();
  await Promise.race([Promise.allSettled([...pool.entries()].sort((p, q) => (q[1].pct || 0) - (p[1].pct || 0)).slice(0, 12).map(async ([u, r]) => { const g = await loadSig(c, r.x, s, e); if (g) sig.set(u, g); })), new Promise((ok) => setTimeout(ok, 7000))]);
  const pc = new Map(), tf = (ua, ub) => { const k = ua + '\n' + ub; if (!pc.has(k)) pc.set(k, timingFit(sig.get(ua), sig.get(ub))); return pc.get(k); };
  const canFix = c.fix !== false, series = !!s;
  for (const grp of groups) {
    const have = grp.subs.filter((r) => sig.has(r.x.url));
    // طبقة المدة: إن لم تتوفر مدة من Cinemeta (شائع في المسلسلات القديمة) نستنتج المدة المتوقعة من وسيط أواخر السطور عند ≥3 ترجمات
    let rtEff = meta && meta.rt, inferred = false;
    if (!rtEff && have.length >= 3) { const md = median(have.map((r) => sig.get(r.x.url).last)); if (md > 0) { rtEff = md / 60000; inferred = true; } }
    let anchor = have.find((r) => r.exact || r.pct >= 88), soft = null;
    if (!anchor && have.length >= 3) { // إجماع: المركز الذي يتفق معه أكبر وزن من الترجمات الأخرى
      let bs = -1;
      for (const i of have) {
        let sc = wOf(i), sup = 0;
        for (const j of have) { if (j === i) continue; const t = tf(i.x.url, j.x.url); if (t && (t.sync >= 0.5 || t.fixable)) { sc += wOf(j); sup++; } }
        if (sup >= 2 && sc > bs) { bs = sc; soft = i; }
      }
    }
    // مرجع ضعيف: لا اسم مطابق ولا إجماع، فنعتمد أفضل ترجمة سليمة المحتوى ونضبط عليها الباقي بحذر (التصحيح فقط عند تطابق قوي)
    let weak = null;
    if (!anchor && !soft && have.length >= 2) weak = have.slice().sort((p, q) => wOf(q) - wOf(p)).find((r) => contentFactor(sig.get(r.x.url), lang, rtEff) === 1 && runtimeFit(sig.get(r.x.url), rtEff, series) === 1) || null;
    const ref = anchor || soft || weak;
    for (const r of have) {
      const g = sig.get(r.x.url), base = r.pct == null ? 50 : r.pct, rf = runtimeFit(g, rtEff, series), qf = contentFactor(g, lang, rtEff);
      let st = '', pct = base;
      if (ref === r) { st = anchor ? 'ok' : soft ? 'cons' : ''; if (soft) pct = Math.min(96, base + 8); }
      else if (ref) {
        const t = tf(ref.x.url, r.x.url), fixed = t.fixable && canFix, eff = fixed ? t.score : t.sync;
        if (anchor) {
          if (fixed) r.fix = t;
          st = eff >= 0.4 ? (fixed ? 'fix' : 'ok') : 'bad';
          pct = Math.round(base * (0.55 + 0.45 * Math.min(1, eff / 0.7)));
          if (st !== 'bad') pct = Math.max(pct, Math.round(60 + 35 * Math.min(1, eff))); // توقيت مؤكَّد = تطابق فعلي حتى لو اختلف اسم المجموعة
        } else if (soft) {
          if (fixed) r.fix = t;
          if (eff >= 0.5) { st = fixed ? 'fix' : 'cons'; pct = Math.min(95, base + 8); } else { st = 'bad'; pct = Math.round(base * 0.8); }
        } else if (fixed && t.score >= 0.7) { r.fix = t; st = 'fix'; pct = Math.min(95, base + 4); }
        else if (t.sync >= 0.5) { st = 'cons'; pct = Math.min(95, base + 4); }
      }
      // احتياط المدة: لا مرجع توقيت ولا إجماع → نعتمد قرب المدة (ترجمة قريبة من المدة المتوقعة تُرفع قليلاً، والبعيدة تُخفض)
      if (!ref && rtEff && !inferred) { const ds = durScore(g, rtEff, series); if (ds != null) { r.dur = ds; pct = ds >= 1 ? Math.min(88, base + 6) : Math.round(base * (0.7 + 0.3 * ds)); } }
      if (rf < 1 && st !== 'bad') st = 'bad';
      r.pct = r.pct == null && !st && rf * qf === 1 ? null : Math.round(pct * rf * qf); r.exact = r.exact && st !== 'bad' && qf >= 1; const dd = rtEff ? g.last / (rtEff * 60000) : 1; r.tm = qf < 0.5 || dd > 1.7 || dd < 0.35 ? 'junk' : st; // مدة بضعف المتوقع (ترجمة مدموجة/حلقة أخرى) = مرفوضة r.q = qf;
      r.url = r.fix ? proxied(ctx, r.x.url, s, e) + (proxied(ctx, r.x.url, s, e).includes('?') ? '&' : '?') + 'r=' + r.fix.r.toFixed(6) + '&o=' + r.fix.off : r.x.url;
    }
    const kr = (r) => (r.pct == null ? 20 : r.pct) + qual(r.x) + (r.dur || 0) - (r.tm === 'bad' ? 30 : 0);
    grp.subs.sort((a, b) => kr(b) - kr(a));
    const seenSig = new Set(); // نفس الملف من مزوّدين: نُبقي الأعلى ترتيباً
    grp.subs = grp.subs.filter((r) => { const g = sig.get(r.x.url); if (!g) return true; const k = g.n + '|' + g.first + '|' + g.last; if (seenSig.has(k)) return false; seenSig.add(k); return true; });
  }
}
async function deepTiming(c, list, o, meta, ctx, s, e) {
  const wide = list.map((v) => ({ subs: v.cands || v.subs }));
  await timingRank(c, wide, meta, ctx, s, e, wide.slice(0, 8));
  list.forEach((v, i) => { v.cands = wide[i].subs; v.subs = pickSubs(v.cands); });
  for (const v of list) {
    const b = v.subs[0];
    v.sub = b ? { provider: b.x.prov, pct: b.pct, exact: b.exact, url: b.url || b.x.url, tm: b.tm || '' } : null;
    v.score = score(v, o, meta);
  }
}

// ---------- الترتيب ----------
const W = { res: { 2160: 40, 1080: 30, 720: 15, 480: 5, 0: 0 }, src: { remux: 25, bluray: 20, 'web-dl': 18, webrip: 12, hdtv: 8, cam: -200, dvd: 2, '': 0 }, aud: { Atmos: 20, TrueHD: 10, 'DTS-HD': 8, 'DD+': 6, DD: 3, AAC: 1, '': 0 }, hdr: { 'DV+HDR': 7, DV: 6, 'HDR10+': 6, HDR: 5, '': 0 }, cod: { av1: 2, hevc: 4, x264: 3, '': 0 } };
function score(s, o, meta) {
  let v = W.res[s.res] + W.src[s.source] + W.aud[s.audio] + W.hdr[s.hdr] + W.cod[s.codec];
  if (o.atmos && s.atmos) v += 25;
  v += s.emb === 'yes' ? 35 : s.emb === 'maybe' ? 10 : 0;
  if (s.cached) v += o.debrid ? 30 : 15;
  else if (!o.debrid && !s.url) v += s.seeders === 0 ? -25 : Math.min(14, Math.log10(1 + s.seeders) * 5); // تورنت بلا بذور = خطر عدم تشغيل
  else v += Math.min(10, Math.log10(1 + s.seeders) * 4);
  if (meta && meta.rt && s.size && s.res >= 720) { // معدل البت: ملف صغير جداً لدقته غالباً ضغط سيئ أو نسخة مزيفة
    const mbps = (s.size * 8192) / (meta.rt * 60);
    if (s.res >= 2160 && mbps < 6) v -= 12; else if (s.res >= 1080 && mbps < 1.5) v -= 15; else v += Math.min(6, mbps / 4);
  } else if (s.size && s.size < 0.15 && s.res >= 720) v -= 30;
  if (s.sub) v += s.sub.exact ? 45 : s.sub.pct != null ? s.sub.pct * 0.3 : 8;
  if (o.maxRes && s.res > o.maxRes) v -= 100;
  if (s.hdr && o.noHdr) v -= 40;
  if (s.size > 60) v -= 10;
  return Math.round(v);
}
async function getMeta(type, imdb, s, e) {
  const k = 'meta' + imdb + s + e, hit = recall(k, 864e5); if (hit) return hit;
  try {
    const m = (await getJSON(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, {}, 4000)).meta || {};
    const v = (m.videos || []).find((x) => s && +x.season === +s && +x.episode === +e);
    return remember(k, { rt: parseInt(m.runtime, 10) || 0, name: m.name || '', year: String(m.year || m.releaseInfo || '').slice(0, 4), ep: v ? v.title || v.name || '' : '' });
  } catch (err) { return { name: '', year: '', ep: '' }; }
}

async function buildStreams(c, type, id, ctx, only) {
  const lang = LANGS[c.lang] ? c.lang : LANGS[c.sublang] ? c.sublang : 'ar';
  if (!/^tt\d+(:\d+:\d+)?$/.test(id)) return { streams: [], lang };
  const [imdb, s, e] = id.split(':');
  const debrid = DEBRID.includes(c.debrid) && c.debridKey ? c.debrid : '';
  let addons = parseList(c.addons || DEFAULT_ADDONS);
  if (debrid) addons = addons.map((a) => (/torrentio/i.test(a.name + a.url) && a.url === new URL(a.url).origin ? { name: a.name, url: a.url + '/' + (c.cachedOnly ? 'debridoptions=nodownloadlinks,nocatalog|' : 'debridoptions=nocatalog|') + debrid + '=' + encodeURIComponent(c.debridKey) } : a));
  if (only != null) addons = addons.slice(only, only + 1);
  if (!addons.length) return { streams: [], lang };
  const subsP = collectSubs(c, type, imdb, s, e, lang, ctx, '').catch(() => []), metaP = getMeta(type, imdb, s, e);
  const res = await Promise.allSettled(addons.map(async (a) => ((await getJSON(`${a.url}/stream/${type}/${encodeURIComponent(id)}.json`, {}, 10000)).streams || []).map((x) => ({ x, addon: a.name }))));
  const [subs, meta] = await Promise.all([subsP, metaP]);
  const seen = new Map();
  for (const { x, addon } of res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))) {
    const text = [x.name, x.title, x.description].filter(Boolean).join('\n');
    const rel = pickRel(x);
    const p = parse(text + ' ' + rel);
    if (x.behaviorHints && x.behaviorHints.videoSize && !p.size) p.size = x.behaviorHints.videoSize / 1073741824;
    const key = addon + '|' + (rel ? norm(rel) + '|' + Math.round(p.size * 10) : x.infoHash || x.url); // لا دمج بين المصادر: كل مصدر نسخه الخاصة
    const item = Object.assign(p, { addon, release: rel, infoHash: x.infoHash || '', fileIdx: x.fileIdx, sources: x.sources, url: x.url || '', cached: /\+\]|⚡|cached|instant/i.test(x.name || ''), emb: embeddedSub(text, lang) });
    const prev = seen.get(key);
    if (prev) { prev.seeders = Math.max(prev.seeders, item.seeders); prev.cached = prev.cached || item.cached; if (!prev.url && item.url) prev.url = item.url; if (!prev.infoHash && item.infoHash) Object.assign(prev, { infoHash: item.infoHash, fileIdx: item.fileIdx, sources: item.sources }); continue; }
    seen.set(key, item);
  }
  const o = { debrid: !!debrid, atmos: !!c.atmos, maxRes: +c.maxRes || 0, noHdr: !!c.noHdr };
  let list = [...seen.values()].filter((v) => !debrid || v.url).map((v) => {
    const ranked = rankSubs(relInfo(v.release || ''), subs);
    v.subs = pickSubs(ranked); v.cands = ranked.slice(0, 12); // المرشحون الأوسع للتحليل العميق
    const b = ranked[0];
    v.sub = b ? { provider: b.x.prov, pct: b.pct, exact: b.exact, url: b.x.url } : null;
    v.score = score(v, o, meta); return v;
  }).sort((a, b) => b.score - a.score).filter((v) => v.score > -50);
  const per = Math.min(20, Math.max(3, +c.top || 5)), cnt = {};
  list = list.filter((v) => (cnt[v.addon] = (cnt[v.addon] || 0) + 1) <= per); // أفضل N نسخ من كل مصدر
  if (c.deep !== false) { await deepTiming(c, list, o, meta, ctx, s, e).catch(() => {}); list.sort((a, b) => b.score - a.score); }
  if (list[0]) list[0].top = true; // ⭐ الأنسب بين كل المصادر
  const first = {}; list.forEach((v) => { if (!first[v.addon]) { first[v.addon] = 1; v.best = true; } }); // 🏆 لأفضل نسخة في كل مصدر
  return { streams: list, lang, meta, subsFound: subs.length, minPct: +c.minPct || 0 };
}

// ---------- شكل النتيجة داخل Stremio ----------
const mark = (v) => (v >= 75 ? '✅' : '⚠️');
function toStremio(r, ctx, type, s, e) {
  const L = LANGS[r.lang], m = r.meta || {};
  return r.streams.map((v) => {
    const title = m.name ? m.name + (m.year ? ' (' + m.year + ')' : '') + (type === 'series' && s ? ` S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}` + (m.ep ? ' · ' + m.ep : '') : '') : v.release.split(/[.\s_]*(?:19|20)\d{2}|\b(?:2160|1080|720|480)p/i)[0].replace(/[._]+/g, ' ').trim() || v.release;
    const tech = [v.source && v.source.toUpperCase(), v.codec && v.codec.toUpperCase(), v.hdr].filter(Boolean).join(' · ');
    const audio = v.atmos ? 'Dolby Atmos' + (v.ch ? ' ' + v.ch : '') : v.audio ? v.audio + (v.ch ? ' ' + v.ch : '') : 'Unknown';
    const k4 = v.res >= 2160 ? 'Yes ✅' : 'No ❌' + (v.res ? ' (' + v.res + 'p)' : '');
    let sub;
    if (v.emb === 'yes') sub = `${L.n} · مدمجة ✅`;
    else if (v.sub) sub = `${L.n} · خارجية ` + (v.sub.exact ? '100% ✅' : v.sub.pct == null ? 'متوفرة ✅' : `${v.sub.pct}% ${mark(v.sub.pct)}`) + ({ ok: ' · ⏱ متزامنة', cons: ' · ⏱ توقيت متوافق مع بقية الترجمات', fix: ' · ⏱ صُحّح التوقيت 🔧', bad: ' · ⏱ توقيت مختلف ⚠️', junk: ' · ⚠️ محتوى مشكوك' }[v.sub.tm] || '') + ' · ' + v.sub.provider;
    else sub = `${L.n} · ` + (v.emb === 'maybe' ? '➕ Multi subs (غير مؤكدة)' : '❌ غير متوفرة');
    const info = [v.size ? '💾 ' + v.size.toFixed(1) + ' GB' : '', v.cached ? '⚡ Cached' : v.seeders ? '👤 ' + v.seeders : '', '📡 ' + v.addon].filter(Boolean).join('  ');
    const o = {
      name: 'Anseb - ' + v.addon + '\n' + (v.res >= 2160 ? '4K' : v.res ? v.res + 'p' : ' '),
      description: [(v.top ? '⭐' : '') + (v.best ? '🏆 ' : '🎬 ') + title + (tech ? ' · ' + tech : ''), '🔊 Audio: ' + audio, '📺 4K: ' + k4, '💬 Subtitle: ' + sub, info].join('\n'),
      behaviorHints: { bingeGroup: ['anseb', v.addon, v.res, v.source, v.group || ''].join('-'), filename: v.release },
    };
    // الترجمة المطابقة تُرفق بالنسخة نفسها: تظهر في مشغّل ستريمو بمجرد التشغيل
    const att = (v.emb === 'yes' ? v.subs.slice(0, 1) : v.subs).filter((q) => q.tm !== 'junk' && (q.exact || q.pct == null || q.pct >= (r.minPct || 0)));
    if (att.length) o.subtitles = att.map((q, n) => ({ id: `anseb-${q.x.prov.toLowerCase().replace(/\W+/g, '-')}-${n}`, url: q.url || q.x.url, lang: L.iso3 }));
    if (v.url) o.url = v.url; else if (v.infoHash) { o.infoHash = v.infoHash; if (v.fileIdx != null) o.fileIdx = v.fileIdx; if (v.sources) o.sources = v.sources; } else return null;
    return o;
  }).filter(Boolean);
}
const slug = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'src';
const manifest = (v) => {
  const m = { id: 'org.anseb.addon', version: '3.2.0', name: 'Anseb ⭐', description: 'أنسب: يختار لك أنسب نسخة ويربطها بأنسب ترجمة (SubDL / SubSource / OpenSubtitles) — مدمجة أو خارجية مع نسبة التطابق. كل مصدر (Torrentio / Comet / StremThru) يظهر بنسخه الخاصة.', resources: ['stream', 'subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [], behaviorHints: { configurable: true, configurationRequired: false } };
  if (v && v.subsOnly) return Object.assign(m, { id: 'org.anseb.subtitles', name: 'Anseb - Subtitles', description: 'أنسب: ترجمات مطابقة لاسم الملف الفعلي، مع مزامنة تلقائية لكل ترجمة وفحص لمحتواها (اختياري مع إضافات المصادر).', resources: ['subtitles'] });
  if (v && v.src) return Object.assign(m, { id: 'org.anseb.' + slug(v.src.name) + (v.dup ? '-' + v.idx : ''), name: 'Anseb - ' + v.src.name, description: 'أنسب: نسخ ' + v.src.name + ' مع أنسب ترجمة ونسبة التطابق.', resources: ['stream'] });
  return m;
};

// ---------- الإعدادات داخل الرابط ----------
function decodeCfg(t) {
  try { if (!t) return {}; const raw = t[0] === '~' ? zlib.inflateRawSync(Buffer.from(t.slice(1), 'base64url')) : Buffer.from(t, 'base64url'); return JSON.parse(raw.toString('utf8')); } catch (e) { return {}; }
}

// ---------- الخادم ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.otf': 'font/otf', '.woff2': 'font/woff2', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const send = (res, code, body, h) => { res.writeHead(code, Object.assign({ 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json; charset=utf-8' }, h)); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
function serveFile(res, rel) {
  const f = path.join(WEB, rel);
  if (!f.startsWith(WEB + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(f), h = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': (ext === '.otf' || ext === '.png') ? 'public, max-age=604800' : 'no-cache' }, SEC);
    if (ext === '.html') h['Content-Security-Policy'] = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https://dima.tools https://avatars.githubusercontent.com; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
    res.writeHead(200, h); res.end(data);
  });
}
const readBody = (r) => new Promise((ok, no) => { let b = ''; r.on('data', (d) => { b += d; if (b.length > 20000) { r.destroy(); no(new Error('big')); } }); r.on('end', () => ok(b)); r.on('error', no); });

async function testKey(b) {
  const g = (k) => String(b[k] || '').trim();
  if (b.kind === 'subdl') {
    const d = await getJSON('https://api.subdl.com/api/v1/subtitles?' + new URLSearchParams({ api_key: g('key'), imdb_id: 'tt0111161', languages: 'EN', subs_per_page: '1', type: 'movie' }), {}, 9000);
    if (d.status === false) throw new Error(d.error || 'مفتاح غير صالح');
    return 'المفتاح يعمل';
  }
  if (b.kind === 'subsource') { await ss(g('key'), '/movies/search?searchType=imdb&imdb=tt0111161'); return 'المفتاح يعمل'; }
  if (b.kind === 'os') {
    const c = { kOs: g('key'), osUser: g('user'), osPass: g('pass') }, a = await osAuth(c);
    await getJSON(a.url + '/subtitles?imdb_id=111161&languages=en', a.h, 9000);
    return c.osUser ? 'المفتاح وتسجيل الدخول يعملان (التنزيل مفعّل)' : 'المفتاح يعمل — أضف اسم المستخدم وكلمة المرور لتفعيل التنزيل';
  }
  throw new Error('نوع غير معروف');
}

async function handler(rq, res) {
  const u = new URL(rq.url, 'http://x'), m = u.pathname.match(/^(?:\/c\/([\w~-]{1,20000}))?(\/.*)$/), tok = (m && m[1]) || '';
  let p = m ? m[2] : u.pathname, only = null, subsOnly = false, pm;
  // /a/<n>/... = إضافة مستقلة لمصدر واحد، /subs/... = إضافة الترجمة فقط
  if ((pm = p.match(/^\/a\/(\d+)(\/.*)$/))) { only = +pm[1]; p = pm[2]; } else if ((pm = p.match(/^\/subs(\/.*)$/))) { subsOnly = true; p = pm[1]; }
  const base = PUBLIC_URL || ((/^(localhost|127\.)/.test(rq.headers.host || '') ? 'http' : rq.headers['x-forwarded-proto'] || 'https') + '://' + rq.headers.host), ctx = { base, tok };
  if (rq.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return res.end(); }
  if (p === '/health') return send(res, 200, { ok: true });
  if (p === '/' || p === '/configure' || p === '/index.html') return serveFile(res, 'index.html');
  if (p.startsWith('/fonts/') || p.startsWith('/emoji/')) return serveFile(res, p.slice(1));
  if (p === '/manifest.json') {
    if (subsOnly) return send(res, 200, manifest({ subsOnly: true }));
    if (only == null) return send(res, 200, manifest());
    const L = parseList(decodeCfg(tok).addons || DEFAULT_ADDONS), src = L[only];
    if (!src) return send(res, 404, { error: 'not found' });
    return send(res, 200, manifest({ src, idx: only, dup: L.filter((x) => slug(x.name) === slug(src.name)).length > 1 }));
  }

  if (p === '/api/check') {
    const url = safeUrl(u.searchParams.get('url') || ''), h = { 'Access-Control-Allow-Origin': ORIGIN, 'Content-Type': 'application/json; charset=utf-8' };
    if (!url) return send(res, 200, { ok: false, error: 'الرابط غير صالح (لازم https)' }, h);
    const want = u.searchParams.get('kind') === 'subs' ? 'subtitles' : 'stream', AJ = { Accept: 'application/json' };
    const variants = [...new Set([url, url.replace(/%7C/gi, '|'), url.replace(/\|/g, '%7C')])];
    let d = null, lastErr = null;
    for (const v of variants) for (let k = 0; k < 2 && !d; k++) { try { d = await getJSON(v + '/manifest.json', AJ, 12000); } catch (e) { lastErr = e; } }
    if (d) { const rs = (d.resources || []).map((x) => (x.name || x)), ok = rs.includes(want); return send(res, 200, { ok, name: d.name, version: d.version, error: ok ? '' : want === 'stream' ? 'هذي الإضافة لا تقدّم نسخ (stream)' : 'هذي الإضافة لا تقدّم ترجمات (subtitles)' }, h); }
    if (want === 'subtitles') { // فحص وظيفي بديل: نطلب ترجمات عنوان معروف
      for (const v of variants) { try { const pr = await getJSON(v + '/subtitles/movie/tt0111161.json', AJ, 12000); if (pr && Array.isArray(pr.subtitles)) return send(res, 200, { ok: true, name: 'الإضافة تعمل (فحص مباشر)', version: '' }, h); } catch (e) { lastErr = lastErr || e; } }
    }
    // مصادر معروفة: لا نحمّر الصفحة، قد يكون الحظر من جهة الفحص فقط
    const known = /(^|\.)(stremio\.homes|strem\.io|strem\.fun|elfhosted\.com|13377001\.xyz)$/.test(new URL(url).hostname);
    return send(res, 200, { ok: false, soft: known, error: (known ? 'تعذّر فحصه من الخادم (' + (lastErr && lastErr.message) + ') لكنه مصدر معروف وسيُجرَّب وقت التشغيل' : 'تعذّر قراءة الإضافة: ' + (lastErr && lastErr.message)) }, h);
  }
  if (p === '/api/test' && rq.method === 'POST') {
    const h = { 'Access-Control-Allow-Origin': ORIGIN, 'Content-Type': 'application/json; charset=utf-8' };
    try { return send(res, 200, { ok: true, msg: await testKey(JSON.parse(await readBody(rq))) }, h); }
    catch (e) { return send(res, 200, { ok: false, msg: /HTTP 40[13]/.test(e.message) ? 'المفتاح غير صالح (' + e.message + ')' : e.message }, h); }
  }

  let a;
  const c = decodeCfg(tok);
  if ((a = p.match(/^\/sub\/(subdl|subsource|os|u)\/([\w-]+)\.srt$/))) {
    const k = 'file' + sha(tok + p + u.search), hit = recall(k, 1800000);
    const rr = +u.searchParams.get('r') || 1, oo = +u.searchParams.get('o') || 0, okFix = (rr !== 1 || oo) && rr > 0.9 && rr < 1.1 && Math.abs(oo) <= 120000;
    try {
      const text = hit || remember(k, ((t) => { if (okFix) t = shiftSrt(t, rr, oo); return c.rtl !== false && (c.lang || 'ar') === 'ar' ? rtlFix(t) : t; })(await fetchSubFile(c, a[1], Buffer.from(a[2], 'base64url').toString(), u.searchParams.get('s'), u.searchParams.get('e'))), 60);
      return send(res, 200, text, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if ((a = p.match(/^\/(stream|subtitles)\/(movie|series)\/([^/]+?)(?:\/([^/]+?))?\.json$/))) {
    const kind = a[1], type = a[2], id = decodeURIComponent(a[3]), extra = a[4] ? decodeURIComponent(a[4]) : '';
    const key = 'out' + sha(kind + tok + type + id + extra + '|' + only + subsOnly), hit = recall(key, 600000);
    if (hit) return send(res, 200, hit);
    let out;
    try {
      if ((kind === 'stream' && subsOnly) || (kind === 'subtitles' && only != null)) return send(res, 200, kind === 'stream' ? { streams: [] } : { subtitles: [] });
      const [imdb, s, e] = id.split(':');
      if (kind === 'stream') out = { streams: toStremio(await buildStreams(c, type, id, ctx, only), ctx, type, s, e) };
      else {
        const lang = LANGS[c.lang] ? c.lang : 'ar', ex = new URLSearchParams(extra), fn = ex.get('filename') || '';
        const subs = await collectSubs(c, type, imdb, s, e, lang, ctx, ex.get('videoHash') || '', fn, ex.get('videoSize') || '');
        // طبقة الهاش: ترجمة مطابقة للهاش تكشف النسخة الحقيقية للفيديو؛ نستخدم اسمها كأساس لترتيب الباقي حين لا يصلنا filename
        const hs = subs.find((x) => x.hash && x.rel), base = fn ? relInfo(fn) : hs ? relInfo(hs.rel) : null;
        const ranked = base ? rankSubs(base, subs) : subs.map((x) => ({ x, pct: x.hash ? 100 : null, exact: !!x.hash })).sort((p, q) => (q.x.hash ? 100 : 0) + qual(q.x) - ((p.x.hash ? 100 : 0) + qual(p.x)));
        const g = { subs: ranked.slice(0, 15) };
        if (c.deep !== false && g.subs.length > 1) await timingRank(c, [g], await getMeta(type, imdb, s, e), ctx, s, e).catch(() => {});
        out = { subtitles: g.subs.filter((q) => q.tm !== 'junk').map((q, n) => ({ id: `anseb-${q.x.prov.toLowerCase().replace(/\W+/g, '-')}-${n}` + (q.pct != null ? '-' + q.pct : ''), url: q.url || q.x.url, lang: LANGS[lang].iso3 })) };
      }
    } catch (e) { out = kind === 'stream' ? { streams: [] } : { subtitles: [] }; }
    return send(res, 200, remember(key, out));
  }
  return send(res, 404, { error: 'not found' });
}

if (require.main === module) {
  http.createServer((rq, rs) => handler(rq, rs).catch((e) => send(rs, 500, { error: e.message }))).listen(PORT, () => console.log('Anseb on ' + PORT));
}
module.exports = { parseSE, seOk, fuzzyJaccard, stripNoise, durScore, median, histOffset, driftFit, contentStats, contentFactor, fixMojibake, rtlFix, pickRel, pickSubs, platOf, coreToks, timingRank, collectSubs, score, safeFetchUrl, parseSrt, sigOf, timingFit, shiftSrt, runtimeFit, relInfo, fit, rankSubs, unzip, pickSub, decodeText, embeddedSub, parse, buildStreams, toStremio, handler, decodeCfg, safeUrl, parseList };
