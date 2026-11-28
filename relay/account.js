/* Optional accounts for the Race Wars relay.
 *
 * The game is a static page on another origin, so a session cannot be an httpOnly
 * cookie the browser will send to the Worker. A magic link is single-use and lives
 * 15 minutes. Clicking it creates a long-lived session token. The Worker stores only
 * the token's hash and redirects the browser to the game with the raw token in the
 * URL hash. The page keeps that token in localStorage and sends it as
 * Authorization: Bearer. Guest play never calls these routes.
 *
 * Ghosts are one D1 row per course, not a column on the progress row. D1 rejects a
 * row around 2 MB, and a ghost is the only large value. Each ghost is capped at
 * 500 KB, under that limit with room for the other columns. Players have a handful
 * of course ghosts, so a separate table is enough and R2 is not required.
 */

export const MAGIC_TTL = 15 * 60 * 1000;
export const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
export const RATE_WINDOW = 60 * 60 * 1000;
export const RATE_EMAIL = 5;
export const RATE_IP = 20;
export const GHOST_MAX = 500000;
export const BODY_MAX = 1500000;
export const DEFAULT_GAME_URL = 'https://barnickelus.github.io/Sperm-Racer/index.html';
export const DEFAULT_FROM = 'Race Wars <onboarding@resend.dev>';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-max-age': '86400',
};

const COURSE_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}(?:~r\d{1,3})?$/;
const ID_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;
const CUP_KEY = /^c\d{1,3}$/;
const EMAIL_KEY = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

export function emptyProgress() {
  return { unlocks: [], podiums: 0, cups: {}, runs: {}, bests: {}, ghosts: {}, racer: '', track: '', diff: '' };
}

export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return '';
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_KEY.test(email)) return '';
  return email;
}

export function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function num(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n < 1e7 ? n : null;
}

function betterCup(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const pa = +a.place || 99, pb = +b.place || 99;
  if (pa !== pb) return pa < pb ? a : b;
  const ea = +a.eggs || 0, eb = +b.eggs || 0;
  if (ea !== eb) return ea > eb ? a : b;
  return (+a.pts || 0) >= (+b.pts || 0) ? a : b;
}

function betterRun(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ia = +a.idx || 0, ib = +b.idx || 0;
  if (ia !== ib) return ia > ib ? a : b;
  return (+a.t || 0) >= (+b.t || 0) ? a : b;
}

function cleanIdList(list) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(list)) return out;
  for (const id of list) {
    if (typeof id !== 'string' || !ID_KEY.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 300) break;
  }
  return out;
}

function cleanCup(id, raw) {
  if (!CUP_KEY.test(id) || !raw || typeof raw !== 'object') return null;
  const place = +raw.place;
  if (!Number.isInteger(place) || place < 1 || place > 12) return null;
  const eggs = +raw.eggs, pts = +raw.pts;
  if (!Number.isFinite(eggs) || !Number.isFinite(pts) || eggs < 0 || pts < 0 || eggs > 100 || pts > 10000) return null;
  const diff = raw.diff === 'easy' || raw.diff === 'medium' || raw.diff === 'hard' ? raw.diff : 'medium';
  return { eggs: eggs | 0, pts: pts | 0, place, diff };
}

function cleanRun(id, raw) {
  if (!CUP_KEY.test(id) || !raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.courses) || !Array.isArray(raw.lineup) || raw.lineup.length !== 6) return null;
  if (raw.courses.length < 1 || raw.courses.length > 25) return null;
  if (!raw.courses.every(n => typeof n === 'string' && COURSE_KEY.test(n))) return null;
  if (!raw.lineup.every(n => typeof n === 'string' && ID_KEY.test(n))) return null;
  const idx = +raw.idx;
  if (!Number.isInteger(idx) || idx < 0 || idx > raw.courses.length) return null;
  const nums = a => Array.isArray(a) && a.length === 6 && a.every(n => Number.isFinite(+n) && +n >= 0 && +n < 100000);
  if (!nums(raw.pts) || !nums(raw.eggs)) return null;
  const diff = raw.diff === 'easy' || raw.diff === 'medium' || raw.diff === 'hard' ? raw.diff : null;
  if (!diff) return null;
  const name = typeof raw.name === 'string' ? raw.name.slice(0, 80) : '';
  const last = Array.isArray(raw.last) && raw.last.length === 6 && raw.last.every(n => Number.isInteger(+n) && +n >= 0 && +n <= 12)
    ? raw.last.map(n => +n) : null;
  return {
    v: 1, id, name, courses: raw.courses.slice(), idx, lineup: raw.lineup.slice(),
    pts: raw.pts.map(n => +n), eggs: raw.eggs.map(n => +n), last, diff, t: num(raw.t) || 0,
  };
}

function cleanGhost(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = num(raw.t);
  if (t == null || typeof raw.d !== 'string' || raw.d.length < 2 || raw.d.length > GHOST_MAX) return null;
  if (raw.d[0] !== 'r' && raw.d[0] !== 'z') return null;
  const ty = typeof raw.ty === 'string' && ID_KEY.test(raw.ty) ? raw.ty : 'guido';
  const c = typeof raw.c === 'string' && COURSE_KEY.test(raw.c) ? raw.c : '';
  const n = typeof raw.n === 'string' ? raw.n.slice(0, 24) : 'You';
  const hz = num(raw.hz) || 5;
  const cr = Number.isInteger(+raw.cr) && +raw.cr >= 0 && +raw.cr < 100 ? +raw.cr : 0;
  const at = num(raw.at) || 0;
  return { v: 1, n, ty, c, t, hz, cr, at, d: raw.d };
}

/* A progress document as the client and the database both understand it.
   ghosts is course -> ghost object (with d) or omitted. */
export function sanitizeProgress(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = emptyProgress();
  out.unlocks = cleanIdList(src.unlocks);
  const pod = +src.podiums;
  out.podiums = Number.isInteger(pod) && pod > 0 ? Math.min(pod, 1000000) : 0;
  if (src.cups && typeof src.cups === 'object') {
    for (const [id, cup] of Object.entries(src.cups)) {
      const c = cleanCup(id, cup);
      if (c) out.cups[id] = c;
      if (Object.keys(out.cups).length >= 40) break;
    }
  }
  if (src.runs && typeof src.runs === 'object') {
    for (const [id, run] of Object.entries(src.runs)) {
      const r = cleanRun(id, run);
      if (r) out.runs[id] = r;
      if (Object.keys(out.runs).length >= 40) break;
    }
  }
  if (src.bests && typeof src.bests === 'object') {
    for (const [k, v] of Object.entries(src.bests)) {
      if (!COURSE_KEY.test(k)) continue;
      const t = num(v);
      if (t == null) continue;
      out.bests[k] = t;
      if (Object.keys(out.bests).length >= 80) break;
    }
  }
  if (src.ghosts && typeof src.ghosts === 'object') {
    for (const [k, v] of Object.entries(src.ghosts)) {
      if (!COURSE_KEY.test(k)) continue;
      const g = cleanGhost(v);
      if (!g) continue;
      out.ghosts[k] = g;
      if (Object.keys(out.ghosts).length >= 80) break;
    }
  }
  if (typeof src.racer === 'string' && ID_KEY.test(src.racer)) out.racer = src.racer;
  if (typeof src.track === 'string' && /^\d{1,4}$/.test(src.track)) out.track = String(+src.track);
  if (src.diff === 'easy' || src.diff === 'medium' || src.diff === 'hard') out.diff = src.diff;
  return out;
}

/* Union of two progress documents. A device that is signed in sends its local
   copy; the stored copy is the other side. Unlocks and cup records combine.
   The faster time for a course wins, and only a ghost whose time is that time
   is kept. A non-empty local pick wins, so the device you are holding stays
   on the racer you just chose. */
export function mergeProgress(local, remote) {
  const a = local || emptyProgress();
  const b = remote || emptyProgress();
  const unlocks = cleanIdList([...(a.unlocks || []), ...(b.unlocks || [])]);
  const podiums = Math.max(+a.podiums || 0, +b.podiums || 0);
  const cups = {};
  for (const id of new Set([...Object.keys(a.cups || {}), ...Object.keys(b.cups || {})])) {
    const cup = betterCup(a.cups && a.cups[id], b.cups && b.cups[id]);
    if (cup) cups[id] = cup;
  }
  const runs = {};
  for (const id of new Set([...Object.keys(a.runs || {}), ...Object.keys(b.runs || {})])) {
    const run = betterRun(a.runs && a.runs[id], b.runs && b.runs[id]);
    if (run) runs[id] = run;
  }
  const bests = {};
  const ghosts = {};
  const keys = new Set([
    ...Object.keys(a.bests || {}), ...Object.keys(b.bests || {}),
    ...Object.keys(a.ghosts || {}), ...Object.keys(b.ghosts || {}),
  ]);
  for (const k of keys) {
    if (!COURSE_KEY.test(k)) continue;
    const ag = a.ghosts && a.ghosts[k], bg = b.ghosts && b.ghosts[k];
    const at = num(a.bests && a.bests[k]);
    const bt = num(b.bests && b.bests[k]);
    const agt = ag && num(ag.t);
    const bgt = bg && num(bg.t);
    const ac = at != null ? at : agt;
    const bc = bt != null ? bt : bgt;
    if (ac == null && bc == null) continue;
    const takeA = bc == null || (ac != null && ac <= bc);
    const time = takeA ? ac : bc;
    bests[k] = time;
    const g = takeA ? ag : bg;
    if (g && typeof g.d === 'string' && g.d.length <= GHOST_MAX && num(g.t) != null && Math.abs(g.t - time) < 0.02) ghosts[k] = g;
  }
  return sanitizeProgress({
    unlocks, podiums, cups, runs, bests, ghosts,
    racer: a.racer || b.racer || '',
    track: a.track || b.track || '',
    diff: a.diff || b.diff || '',
  });
}

export function allowedNext(gameUrl, next) {
  const fallback = String(gameUrl || DEFAULT_GAME_URL).split('#')[0].split('?')[0];
  if (!next || typeof next !== 'string') return fallback;
  let u, g;
  try { u = new URL(next); g = new URL(fallback); }
  catch { return fallback; }
  if (u.username || u.password || u.hash || (u.protocol !== 'http:' && u.protocol !== 'https:')) return fallback;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  const same = u.origin === g.origin && (u.pathname === g.pathname || u.pathname.replace(/\/index\.html$/, '/') === g.pathname.replace(/\/index\.html$/, '/'));
  if (!local && !same) return fallback;
  return u.origin + u.pathname;
}

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra },
  });
}

function clientIp(req) {
  const h = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '';
  return h.split(',')[0].trim().slice(0, 80) || 'unknown';
}

async function dbRun(db, sql, args) {
  const res = await db.prepare(sql).bind(...args).run();
  const changes = res && res.meta && res.meta.changes != null ? res.meta.changes : 0;
  return changes | 0;
}
async function dbFirst(db, sql, args) {
  const row = await db.prepare(sql).bind(...args).first();
  return row || null;
}
async function dbAll(db, sql, args) {
  const res = await db.prepare(sql).bind(...args).all();
  return (res && res.results) || [];
}

async function limited(db, bucket, now, max) {
  const row = await dbFirst(db, 'SELECT window_start, count FROM rate_limits WHERE bucket = ?', [bucket]);
  let count = 1, start = now;
  if (row && now - row.window_start < RATE_WINDOW) { count = row.count + 1; start = row.window_start; }
  await dbRun(db, `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?)
    ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`, [bucket, start, count]);
  return count > max;
}

async function bearer(db, req, now) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(h);
  if (!m) return null;
  const hash = await sha256(m[1]);
  const row = await dbFirst(db, 'SELECT user_id, email, expires_at FROM sessions WHERE token_hash = ?', [hash]);
  if (!row || row.expires_at <= now) return null;
  return { userId: row.user_id, email: row.email, token: m[1] };
}

async function loadProgress(db, userId) {
  const row = await dbFirst(db, 'SELECT unlocks, podiums, cups, cup_runs, bests, racer, track, diff FROM progress WHERE user_id = ?', [userId]);
  const ghosts = await dbAll(db, 'SELECT course, time FROM ghosts WHERE user_id = ?', [userId]);
  const ghostTimes = {};
  for (const g of ghosts) ghostTimes[g.course] = g.time;
  let parsed = emptyProgress();
  if (row) {
    try {
      parsed = sanitizeProgress({
        unlocks: JSON.parse(row.unlocks || '[]'),
        podiums: row.podiums,
        cups: JSON.parse(row.cups || '{}'),
        runs: JSON.parse(row.cup_runs || '{}'),
        bests: JSON.parse(row.bests || '{}'),
        racer: row.racer, track: row.track, diff: row.diff,
      });
    } catch { parsed = emptyProgress(); }
  }
  return { progress: parsed, ghostTimes };
}

function publicProgress(progress, ghostTimes) {
  return {
    unlocks: progress.unlocks, podiums: progress.podiums, cups: progress.cups, runs: progress.runs,
    bests: progress.bests, ghosts: ghostTimes, racer: progress.racer, track: progress.track, diff: progress.diff,
  };
}

async function saveProgress(db, userId, merged, incomingGhosts, now) {
  await dbRun(db, `INSERT INTO progress (user_id, unlocks, podiums, cups, cup_runs, bests, racer, track, diff, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET unlocks = excluded.unlocks, podiums = excluded.podiums, cups = excluded.cups,
      cup_runs = excluded.cup_runs, bests = excluded.bests, racer = excluded.racer, track = excluded.track,
      diff = excluded.diff, updated_at = excluded.updated_at`, [
    userId, JSON.stringify(merged.unlocks), merged.podiums, JSON.stringify(merged.cups), JSON.stringify(merged.runs),
    JSON.stringify(merged.bests), merged.racer, merged.track, merged.diff, now,
  ]);
  const existing = await dbAll(db, 'SELECT course, time FROM ghosts WHERE user_id = ?', [userId]);
  const have = {};
  for (const g of existing) have[g.course] = g.time;
  const ghostTimes = {};
  const courses = new Set([...Object.keys(merged.bests), ...Object.keys(have)]);
  for (const course of courses) {
    const time = merged.bests[course];
    const uploaded = incomingGhosts[course];
    const uploadedOk = uploaded && Math.abs(uploaded.t - time) < 0.02;
    if (time == null) {
      if (have[course] != null) await dbRun(db, 'DELETE FROM ghosts WHERE user_id = ? AND course = ?', [userId, course]);
      continue;
    }
    if (uploadedOk) {
      await dbRun(db, `INSERT INTO ghosts (user_id, course, time, payload, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, course) DO UPDATE SET time = excluded.time, payload = excluded.payload, updated_at = excluded.updated_at`,
        [userId, course, time, JSON.stringify(uploaded), now]);
      ghostTimes[course] = time;
    } else if (have[course] != null && Math.abs(have[course] - time) < 0.02) {
      ghostTimes[course] = have[course];
    } else if (have[course] != null) {
      await dbRun(db, 'DELETE FROM ghosts WHERE user_id = ? AND course = ?', [userId, course]);
    }
  }
  return ghostTimes;
}

async function sendMail(env, email, link) {
  const from = env.FROM_EMAIL || DEFAULT_FROM;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: [email],
      subject: 'Your Race Wars sign-in link',
      text: 'Tap this link to save your Race Wars progress on this device. It works once and expires in 15 minutes.\n\n' + link + '\n\nIf you did not ask for this, you can ignore it.',
      html: '<p>Tap this link to save your Race Wars progress on this device. It works once and expires in 15 minutes.</p><p><a href="' + link.replace(/"/g, '%22') + '">Sign in to Race Wars</a></p><p>If you did not ask for this, you can ignore it.</p>',
    }),
  });
  return res.ok;
}

function page(status, text) {
  return new Response('<!DOCTYPE html><meta charset="utf-8"><title>Race Wars</title><body style="font:16px/1.5 sans-serif;background:#0E0806;color:#F3E6C8;padding:48px"><p>' + text + '</p></body>', {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS },
  });
}

export async function handleAccount(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== '/auth/request' && path !== '/auth/verify' && path !== '/auth/me' && path !== '/auth/logout' && path !== '/progress' && path !== '/progress/ghost') return null;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!env.DB) return json(503, { ok: false, error: 'progress saving is not set up yet' });
  const now = Date.now();
  try {
    if (path === '/auth/request' && req.method === 'POST') return requestLink(req, env, now);
    if (path === '/auth/verify' && req.method === 'GET') return verifyLink(req, env, url, now);
    if (path === '/auth/me' && req.method === 'GET') return me(req, env, now);
    if (path === '/auth/logout' && req.method === 'POST') return logout(req, env, now);
    if (path === '/progress' && req.method === 'GET') return getProgress(req, env, now);
    if (path === '/progress' && req.method === 'PUT') return putProgress(req, env, now);
    if (path === '/progress/ghost' && req.method === 'GET') return getGhost(req, env, url, now);
    return json(405, { ok: false, error: 'method not allowed' });
  } catch (e) {
    return json(500, { ok: false, error: 'progress saving failed' });
  }
}

async function requestLink(req, env, now) {
  let body = null;
  try { body = await req.json(); } catch { body = null; }
  const email = normalizeEmail(body && body.email);
  if (!email) return json(400, { ok: false, error: 'enter a valid email address' });
  const db = env.DB;
  await dbRun(db, 'DELETE FROM magic_links WHERE expires_at < ? OR used_at IS NOT NULL', [now - 24 * 60 * 60 * 1000]);
  if (await limited(db, 'em:' + email, now, RATE_EMAIL) || await limited(db, 'ip:' + clientIp(req), now, RATE_IP)) {
    return json(429, { ok: false, error: 'too many sign-in emails. try again in an hour' });
  }
  if (!env.RESEND_API_KEY) return json(503, { ok: false, error: 'sign-in email is not set up yet' });
  const token = randomToken();
  const hash = await sha256(token);
  await dbRun(db, 'INSERT INTO magic_links (token_hash, email, expires_at, used_at) VALUES (?, ?, ?, NULL)', [hash, email, now + MAGIC_TTL]);
  const next = allowedNext(env.GAME_URL, body && body.next);
  const link = new URL(req.url).origin + '/auth/verify?token=' + encodeURIComponent(token) + '&next=' + encodeURIComponent(next);
  const sent = await sendMail(env, email, link);
  if (!sent) {
    await dbRun(db, 'DELETE FROM magic_links WHERE token_hash = ?', [hash]);
    return json(502, { ok: false, error: 'the sign-in email could not be sent' });
  }
  return json(200, { ok: true });
}

async function verifyLink(req, env, url, now) {
  const token = url.searchParams.get('token') || '';
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return page(400, 'This sign-in link is not valid. Go back to Race Wars and ask for a new one.');
  const hash = await sha256(token);
  const changes = await dbRun(env.DB, 'UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', [now, hash, now]);
  if (!changes) return page(400, 'This sign-in link has expired or was already used. Go back to Race Wars and ask for a new one.');
  const row = await dbFirst(env.DB, 'SELECT email FROM magic_links WHERE token_hash = ?', [hash]);
  if (!row) return page(400, 'This sign-in link is not valid. Go back to Race Wars and ask for a new one.');
  const email = row.email;
  let user = await dbFirst(env.DB, 'SELECT id FROM users WHERE email = ?', [email]);
  if (!user) {
    const id = crypto.randomUUID();
    await dbRun(env.DB, 'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)', [id, email, now]);
    user = { id };
  }
  const session = randomToken();
  const sessionHash = await sha256(session);
  await dbRun(env.DB, 'INSERT INTO sessions (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [sessionHash, user.id, email, now, now + SESSION_TTL]);
  const next = allowedNext(env.GAME_URL, url.searchParams.get('next'));
  return new Response(null, { status: 302, headers: { location: next + '#session=' + session, 'cache-control': 'no-store', ...CORS } });
}

async function me(req, env, now) {
  const who = await bearer(env.DB, req, now);
  if (!who) return json(401, { ok: false, error: 'sign in again' });
  return json(200, { ok: true, email: who.email });
}

async function logout(req, env, now) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(h);
  if (m) await dbRun(env.DB, 'DELETE FROM sessions WHERE token_hash = ?', [await sha256(m[1])]);
  return json(200, { ok: true });
}

async function getProgress(req, env, now) {
  const who = await bearer(env.DB, req, now);
  if (!who) return json(401, { ok: false, error: 'sign in again' });
  const { progress, ghostTimes } = await loadProgress(env.DB, who.userId);
  return json(200, { ok: true, email: who.email, progress: publicProgress(progress, ghostTimes) });
}

async function putProgress(req, env, now) {
  const who = await bearer(env.DB, req, now);
  if (!who) return json(401, { ok: false, error: 'sign in again' });
  const len = +(req.headers.get('content-length') || 0);
  if (len > BODY_MAX) return json(413, { ok: false, error: 'that save is too large' });
  const text = await req.text();
  if (text.length > BODY_MAX) return json(413, { ok: false, error: 'that save is too large' });
  let body = null;
  try { body = JSON.parse(text); } catch { return json(400, { ok: false, error: 'progress was not valid' }); }
  const incoming = sanitizeProgress(body);
  const { progress: stored } = await loadProgress(env.DB, who.userId);
  const merged = mergeProgress(incoming, stored);
  // A stored ghost stays in its own row when its time is still the best.
  // An uploaded ghost replaces it only when that upload is the best time.
  const ghostTimesOut = await saveProgress(env.DB, who.userId, merged, incoming.ghosts, now);
  return json(200, { ok: true, progress: publicProgress(merged, ghostTimesOut) });
}

async function getGhost(req, env, url, now) {
  const who = await bearer(env.DB, req, now);
  if (!who) return json(401, { ok: false, error: 'sign in again' });
  const course = url.searchParams.get('course') || '';
  if (!COURSE_KEY.test(course)) return json(400, { ok: false, error: 'unknown course' });
  const row = await dbFirst(env.DB, 'SELECT payload FROM ghosts WHERE user_id = ? AND course = ?', [who.userId, course]);
  if (!row) return json(404, { ok: false, error: 'no ghost for that course' });
  let ghost = null;
  try { ghost = JSON.parse(row.payload); } catch { return json(404, { ok: false, error: 'no ghost for that course' }); }
  return json(200, { ok: true, course, ghost });
}
