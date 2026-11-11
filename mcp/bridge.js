/* ══════════════════════════════════════════════════════════════════════════
   MCP BRIDGE — the page side of the Sperm-Racer MCP server (mcp/server.mjs)
   (the same bridge as Tesserae-Engine's examples/lib/mcp-bridge.js; keep the two in step)

   Lets an agent outside the page (Claude, through MCP) see and drive a live
   scene: screenshot it, measure it, walk its graph, move the camera, read its
   console, and call whatever commands the page registers (Forge registers its
   schema / state / patch / undo; the racer registers race setup, driving and
   a photo camera). The agent never gets a bare eval: it gets the verbs the
   page chose to expose.

   Off unless asked for. A page only dials the bridge when its URL carries
   `?mcp` (port 7458) or `?mcp=<port>`, so the deployed site never tries.

     import { connectBridge } from './lib/mcp-bridge.js';
     connectBridge({ name: 'my-scene', renderer, scene, camera, controls,
                     commands: { 'my.verb': (params) => result } });

   Protocol (JSON over one WebSocket to ws://127.0.0.1:<port>/bridge):
     page → server  { type:'hello', name, url, title, commands, gpu }
     server → page  { type:'call', id, method, params }
     page → server  { type:'result', id, ok:true, result } | { ..., ok:false, error }

   Screenshots and frame stats are taken from inside the page's own render
   loop (a rAF callback queued behind the page's), so no preserveDrawingBuffer
   is needed and post-processing is included: what comes back is what the
   canvas shows. A tab in the background has no render loop — browsers pause
   it — so those calls fail with a message saying so instead of hanging.
   ══════════════════════════════════════════════════════════════════════════ */

const DEFAULT_PORT = 7458;   // Tesserae's server takes 7457, so both can run at once

export function connectBridge(opts) {
  const q = new URLSearchParams(location.search);
  if (!q.has('mcp')) return null;
  const port = Number(q.get('mcp')) || DEFAULT_PORT;
  const sessionTag = q.get('mcpid') || null;
  const { name = document.title || 'scene', renderer, scene, camera, controls } = opts;

  /* — console capture: the agent can't see DevTools, so keep a ring of what
       it would have seen there — */
  const logs = [];
  const keep = (level, args) => {
    const text = args.map(a => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : safeJson(a)).join(' ');
    logs.push({ t: +performance.now().toFixed(0), level, text: text.slice(0, 2000) });
    if (logs.length > 200) logs.shift();
  };
  for (const level of ['error', 'warn', 'log', 'info']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { keep(level, args); orig(...args); };
  }
  addEventListener('error', e => keep('error', [e.error || e.message]));
  addEventListener('unhandledrejection', e => keep('error', ['unhandled rejection:', e.reason]));

  const gpu = gpuString(renderer);

  const builtins = {
    'page.info': () => ({ name, url: location.href, title: document.title, gpu, software: isSoftware(gpu),
      canvas: canvasInfo(renderer), visible: document.visibilityState, commands: Object.keys(all) }),
    'page.logs': ({ clear = false, level } = {}) => {
      const out = level ? logs.filter(l => l.level === level) : logs.slice();
      if (clear) logs.length = 0;
      return { entries: out };
    },
    'scene.screenshot': ({ maxWidth = 1000, format = 'jpeg', quality = 0.85 } = {}) => afterNextFrame(() => {
      const src = renderer.domElement;
      const k = Math.min(1, maxWidth / src.width);
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(src.width * k));
      cv.height = Math.max(1, Math.round(src.height * k));
      cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
      const mime = format === 'png' ? 'image/png' : 'image/jpeg';
      const url = cv.toDataURL(mime, quality);
      return { mimeType: mime, data: url.slice(url.indexOf(',') + 1), width: cv.width, height: cv.height,
               source: { width: src.width, height: src.height } };
    }),
    'scene.stats': ({ sampleMs = 1000 } = {}) => sampleFrames(renderer, Math.min(Math.max(sampleMs, 200), 10000))
      .then(s => ({ ...s, gpu, software: isSoftware(gpu), canvas: canvasInfo(renderer),
                    memory: { ...renderer.info.memory }, programs: renderer.info.programs?.length ?? null,
                    census: census(scene) })),
    'scene.graph': ({ depth = 4, maxNodes = 300, root } = {}) => {
      let budget = maxNodes;
      const start = root ? scene.getObjectByName(root) : scene;
      if (!start) throw new Error(`no object named "${root}"`);
      const walk = (o, d) => {
        budget--;
        const n = describe(o);
        if (o.children.length) {
          if (d <= 0 || budget <= 0) n.childCount = o.children.length;
          else n.children = o.children.filter(() => budget > 0).map(c => walk(c, d - 1));
        }
        return n;
      };
      return { root: walk(start, depth), truncated: budget <= 0 };
    },
    'scene.view': ({ azimuth, elevation, distance, target } = {}) => {
      const t = controls ? controls.target : new camera.position.constructor(0, 0, 0);
      if (target) t.set(target[0], target[1], target[2]);
      const off = camera.position.clone().sub(t);
      let r = off.length();
      let az = Math.atan2(off.x, off.z) * 180 / Math.PI;
      let el = Math.asin(Math.max(-1, Math.min(1, off.y / (r || 1)))) * 180 / Math.PI;
      if (azimuth != null) az = azimuth;
      if (elevation != null) el = Math.max(-89, Math.min(89, elevation));
      if (distance != null) r = Math.max(0.01, distance);
      if (azimuth != null || elevation != null || distance != null || target) {
        const a = az * Math.PI / 180, e = el * Math.PI / 180;
        camera.position.set(t.x + r * Math.cos(e) * Math.sin(a), t.y + r * Math.sin(e), t.z + r * Math.cos(e) * Math.cos(a));
        camera.lookAt(t);
        controls?.update?.();
      }
      return { azimuth: +az.toFixed(1), elevation: +el.toFixed(1), distance: +r.toFixed(3),
               target: [t.x, t.y, t.z].map(v => +v.toFixed(3)), fov: camera.fov };
    },
  };
  const all = { ...builtins, ...(opts.commands || {}) };

  /* — a small badge, so someone watching a live tab knows it can be driven — */
  const badge = document.createElement('div');
  badge.style.cssText = 'position:fixed;left:10px;bottom:10px;z-index:99;font:11px/1.2 ui-monospace,monospace;' +
    'padding:4px 7px;border-radius:5px;background:rgba(10,14,20,.78);color:#9aa7b6;pointer-events:none';
  const setBadge = (on) => { badge.textContent = on ? `● MCP :${port}` : `○ MCP :${port} — waiting for server`; badge.style.color = on ? '#7ee0a8' : '#9aa7b6'; };
  setBadge(false);
  (document.body || document.documentElement).appendChild(badge);

  /* — the socket, reconnecting forever so a tab outlives server restarts — */
  let ws = null, delay = 500;
  function dial() {
    try { ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`); }
    catch { return retry(); }
    ws.onopen = () => {
      delay = 500; setBadge(true);
      ws.send(JSON.stringify({ type: 'hello', name, url: location.href, title: document.title, tag: sessionTag,
                               gpu, software: isSoftware(gpu), commands: Object.keys(all) }));
    };
    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'call') return;
      const fn = all[msg.method];
      let reply;
      try {
        if (!fn) throw new Error(`this page has no command "${msg.method}" (it has: ${Object.keys(all).join(', ')})`);
        reply = { type: 'result', id: msg.id, ok: true, result: await fn(msg.params || {}) };
      } catch (e) {
        reply = { type: 'result', id: msg.id, ok: false, error: String(e && e.message || e) };
      }
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(reply));
    };
    ws.onclose = () => { setBadge(false); retry(); };
    ws.onerror = () => {};
  }
  function retry() { setTimeout(dial, delay); delay = Math.min(delay * 2, 5000); }
  dial();

  return { port, close: () => { const w = ws; ws = null; w?.close(); badge.remove(); } };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/* Run fn inside the next animation frame, queued behind the page's own loop,
   while the drawing buffer still holds the frame just rendered. */
function afterNextFrame(fn, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(
      'no frame was rendered within ' + timeoutMs + 'ms — if this is a live tab, bring it to the front (browsers pause rendering in background tabs)')), timeoutMs);
    requestAnimationFrame(() => {
      clearTimeout(to);
      try { resolve(fn()); } catch (e) { reject(e); }
    });
  });
}

/* Per-frame cost over a window. info.autoReset is switched off so draw calls
   and triangles add up across every render() a frame makes (scene + post
   passes), then read and reset once per frame from behind the page's loop. */
function sampleFrames(renderer, ms) {
  return new Promise((resolve, reject) => {
    const info = renderer.info, wasAuto = info.autoReset;
    info.autoReset = false; info.reset();
    const dts = [], calls = [], tris = [];
    let last = null, t0 = null, done = false, guard = setTimeout(() => finish(true), ms + 3000);
    function tick() {
      if (done) return;
      const now = performance.now();
      if (last !== null) {
        dts.push(now - last);
        calls.push(info.render.calls); tris.push(info.render.triangles);
      } else t0 = now;
      info.reset();
      last = now;
      if (now - t0 < ms) requestAnimationFrame(tick); else finish(false);
    }
    function finish(stalled) {
      if (done) return;
      done = true; clearTimeout(guard); info.autoReset = wasAuto;
      if (!dts.length) return reject(new Error('no frames rendered while sampling — a background tab pauses rendering; bring it to the front'));
      const sorted = dts.slice().sort((a, b) => a - b);
      const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
      resolve({
        frames: dts.length, sampleMs: Math.round(performance.now() - t0), stalled,
        fps: +(1000 / avg).toFixed(1),
        frameMs: { avg: +avg.toFixed(2), p50: +sorted[sorted.length >> 1].toFixed(2),
                   p95: +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(2),
                   max: +sorted[sorted.length - 1].toFixed(2) },
        perFrame: { drawCalls: Math.round(avg_(calls)), triangles: Math.round(avg_(tris)) },
      });
    }
    requestAnimationFrame(tick);
  });
}
const avg_ = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;

function census(scene) {
  const c = { objects: 0, meshes: 0, instancedMeshes: 0, instances: 0, lights: 0, points: 0, lines: 0, sprites: 0 };
  scene.traverse(o => {
    c.objects++;
    if (o.isInstancedMesh) { c.instancedMeshes++; c.instances += o.count; }
    else if (o.isMesh) c.meshes++;
    if (o.isLight) c.lights++;
    if (o.isPoints) c.points++;
    if (o.isLine) c.lines++;
    if (o.isSprite) c.sprites++;
  });
  return c;
}

const r3 = v => +v.toFixed(3);
function describe(o) {
  const n = { type: o.type };
  if (o.name) n.name = o.name;
  if (!o.visible) n.visible = false;
  if (o.position.lengthSq() > 1e-12) n.position = o.position.toArray().map(r3);
  if (o.rotation && (o.rotation.x || o.rotation.y || o.rotation.z)) n.rotation = [o.rotation.x, o.rotation.y, o.rotation.z].map(r3);
  if (Math.abs(o.scale.x - 1) + Math.abs(o.scale.y - 1) + Math.abs(o.scale.z - 1) > 1e-6) n.scale = o.scale.toArray().map(r3);
  if (o.isInstancedMesh) n.instances = o.count;
  if (o.geometry) {
    n.geometry = o.geometry.type;
    const p = o.geometry.attributes?.position;
    if (p) n.vertices = p.count;
  }
  if (o.material) {
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    n.material = ms.map(m => {
      const d = { type: m.type };
      if (m.name) d.name = m.name;
      if (m.color) d.color = '#' + m.color.getHexString();
      if (m.roughness !== undefined) d.roughness = r3(m.roughness);
      if (m.metalness !== undefined) d.metalness = r3(m.metalness);
      if (m.transparent) d.opacity = r3(m.opacity);
      if (m.wireframe) d.wireframe = true;
      return d;
    });
    if (n.material.length === 1) n.material = n.material[0];
  }
  if (o.isLight) {
    n.intensity = r3(o.intensity);
    if (o.color) n.color = '#' + o.color.getHexString();
    if (o.castShadow) n.castShadow = true;
  }
  if (o.isCamera && o.fov) n.fov = o.fov;
  return n;
}

function canvasInfo(renderer) {
  const c = renderer.domElement;
  return { width: c.width, height: c.height, cssWidth: c.clientWidth, cssHeight: c.clientHeight, pixelRatio: renderer.getPixelRatio() };
}

function gpuString(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { return 'unknown'; }
}
const isSoftware = (gpu) => /swiftshader|llvmpipe|software|basic render/i.test(gpu);

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }
