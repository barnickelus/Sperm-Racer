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
  const errors = [];
  tab.on('pageerror', e => errors.push(String(e)));
  await tab.goto(`http://localhost:${PORT}/${rel}?mcp=${PORT}&mcpid=${tag}`, { waitUntil: 'load', timeout: 120000 });
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
async function shot(p, { maxWidth = 1000, format = 'jpeg' } = {}) {
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
  inputSchema: { page: pageArg, maxWidth: z.number().int().min(64).max(2048).default(1000), format: z.enum(['jpeg', 'png']).default('jpeg') },
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
  description: 'Pick what the next race_start will race. course: index or (part of) a name. character: an id from race_options. Locked characters are allowed here (it is a test).',
  inputSchema: {
    page: pageArg,
    course: z.union([z.number().int(), z.string()]).optional(),
    character: z.string().optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
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
  },
}, async ({ page, ...a }) => {
  const p = pick(page, 'race.sheet');
  const s = await call(p, 'race.sheet', a, 240000);
  return ok({ type: 'image', data: s.data, mimeType: s.mimeType }, text(`${s.cells} cells · ${s.width}×${s.height}`));
});

tool('race_film', {
  title: 'Film a filmstrip',
  description: 'Render `frames` frames spread over `seconds` of GAME time into one image, so motion can be judged: smoke, cloth, hair, a face changing. still:true keeps the race frozen and lets the racers\' own animation run (idle motion); otherwise the race is driven between frames (autopilot or held keys). cam: photo-camera params {azimuth, elevation, distance, height, along, fov} to follow one racer, or omit for the game\'s chase camera.',
  inputSchema: {
    page: pageArg, racer: z.string().optional(), frames: z.number().int().min(2).max(16).default(8), seconds: z.number().positive().max(60).default(2),
    still: z.boolean().default(false), autopilot: z.boolean().default(true), keys: z.array(z.string()).default([]),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional(),
    cell: z.number().int().min(120).max(600).default(320), columns: z.number().int().min(1).max(8).optional(), title: z.string().optional(),
  },
}, async ({ page, ...a }) => {
  const p = pick(page, 'race.film');
  const s = await call(p, 'race.film', a, 300000);
  return ok({ type: 'image', data: s.data, mimeType: s.mimeType }, text(`${s.frames} frames · ${s.width}×${s.height}`));
});

tool('scene_profile', {
  title: 'Profile render cost',
  description: 'What each racer on the grid costs to draw (visible meshes ≈ draw calls, triangles, materials, textures), the track, and the whole scene. roster:true also builds EVERY character off-screen once and measures it, build time included: the table to keep new characters within budget.',
  inputSchema: { page: pageArg, roster: z.boolean().default(false) },
  annotations: { readOnlyHint: true },
}, async ({ page, roster }) => ok(text(await call(pick(page, 'race.profile'), 'race.profile', { roster }, 180000))));

tool('race_palette', {
  title: 'Analyse a racer\'s colours',
  description: 'Which of a racer\'s parts blend into each other on screen. Renders the frame and an ID pass from the same camera, then reports each part\'s share of the racer\'s pixels and mean on-screen colour, and the closest-coloured pairs by CIE ΔE (under ~10 reads as the same colour at racing distance). cam: photo-camera params, or omit for the current view.',
  inputSchema: { page: pageArg, racer: z.string().optional(), minShare: z.number().min(0).max(0.5).default(0.02),
    cam: z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() }).optional() },
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
  return ok({ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, text(`${p.id} · whole page`));
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

tool('race_fx', {
  title: 'Hold an effect up',
  description: 'Hold a racing effect up on your kart so it can be looked at or filmed: slipstream (0..1, the wind lines of a rival\'s tow). null hands it back to the race.',
  inputSchema: { page: pageArg, slipstream: z.number().min(0).max(1).nullable().optional() },
}, async ({ page, ...a }) => ok(text(await call(pick(page, 'race.fx'), 'race.fx', a))));

const frameZ = z.object({ azimuth: z.number().optional(), elevation: z.number().optional(), distance: z.number().optional(), height: z.number().optional(), along: z.number().optional(), fov: z.number().optional() });
tool('race_record', {
  title: 'Film a shot',
  description: 'Film a shot at an exact frame rate, however slow the machine: the game is stepped 1/fps of GAME time per frame (racing on autopilot, held keys, or still: frozen race, live animation), the camera placed for each frame (the chase cam, or a photo camera eased from one framing to another over the shot: azimuth relative to the racer\'s heading, elevation, distance, height, along its body, fov), and every frame written to disk as a JPEG. encode:true also makes an MP4 with ffmpeg. Returns the folder, the files, the race clock at both ends, and the shot\'s middle frame to look at. The display loop stands aside while it films, and the canvas renders at pixel ratio 1 (its size is the window\'s: open the scene at 1280x720 for 720p).',
  inputSchema: { page: pageArg, seconds: z.number().positive().max(60), fps: z.number().int().min(12).max(60).default(30), cam: z.object({ mode: z.enum(['chase', 'photo']).default('chase'), who: z.string().optional().describe('racer name or character id (default: you)'), ease: z.enum(['inout', 'linear', 'in', 'out']).default('inout'), from: frameZ.optional(), to: frameZ.optional() }).optional(),
    still: z.boolean().default(false), autopilot: z.boolean().default(true), keys: z.array(z.string()).default([]), quality: z.number().min(0.5).max(1).default(0.9),
    straight: z.boolean().default(false).describe('the filmed racer looks straight ahead (no glancing at rivals): for portraits'),
    dir: z.string().optional().describe('folder for the frames (default mcp/recordings)'), name: z.string().default('shot'), encode: z.boolean().default(false) },
}, async ({ page, seconds, fps, cam, still, autopilot, keys, quality, straight, dir, name, encode }) => {
  const p = pick(page, 'race.rec');
  const out = path.resolve(dir || path.join(here, 'recordings')); fs.mkdirSync(out, { recursive: true });
  const n = Math.max(1, Math.round(seconds * fps)), files = []; let first = null, last = null, mid = null;
  await call(p, 'race.recmode', { on: true });
  try {
    for (let k = 0; k < n; k++) {
      const f = await call(p, 'race.rec', { k, n, fps, cam, still, autopilot, keys, quality, straight }, 120000);
      const file = path.join(out, `${name}_${String(k).padStart(4, '0')}.jpg`); fs.writeFileSync(file, Buffer.from(f.data, 'base64')); files.push(file);
      if (k === 0) first = f.raceTime; last = f.raceTime; if (k === (n >> 1)) mid = f.data;
    }
  } finally { await call(p, 'race.recmode', { on: false }).catch(() => {}); }
  let mp4 = null;
  if (encode) { mp4 = path.join(out, `${name}.mp4`);
    await new Promise((res, rej) => { const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(out, `${name}_%04d.jpg`), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; ff.stderr.on('data', d => { err += d; }); ff.on('error', rej); ff.on('close', c => c === 0 ? res() : rej(new Error('ffmpeg: ' + err.slice(-400)))); }); }
  return ok({ type: 'image', data: mid, mimeType: 'image/jpeg' }, text({ frames: n, fps, dir: out, first: files[0], last: files[files.length - 1], mp4, raceTime: [first, last] }));
});

tool('race_audio', {
  title: 'Record the music',
  description: 'Record the game\'s music (the master bus, with the engine hum muted) for `seconds` of real time and save it as a .webm (opus) file. Starts the audio and the current race\'s music if they are not playing. For a soundtrack under recorded footage.',
  inputSchema: { page: pageArg, seconds: z.number().positive().max(180).default(30), file: z.string() },
}, async ({ page, seconds, file }) => {
  const a = await call(pick(page, 'race.audio'), 'race.audio', { seconds }, (seconds + 30) * 1000);
  const f = path.resolve(file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(a.data, 'base64'));
  return ok(text({ file: f, bytes: fs.statSync(f).size, seconds, style: a.style, beat: a.beat }));
});

tool('race_regress', {
  title: 'Visual regression of a character',
  description: 'Render a character\'s reference sheet (studio-lit, on a plain backdrop) and compare it with its saved golden sheet, <character>-<kind>.jpg in mcp/baselines/ (or SPERM_RACER_MCP_BASELINES): the share of pixels changed beyond a tolerance, the mean change, a heat map of where, and pass/fail against `threshold`. No golden yet, or update:true, saves this render as the golden. Run after engine changes to catch characters that changed by accident.',
  inputSchema: { page: pageArg, character: z.string().optional().describe('character id (default: your racer)'), kind: z.enum(['turnaround', 'expressions']).default('turnaround'),
    update: z.boolean().default(false), threshold: z.number().min(0).max(1).default(0.04) },
}, async ({ page, character, kind, update, threshold }) => {
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
    return ok({ type: 'image', data: s.data, mimeType: s.mimeType }, text({ saved: path.relative(ROOT, file), note: update ? 'golden updated' : 'no golden yet: this render is now the golden' })); }
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
  description: 'mode "chase" is the game\'s own camera. mode "photo" orbits one racer relative to its heading — azimuth 0 = in front looking at its face, 90 = its left side, 180 = behind — at elevation degrees and distance units (a racer\'s head is ~7 units long), aimed `height` above its origin. Use photo to inspect a character model; then scene_screenshot.',
  inputSchema: {
    page: pageArg,
    mode: z.enum(['chase', 'photo']).default('photo'),
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
