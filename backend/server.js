'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const WEB = path.join(__dirname, 'public');
const UA = 'Stremify/7.0';

const LANGS = {
  ar: { name: 'Arabic',   flag: '🇸🇦', iso3: 'ara', words: ['arabic','ara','arab','عربي','عربية'] },
  en: { name: 'English',  flag: '🇬🇧', iso3: 'eng', words: ['english','eng','ang'] },
  de: { name: 'German',   flag: '🇩🇪', iso3: 'ger', words: ['german','ger','deu','deutsch'] },
  fr: { name: 'French',   flag: '🇫🇷', iso3: 'fre', words: ['french','fre','fra','français','vf','vff'] },
  es: { name: 'Spanish',  flag: '🇪🇸', iso3: 'spa', words: ['spanish','spa','español','castellano'] },
  tr: { name: 'Turkish',  flag: '🇹🇷', iso3: 'tur', words: ['turkish','tur','türkçe'] },
  hi: { name: 'Hindi',    flag: '🇮🇳', iso3: 'hin', words: ['hindi','hin'] },
  ja: { name: 'Japanese', flag: '🇯🇵', iso3: 'jpn', words: ['japanese','jpn','日本語'] },
};

const DEBRID = {
  realdebrid: 'RD+',
  alldebrid:  'AD+',
  premiumize: 'PM+',
  torbox:     'TB+',
  debridlink: 'DL+',
};

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const b64u = (s) => Buffer.from(s).toString('base64url');
const ub64 = (s) => Buffer.from(s, 'base64url').toString('utf8');

function safeUrl(u) {
  try {
    const x = new URL(String(u).trim().replace(/^stremio:\/\//i, 'https://'));
    if (x.protocol !== 'https:') return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/i.test(x.hostname)) return null;
    return x.origin + x.pathname.replace(/\/(manifest\.json|configure)\/?$/i, '').replace(/\/$/, '');
  } catch (e) { return null; }
}

async function req(url, opt, ms) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms || 9000);
  try {
    const r = await fetch(url, Object.assign({}, opt, {
      headers: Object.assign({ 'User-Agent': UA }, opt && opt.headers),
      signal: ctrl.signal,
    }));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally { clearTimeout(id); }
}
const getJSON = async (url, headers, ms) => (await req(url, { headers }, ms)).json();

const cache = new Map();
const remember = (k, v, max) => { cache.set(k, { t: Date.now(), v }); if (cache.size > (max || 500)) cache.delete(cache.keys().next().value); return v; };
const recall = (k, ttl) => { const h = cache.get(k); return h && Date.now() - h.t < (ttl || 600000) ? h.v : null; };

function parseRelease(text) {
  const t = String(text || '').toLowerCase();
  const has = (re) => re.test(t);
  const res = has(/2160p|\b4k\b|\buhd\b/) ? 2160
    : has(/1080p|1080i/) ? 1080
    : has(/720p/) ? 720
    : has(/480p|576p/) ? 480 : 0;
  const source = has(/remux/) ? 'BluRay REMUX'
    : has(/blu-?ray|bdrip|brrip/) ? 'BluRay'
    : has(/web-?dl/) ? 'WEB-DL'
    : has(/web-?rip|\bweb\b/) ? 'WEBRip'
    : has(/hdtv/) ? 'HDTV'
    : has(/dvd-?rip|\bdvd\b/) ? 'DVD'
    : has(/\bcam\b|telesync|hdcam/) ? 'CAM' : '';
  const codec = has(/x265|hevc|h\.?265/) ? 'HEVC'
    : has(/x264|h\.?264|avc/) ? 'x264'
    : has(/av1/) ? 'AV1' : '';
  const hdr = has(/dolby.?vision|\bdv\b/) ? 'DV'
    : has(/hdr10\+/) ? 'HDR10+'
    : has(/hdr/) ? 'HDR' : '';
  const audio = has(/atmos/) ? 'Atmos'
    : has(/truehd/) ? 'TrueHD'
    : has(/dts-?(hd|x)/) ? 'DTS-HD'
    : has(/ddp|dd\+|e-?ac-?3/) ? 'DD+'
    : has(/\bdd\b|ac-?3/) ? 'DD'
    : has(/aac/) ? 'AAC' : '';
  const ch = (t.match(/\b(7\.1|5\.1|2\.0)\b/) || [])[1] || '';
  const sz = t.match(/(\d+(?:\.\d+)?)\s*(gb|mb)/i);
  const size = sz ? (sz[2].toLowerCase() === 'gb' ? +sz[1] : +sz[1] / 1024) : 0;
  const se = t.match(/(?:👤|seeders?:?)\s*(\d+)/i);
  const seeders = se ? +se[1] : 0;
  const grp = (t.match(/-([a-z0-9]+)(?:\[|$|\s)/i) || [])[1] || '';
  const year = (t.match(/\b(19|20)\d{2}\b/) || [''])[0];
  return { res, source, codec, hdr, audio, ch, size, seeders, group: grp, year };
}

// ==================================================================
// EXACT embeddedSub from Anseb v3.1
// Returns 'yes' | 'maybe' | 'no'
// ==================================================================
function embeddedSub(text, lang) {
  const L = LANGS[lang] || LANGS.ar;
  const t = String(text).toLowerCase();
  if (L.flags.some((f) => text.includes(f)) ||
      new RegExp('(?:^|[^a-z])(?:' + L.words.join('|') + ')(?:[^a-z]|$)', 'i').test(t)) return 'yes';
  return /multi[ ._-]?subs?|msubs?|\bmulti\b|dual/.test(t) ? 'maybe' : 'no';
}

async function fetchAllStreams(sources, type, id, debrid, key) {
  const tasks = sources.map(async (src) => {
    let url = `${src.url}/stream/${type}/${encodeURIComponent(id)}.json`;
    if (debrid && key && /torrentio/i.test(src.url) && !/debridoptions=/.test(src.url) && !/debrid=/i.test(src.url)) {
      url = `${src.url}/${debrid}=${encodeURIComponent(key)}/stream/${type}/${encodeURIComponent(id)}.json`;
    }
    try {
      const d = await getJSON(url, {}, 10000);
      return (d.streams || []).map((s) => ({ ...s, _source: src.name }));
    } catch (e) { return []; }
  });
  const lists = await Promise.all(tasks);
  return lists.flat();
}

function buildStreams(rawList, opts) {
  const { lang, debrid } = opts;
  const L = LANGS[lang];
  const badge = debrid && DEBRID[debrid] ? DEBRID[debrid] : '';
  const seen = new Set();
  const out = [];

  for (const s of rawList) {
    const text = [s.name, s.title, s.description].filter(Boolean).join('\n');
    const info = parseRelease(text + ' ' + (s.behaviorHints?.filename || ''));
    const emb = embeddedSub(text, lang);

    const key = (s._source || '') + '|' + (s.infoHash || s.url || '') + '|' + (s.fileIdx ?? '');
    if (seen.has(key)) continue;
    seen.add(key);

    const fn = s.behaviorHints?.filename || '';
    const titleSrc = fn || (text.split('\n')[0] || '');
    const title = titleSrc
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[._]+/g, ' ')
      .replace(/\b(2160p|1080p|720p|480p|WEB[- ]?DL|WEB[- ]?Rip|BluRay|REMUX|HEVC|x264|x265|HDR|DV)\b.*$/i, '')
      .trim() || 'Unknown';

    const resLabel = info.res === 2160 ? '2160p' : info.res ? info.res + 'p' : '';
    const head = [s._source || 'Source', resLabel].filter(Boolean).join(' ');
    const badgeSuffix = badge ? ` [${badge}]` : '';

    const l2 = `📁 ${title}${info.year ? ` (${info.year})` : ''}`;

    const q3 = [];
    if (info.source) q3.push(`🎥 ${info.source}`);
    if (info.codec)  q3.push(`🎞️ ${info.codec}`);
    if (info.group)  q3.push(`🏷️ ${info.group}`);

    const q4 = [];
    if (info.hdr)   q4.push(`📺 ${info.hdr}`);
    if (info.audio) q4.push(`🎧 ${info.audio}`);
    if (info.ch)    q4.push(`🔊 ${info.ch}`);

    const q5 = [];
    if (info.size)    q5.push(`📦 ${info.size.toFixed(1)} GB`);
    if (info.seeders) q5.push(`👤 ${info.seeders}`);

    const flag = (emb === 'yes' || emb === 'maybe') ? L.flag : '';
    const l6 = flag ? `🌐 ${flag}` : '';

    const name = head + badgeSuffix;
    const descLines = [l2];
    if (q3.length) descLines.push(q3.join(' '));
    if (q4.length) descLines.push(q4.join(' '));
    if (q5.length) descLines.push(q5.join(' '));
    if (l6)        descLines.push(l6);

    const o = {
      name,
      description: descLines.join('\n'),
      behaviorHints: { bingeGroup: 'stremify-' + (s._source || '') + '-' + info.res },
    };

    if (s.url) o.url = s.url;
    else if (s.infoHash) {
      o.infoHash = s.infoHash;
      if (s.fileIdx != null) o.fileIdx = s.fileIdx;
      if (s.sources) o.sources = s.sources;
    } else continue;

    out.push(o);
  }
  return out;
}

function encodeConfig(cfg) { return b64u(JSON.stringify(cfg)); }
function decodeConfig(tok) {
  try { return JSON.parse(ub64(tok)); } catch (e) { return {}; }
}

function buildManifest() {
  return {
    id: 'com.stremify.addon',
    version: '7.0.0',
    name: 'Stremify',
    description: 'Multi-source stream addon that flags embedded subtitles for your preferred language.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  }, headers));
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function serveStatic(res, rel) {
  const f = path.join(WEB, rel);
  if (!f.startsWith(WEB)) return send(res, 404, { error: 'not found' });
  fs.readFile(f, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    const ext = path.extname(f).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(data);
  });
}

async function handler(rq, res) {
  const u = new URL(rq.url, 'http://x');
  const pathname = u.pathname;

  if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
  if (pathname.startsWith('/public/')) return serveStatic(res, pathname.slice('/public/'.length));

  if (pathname === '/manifest.json') return send(res, 200, buildManifest());

  const m1 = pathname.match(/^\/c\/([\w-]+)\/manifest\.json$/);
  if (m1) return send(res, 200, buildManifest());

  const m2 = pathname.match(/^\/c\/([\w-]+)\/stream\/(movie|series)\/([^/]+)\.json$/);
  if (m2) {
    const cfg = decodeConfig(m2[1]);
    const lang = LANGS[cfg.lang] ? cfg.lang : 'en';
    const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
    const debrid = DEBRID[cfg.debrid] ? cfg.debrid : '';
    const key = cfg.key || '';
    const type = m2[2];
    const id = decodeURIComponent(m2[3]);

    if (!sources.length) return send(res, 200, { streams: [] });

    const cacheKey = sha([m2[1], type, id].join('|'));
    const cached = recall(cacheKey, 5 * 60 * 1000);
    if (cached) return send(res, 200, cached);

    try {
      const raw = await fetchAllStreams(sources, type, id, debrid, key);
      const streams = buildStreams(raw, { lang, debrid });
      const out = { streams };
      remember(cacheKey, out);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 200, { streams: [] });
    }
  }

  return send(res, 404, { error: 'not found' });
}

if (require.main === module) {
  http.createServer((rq, rs) => handler(rq, rs).catch((e) => send(rs, 500, { error: e.message })))
    .listen(PORT, () => console.log('Stremify on ' + PORT));
}
module.exports = { handler, LANGS, DEBRID, embeddedSub, buildStreams, encodeConfig, decodeConfig };
