// End-to-end check for the Sperm-Racer MCP server: spawns server.mjs over stdio as Claude Code would, opens the
// game headless through it, and plays: options, setup, a race started and driven in fixed steps on autopilot and
// on held keys, the standings, a photo of Tex Calloway, his parts in the scene graph, the select stage. Also
// proves the page stays inert without ?mcp and that a foreign origin can't attach. Later checks cover the character
// tools: sheets, film, profile, palette, motion (Guido Tony against his Fluid copy) and visual regression.
//
//   cd mcp && npm install && npm test        (SHOTS=<dir> keeps the images)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const GOLDEN = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-golden-'));   // race_regress's goldens, thrown away after

const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(here, '..', 'server.mjs')],
  env: { ...process.env, SPERM_RACER_MCP_PORT: '0', SPERM_RACER_MCP_BASELINES: GOLDEN }, stderr: 'pipe',
});
let serverLog = '';
transport.stderr?.on('data', d => { serverLog += d; });
const client = new Client({ name: 'sperm-racer-e2e', version: '0' });
await client.connect(transport);

const callRaw = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
async function call(name, args) {
  const r = await callRaw(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.content.map(c => c.text).join(' ')}`);
  return r;
}
const json = (r) => JSON.parse(r.content.find(c => c.type === 'text').text);
const image = (r) => r.content.find(c => c.type === 'image');
const save = (img, name) => { if (SHOTS && img) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(img.data, 'base64')); };

const results = [];
// ONLY=lux,flow node test/e2e.mjs runs just the checks whose names contain one of those words (plus the two that bring
// the page up), so a change is checked in a minute, not the whole suite. A check that leans on the one before it
// (race_regress expects the Fluid copy left on the grid) wants that one named too: ONLY=fluid,regress
const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
async function check(name, fn) {
  if (ONLY.length && !/lists every tool|scene_open launches/.test(name) && !ONLY.some(k => name.toLowerCase().includes(k))) return;
  try { await fn(); results.push(true); console.log('  ok  ', name); }
  catch (e) { results.push(false); console.log('  FAIL', name, '\n       ', String(e.stack || e).split('\n').slice(0, 5).join('\n        ')); }
}

let port;

await check('lists every tool', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['page_logs', 'race_ab', 'race_alias', 'race_audio', 'race_audit', 'race_camera', 'race_drive', 'race_features', 'race_film', 'race_framing', 'race_fx', 'race_hud', 'race_light', 'race_motion', 'race_options', 'race_palette', 'race_perf', 'race_pose',
    'race_realtime', 'race_record', 'race_regress', 'race_review', 'race_season', 'race_select', 'race_setup', 'race_sheet', 'race_soak', 'race_start', 'race_state', 'race_studio', 'race_surface', 'race_warp', 'scene_close', 'scene_graph', 'scene_open', 'scene_page',
    'scene_pages', 'scene_profile', 'scene_screenshot', 'scene_stats'].sort());
});

await check('nothing connected: tools say how to connect; a foreign origin is refused', async () => {
  const pg = json(await call('scene_pages'));
  port = pg.port;
  assert.deepEqual(pg.pages, []);
  const r = await callRaw('race_state');
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /no scene is connected\. Call scene_open/);
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'https://evil.example' });
    ws.on('open', () => { ws.close(); resolve('opened'); });
    ws.on('unexpected-response', () => resolve('refused')); ws.on('error', () => resolve('error'));
  });
  assert.notEqual(outcome, 'opened');
});

await check('a page loaded WITHOUT ?mcp never dials the bridge', async () => {
  const { chromium } = await import('playwright');
  const exe = ['/opt/pw-browsers/chromium'].find(fs.existsSync);
  const b = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage();
  await p.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load', timeout: 120000 });
  await p.waitForTimeout(4000);
  assert.deepEqual(json(await call('scene_pages')).pages, []);
  assert.equal(await p.evaluate(() => [...document.querySelectorAll('div')].some(d => /MCP :/.test(d.textContent) && d.children.length === 0)), false, 'no MCP badge');
  await b.close();
});

await check('scene_open launches the game headless and it connects', async () => {
  const r = json(await call('scene_open', { width: 960, height: 600 }));
  assert.equal(r.opened.name, 'sperm-racer');
  assert.equal(r.opened.softwareRendering, true);
});

await check('race_options lists the courses and characters, Tex among them', async () => {
  const o = json(await call('race_options'));
  assert.ok(o.courses.length >= 20, `${o.courses.length} courses`);
  assert.ok(o.courses.some(c => c.name === 'Ophelia'));
  const tex = o.characters.find(c => c.id === 'cowboy');
  assert.equal(tex.name, 'Tex Calloway');
  assert.equal(tex.locked, false);
  assert.deepEqual(o.difficulties, ['easy', 'medium', 'hard']);
});

await check('race_setup validates and applies', async () => {
  const bad = await callRaw('race_setup', { character: 'nobody' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /no character "nobody"/);
  const s = json(await call('race_setup', { course: 'ophel', character: 'cowboy', difficulty: 'medium' }));
  assert.equal(s.course.name, 'Ophelia'); assert.equal(s.character.id, 'cowboy'); assert.equal(s.difficulty, 'medium');
});

await check('race_start puts six karts on the grid, frozen until driven', async () => {
  const r = json(await call('race_start'));
  assert.equal(r.state, 'race'); assert.equal(r.manual, true);
  assert.equal(r.grid.length, 6);
  const me = r.grid.find(g => g.you);
  assert.equal(me.character, 'cowboy');
  assert.equal(me.offRoad, false, 'the grid is on the road');
  const s = json(await call('race_state'));
  assert.equal(s.raceTime, 0, 'nothing moves until race_drive');
});

await check('race_drive on autopilot races in fixed steps: true game time, on the road, moving up', async () => {
  const d = json(await call('race_drive', { seconds: 10 }));
  assert.equal(d.simulated, 10); assert.equal(d.raceTime, 10); assert.equal(d.ended, 'time');
  assert.ok(d.you.distance > 900, `distance ${d.you.distance}`);
  assert.ok(d.you.avgSpeed > 90, `avg ${d.you.avgSpeed}`);
  assert.ok(d.you.offRoadSeconds < 1, `off road ${d.you.offRoadSeconds}s`);
  assert.equal(d.standings.length, 6);
  assert.ok(d.you.total > 0.15, `progress ${d.you.total}`);
});

await check('held keys drive the kart the way a keyboard does (brake from speed)', async () => {
  const before = json(await call('race_state')).standings.find(s => s.you).speed;
  const d = json(await call('race_drive', { seconds: 1.5, autopilot: false, keys: ['arrowdown'] }));
  assert.ok(d.you.speed < before * 0.6, `speed ${before} -> ${d.you.speed}`);
});

await check('race_camera photo frames Tex; the parts are in the scene graph', async () => {
  const r = await call('race_camera', { azimuth: 35, elevation: 14, distance: 26, height: 3 });
  const img = image(r); save(img, 'tex-photo.jpg');
  assert.equal(img.mimeType, 'image/jpeg');
  assert.ok(Buffer.from(img.data, 'base64').length > 15000, 'a real frame');
  const hat = json(await call('scene_graph', { root: 'cattleman', depth: 1 }));
  assert.ok(hat.root.children.length >= 6, 'crown, brim (top, underside, binding), band, concho');
  for (const name of ['flagellum', 'mitochondria', 'nucleus']) {
    const n = json(await call('scene_graph', { root: name, depth: 0 }));
    assert.equal(n.root.name, name);
  }
  json(await call('race_camera', { mode: 'chase', screenshot: false }));
});

await check('race_drive untilFinish runs the race to the line', async () => {
  const d = json(await call('race_drive', { seconds: 400, untilFinish: true }));
  assert.equal(d.ended, 'finished');
  assert.equal(d.you.finished, true);
  assert.equal(d.you.lapsCompleted.length + 0 >= 3, true, `laps ${JSON.stringify(d.you.lapsCompleted)}`);
  assert.ok(d.you.time > 100 && d.you.time < 260, `race time ${d.you.time}`);
});

await check('the game\'s own real-time loop still runs the race (raceStep, called from frame)', async () => {
  json(await call('race_start', { manual: false }));
  const t0 = json(await call('race_state')).raceTime;
  // wait for the page's clock to move the race on: on a software GPU the first real frames each JIT-compile their pipelines
  // and can take seconds, so this waits for progress (up to 30 s) rather than timing it
  let s; for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 1000)); s = json(await call('race_state')); if (s.raceTime > t0 + 0.3) break; }
  assert.equal(s.manual, false);
  assert.ok(s.raceTime > t0 + 0.3, `raceTime ${t0} -> ${s.raceTime}`);
  assert.ok(s.standings.some(r => r.speed > 5), 'karts are moving on their own');
  json(await call('race_realtime', { manual: true }));
});

await check('race_select shows Tex on the select stage', async () => {
  const r = await call('race_select', { character: 'cowboy' });
  const s = json(r);
  assert.equal(s.screen, 'select'); assert.equal(s.character.id, 'cowboy'); assert.equal(s.stage.visible, true);
  // (on a software GPU the stage judges the device too slow and falls back to 2D — for every racer — so no image check)
});

await check('Rusty Malone races, and his face is driven by the race (and reported)', async () => {
  json(await call('race_setup', { course: 'Ophelia', character: 'outlaw', difficulty: 'hard', seed: 5 }));   // (seeded: an unseeded race can be rough enough that he spends it angry and injured)
  const g = json(await call('race_start'));
  assert.equal(g.grid.find(x => x.you).character, 'outlaw');
  assert.equal(g.grid.find(x => x.you).expression, 'smirk', 'resting face on the grid');
  const d = json(await call('race_drive', { seconds: 25 }));
  const faces = d.you.expressions;
  assert.ok(faces && Object.keys(faces).length >= 2, 'more than one face over 25 s of racing: ' + JSON.stringify(faces));
  const total = Object.values(faces).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 25) < 0.5, `face time adds up to the drive (${total})`);
  assert.ok((faces.smirk || 0) + (faces.determined || 0) > total * 0.4, 'mostly at rest or boosting, not twitching: ' + JSON.stringify(faces));
});

await check('race_pose lists and forces expressions; a character without a rig says so', async () => {
  const p = json(await call('race_pose'));
  assert.deepEqual(p.expressions, ['smirk', 'laugh', 'angry', 'surprised', 'suspicious', 'determined', 'tired', 'wink', 'injured', 'victorious']);
  json(await call('race_pose', { expression: 'wink', hold: 30 }));
  await call('race_drive', { seconds: 0.2 });
  assert.equal(json(await call('race_state')).standings.find(s => s.you).expression, 'wink');
  const bad = await callRaw('race_pose', { expression: 'yodel' });
  assert.equal(bad.isError, true); assert.match(bad.content[0].text, /no expression "yodel"/);
  // (a rival with no rig: the grid is drawn at random and several racers have rigs now, so pick one that reports no expression)
  const other = json(await call('race_state')).standings.find(s => !s.you && !s.expression);
  if (other) assert.match(json(await call('race_pose', { racer: other.name })).note || '', /no expression rig/);
});

await check('race_studio isolates the racer; race_sheet draws turnaround and expression sheets', async () => {
  const st = json(await call('race_studio', { lighting: 'studio' }));
  assert.equal(st.studio, true); assert.equal(st.racer, 'Rusty Malone');
  const t = await call('race_sheet', { kind: 'turnaround', cell: 160, title: 'TEST' });
  const ti = image(t); save(ti, 'rusty-turnaround.jpg');
  assert.match(t.content.find(c => c.type === 'text').text, /^8 cells · drawn 640×\d+/);
  assert.ok(Buffer.from(ti.data, 'base64').length > 20000, 'a real sheet');
  const e = await call('race_sheet', { kind: 'expressions', cell: 140 });
  save(image(e), 'rusty-expressions.jpg');
  assert.match(e.content.find(c => c.type === 'text').text, /^10 cells/);
  assert.equal(json(await call('race_studio', { on: false })).studio, false);
});

await check('race_film films motion; Rusty\'s smoke is puffs, not a tube', async () => {
  json(await call('race_pose', { expression: 'smirk', hold: 60 }));
  const f = await call('race_film', { frames: 6, seconds: 1.5, still: true, cam: { azimuth: -45, distance: 14, height: 5, along: 2.5 }, cell: 200 });
  save(image(f), 'rusty-film.jpg');
  assert.match(f.content.find(c => c.type === 'text').text, /^6 frames/);
  const puffs = json(await call('scene_graph', { root: 'puffs', depth: 0 }));
  assert.equal(puffs.root.name, 'puffs');
  assert.equal(puffs.root.geometry, 'InstancedBufferGeometry');
});

await check('scene_profile breaks the cost down per racer and over the whole roster', async () => {
  const p = json(await call('scene_profile', { roster: true }));
  assert.equal(p.racers.length, 6);
  assert.ok(p.scene.draws > p.track.draws);
  const opts = json(await call('race_options'));
  assert.equal(p.roster.length, opts.characters.length, 'every character built');
  assert.deepEqual(p.roster.filter(r => r.error), [], 'none failed to build');
  const rusty = p.roster.find(r => r.id === 'outlaw');
  assert.ok(rusty.draws <= 64, `Rusty within his budget: ${rusty.draws} draws`);
});

await check('race_palette measures how far apart a racer\'s parts are on screen (Rusty: hat and hair)', async () => {
  // a fresh race, so this is Ophelia's afternoon: later laps run into golden hour and dusk, whose warm light pulls colours together
  json(await call('race_setup', { course: 'Ophelia', character: 'outlaw', difficulty: 'hard', seed: 5 })); json(await call('race_start')); json(await call('race_drive', { seconds: 3 }));   // (seeded: who else is on the grid decides what stands between him and the camera)
  // from the front quarter: from behind, his own smoke trail hides most of him (race_palette counts only what is seen)
  const p = json(await call('race_palette', { cam: { azimuth: 35, elevation: 15, distance: 22, height: 3.5 } }));
  assert.equal(p.racer, 'Rusty Malone');
  const parts = Object.fromEntries(p.parts.map(x => [x.part, x]));
  assert.ok(parts.hat && parts.hair, 'hat and hair both on screen: ' + p.parts.map(x => x.part).join(', '));
  const pair = p.closestPairs.find(x => new Set([x.a, x.b]).has('hat') && new Set([x.a, x.b]).has('hair'));
  assert.ok(!pair || pair.dE > 20, `hat and hair read apart (ΔE ${pair && pair.dE})`);
});

await check('Kasi: built, acting, and within the roster budget', async () => {
  json(await call('race_setup', { course: 'Ophelia', character: 'kasi', difficulty: 'medium' }));
  const g = json(await call('race_start'));
  assert.equal(g.grid.find(x => x.you).expression, 'chill');
  assert.deepEqual(json(await call('race_pose')).expressions, ['chill', 'hype', 'focused', 'shook', 'side-eye', 'annoyed', 'wink', 'tired', 'vibing', 'champion']);
  const d = json(await call('race_drive', { seconds: 20 }));
  assert.ok(Object.keys(d.you.expressions || {}).length >= 2, JSON.stringify(d.you.expressions));
  const prof = json(await call('scene_profile'));
  const k = prof.racers.find(r => r.character === 'kasi');
  assert.ok(k.draws <= 48, `Kasi within budget: ${k.draws} draws`);
  const tw = json(await call('scene_graph', { root: 'twists', depth: 0 }));
  assert.ok(tw.root.instances >= 150, 'the twists are one instanced draw (r128 reports InstancedMesh as type Mesh, with an instance count)');
});

await check('the flow body: one skin on one spine (no gap at the join, a tail that keeps its length, a head that eases); the stock body is an A/B away', async () => {
  const run = async (character, flowBody) => {
    json(await call('race_fx', { flowBody }));
    json(await call('race_setup', { course: 'Ophelia', character, difficulty: 'medium', seed: 8 })); json(await call('race_start'));
    json(await call('race_drive', { seconds: 2 }));
    const m = json(await call('race_motion', { seconds: 4 }));
    return { m, P: Object.fromEntries(m.probes.map(p => [p.probe, p])) };
  };
  const a = await run('proto', true);
  assert.equal(a.m.body, 'flow');
  assert.ok(a.m.skin.seamGap < 1e-3, `gap at the join: ${a.m.skin.seamGap}`);
  assert.ok(a.m.skin.lengthMin > 0.98 && a.m.skin.lengthMax < 1.02, `the spine keeps its length: ${a.m.skin.lengthMin}..${a.m.skin.lengthMax} of rest`);
  assert.ok(a.m.skin.maxBendDeg < 40, `sharpest bend between two rings: ${a.m.skin.maxBendDeg} deg`);
  assert.ok(a.P.neck.snaps <= 2 && a.P.neck.jerk < 600, `the head eases: neck jerk ${a.P.neck.jerk}, ${a.P.neck.snaps} snaps`);
  const sheet = await call('race_sheet', { rest: true, cell: 260 }); save(image(sheet), 'proto-sheet.jpg'); assert.ok(image(sheet));
  const b = await run('proto', false);   // the same racer on the stock ball and tube
  assert.equal(b.m.body, 'stock'); assert.equal(b.m.skin, undefined);
  assert.ok(a.P.neck.snaps < b.P.neck.snaps / 3 && a.P.neck.jerk < b.P.neck.jerk / 4, `neck: stock ${b.P.neck.jerk}/${b.P.neck.snaps} -> flow ${a.P.neck.jerk}/${a.P.neck.snaps}`);
  // a racer whose kit rides the tail (the Viking's bracer, pinned with flowRide) and one that asks its neck for more than a neck can give (Rick)
  for (const id of ['viking', 'rick']) { const c = await run(id, 'all');
    assert.equal(c.m.body, 'flow'); assert.ok(c.m.skin.seamGap < 1e-3 && c.m.skin.lengthMax < 1.02 && c.m.skin.maxBendDeg < 40, `${id}: ${JSON.stringify(c.m.skin)}`); }
  // the tail acts: each state can be held on your racer, is reported, and the skin still keeps its length in it
  json(await call('race_fx', { flowBody: true }));
  json(await call('race_setup', { course: 'Ophelia', character: 'proto', difficulty: 'medium', seed: 8 })); json(await call('race_start')); json(await call('race_drive', { seconds: 2 }));
  for (const st of ['happy', 'angry', 'stiff']) {
    json(await call('race_fx', { tail: { stiff: 0, happy: 0, angry: 0, [st]: 1 } }));
    const m = json(await call('race_motion', { seconds: 2 })), now = json(await call('race_fx', {})).tailAct;
    assert.ok(now[st] > 0.9, `${st} held: ${JSON.stringify(now)}`);
    assert.ok(m.skin.seamGap < 1e-3 && m.skin.lengthMin > 0.97 && m.skin.lengthMax < 1.03, `${st}: ${JSON.stringify(m.skin)}`);
  }
  const film = await call('race_film', { frames: 6, seconds: 0.6, still: true, cell: 240, title: 'happy / angry / stiff: the last held' }); save(image(film), 'tail-acting.jpg'); assert.ok(image(film));
  const fx = json(await call('race_fx', { tail: null, flowBody: true }));
  assert.equal(fx.flowBody, true); assert.equal(fx.tail, null); assert.ok(fx.flowIds.includes('proto'));
});

await check('race_motion: the Fluid copy of Guido Tony moves without the snaps (same race, same seconds)', async () => {
  const run = async (character) => {
    json(await call('race_setup', { course: 'Ophelia', character, difficulty: 'medium' })); json(await call('race_start'));
    json(await call('race_drive', { seconds: 2 }));
    const m = json(await call('race_motion', { seconds: 4 }));
    const P = Object.fromEntries(m.probes.map(p => [p.probe, p])), sw = m.probes.filter(p => p.probe.startsWith('sway'));
    return { neck: P.neck, sway: sw.reduce((a, p) => a + p.jerk, 0) / sw.length, swaySnaps: sw.reduce((a, p) => a + p.snaps, 0), n: sw.length };
  };
  const a = await run('guido'), b = await run('guidoFluid');
  assert.equal(a.n, b.n, 'the copy has the same swaying parts');
  assert.ok(b.neck.jerk < a.neck.jerk / 4, `neck jerk ${a.neck.jerk} -> ${b.neck.jerk}`);
  assert.ok(b.neck.snaps < a.neck.snaps / 3, `neck snaps ${a.neck.snaps} -> ${b.neck.snaps}`);
  assert.ok(b.sway < a.sway / 4, `sway jerk ${Math.round(a.sway)} -> ${Math.round(b.sway)}`);
  assert.ok(b.swaySnaps < a.swaySnaps / 3, `sway snaps ${a.swaySnaps} -> ${b.swaySnaps}`);
  const s = json(await call('race_motion', { seconds: 1, series: true }));
  assert.equal(s.probes.find(p => p.probe === 'neck').speedSeries.length, 59, 'series: one speed per frame step');
});

await check('race_regress: a rest-pose sheet is the same pixels every time; the Fluid copy matches its original; another racer fails', async () => {
  const first = json(await call('race_regress'));   // (guidoFluid is on the grid: the last check left it there)
  assert.match(first.note, /golden/);
  json(await call('race_drive', { seconds: 3 }));
  const again = json(await call('race_regress'));
  assert.equal(again.pass, true); assert.ok(again.changed < 0.005, `changed ${again.changed} after racing on`);
  fs.copyFileSync(path.join(GOLDEN, 'guidoFluid-turnaround.jpg'), path.join(GOLDEN, 'guido-turnaround.jpg'));
  fs.copyFileSync(path.join(GOLDEN, 'guidoFluid-turnaround.jpg'), path.join(GOLDEN, 'punk-turnaround.jpg'));
  json(await call('race_setup', { character: 'guido' })); json(await call('race_start'));
  const orig = json(await call('race_regress'));
  assert.equal(orig.pass, true, `Guido at rest is his Fluid copy at rest (changed ${orig.changed})`);
  json(await call('race_setup', { character: 'punk' })); json(await call('race_start'));
  const other = await call('race_regress');
  save(image(other), 'regress-heat.jpg');
  assert.equal(json(other).pass, false, 'Sid Spitfire is not Guido');
});

await check('race_perf: the frame split into segments, the browser\'s style work, CPU and allocation profiles; shaders compiled in the countdown', async () => {
  json(await call('race_setup', { course: 'Victoria', character: 'guido', difficulty: 'medium' }));
  const st = json(await call('race_start'));
  assert.ok(st.programs > 20, `the countdown compiled the course's shaders (${st.programs} programs, ${st.shaderWarmupMs} ms)`);
  const js = json(await call('race_perf', { seconds: 3, draw: false }));
  assert.ok(js.frame.frames >= 170, `${js.frame.frames} frames`);
  for (const k of ['sim', 'racers', 'camera', 'minimap', 'world', 'particles']) assert.ok(k in js.frame.segments, k);
  assert.ok(js.frame.browser.styleMsPerFrame < 0.5, `style recalc ${js.frame.browser.styleMsPerFrame} ms a frame (a :has() on <html>/<body> made it 3 ms)`);
  assert.ok(js.cpu.selfTop.length > 0 && js.cpu.gameInclusive.some(f => f.fn === 'frameStep'), 'the CPU profile sees the frame');
  assert.ok(js.alloc.top.length > 0);
  const drawn = json(await call('race_perf', { seconds: 1, cpu: false, alloc: false }));
  assert.ok(drawn.frame.draws > 20, `${drawn.frame.draws} draw calls`);
  assert.ok(drawn.frame.shaderCompiles.length <= 1, 'no shader compiles mid-race: ' + JSON.stringify(drawn.frame.shaderCompiles));
});

await check('race_record films at an exact frame rate; race_audio records the music; slipstream is reported', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-rec-'));
  try {
    const r = json(await call('race_record', { seconds: 0.5, fps: 12, dir, name: 'shot', cam: { mode: 'photo', from: { azimuth: 30, distance: 20 }, to: { azimuth: 60, distance: 16 } } }));
    assert.equal(r.frames, 6); assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length, 6);
    assert.ok(r.raceTime[1] > r.raceTime[0], 'game time moved on between frames');
    const a = json(await call('race_audio', { seconds: 2, file: path.join(dir, 'm.webm') }));
    assert.ok(a.bytes > 4000, `${a.bytes} bytes of music`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const st = json(await call('race_state'));
  assert.ok(st.standings.every(s => typeof s.draft === 'number' && typeof s.slingshots === 'number'));
  assert.equal(json(await call('race_fx', { slipstream: 1 })).slipstream, 1);
  const sg = json(await call('scene_graph', { root: 'slipstream', depth: 0 }));
  assert.ok(sg.root.instances >= 20, 'the wind lines are one instanced draw');
  json(await call('race_fx', { slipstream: null }));
});

await check('Eve: race_warp jumps the race, race_framing judges a shot, the profiler sees what is drawn, the garden answers', async () => {
  json(await call('race_setup', { course: 'Eve', character: 'guido', difficulty: 'medium' })); json(await call('race_start'));
  const w = json(await call('race_warp', { to: 0.6 }));
  assert.equal(w.loop, false); assert.ok(Math.abs(w.you.total - 0.6) < 0.05, `you at ${w.you.total}`);
  json(await call('race_drive', { seconds: 0.5 }));
  const good = json(await call('race_framing', { cam: { azimuth: 160, elevation: 10, distance: 26, height: 3.5 } }));
  assert.ok(good.fill > 0.02 && good.box, JSON.stringify(good));
  const inside = json(await call('race_framing', { cam: { azimuth: 0, elevation: 0, distance: 1.5, height: 3 } }));
  assert.equal(inside.ok, false, 'a lens inside the racer is not a shot: ' + JSON.stringify(inside));
  const prof = json(await call('scene_profile', { inView: true, top: 6 }));
  assert.ok(prof.inView.draws > 20 && prof.inView.top.length, 'counts what the camera draws');
  assert.ok(prof.trackTop.length && prof.sceneOtherTop.length, 'names the heaviest pieces');
  const parts = json(await call('scene_graph', { root: 'particles', depth: 0 }));
  assert.equal(parts.root.geometry, 'InstancedBufferGeometry', 'every particle in one instanced draw');
  assert.equal(json(await call('race_fx', { edenLive: false })).edenLive, false);
  assert.equal(json(await call('race_fx', { edenLive: true })).edenLive, true);
  const free = json(await call('race_camera', { mode: 'free', from: [0, 400, 0], at: [0, 0, -100], screenshot: false }));
  assert.equal(free.mode, 'free'); assert.ok(Array.isArray(free.hazards));
  json(await call('race_camera', { mode: 'chase', screenshot: false }));
});

await check('race_features maps the set pieces; race_warp lands short of a jump; the recorder catches the take-off; race_audit; race_audio plays any song from a bar', async () => {
  json(await call('race_setup', { course: 'Victoria', character: 'king', difficulty: 'medium' })); json(await call('race_start'));
  const f = json(await call('race_features'));
  assert.ok(f.jumps.length && f.boostPads.length, 'Victoria has jumps and boost pads');
  assert.ok(f.jumps.every(j => typeof j.at === 'number' && j.n.length === 2), JSON.stringify(f.jumps[0]));
  json(await call('race_warp', { jump: 0, you: 'front', lead: 120 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-mom-'));
  try {
    const r = json(await call('race_record', { seconds: 3, fps: 12, dir, name: 'j' }));
    assert.ok(r.moments.some(m => m.what === 'airborne'), 'the take-off is a moment: ' + JSON.stringify(r.moments));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'j.events.json'), 'utf8')).length, r.frames);
    const a = json(await call('race_audio', { seconds: 2, style: 'king', bar: 8, file: path.join(dir, 'k.webm') }));
    assert.ok(a.bytes > 4000 && a.firstDownbeat >= 0 && a.firstDownbeat < 2, JSON.stringify(a));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const au = json(await call('race_audit'));
  assert.ok(au.pieces > 50 && Array.isArray(au.onRoad) && Array.isArray(au.overlaps), JSON.stringify(au.counts));
});

await check('blind spots: a seeded race repeats; surfaces, aliasing, shader counts, colour-blind pairs, HUD contrast, shot qa, audio analysis, a season', async () => {
  const run = async () => { json(await call('race_setup', { course: 'Ophelia', character: 'kasi', difficulty: 'medium', seed: 21 })); json(await call('race_start'));
    return json(await call('race_drive', { seconds: 2 })).standings.map(s => s.character + ':' + s.total).join(' '); };
  const a = await run(), b = await run();
  assert.equal(a, b, 'the same seed, the same race');
  json(await call('race_setup', { seed: null }));
  const surf = json(await call('race_surface', { scope: 'racer', cam: { azimuth: 30, elevation: 8, distance: 18, height: 3.5 } }));
  assert.ok(surf.materials.length && 'plastic' in surf.totals, JSON.stringify(surf.totals));
  assert.ok(surf.materials.some(m => m.detail === 'relief'), 'Kasi has textured surfaces');
  const al = json(await call('race_alias', { factor: 2 }));
  assert.ok(typeof al.meanAlias === 'number' && al.materials.length, 'aliasing by material');
  const prof = json(await call('scene_profile'));
  assert.ok(prof.programs.total > 10 && prof.racers.every(r => typeof r.programs === 'number'), 'shader programs counted');
  const pal = json(await call('race_palette', { vision: 'all', cam: { azimuth: 35, elevation: 15, distance: 22, height: 3.5 } }));
  assert.ok(pal.vision && pal.vision.deutan && pal.vision.protan && pal.vision.tritan, 'colour-blind pairs');
  const hud = json(await call('race_hud'));
  assert.ok(hud.elements.length && hud.elements.every(e => typeof e.worst === 'number'), 'HUD contrast');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-qa-'));
  try {
    const r = json(await call('race_record', { seconds: 0.5, fps: 12, dir, name: 'q', qa: true, cam: { mode: 'photo', from: { azimuth: 0, elevation: 0, distance: 2, height: 3 } } }));
    assert.ok(Array.isArray(r.problems) && r.problems.some(p => /cut|hidden|frame/.test(p.what)), 'a lens inside the racer is a problem: ' + JSON.stringify(r.problems));
    const au = json(await call('race_audio', { seconds: 3, file: path.join(dir, 'a.webm'), sfxProbe: true }));
    assert.ok(au.analysis && au.analysis.loudnessDbfs < 0 && au.analysis.sfx && au.analysis.sfx.length, JSON.stringify(au.analysis && au.analysis.loudnessDbfs));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const se = json(await call('race_season', { characters: ['kasi'], courses: ['Ophelia'], maxSeconds: 12 }));
  assert.equal(se.races.length, 1); assert.ok(se.hotspots.Ophelia, 'hotspots by course');
});

await check('LUX: the light pipeline proves its target, draws on both anti-aliasing paths, throws a shockwave, and steps aside when told', async () => {
  json(await call('race_setup', { course: 'Nova', character: 'proto', seed: 3 })); json(await call('race_start'));
  json(await call('race_warp', { to: 0.66, you: 'back', spread: 20 })); json(await call('race_drive', { seconds: 0.7 }));
  const a = json(await call('race_fx', {})).lux;
  assert.equal(a.ok, true, 'the pipeline came up: ' + JSON.stringify(a)); assert.equal(a.on, true);
  assert.ok(['half-float', '8-bit'].includes(a.target)); assert.ok(a.size[0] > 100 && a.size[1] > 50, 'the scene target has a size');
  assert.equal(a.light.bloom, 1.0, 'Nova asks for its own light');
  // (Nova's tube is the heaviest view in the game and this is a software GPU: a frame can take longer than one screenshot waits)
  const shot = async () => { for (let k = 0; ; k++) { try { return await call('scene_screenshot'); } catch (e) { if (k >= 3) throw e; } } };
  const on = await shot(); save(image(on), 'lux-on.jpg'); assert.ok(image(on));
  const f = json(await call('race_fx', { lux: { aa: 'fxaa', ripple: 1 } })).lux;
  assert.equal(f.ok, true); assert.equal(f.aa, 'fxaa'); assert.equal(f.msaa, 0); assert.ok(f.ripples >= 1, 'a shockwave is in the picture');
  assert.ok(image(await shot()));
  const tuned = json(await call('race_fx', { lux: { bloom: 0.2, thr: 1.2 } })).lux.light; assert.equal(tuned.bloom, 0.2); assert.equal(tuned.thr, 1.2);
  const off = json(await call('race_fx', { lux: { on: false, reset: true } })).lux; assert.equal(off.on, false); assert.equal(off.light.bloom, 1.0);
  const plain = await shot(); save(image(plain), 'lux-off.jpg'); assert.ok(image(plain));
  assert.equal(json(await call('race_fx', { lux: { on: true, aa: 'msaa' } })).lux.on, true);
});

await check('the build tools: race_ab compares one frozen frame under two settings, race_light measures the glow, race_review runs the checklist', async () => {
  json(await call('race_setup', { course: 'Nova', character: 'proto', seed: 3 })); json(await call('race_start'));
  json(await call('race_warp', { to: 0.66, you: 'back', spread: 20 })); json(await call('race_drive', { seconds: 0.7 }));
  // a tool is driving, so the page's own loop adds no time: two captures of the same setting are the same frame
  const same = await call('race_ab', { a: { lux: { on: true } }, b: { lux: { on: true } } });
  assert.ok(image(same)); assert.ok(json(same).changed < 0.002, 'the same setting twice is the same picture: ' + json(same).changed);
  const ab = await call('race_ab', { a: { lux: { on: false } }, b: { lux: { on: true } }, labels: ['plain', 'LUX'] }); save(image(ab), 'ab-lux.jpg');
  assert.ok(json(ab).changed > 0.01 && json(ab).where, 'the light pipeline changes the picture, and the tool says where: ' + JSON.stringify(json(ab)));
  const li = await call('race_light'); save(image(li), 'light.jpg');
  assert.ok(image(li)); assert.ok(json(li).overBright > 0 && json(li).glowMean > 0 && json(li).glowMean < 0.2, 'Nova\'s tube has light in it, and is not washed out: ' + JSON.stringify(json(li)));
  const rv = await call('race_review', { character: 'proto' }), R = json(rv); save(image(rv), 'review-proto.jpg');
  assert.ok(image(rv), 'the review carries its reference sheet');
  const by = Object.fromEntries(R.checks.map(c => [c.check, c]));
  for (const k of ['neck eases (flow body)', 'no gap at the join', 'the tail keeps its length', 'within the draw budget', 'no page errors']) assert.ok(by[k] && by[k].ok, `${k}: ${JSON.stringify(by[k])}`);
  assert.equal(R.pass, R.failed.length === 0); assert.ok(by['parts read apart'] && by['not plastic'], 'palette and surfaces were looked at');
  const bad = await callRaw('race_review', {}); assert.equal(bad.isError, true);
});

await check('scene_page shows the whole page; race_state carries the music clock', async () => {
  const pg = await call('scene_page');
  assert.ok(Buffer.from(image(pg).data, 'base64').length > 10000, 'a real screenshot');
  const st = json(await call('race_state'));
  assert.ok('music' in st);
  if (st.music) { assert.ok(st.music.bpm > 40 && st.music.bpm < 240, `bpm ${st.music.bpm}`); assert.ok(st.music.phase >= 0 && st.music.phase < 1); }
});

await check('no page errors through all of it', async () => {
  const l = json(await call('page_logs', { level: 'error' }));
  assert.deepEqual(l.entries, []);
});

await client.close();
fs.rmSync(GOLDEN, { recursive: true, force: true });
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
if (passed !== results.length) console.log('\nserver stderr:\n' + serverLog);
process.exit(passed === results.length ? 0 : 1);
