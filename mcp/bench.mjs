#!/usr/bin/env node
/* THE BENCH: one game page kept open, any tool called from a shell.

   The MCP server is built for a client that holds a session. Work at a terminal (or an agent shelling out) does not:
   every `node` run would launch a browser, load the game and throw it away. The bench is a small daemon that owns one
   MCP client and one headless page, and a command that talks to it. Images in a reply are written to files and the
   reply carries their paths, so a shell pipeline can pick them up.

     node mcp/bench.mjs call race_setup '{"course":"Nova","character":"proto","seed":3}'
     node mcp/bench.mjs call race_start
     node mcp/bench.mjs call race_film '{"seconds":1,"frames":6}' whip     # -> [image saved: .../03-whip.jpg]
     node mcp/bench.mjs json race_motion '{"seconds":4}'                   # the reply's JSON only (for jq / python)
     node mcp/bench.mjs reload                                             # index.html changed: a fresh page, same daemon
     node mcp/bench.mjs stop

   `call` starts the daemon if it is not running (it opens a 960x540 page on first use). Options, as environment:
     BENCH_PORT   where the daemon listens (default 7600); run two benches side by side on two ports
     BENCH_SHOTS  where images go (default mcp/.bench/shots)
     BENCH_SIZE   the page, WxH (default 960x540)

   From a script, import { bench } and call tools as functions:
     import { bench } from './bench.mjs';
     const t = await bench();                      // connects (and starts the daemon if needed)
     const m = await t.json('race_motion', { seconds: 4 });
     const { files } = await t.call('scene_screenshot', {}, 'tunnel');   */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.BENCH_PORT || 7600);
const SHOTS = path.resolve(process.env.BENCH_SHOTS || path.join(here, '.bench', 'shots'));
const [SW, SH] = (process.env.BENCH_SIZE || '960x540').split('x').map(Number);

const post = (body, port = PORT) => new Promise((res, rej) => {
  const rq = http.request({ host: '127.0.0.1', port, path: '/call', method: 'POST' }, rs => { let d = ''; rs.on('data', c => d += c); rs.on('end', () => res(d)); });
  rq.on('error', rej); rq.setTimeout(0); rq.end(JSON.stringify(body));
});
const alive = async (port = PORT) => { try { return (await post({ ping: true }, port)).startsWith('pong'); } catch { return false; } };

/* ── the daemon ─────────────────────────────────────────────────────────── */
async function serve() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  fs.mkdirSync(SHOTS, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, 'server.mjs')], env: { ...process.env, SPERM_RACER_MCP_PORT: '0' }, stderr: 'inherit' });
  const client = new Client({ name: 'bench', version: '1' });
  await client.connect(transport);
  let n = fs.readdirSync(SHOTS).reduce((m, f) => Math.max(m, parseInt(f, 10) || 0), 0), open = false;
  const tool = (name, args) => client.callTool({ name, arguments: args || {} }, undefined, { timeout: 1800000 });
  const ensure = async () => { if (!open) { await tool('scene_open', { width: SW, height: SH }); open = true; } };
  const srv = http.createServer(async (rq, rs) => {
    let body = ''; for await (const c of rq) body += c;
    try {
      const { ping, stop, reload, name, arguments: args = {}, tag = '' } = JSON.parse(body || '{}');
      if (ping) return rs.end('pong\n');
      if (stop) { rs.end('stopped\n'); try { await client.close(); } catch {} process.exit(0); }
      if (reload) { if (open) await tool('scene_close', {}).catch(() => 0); open = false; await ensure(); return rs.end('reloaded\n'); }
      if (!/^scene_(open|close|pages)$/.test(name)) await ensure(); else if (name === 'scene_open') open = true; else if (name === 'scene_close') open = false;
      const r = await tool(name, args);
      const out = r.content.map(c => {
        if (c.type !== 'image') return c.text;
        const f = path.join(SHOTS, `${String(++n).padStart(3, '0')}${tag ? '-' + tag : ''}.${c.mimeType === 'image/png' ? 'png' : 'jpg'}`);
        fs.writeFileSync(f, Buffer.from(c.data, 'base64'));
        return `[image saved: ${f}]`;
      });
      rs.end((r.isError ? 'ERROR: ' : '') + out.join('\n') + '\n');
    } catch (e) { rs.end('BENCH ERROR: ' + (e && e.message || e) + '\n'); }
  });
  srv.listen(PORT, '127.0.0.1', () => console.log(`bench ready on :${PORT}, images to ${SHOTS}`));
}

/* ── the client ─────────────────────────────────────────────────────────── */
async function up() {
  if (await alive()) return;
  fs.mkdirSync(path.join(here, '.bench'), { recursive: true });
  const log = fs.openSync(path.join(here, '.bench', `bench-${PORT}.log`), 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();
  for (let k = 0; k < 200; k++) { if (await alive()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`the bench did not come up on :${PORT} (see mcp/.bench/bench-${PORT}.log)`);
}
const parse = (s) => {
  const files = [...s.matchAll(/\[image saved: ([^\]]+)\]/g)].map(m => m[1]);
  const err = s.startsWith('ERROR') || s.startsWith('BENCH ERROR');
  const i = s.indexOf('{'), j = s.lastIndexOf('}'); let json = null;
  if (!err && i >= 0 && j > i) { try { json = JSON.parse(s.slice(i, j + 1)); } catch {} }
  return { text: s, files, json, error: err ? s.trim() : null };
};
export async function bench() {
  await up();
  const call = async (name, args = {}, tag = '') => { const r = parse(await post({ name, arguments: args, tag })); if (r.error) throw new Error(`${name}: ${r.error.slice(0, 600)}`); return r; };
  return { call, json: async (name, args, tag) => (await call(name, args, tag)).json, reload: () => post({ reload: true }), stop: () => post({ stop: true }).catch(() => 0), shots: SHOTS };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, name, args, tag] = process.argv.slice(2);
  if (cmd === 'serve') await serve();
  else if (cmd === 'stop') { console.log(await alive() ? (await post({ stop: true }).catch(() => 'stopped')).trim() : 'not running'); }
  else if (cmd === 'reload') { await up(); console.log((await post({ reload: true })).trim()); }
  else if (cmd === 'call' || cmd === 'json') {
    if (!name) { console.error('usage: bench.mjs call <tool> [json args] [tag]'); process.exit(2); }
    await up();
    const s = await post({ name, arguments: args ? JSON.parse(args) : {}, tag: tag || '' }), r = parse(s);
    if (cmd === 'json') { if (r.error) { console.error(r.error); process.exit(1); } console.log(JSON.stringify(r.json)); for (const f of r.files) console.error(f); }
    else { process.stdout.write(s); if (r.error) process.exit(1); }
  } else { console.log('bench.mjs serve | call <tool> [json] [tag] | json <tool> [json] | reload | stop    (see the header of this file)'); process.exit(cmd ? 2 : 0); }
}
