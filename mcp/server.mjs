#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   SPERM-RACER MCP SERVER

   Lets Claude (or any MCP client) PLAYTEST the game: set up a race, start it,
   drive it — in fixed simulation steps, so a software-rendered page that only
   draws a few frames a second still races at true speed — read the standings,
   photograph any racer up close, and look at the page's console.

     Claude ──stdio/MCP──▶ this process ──WebSocket──▶ index.html?mcp
                                         └─ HTTP: serves the repo to that page

   The page is either a headless Chromium this server launches (scene_open),
   or a real tab: http://localhost:7458/index.html?mcp (real GPU, real fps).
   Bound to 127.0.0.1; the WebSocket only accepts pages served from localhost.

   Same core as Tesserae-Engine's mcp/server.mjs (HTTP + bridge + headless);
   the tools below are the game's own.

   Env: SPERM_RACER_MCP_PORT (default 7458; 0 = any free port)
        SPERM_RACER_MCP_ORIGINS (extra allowed page origins), CHROMIUM_PATH (browser for scene_open)
   ══════════════════════════════════════════════════════════════════════════ */

import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.SPERM_RACER_ROOT || path.join(here, '..'));
const BASELINES = path.resolve(process.env.SPERM_RACER_MCP_BASELINES || path.join(here, 'baselines'));   // golden sheets for race_regress (per machine: a GPU and a software renderer draw differently)
const require = createRequire(import.meta.url);
const say = (...a) => process.stderr.write('[sperm-racer-mcp] ' + a.join(' ') + '\n');   // stdout is the MCP channel

/* ── 1. HTTP: serve the repo, so pages load same-origin from localhost ───── */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.hdr': 'application/octet-stream',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.woff2': 'font/woff2' };

const httpServer = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep) || rel.split('/').some(s => s.startsWith('.') && s.length > 1)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

/* ── 2. WebSocket: the bridge pages dial into ─────────────────────────────── */

const extraOrigins = (process.env.SPERM_RACER_MCP_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(origin) {
  if (!origin) return false;
  if (extraOrigins.includes(origin)) return true;
  try { const u = new URL(origin); return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname); }
  catch { return false; }
}

const pages = new Map();       // id -> { id, ws, hello, since, headless, pending: Map }
let nextPage = 1;
const helloWaiters = new Set(); // (page) => boolean  — resolve once a matching page says hello

const wss = new WebSocketServer({ server: httpServer, path: '/bridge',
  verifyClient: ({ origin }) => { const ok = originAllowed(origin); if (!ok) say('refused bridge from origin', origin); return ok; } });

wss.on('connection', (ws) => {
  const page = { id: 'p' + nextPage++, ws, hello: null, since: Date.now(), headless: null, pending: new Map() };
  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(String(buf)); } catch { return; }
    if (msg.type === 'hello') {
      page.hello = msg; pages.set(page.id, page);
      say(`page ${page.id} connected: ${msg.name} (${msg.software ? 'software GL' : msg.gpu})`);
      for (const w of [...helloWaiters]) if (w(page)) helloWaiters.delete(w);
    } else if (msg.type === 'result') {
      const p = page.pending.get(msg.id);
      if (!p) return;
      page.pending.delete(msg.id); clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    }
  });
  ws.on('close', () => {
    pages.delete(page.id);
    for (const p of page.pending.values()) { clearTimeout(p.timer); p.reject(new Error('the page disconnected (closed or reloaded) before answering')); }
    if (page.hello) say(`page ${page.id} disconnected`);
  });
});

function call(page, method, params = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { page.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    page.pending.set(id, { resolve, reject, timer });
    page.ws.send(JSON.stringify({ type: 'call', id, method, params }));
  });
}

/* Which page a tool talks to: the one named, else the newest that has the
   command. A friendly error beats "undefined" when nothing is connected. */
function pick(pageId, needs) {
  if (pageId) {
    const p = pages.get(pageId);
    if (!p) throw new Error(`no page "${pageId}" connected (connected: ${[...pages.keys()].join(', ') || 'none'})`);
    if (needs && !p.hello.commands.includes(needs)) throw new Error(`page ${pageId} (${p.hello.name}) has no "${needs}" command`);
    return p;
  }
  const cands = [...pages.values()].filter(p => !needs || p.hello.commands.includes(needs)).sort((a, b) => b.since - a.since);
  if (!cands.length) throw new Error(pages.size
    ? `no connected page supports "${needs}" (connected: ${[...pages.values()].map(p => `${p.id}=${p.hello.name}`).join(', ')})`
    : `no scene is connected. Call scene_open to launch one headless, or open ${liveUrl('index.html')} in a browser.`);
  return cands[0];
}

let PORT = 0;
const liveUrl = (rel) => `http://localhost:${PORT}/${rel}?mcp=${PORT}`;

/* ── 3. Headless browser, launched on demand ──────────────────────────────── */

let browserP = null;
async function browser() {
  if (browserP) return browserP;
  browserP = (async () => {
    let chromium;
    try { ({ chromium } = await import('playwright')); }
    catch { throw new Error('scene_open needs Playwright: run `npm install` in mcp/ (it is an optional dependency), or open the page in your own browser instead'); }
    const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-background-networking',
      '--autoplay-policy=no-user-gesture-required'];   // audio runs without a click, so the music (and its beat) can be tested
    const exe = process.env.CHROMIUM_PATH || findChromium();
    if (exe) return chromium.launch({ headless: true, executablePath: exe, args });
    /* No known binary: Playwright's own download if there is one, else the
       Chrome already installed on this machine. */
    try { return await chromium.launch({ headless: true, args }); }
    catch (e) {
      try { return await chromium.launch({ headless: true, channel: 'chrome', args }); }
      catch { throw new Error(`no browser to launch: run \`npx playwright install chromium\` in mcp/, install Chrome, or set CHROMIUM_PATH (${String(e.message).split('\n')[0]})`); }
    }
  })();
  browserP.catch(() => { browserP = null; });
  return browserP;
}
/* A preinstalled Playwright Chromium (cloud sandboxes put one in /opt/pw-browsers). */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const cands = [path.join(base, 'chromium')];
  try {
    for (const d of fs.readdirSync(base).filter(d => /^chromium-\d+$/.test(d)).sort().reverse())
      cands.push(path.join(base, d, 'chrome-linux64/chrome'), path.join(base, d, 'chrome-linux/chrome'));
  } catch {}
  return cands.find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
}

const headless = new Map();   // pageId -> { context }

async function openHeadless(rel, width, height) {
  const b = await browser();
  // no-preference: a headless browser can report reduced motion, and the game then draws its animated screens as one still
  const context = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  const tab = await context.newPage();
  const tag = crypto.randomUUID().slice(0, 8);
  const joined = new Promise((resolve, reject) => {
    const to = setTimeout(() => { helloWaiters.delete(w); reject(new Error(`the page loaded but never connected to the bridge within 120s — is ?mcp wired up in ${rel}?`)); }, 120000);
    const w = (page) => { if (page.hello.tag !== tag) return false; clearTimeout(to); resolve(page); return true; };
    helloWaiters.add(w);
  });
  // if the load itself fails first, this promise's later rejection must not go unhandled: that takes the whole server down
  // (it did, opening a page on a machine busy enough that the load took over two minutes)
  joined.catch(() => {});
  const errors = [];
  tab.on('pageerror', e => errors.push(String(e)));
  try { await tab.goto(`http://localhost:${PORT}/${rel}?mcp=${PORT}&mcpid=${tag}`, { waitUntil: 'load', timeout: 120000 }); }
  catch (e) { await context.close().catch(() => {}); throw e; }
  let page;
  try { page = await joined; }
  catch (e) { await context.close(); throw new Error(e.message + (errors.length ? `\npage errors:\n  ${errors.join('\n  ')}` : '')); }
  page.headless = { context, tab };
  headless.set(page.id, page);
  page.ws.on('close', () => headless.delete(page.id));
  return page;
}

/* ── 4. MCP tools ─────────────────────────────────────────────────────────── */

const mcp = new McpServer({ name: 'sperm-racer', version: '0.1.0' }, {
  instructions: `Playtests Sperm-Racer, a browser kart racer, in a live page. Typical loop: scene_open → race_options → race_setup (track, character, difficulty) → race_start (the race then waits, frozen on the grid, for you to drive it) → race_drive in chunks (autopilot or held keys; each call returns what happened: speed, off-road time, laps, spins, places) → scene_screenshot / race_camera to look → race_state. Driving is in fixed simulation steps, so results do not depend on how fast the page renders; a headless page renders in software (a few fps) and its fps means nothing. race_camera mode "photo" orbits one racer for close-ups (e.g. to judge a character's model).`,
});

const pageArg = z.string().optional().describe('Page id from scene_pages. Omit to use the most recently connected page.');
const text = (v) => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) });
const ok = (...content) => ({ content });
const fail = (e) => ({ isError: true, content: [text(String(e && e.message || e))] });
const tool = (name, config, fn) => mcp.registerTool(name, config, async (args) => { try { return await fn(args || {}); } catch (e) { return fail(e); } });

function pageSummary(p) {
  return { page: p.id, name: p.hello.name, url: p.hello.url, mode: p.headless ? 'headless (launched by this server)' : 'live tab',
           gpu: p.hello.gpu, softwareRendering: !!p.hello.software };
}
// Pictures cost the agent that looks at them in proportion to their pixels: tools return them at a working width
// (SPERM_RACER_MCP_IMAGE_MAX, 800 by default; 0 = full size). Files written to disk keep full size.
const IMG_MAX = process.env.SPERM_RACER_MCP_IMAGE_MAX != null ? +process.env.SPERM_RACER_MCP_IMAGE_MAX : 800;
async function fit(p, data, maxWidth) { const w = maxWidth ?? IMG_MAX; if (!w) return data;
  try { return (await call(p, 'img.fit', { data, maxWidth: w })).data; } catch { return data; } }
const maxWidthArg = z.number().int().min(0).max(4096).optional().describe(`width of the returned picture (default ${IMG_MAX}; 0 = full size). Smaller costs less to look at`);
async function shot(p, { maxWidth = IMG_MAX || 1600, format = 'jpeg' } = {}) {
  const s = await call(p, 'scene.screenshot', { maxWidth, format });
  return [{ type: 'image', data: s.data, mimeType: s.mimeType }, text(`${p.id} · ${s.width}×${s.height}${p.hello.software ? ' · software GL' : ''}`)];
}

/* — the page — */

tool('scene_open', {
  title: 'Open the game headless',
  description: 'Launch the game in a headless Chromium (software WebGL) and connect to it. Loading takes a while (a 6 MB page, a course built on a software GPU). Use when no live tab is connected.',
  inputSchema: { width: z.number().int().min(320).max(2560).default(1100), height: z.number().int().min(240).max(1600).default(700) },
  annotations: { openWorldHint: false },
}, async ({ width = 1100, height = 700 }) => {
  const p = await openHeadless('index.html', width, height);
  return ok(text({ opened: pageSummary(p), note: 'Software WebGL: screenshots are accurate, fps is not. Next: race_options.' }));
});

tool('scene_pages', {
  title: 'List connected game pages',
  description: 'Pages connected to the bridge, and the URL a user can open to connect a real-GPU tab.',
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => ok(text({ pages: [...pages.values()].map(pageSummary), connectALiveTab: liveUrl('index.html'), port: PORT })));

tool('scene_close', {
  title: 'Close a headless game page',
  description: 'Close a headless page this server opened (a live tab belongs to the user and is left alone).',
  inputSchema: { page: pageArg },
}, async ({ page }) => {
  const p = pick(page);
  if (!p.headless) throw new Error(`${p.id} is the user's own tab — it can't be closed from here`);
  await p.headless.context.close();
  return ok(text(`closed ${p.id}`));
});

tool('scene_screenshot', {
  title: 'Screenshot the game',
  description: 'What the 3D canvas shows right now (HUD and menus are HTML and are not included).',
  inputSchema: { page: pageArg, maxWidth: z.number().int().min(64).max(2048).default(IMG_MAX || 1600), format: z.enum(['jpeg', 'png']).default('jpeg') },
  annotations: { readOnlyHint: true },
}, async ({ page, maxWidth, format }) => ok(...await shot(pick(page, 'scene.screenshot'), { maxWidth, format })));

tool('scene_stats', {
  title: 'Measure rendering cost',
  description: 'fps, frame-time percentiles, draw calls and triangles per frame, GPU memory objects, programs, object census. If softwareRendering is true, compare draw calls/triangles, not timings.',
  inputSchema: { page: pageArg, sampleMs: z.number().int().min(200).max(10000).default(1500) },
  annotations: { readOnlyHint: true },
}, async ({ page, sampleMs }) => {
  const p = pick(page, 'scene.stats');
  return ok(text({ page: p.id, ...await call(p, 'scene.stats', { sampleMs }, sampleMs + 30000) }));
});

tool('scene_graph', {
  title: 'Read the scene graph',
  description: 'Summarise the Three.js object tree under the scene, or under a named object.',
  inputSchema: { page: pageArg, depth: z.number().int().min(0).max(12).default(3), maxNodes: z.number().int().min(1).max(2000).default(200), root: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async ({ page, depth, maxNodes, root }) => ok(text(await call(pick(page, 'scene.graph'), 'scene.graph', { depth, maxNodes, root }))));

tool('page_logs', {
  title: 'Read the page console',
  description: 'Recent console output and uncaught errors from the game page.',
  inputSchema: { page: pageArg, level: z.enum(['error', 'warn', 'log', 'info']).optional(), clear: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, async ({ page, level, clear }) => ok(text(await call(pick(page, 'page.logs'), 'page.logs', { level, clear }))));

/* — the race — */

tool('race_options', {
  title: 'List courses, characters, difficulties',
  description: 'Every course (index, name, laps, kind), every character (id, name, description, locked) and the difficulties.',
  inputSchema: { page: pageArg }, annotations: { readOnlyHint: true },
}, async ({ page }) => ok(text(await call(pick(page, 'race.options'), 'race.options'))));

tool('race_setup', {
  title: 'Choose course, character, difficulty',
  description: 'Pick what the next race_start will race. course: index or (part of) a name. character: an id from race_options. Locked characters are allowed here (it is a test). seed: make the race repeatable, for before/after comparisons.',
  inputSchema: {
    page: pageArg,
    course: z.union([z.number().int(), z.string()]).optional(),
    character: z.string().optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    seed: z.number().int().nullable().optional().describe('build and run the next race from this seed, so it is the same race twice (scenery, field, AI, effects; a fixed clock). null: random again'),
  },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.setup'), 'race.setup', a))));

tool('race_start', {
  title: 'Start a race',
  description: 'Start a solo race with the current setup. Waits through the 3-second countdown. With manual:true (default) the race then stays frozen on the grid until race_drive steps it; manual:false lets it run in real time (slow motion on a software GPU).',
  inputSchema: { page: pageArg, manual: z.boolean().default(true) },
}, async ({ page, manual }) => ok(text(await call(pick(page, 'race.start'), 'race.start', { manual }, 200000))));

tool('race_drive', {
  title: 'Drive the race forward',
  description: 'Advance the race by `seconds` of game time in fixed 1/60 s steps, with your kart either on autopilot (follows the racing line, drifts the bends) or holding the given keys the whole time. Keys: arrowup (gas), arrowdown (brake/reverse), arrowleft, arrowright, shift (drift), " " (fire item), j (tail-whip). Returns what happened over the stretch — distance, speeds, off-road time, laps and lap times, spins, hits, place changes, items — and the standings at the end. untilFinish:true keeps going until you cross the line (capped by seconds). screenshot:true adds an image of the end state.',
  inputSchema: {
    page: pageArg,
    seconds: z.number().positive().max(600).default(5),
    autopilot: z.boolean().default(true),
    keys: z.array(z.string()).default([]).describe('Keys held for the whole stretch (with autopilot:false), or added on top of autopilot (e.g. [" "] to fire as soon as an item arrives).'),
    untilFinish: z.boolean().default(false),
    screenshot: z.boolean().default(false),
  },
}, async ({ page, seconds, autopilot, keys, untilFinish, screenshot }) => {
  const p = pick(page, 'race.drive');
  const r = await call(p, 'race.drive', { seconds, autopilot, keys, untilFinish }, 60000 + seconds * 4000);
  const out = [text(r)];
  if (screenshot) out.push(...await shot(p));
  return ok(...out);
});

tool('race_state', {
  title: 'Read the race',
  description: 'Game state (menu/count/race/done), course, race clock, and every racer: place, lap, progress, speed, position, item, off-road, spinning, boosting, finished/time.',
  inputSchema: { page: pageArg }, annotations: { readOnlyHint: true },
}, async ({ page }) => ok(text(await call(pick(page, 'race.state'), 'race.state'))));

tool('race_realtime', {
  title: 'Let the race run by itself',
  description: 'manual:false hands the race back to the page\'s own clock (it runs in real time, which on a software GPU is slow motion); manual:true freezes it again for race_drive.',
  inputSchema: { page: pageArg, manual: z.boolean() },
}, async ({ page, manual }) => ok(text(await call(pick(page, 'race.manual'), 'race.manual', { manual }))));

tool('race_studio', {
  title: 'Studio backdrop',
  description: 'Show one racer alone on a plain backdrop (the course, the other racers, particles all out of frame), lit by the course\'s own lights or a neutral three-point studio rig. For judging a character model. on:false restores the game.',
  inputSchema: { page: pageArg, on: z.boolean().default(true), racer: z.string().optional(), background: z.string().default('#efe3c8'),
    lighting: z.enum(['course', 'studio']).default('course') },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.studio'), 'race.studio', a))));

tool('race_pose', {
  title: 'Set a racer\'s expression',
  description: 'For a character with an expression rig: list its expressions, or force one (held for `hold` seconds, after which its own reactions take over again). Omit expression to just list them.',
  inputSchema: { page: pageArg, racer: z.string().optional(), expression: z.string().optional(), hold: z.number().min(0).max(600).default(8) },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.pose'), 'race.pose', a))));

tool('race_sheet', {
  title: 'Render a reference sheet',
  description: 'The engine draws a character reference sheet of one racer and returns it as ONE image: kind "turnaround" (8 views round the racer: front, 3/4, side, rear...) or "expressions" (every expression its rig has, close on the face), or your own `cells` [{label, azimuth, elevation, distance, height, along, expression}]. Best inside race_studio. Compare it against concept art to check a model.',
  inputSchema: {
    page: pageArg, racer: z.string().optional(), kind: z.enum(['turnaround', 'expressions']).default('turnaround'),
    cells: z.array(z.object({ label: z.string().optional(), azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(),
      height: z.number().optional(), along: z.number().optional(), fov: z.number().optional(), expression: z.string().optional() })).optional(),
    cell: z.number().int().min(120).max(600).default(300), columns: z.number().int().min(1).max(10).optional(), title: z.string().optional(),
    photo: z.object({ elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), fov: z.number().optional(), along: z.number().optional() }).optional(),
    rest: z.boolean().default(false).describe('draw a fresh build of the character in its rest pose at a fixed heading, not the live racer: the same pixels every time'),
    maxWidth: maxWidthArg,
  },
}, async ({ page, maxWidth, ...a }) => {
  const p = pick(page, 'race.sheet');
  const s = await call(p, 'race.sheet', a, 240000);
  return ok({ type: 'image', data: await fit(p, s.data, maxWidth), mimeType: 'image/jpeg' }, text(`${s.cells} cells · drawn ${s.width}×${s.height}`));
});

tool('race_film', {
  title: 'Film a filmstrip',
  description: 'Render `frames` frames spread over `seconds` of GAME time into one image, so motion can be judged: smoke, cloth, hair, a face changing. still:true keeps the race frozen and lets the racers\' own animation run (idle motion); otherwise the race is driven between frames (autopilot or held keys). cam: photo-camera params {azimuth, elevation, distance, height, along, fov} to follow one racer, or omit for the game\'s chase camera.',
  inputSchema: {
    page: pageArg, racer: z.string().optional(), frames: z.number().int().min(2).max(16).default(8), seconds: z.number().positive().max(60).default(2),
    still: z.boolean().default(false), autopilot: z.boolean().default(true), keys: z.array(z.string()).default([]),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional(),
    cell: z.number().int().min(120).max(600).default(320), columns: z.number().int().min(1).max(8).optional(), title: z.string().optional(),
    maxWidth: maxWidthArg,
  },
}, async ({ page, maxWidth, ...a }) => {
  const p = pick(page, 'race.film');
  const s = await call(p, 'race.film', a, 300000);
  return ok({ type: 'image', data: await fit(p, s.data, maxWidth), mimeType: 'image/jpeg' }, text(`${s.frames} frames · drawn ${s.width}×${s.height}`));
});

tool('scene_profile', {
  title: 'Profile render cost',
  description: 'What each racer on the grid costs to draw (visible meshes ≈ draw calls, triangles, materials, textures), the track, and the whole scene. trackTop lists the course\'s heaviest pieces. roster:true also builds EVERY character off-screen once and measures it, build time included: the table to keep new characters within budget.',
  inputSchema: { page: pageArg, roster: z.boolean().default(false), top: z.number().int().min(1).max(60).default(12).describe('how many of the course\'s heaviest pieces to list (trackTop)'),
    inView: z.boolean().default(false).describe('also count only what the camera draws right now (frustum-tested), by the piece it belongs to') },
  annotations: { readOnlyHint: true },
}, async ({ page, roster, top, inView }) => ok(text(await call(pick(page, 'race.profile'), 'race.profile', { roster, top, inView }, 180000))));

tool('race_palette', {
  title: 'Analyse a racer\'s colours',
  description: 'Which of a racer\'s parts blend into each other on screen. Renders the frame and an ID pass from the same camera, then reports each part\'s share of the racer\'s pixels and mean on-screen colour, and the closest-coloured pairs by CIE ΔE (under ~10 reads as the same colour at racing distance). cam: photo-camera params, or omit for the current view.',
  inputSchema: { page: pageArg, racer: z.string().optional(), minShare: z.number().min(0).max(0.5).default(0.02),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional(),
    vision: z.enum(['normal', 'protan', 'deutan', 'tritan', 'all']).default('normal').describe('also the closest pairs as a colour-blind player sees them (protanopia, deuteranopia, tritanopia; all three)') },
  annotations: { readOnlyHint: true },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.palette'), 'race.palette', a))));

tool('scene_page', {
  title: 'Screenshot the whole page',
  description: 'The whole page as a player sees it (HUD, menus, overlays and the 3D canvas), not just the canvas. Headless pages only (this server owns their browser).',
  inputSchema: { page: pageArg, fullPage: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, async ({ page, fullPage }) => {
  const p = pick(page); if (!p.headless || !p.headless.tab) throw new Error(`${p.id} is a live tab: use scene_screenshot (the canvas) instead`);
  const buf = await p.headless.tab.screenshot({ type: 'jpeg', quality: 82, fullPage });
  return ok({ type: 'image', data: await fit(p, buf.toString('base64')), mimeType: 'image/jpeg' }, text(`${p.id} · whole page`));
});

tool('race_motion', {
  title: 'Measure how fluidly a racer moves',
  description: 'Step the page at 1/60 s (racing on autopilot, or still) and track probes in the racer\'s own space: head, neck turn, tail tip, swaying parts, and any ud.motionProbes. Per probe: travel, RMS speed, acceleration and jerk, and "snaps" (frames of jerk far above the probe\'s median). Low jerk with few snaps reads as fluid; high jerk reads as popping or robotic. Compare a character before and after an animation change. `series:true` adds each probe\'s per-frame speed and the frames its snaps fell on, to find what causes them.',
  inputSchema: { page: pageArg, racer: z.string().optional(), seconds: z.number().positive().max(30).default(3), still: z.boolean().default(false), autopilot: z.boolean().default(true), series: z.boolean().default(false) },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.motion'), 'race.motion', a, 120000))));

tool('race_perf', {
  title: 'Where the frame time goes',
  description: 'Run the game for `seconds` and measure it three ways at once. mode "steps" (default) runs whole frames at a fixed 1/60 s step as fast as the machine allows (draw:false leaves the picture out, to see the JavaScript alone); "realtime" lets the page\'s own clock run it. The three measures: the game\'s frame split into segments (setup, sim, racers, camera, minimap, world animation, particles, render) in ms per frame, with the worst frame, draw calls and triangles; Chrome\'s sampling CPU profiler (top functions by self time, labelled game / three.js / native, and the game functions with the most time including what they call); and its sampling heap profiler (who allocates the most: garbage the collector must clear, which shows up as hitches). Headless pages only. A software GPU makes render and fps slow; the JavaScript costs are real. Restores manual stepping afterwards if the race was manual.',
  inputSchema: { page: pageArg, seconds: z.number().positive().max(60).default(6), mode: z.enum(['steps', 'realtime']).default('steps'), draw: z.boolean().default(true),
    top: z.number().int().min(5).max(60).default(18), cpu: z.boolean().default(true), alloc: z.boolean().default(true),
    shaderChecks: z.boolean().default(false).describe('keep three\'s shader-error checks on while measuring (MCP pages have them on; players don\'t)') },
}, async ({ page, seconds, mode, draw, top, cpu, alloc, shaderChecks }) => {
  const p = pick(page, 'race.perf'); if (!p.headless || !p.headless.tab) throw new Error(`${p.id} is a live tab: race_perf profiles headless pages (open DevTools on a live tab instead)`);
  const st = await call(p, 'race.state'); const wasManual = !!st.manual;
  const cdp = await p.headless.context.newCDPSession(p.headless.tab);
  try {
    if (cpu) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); }
    if (alloc) { await cdp.send('HeapProfiler.enable'); }
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const m0 = await metrics();
    const steps = mode === 'steps';
    if (!steps && st.state === 'race' && wasManual) await call(p, 'race.manual', { manual: false });
    await call(p, 'race.perf', { on: true, autopilot: !steps, shaderChecks });
    if (cpu) await cdp.send('Profiler.start');
    if (alloc) await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    if (steps) await call(p, 'race.frames', { frames: Math.round(seconds * 60), draw }, 600000);
    else await new Promise(r => setTimeout(r, seconds * 1000));
    const prof = cpu ? (await cdp.send('Profiler.stop')).profile : null;
    const heap = alloc ? (await cdp.send('HeapProfiler.stopSampling')).profile : null;
    const m1 = await metrics();
    const frame = await call(p, 'race.perf', { on: false });
    { const n = Math.max(1, frame.frames), d = k => (m1[k] || 0) - (m0[k] || 0);   // the browser's own counters: layout and style work the page caused
      frame.browser = { layoutsPerFrame: +(d('LayoutCount') / n).toFixed(2), layoutMsPerFrame: +(d('LayoutDuration') * 1000 / n).toFixed(3),
        styleRecalcsPerFrame: +(d('RecalcStyleCount') / n).toFixed(2), styleMsPerFrame: +(d('RecalcStyleDuration') * 1000 / n).toFixed(3),
        scriptMsPerFrame: +(d('ScriptDuration') * 1000 / n).toFixed(3), heapMB: +((m1.JSHeapUsedSize || 0) / 1048576).toFixed(1) }; }
    if (!steps && st.state === 'race' && wasManual) await call(p, 'race.manual', { manual: true });
    const where = (cf) => { const u = cf.url || ''; const file = u ? u.split('/').pop().split('?')[0] : ''; const kind = /three/.test(file) ? 'three' : /index\.html/.test(file) ? 'game' : file ? file : 'native';
      return { key: `${cf.functionName || '(anonymous)'} ${file}:${cf.lineNumber + 1}`, name: cf.functionName || '(anonymous)', at: file ? `${file}:${cf.lineNumber + 1}` : '', kind }; };
    const out = { seconds, mode, draw, frame };
    if (prof) {
      const byId = new Map(prof.nodes.map(n => [n.id, n])), parent = new Map();
      for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
      const self = new Map(), incl = new Map(), kinds = {}; let total = 0;
      for (let i = 0; i < prof.samples.length; i++) {
        const dt = (prof.timeDeltas[i] || 0) / 1000; total += dt; const n = byId.get(prof.samples[i]); const w = where(n.callFrame);
        const s0 = self.get(w.key) || { ...w, ms: 0 }; s0.ms += dt; self.set(w.key, s0); kinds[w.kind] = (kinds[w.kind] || 0) + dt;
        const seen = new Set(); for (let id = n.id; id != null; id = parent.get(id)) { const x = where(byId.get(id).callFrame); if (x.kind !== 'game' || seen.has(x.key)) continue; seen.add(x.key);
          const t0 = incl.get(x.key) || { ...x, ms: 0 }; t0.ms += dt; incl.set(x.key, t0); } }
      const fmt = (a) => a.sort((x, y) => y.ms - x.ms).slice(0, top).map(x => ({ fn: x.name, at: x.at, kind: x.kind, ms: +x.ms.toFixed(1), share: +(x.ms / total).toFixed(3) }));
      out.cpu = { sampledMs: +total.toFixed(0), byKind: Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, +(v / total).toFixed(3)]).sort((a, b) => b[1] - a[1])),
        selfTop: fmt([...self.values()].filter(x => !/^\((idle|program)\)$/.test(x.name))), gameInclusive: fmt([...incl.values()]) };
    }
    if (heap) {
      const agg = new Map(); let bytes = 0;
      const walk = (n) => { const w = where(n.callFrame); if (n.selfSize) { const a = agg.get(w.key) || { ...w, b: 0 }; a.b += n.selfSize; agg.set(w.key, a); bytes += n.selfSize; } for (const c of n.children || []) walk(c); };
      walk(heap.head);
      const fr = Math.max(1, frame.frames);
      out.alloc = { sampledMB: +(bytes / 1048576).toFixed(1), perFrameKB: +(bytes / fr / 1024).toFixed(1),
        top: [...agg.values()].sort((a, b) => b.b - a.b).slice(0, top).map(a => ({ fn: a.name, at: a.at, kind: a.kind, kb: Math.round(a.b / 1024), kbPerFrame: +(a.b / fr / 1024).toFixed(2) })) };
    }
    return ok(text(out));
  } finally { await cdp.detach().catch(() => {}); }
});

tool('race_audit', {
  title: 'Find scenery in the wrong place',
  description: 'Audit the built course: every piece of scenery (each instance of an instanced batch on its own) is boxed in world space and checked for pushing into the racing corridor (its footprint inside the road\'s half-width of the centreline, at road height, so overhead gantries don\'t count) and for overlapping another piece by at least `overlap` of the smaller one\'s volume. Each finding gives where it is along the lap (`at`, in laps, for race_warp), its offset from the centreline, how far into the road it reaches, its world x/z and what it is. Ground, road, sky and water (bigger than `maxSize`) are skipped. The course\'s own driving surfaces near a boost or jump pad are listed apart as `surfaces`. Overlaps between pieces of the same kind (a clump of palms) are skipped unless `sameKind:true`; the rest can still be intended, so use the list to look, not as a verdict.',
  inputSchema: { page: pageArg, maxSize: z.number().positive().default(160), minSize: z.number().min(0).default(1.5), margin: z.number().default(1), overlap: z.number().min(0.01).max(1).default(0.3), top: z.number().int().min(1).max(200).default(40), sameKind: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.audit'), 'race.audit', a, 120000))));

tool('race_features', {
  title: 'Where the moments are',
  description: 'Where this course\'s set pieces sit along the lap (fractions; of a lap on a lap course): jump ramps, boost strips, item boxes, smashable clusters and hazards. Use with race_warp (`jump`/`pad`, or `to`) to set up a shot just before one.',
  inputSchema: { page: pageArg },
  annotations: { readOnlyHint: true },
}, async ({ page }) => ok(text(await call(pick(page, 'race.features'), 'race.features'))));

tool('race_surface', {
  title: 'What reads as plastic',
  description: 'An ID pass by MATERIAL over the frame: for one racer (scope racer), the course (course) or everything in view (scene), each material\'s share of the pixels and what it is made of — texture (relief: bump/normal/roughness map; colour: a map; vertex colours; none), how glossy (roughness, clear coat, Phong shininess), lit or unlit, whether its instances vary. A surface with no texture of any kind and a smooth finish is flagged plastic; totals give the plastic, untextured, flat (unlit) and textured shares. A deliberate flat art style (vector, felt) reads as flat or untextured by design: judge by the course\'s style.',
  inputSchema: { page: pageArg, scope: z.enum(['racer', 'course', 'scene']).default('racer'), racer: z.string().optional(), top: z.number().int().min(1).max(40).default(12),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional() },
  annotations: { readOnlyHint: true },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.surface'), 'race.surface', a, 120000))));

tool('race_alias', {
  title: 'Where the picture will shimmer',
  description: 'Find detail finer than a pixel — what crawls and sparkles in motion (a still frame hides it). The frame is drawn at 1x and at `factor`x (box-filtered back down); the difference, per pixel, is aliasing. Returns the mean, the share of hot pixels, the materials responsible (by an ID pass) and a heat map. Fine textures without mipmaps, thin geometry and high-contrast edges top the list.',
  inputSchema: { page: pageArg, scope: z.enum(['scene', 'course', 'racers']).default('scene'), racer: z.string().optional(), factor: z.number().int().min(2).max(4).default(3), top: z.number().int().min(1).max(30).default(10),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional() },
  annotations: { readOnlyHint: true },
}, async ({ page, ...a }) => { const p = pick(page, 'race.alias'); const r = await call(p, 'race.alias', a, 240000); const { heat, ...rest } = r;
  return ok({ type: 'image', data: await fit(p, heat, 640), mimeType: 'image/jpeg' }, text(rest)); });

tool('race_season', {
  title: 'Run a season of races',
  description: 'Balance and trouble spots from many headless races. AI rivals do not use character stats (only the player\'s character does), so each character in turn races as you — on the autopilot, the same driver for all — against the same five rivals on the same seeded course. Per character: finishing time against the course median (vsMedianPct: negative is faster), place, wins. Per course: hotspots — where on the lap every racer spun, got stuck, hit something solid or ran off the road (at: laps, for race_warp). Leaves the game on the menu: race_start after. Long: about 5-30 s of real time per race.',
  inputSchema: { page: pageArg, characters: z.array(z.string()).optional().describe('character ids (default: the whole roster)'), courses: z.array(z.union([z.number().int(), z.string()])).optional().describe('default: the current course'),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'), seed: z.number().int().default(7), rivals: z.array(z.string()).optional().describe('five rival character ids'),
    maxSeconds: z.number().positive().default(300), bins: z.number().int().min(10).max(100).default(40) },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.season'), 'race.season', a, 3600000))));

tool('race_soak', {
  title: 'Memory soak test',
  description: 'Race the courses round and round (start, drive a few seconds, next; every race seeded, so each round is the same race), forcing a garbage collection between races, and record what the page holds each time: GPU geometries and textures, shader programs, scene objects, the JS heap. Growth on the same course from the second round to the last is a leak (the first round also fills caches).',
  inputSchema: { page: pageArg, courses: z.array(z.union([z.number().int(), z.string()])).min(1), rounds: z.number().int().min(2).max(6).default(3), seconds: z.number().min(0.5).max(20).default(3) },
}, async ({ page, courses, rounds, seconds }) => {
  const p = pick(page, 'race.mem');
  const cdp = p.headless ? await p.headless.context.newCDPSession(p.headless.tab) : null;
  const rows = [];
  try {
    for (let k = 0; k < rounds; k++) for (const c of courses) {
      await call(p, 'race.setup', { course: c, seed: 99 }); await call(p, 'race.start', { manual: true }, 200000); await call(p, 'race.drive', { seconds }, 300000);   // (seeded: every round the same race, so a difference is the page's)
      if (cdp) await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const m = await call(p, 'race.mem', {}); rows.push({ round: k + 1, ...m, course: m.course && m.course.name || String(c) });
    }
  } finally { if (cdp) await cdp.detach().catch(() => {}); await call(p, 'race.setup', { seed: null }).catch(() => {}); }
  // from the second round on: the first one also fills the caches (textures, shaders, models built once per session)
  const growth = {}; for (const c of new Set(rows.map(r => r.course))) { const rs = rows.filter(r => r.course === c), a = rs[Math.min(1, rs.length - 2)], b = rs[rs.length - 1];
    growth[c] = { geometries: b.geometries - a.geometries, textures: b.textures - a.textures, programs: b.programs - a.programs, sceneObjects: b.sceneObjects - a.sceneObjects, heapMB: a.heapMB != null ? +(b.heapMB - a.heapMB).toFixed(1) : null }; }
  const leak = Object.values(growth).some(g => g.geometries > 0 || g.textures > 0 || g.sceneObjects > 20 || (g.heapMB || 0) > 15);
  return ok(text({ leak, growth, rows }));
});

tool('race_hud', {
  title: 'Can the HUD be read here',
  description: 'For every visible piece of race HUD text: its colour against what is behind it — its glass panel blended over the frame as drawn — as a WCAG contrast ratio (median and worst tenth of the sampled points), the size and weight, whether it has an outline or shadow, and ok against the WCAG minimum (4.5:1, or 3:1 for large text). Run it in a race, on each course.',
  inputSchema: { page: pageArg },
  annotations: { readOnlyHint: true },
}, async ({ page }) => ok(text(await call(pick(page, 'race.hud'), 'race.hud', {}))));

tool('race_warp', {
  title: 'Jump the race to a point',
  description: 'Jump the running race to any point, so a late part of a course, or a late hour of its light, can be looked at without driving there. `to` is in laps on a lap course (2.5 = halfway round the third lap) and a fraction of the way to the egg on a point-to-point course. You are placed there with the field `spread` units apart (you at the back by default, so the chase camera sees the pack ahead), at speed, with lap counts and checkpoints set as if driven. Eased course state, such as Ophelia\'s hour, snaps to the new point.',
  inputSchema: { page: pageArg, to: z.number().min(0).default(0), jump: z.number().int().min(0).optional().describe('instead of `to`: put you `lead` units short of this jump ramp (race_features lists them)'),
    pad: z.number().int().min(0).optional().describe('instead of `to`: `lead` units short of this boost pad'), lead: z.number().min(0).default(160), spread: z.number().min(0).max(80).default(26), you: z.union([z.enum(['back', 'front', 'order']), z.number().int().min(1)]).default('back').describe('where you sit in the field: at the back (the chase camera sees the pack ahead), the front, in race order, or a place (2 = right behind the leader, to stage a pass)') },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.warp'), 'race.warp', a))));

tool('race_framing', {
  title: 'Is the racer well shot?',
  description: 'Check a shot without looking at it. From the current camera, or a photo camera given as `cam`, it renders two flat passes: the racer alone (its whole silhouette) and the racer against the scene\'s depth (what is actually seen). It reports how much of the frame the racer fills, how much of it is hidden behind solid scenery or rivals (glows, sprites, haze and water don\'t count), its box and centre in the frame (0..1, from the bottom left), whether the frame edge cuts it, and ok/why against minFill, maxFill and maxHidden.',
  inputSchema: { page: pageArg, racer: z.string().optional(), cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional(),
    minFill: z.number().min(0).max(1).default(0.02), maxFill: z.number().min(0).max(1).default(0.6), maxHidden: z.number().min(0).max(1).default(0.25) },
  annotations: { readOnlyHint: true },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.framing'), 'race.framing', a))));

tool('race_fx', {
  title: 'Hold an effect up',
  description: 'Hold a racing effect up on your kart so it can be looked at or filmed: slipstream (0..1, the wind lines of a rival\'s tow). null hands it back to the race.',
  inputSchema: { page: pageArg, slipstream: z.number().min(0).max(1).nullable().optional(), edenLive: z.boolean().optional().describe('Eve: the garden\'s living light (the racers\' wake and the egg\'s call) on or off, for an A/B look'),
    flowBody: z.boolean().optional().describe('the flow body (one skin on one spine) on or off for the racers built from the next race_start on: false builds them on the stock ball-and-tube body, for an A/B') },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.fx'), 'race.fx', a))));

const frameZ = z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() });
tool('race_record', {
  title: 'Film a shot',
  description: 'cam.mode \'fp\' films through the game\'s own first-person lens (the racer\'s eyes). Film a shot at an exact frame rate, however slow the machine: the game is stepped 1/fps of GAME time per frame (racing on autopilot, held keys, or still: frozen race, live animation), the camera placed for each frame (the chase cam, or a photo camera eased from one framing to another over the shot: azimuth relative to the racer\'s heading, elevation, distance, height, along its body, fov), and every frame written to disk as a JPEG. encode:true also makes an MP4 with ffmpeg. Returns the folder, the files, the race clock at both ends, the shot\'s MOMENTS (boosts, take-offs and landings, slingshots, overtakes, spins, the finish, by frame; every frame\'s telemetry is written to <name>.events.json) and the middle frame to look at. The display loop stands aside while it films, and the canvas renders at pixel ratio 1 (its size is the window\'s: open the scene at 1280x720 for 720p).',
  inputSchema: { page: pageArg, seconds: z.number().positive().max(60), fps: z.number().int().min(12).max(60).default(30), cam: z.object({ mode: z.enum(['chase', 'photo', 'fp']).default('chase'), who: z.string().optional().describe('racer name or character id (default: you)'), ease: z.enum(['inout', 'linear', 'in', 'out']).default('inout'), from: frameZ.optional(), to: frameZ.optional() }).optional(),
    still: z.boolean().default(false), autopilot: z.boolean().default(true), keys: z.array(z.string()).default([]), quality: z.number().min(0.5).max(1).default(0.9),
    straight: z.boolean().default(false).describe('the filmed racer looks straight ahead (no glancing at rivals): for portraits'),
    dir: z.string().optional().describe('folder for the frames (default mcp/recordings)'), name: z.string().default('shot'), encode: z.boolean().default(false),
    qa: z.boolean().default(false).describe('check every frame: the subject\'s framing (hidden, out of frame, tiny, cut by the edge) and the exposure (blown out, crushed, sudden flashes); the result lists the frame ranges with a problem') },
}, async ({ page, seconds, fps, cam, still, autopilot, keys, quality, straight, dir, name, encode, qa }) => {
  const p = pick(page, 'race.rec');
  const out = path.resolve(dir || path.join(here, 'recordings')); fs.mkdirSync(out, { recursive: true });
  const n = Math.max(1, Math.round(seconds * fps)), files = [], evs = []; let first = null, last = null, mid = null;
  await call(p, 'race.recmode', { on: true });
  try {
    for (let k = 0; k < n; k++) {
      const f = await call(p, 'race.rec', { k, n, fps, cam, still, autopilot, keys, quality, straight, qa }, 120000);
      const file = path.join(out, `${name}_${String(k).padStart(4, '0')}.jpg`); fs.writeFileSync(file, Buffer.from(f.data, 'base64')); files.push(file);
      if (k === 0) first = f.raceTime; last = f.raceTime; if (k === (n >> 1)) mid = f.data; evs.push({ k, t: f.raceTime, ...(f.ev || {}), ...(f.qa ? { qa: f.qa } : {}) });
    }
  } finally { await call(p, 'race.recmode', { on: false }).catch(() => {}); }
  let mp4 = null;
  if (encode) { mp4 = path.join(out, `${name}.mp4`);
    await new Promise((res, rej) => { const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(out, `${name}_%04d.jpg`), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; ff.stderr.on('data', d => { err += d; }); ff.on('error', rej); ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg: ' + err.slice(-400)))); }); }
  // the moments in the shot: when boosts lit, the kart left the ground, a slingshot fired, places changed, a spin, the line
  fs.writeFileSync(path.join(out, `${name}.events.json`), JSON.stringify(evs));
  const moments = []; for (let i = 1; i < evs.length; i++) { const a = evs[i - 1], b = evs[i];
    if (b.boost && !a.boost) moments.push({ k: b.k, what: 'boost' }); if (b.air && !a.air) moments.push({ k: b.k, what: 'airborne' }); if (!b.air && a.air) moments.push({ k: b.k, what: 'landing' });
    if (b.slings > a.slings) moments.push({ k: b.k, what: 'slingshot' }); if (b.place < a.place) moments.push({ k: b.k, what: `overtake → P${b.place}` }); if (b.place > a.place) moments.push({ k: b.k, what: `passed → P${b.place}` });
    if (b.spin && !a.spin) moments.push({ k: b.k, what: 'spin' }); if (b.finished && !a.finished) moments.push({ k: b.k, what: 'finish' }); if (b.mega && !a.mega) moments.push({ k: b.k, what: 'mega' }); }
  // qa: runs of frames with a problem, so a shot can be trimmed or re-shot without looking at every frame
  let problems = null;
  if (qa) { const tests = [['subject out of frame', e => e.qa.fill === 0], ['subject mostly hidden', e => e.qa.fill > 0 && e.qa.hidden > 0.4], ['subject tiny', e => e.qa.fill > 0 && e.qa.fill < 0.006],
      ['subject cut by the frame edge', e => e.qa.cut], ['blown out', e => e.qa.blown > 0.25], ['crushed', e => e.qa.crushed > 0.45]];
    problems = [];
    for (const [what, f] of tests) { let a = -1; for (let i = 0; i <= evs.length; i++) { const bad = i < evs.length && evs[i].qa && f(evs[i]); if (bad && a < 0) a = i; if (!bad && a >= 0) { if (i - a >= 2) problems.push({ what, from: a, to: i - 1, frames: i - a }); a = -1; } } }
    for (let i = 1; i < evs.length; i++) { const d = evs[i].qa && evs[i - 1].qa ? evs[i].qa.mean - evs[i - 1].qa.mean : 0; if (Math.abs(d) > 70) problems.push({ what: d > 0 ? 'flash' : 'sudden dark', from: i, to: i, frames: 1 }); }
    problems.sort((a, b) => a.from - b.from); }
  return ok({ type: 'image', data: await fit(p, mid), mimeType: 'image/jpeg' }, text({ moments, ...(problems ? { problems, clean: !problems.length } : {}), frames: n, fps, dir: out, first: files[0], last: files[files.length - 1], mp4, raceTime: [first, last] }));
});

tool('race_audio', {
  title: 'Record the music',
  description: 'Record the game\'s music (the master bus, with the engine hum muted) for `seconds` of real time and save it as a .webm (opus) file, and ANALYSE it (you cannot hear it): loudness in dBFS, peak, clipped samples, short-term loudness range, gaps, the low/high balance, and how many onsets land on the game\'s beat clock. sfxProbe:true fires every sound effect over the music and reports how many dB each sits above it. Starts the audio and the current race\'s music if they are not playing.',
  inputSchema: { page: pageArg, seconds: z.number().positive().max(180).default(30), file: z.string(),
    style: z.string().optional().describe('a music style to play instead: a character id (their home station, e.g. king) or a station id'), bar: z.number().int().min(0).optional().describe('with style: the bar of a produced record to start from'),
    analyze: z.boolean().default(true).describe('measure what the speakers get: loudness, peak and clipping, loudness range, gaps, low/high balance, and whether the sound lands on the game\'s beat clock'),
    sfxProbe: z.boolean().default(false).describe('fire every sound effect once over the music (and the engine at speed) and report how far each sits above the music') },
}, async ({ page, seconds, file, style, bar, analyze, sfxProbe }) => {
  const a = await call(pick(page, 'race.audio'), 'race.audio', { seconds, style, bar, analyze, sfxProbe }, (seconds + 40) * 1000);
  const f = path.resolve(file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(a.data, 'base64'));
  return ok(text({ file: f, bytes: fs.statSync(f).size, seconds, style: a.style, beat: a.beat, firstDownbeat: a.firstDownbeat, startBar: a.startBar, section: a.section, ...(a.analysis ? { analysis: a.analysis } : {}) }));
});

/* course snapshots: a seeded race, warped to fixed points of the lap, the chase camera's frame at each, against goldens */
async function courseSnapshots(p, course, points, update, threshold) {
  const slug = String(course).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await call(p, 'race.setup', { course, seed: 4242 });
  try {
    await call(p, 'race.start', { manual: true }, 200000);
    const out = [], images = [];
    for (let k = 0; k < points.length; k++) {
      await call(p, 'race.warp', { to: points[k], you: 'back', spread: 26 });
      await call(p, 'race.drive', { seconds: 0.4 }, 120000);
      await call(p, 'race.camera', { mode: 'chase' });
      const fr = await call(p, 'race.frame', { racers: false });
      const file = path.join(BASELINES, `course-${slug}-${k}.jpg`);
      fs.mkdirSync(BASELINES, { recursive: true });
      if (update || !fs.existsSync(file)) { fs.writeFileSync(file, Buffer.from(fr.data, 'base64')); out.push({ at: points[k], saved: path.relative(ROOT, file) }); images.push(fr.data); continue; }
      const d = await call(p, 'race.diff', { a: fs.readFileSync(file).toString('base64'), b: fr.data });
      out.push({ at: points[k], golden: path.relative(ROOT, file), changed: d.changed, meanDelta: d.meanDelta, pass: d.changed <= threshold }); images.push(d.heat);
    }
    return { out, images };
  } finally { await call(p, 'race.setup', { seed: null }).catch(() => {}); }
}

tool('race_regress', {
  title: 'Visual regression of a character',
  description: 'Render a character\'s reference sheet (studio-lit, on a plain backdrop) and compare it with its saved golden sheet, <character>-<kind>.jpg in mcp/baselines/ (or SPERM_RACER_MCP_BASELINES): the share of pixels changed beyond a tolerance, the mean change, a heat map of where, and pass/fail against `threshold`. No golden yet, or update:true, saves this render as the golden. Run after engine changes to catch characters that changed by accident.',
  inputSchema: { page: pageArg, character: z.string().optional().describe('character id (default: your racer)'), kind: z.enum(['turnaround', 'expressions']).default('turnaround'),
    update: z.boolean().default(false), threshold: z.number().min(0).max(1).default(0.04),
    course: z.union([z.number().int(), z.string()]).optional().describe('instead of a character: snapshot this COURSE — a seeded race warped to fixed points of the lap, the chase camera\'s frame at each, against its goldens (course-<name>-<k>.jpg)'),
    points: z.array(z.number().min(0)).default([0.12, 0.45, 0.78]).describe('with course: where on the lap (laps; a fraction of the way on a point-to-point)') },
}, async ({ page, character, kind, update, threshold, course, points }) => {
  if (course != null) { const p = pick(page, 'race.frame'); const r = await courseSnapshots(p, course, points, update, Math.max(threshold, 0.1));
    const imgs = []; for (const d of r.images.slice(0, 3)) imgs.push({ type: 'image', data: await fit(p, d, 480), mimeType: 'image/jpeg' });
    return ok(...imgs, text({ course, points: r.out, pass: r.out.every(x => x.pass !== false) })); }
  const p = pick(page, 'race.sheet');
  const st = await call(p, 'race.state');
  const me = st.standings.find(r => r.you); const id = character || (me && me.character);
  if (character && me && me.character !== character) throw new Error(`race_setup the character "${character}" and race_start first (your racer is ${me && me.character})`);
  await call(p, 'race.studio', { on: true, lighting: 'studio', background: '#e8e4dc' });
  let s;
  try { s = await call(p, 'race.sheet', { kind, cell: 220, rest: true, photo: kind === 'turnaround' ? { distance: 30, along: -3, height: 3.6, elevation: 8 } : {} }, 240000); }
  finally { await call(p, 'race.studio', { on: false }); }
  const dir = BASELINES, file = path.join(dir, `${id}-${kind}.jpg`);
  fs.mkdirSync(dir, { recursive: true });
  if (update || !fs.existsSync(file)) { fs.writeFileSync(file, Buffer.from(s.data, 'base64'));
    return ok({ type: 'image', data: await fit(p, s.data), mimeType: 'image/jpeg' }, text({ saved: path.relative(ROOT, file), note: update ? 'golden updated' : 'no golden yet: this render is now the golden' })); }
  const d = await call(p, 'race.diff', { a: fs.readFileSync(file).toString('base64'), b: s.data });
  const pass = d.changed <= threshold;
  return ok({ type: 'image', data: d.heat, mimeType: 'image/jpeg' }, text({ character: id, kind, golden: path.relative(ROOT, file), changed: d.changed, meanDelta: d.meanDelta, threshold, pass }));
});

tool('race_select', {
  title: 'Show the character-select stage',
  description: 'Leave any race for the character-select screen with this character on its 3D stage (the game\'s own studio lighting and idle animation), and screenshot it. Good for judging a character the way players first see it.',
  inputSchema: { page: pageArg, character: z.string().optional(), screenshot: z.boolean().default(true) },
}, async ({ page, character, screenshot }) => {
  const p = pick(page, 'race.select');
  const out = [text(await call(p, 'race.select', { character }, 60000))];
  if (screenshot) out.push(...await shot(p));
  return ok(...out);
});

tool('race_camera', {
  title: 'Point the camera',
  description: 'mode "free" puts the camera at a world point `from`, looking at `at` (or round a hazard by index). mode "chase" is the game\'s own camera. mode "photo" orbits one racer relative to its heading — azimuth 0 = in front looking at its face, 90 = its left side, 180 = behind — at elevation degrees and distance units (a racer\'s head is ~7 units long), aimed `height` above its origin. Use photo to inspect a character model; then scene_screenshot.',
  inputSchema: {
    page: pageArg,
    mode: z.enum(['chase', 'photo', 'free']).default('photo'),
    from: z.array(z.number()).length(3).optional().describe('free: the camera\'s world position'), at: z.array(z.number()).length(3).optional().describe('free: the world point it looks at'),
    hazard: z.number().int().min(0).optional().describe('free: frame this hazard (crab, pill...) by index, from azimuth/elevation/distance around it'),
    racer: z.string().optional().describe('Racer name (from race_state); default your kart'),
    azimuth: z.number().default(30), elevation: z.number().min(-80).max(85).default(12),
    distance: z.number().positive().default(22), height: z.number().default(3.5), fov: z.number().min(10).max(100).default(35),
    along: z.number().default(0).describe('Aim this far along the racer\'s body from its origin: positive toward the nose, negative down the tail (the midpiece is around -9).'),
    screenshot: z.boolean().default(true),
  },
}, async ({ page, screenshot, ...c }) => {
  const p = pick(page, 'race.camera');
  const r = await call(p, 'race.camera', c);
  const out = [text(r)];
  if (screenshot) out.push(...await shot(p));
  return ok(...out);
});


/* ── 5. Start ─────────────────────────────────────────────────────────────── */

async function listen(port, tries) {
  for (let i = 0; i < tries; i++) {
    const want = port === 0 ? 0 : port + i;
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { httpServer.off('listening', onOk); reject(e); };
        const onOk = () => { httpServer.off('error', onErr); resolve(); };
        httpServer.once('error', onErr); httpServer.once('listening', onOk);
        httpServer.listen(want, '127.0.0.1');
      });
      return httpServer.address().port;
    } catch (e) { if (e.code !== 'EADDRINUSE' || port === 0) throw e; }
  }
  throw new Error(`ports ${port}–${port + tries - 1} are all in use`);
}

const envPort = process.env.SPERM_RACER_MCP_PORT;
PORT = await listen(envPort === undefined || envPort === '' ? 7458 : Number(envPort), 10);
say(`serving ${ROOT} on http://localhost:${PORT} — open ${liveUrl('index.html')} to connect a live tab`);

await mcp.connect(new StdioServerTransport());

async function shutdown() {
  try { if (browserP) await (await browserP).close(); } catch {}
  process.exit(0);
}
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
