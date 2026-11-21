#!/usr/bin/env node
// tools/slim-page.mjs <index.html> [out.html]
//
// THE PUBLISHED PAGE, SLIMMED. The game is one hand-written file, and most of its bytes are the comments and the spacing that make
// it readable. A browser has to download and read all of them before the page can start, on every visit that has no cached copy
// (and every push to main makes every cached copy stale). The deploy runs this over the copy it is about to publish: the page's
// inline scripts are re-printed without comments or spacing (esbuild, whitespace only: no name is changed and no code is
// rewritten). The source in the repository is never touched, and nothing else in the page is.
//
// ...AND SET BESIDE IT. The slimmed script is written to game.js and the page asks for it by name
// (<script src="game.js?v=<its hash>">) instead of carrying it inline. A browser keeps the compiled form of a script file from
// one visit to the next, and can read it while it is still arriving; an inline script is read and compiled from nothing,
// on the page's own thread, every visit (measured, CPU slowed four times: 3.2 s of frozen page each visit inline; 2.6 s on a
// first visit and 0.7 s from the third as a file). The page itself becomes small, so the home deck's markup is on screen
// almost at once (see bootDeck in index.html). The ?v= changes with every build, so a page never runs an older build's
// script from a cache; and if a page somehow gets a script that is not the one it asked for (a copy of the page cached just
// before a deploy), the script reloads the page once to fetch the page that goes with it, rather than run mismatched.
// (--inline keeps the script in the page, as before.)
//
// ...AND THE RECORDS SET BESIDE THAT. A third of the script is its fifty produced records (SONG_ENGINE.songs.<id>), each
// played by one course or one racer. Every record that touches nothing but the song engine is lifted out into
// songs/<id>.<hash>.js, and a line is left in its place (SONG_ENGINE.cat.<id>: its title, its course note, its file); the
// game asks for a record when it is about to be wanted (songLoad in index.html). Which records may go is not assumed:
//   - the home theme stays (KEEP): it plays on the home screen itself;
//   - each other record is checked for names it does not define (eslint no-undef, with the engine as its one argument and
//     a short list of browser globals): a record that reads anything of the game's stays in the page, as written;
//   - each is then run against the real engine in a sandbox, which must give back an object with a title.
// If the check cannot be run at all, no record is moved. (--songs-inline keeps them all in the script.)
//
// It must never stand between a push and its deploy. Whatever goes wrong (no network for the tool, a script it cannot read, an
// output that does not parse, or is suspiciously small, or would close its own <script> tag), it says so, leaves the file exactly
// as it was and exits 0: the deploy then publishes the page as written.
//
//   node tools/slim-page.mjs index.html            the file, in place, and game.js beside it (what the deploy does)
//   node tools/slim-page.mjs index.html out.html   a slimmed copy (and game.js beside it), to try out locally
//   node tools/slim-page.mjs index.html out.html --inline   ...with the script kept in the page
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ESBUILD = 'esbuild@0.21.5';   // (pinned: the same printer for every deploy)
const ESLINT = 'eslint@9.14.0';     // (pinned: the check of what a record reaches for)
const KEEP = ['homeTheme'];         // records that stay in the page whatever they touch
const SONG_GLOBALS = ['window','document','performance','console','setTimeout','clearTimeout','setInterval','clearInterval','requestAnimationFrame','Float32Array','Float64Array','Uint8Array','Int16Array','Math','Object','Array','JSON','Number','String','Map','Set','WeakMap','Promise','Infinity','NaN','isFinite','parseInt','parseFloat','undefined','Error','Symbol','Date','AudioContext','OfflineAudioContext','navigator'];
const MIN_SCRIPT = 20000;           // (the few small inline scripts are left as written)
const args = process.argv.slice(2), inline = args.includes('--inline'), songsInline = args.includes('--songs-inline');
const [src, out = src] = args.filter(a => !a.startsWith('--'));
const kb = n => (n / 1024).toFixed(0) + ' KB';
const gz = s => zlib.gzipSync(Buffer.from(s), { level: 6 }).length;

function slim(js) {
  return execFileSync('npx', ['--yes', ESBUILD, '--minify-whitespace', '--charset=utf8', '--legal-comments=none', '--line-limit=400', '--log-level=error'],
    { input: js, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'] });
}

// The records in a script, as written: each starts a line with SONG_ENGINE.songs.<id>=(function(){ and ends on a line that is
// exactly })(); Those that may leave are marked (a call before and after, which the printer keeps; none may be left afterwards) so they can
// be cut out of the slimmed script (the marks are calls, which the printer keeps; none may be left when the cutting is done). Returns null when the script has no loader for them, or nothing may leave.
function markSongs(js) {
  if (!/\nfunction songLoad\(/.test(js) || !js.includes('SONG_ENGINE.cat={};')) return null;
  const lines = js.split('\n'), blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^SONG_ENGINE\.songs\.([A-Za-z0-9_]+)=\(function\(\)\{/.exec(lines[i]); if (!m) continue;
    let j = i; while (j < lines.length && lines[j].trimEnd() !== '})();') j++;
    if (j >= lines.length) throw new Error('record ' + m[1] + ' has no end');
    blocks.push({ id: m[1], i, j, src: lines.slice(i, j + 1).join('\n') }); i = j;
  }
  const cand = blocks.filter(b => !KEEP.includes(b.id)); if (!cand.length) return null;
  // 1. what each reaches for
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-songs-'));
  try {
    for (const b of cand) fs.writeFileSync(path.join(dir, b.id + '.js'), 'export default function(SONG_ENGINE){\n' + b.src + '\n}\n');
    fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), `const g={}; for(const n of ${JSON.stringify(SONG_GLOBALS)}) g[n]='readonly';\nexport default [{ files:['*.js'], languageOptions:{ ecmaVersion:2022, sourceType:'module', globals:g }, rules:{ 'no-undef':'error' } }];\n`);
    let out; try { out = execFileSync('npx', ['--yes', ESLINT, '.', '-f', 'json'], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { out = e.stdout; }                                       // (eslint exits 1 when it finds something: its report is still on stdout)
    const rep = JSON.parse(out); if (!Array.isArray(rep) || rep.length < cand.length) throw new Error('the records could not be checked');
    for (const r of rep) { const b = cand.find(b => path.basename(r.filePath) === b.id + '.js'); if (b) { b.checked = true; if (r.messages.length) b.stays = r.messages.map(m => m.message).slice(0, 3).join('; '); } }
    for (const b of cand) if (!b.checked) b.stays = 'not checked';
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // 2. each, run against the engine itself
  const e0 = lines.findIndex(l => /^const SONG_ENGINE=\(function\(\)\{/.test(l)); let e1 = e0; while (e1 < lines.length && lines[e1].trimEnd() !== '})();') e1++;
  if (e0 < 0 || e1 >= lines.length) throw new Error('the song engine was not found');
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Math, performance: { now: () => 0 } });
  const ENGINE = vm.runInContext('"use strict";' + lines.slice(e0, e1 + 1).join('\n') + '\nSONG_ENGINE;', ctx);
  for (const b of cand) { if (b.stays) continue;
    try { const o = vm.runInContext('(function(SONG_ENGINE){"use strict";\n' + b.src + '\nreturn SONG_ENGINE.songs[' + JSON.stringify(b.id) + '];})', ctx)(ENGINE);
      if (!o || typeof o.title !== 'string') throw new Error('it gave back no title'); b.meta = { title: o.title, courseNote: typeof o.courseNote === 'string' ? o.courseNote : undefined }; }
    catch (e) { b.stays = 'did not run on its own: ' + String(e && e.message || e).slice(0, 120); } }
  const go = cand.filter(b => !b.stays); if (!go.length) return null;
  for (const b of go.slice().reverse()) { lines.splice(b.j + 1, 0, `__SR_SONG_END_${b.id}__();`); lines.splice(b.i, 0, `__SR_SONG_BEGIN_${b.id}__();`); }   // (a name, not a string: the printer may break a long line inside a string)
  return { js: lines.join('\n'), go, stay: cand.filter(b => b.stays) };
}
// ...and cut out of the slimmed script: {min (with a catalog line where each record was), files:[{name, text}]}
function cutSongs(min, go) {
  const files = [];
  for (const b of go) {
    const mark = w => new RegExp('__SR_SONG_' + w + '_' + b.id + '__\\s*\\(\\s*\\)\\s*;?'), mA = mark('BEGIN').exec(min), mZ = mark('END').exec(min);   // (the printer may break a line between a mark's name and its brackets)
    if (!mA || !mZ || mZ.index < mA.index) throw new Error('record ' + b.id + ' was lost in the printing');
    const a = mA.index, z = mZ.index, A = mA[0], Z = mZ[0];
    const body = min.slice(a + A.length, z).trim(), text = `(function(SONG_ENGINE){\n${body}\n})(window.__srSE);\n`;
    if (!body.slice(0, 200).replace(/\s+/g, '').startsWith('SONG_ENGINE.songs.' + b.id + '=')) throw new Error('record ' + b.id + ' is not where it was marked');
    new vm.Script(text, { filename: b.id + '.js' });
    const name = `songs/${b.id}.${crypto.createHash('sha256').update(text).digest('hex').slice(0, 10)}.js`;
    files.push({ name, text });
    min = min.slice(0, a) + `SONG_ENGINE.cat.${b.id}=${JSON.stringify({ title: b.meta.title, courseNote: b.meta.courseNote, src: name })};` + min.slice(z + Z.length);
  }
  if (min.includes('__SR_SONG_')) throw new Error('a record\'s mark was left in the script');
  return { min, files };
}

try {
  if (!src) throw new Error('usage: node tools/slim-page.mjs <index.html> [out.html]');
  const html = fs.readFileSync(src, 'utf8');
  const tags = s => (s.match(/<script\b/gi) || []).length + ':' + (s.match(/<\/script>/gi) || []).length;
  let done = 0, game = null, songs = null, songNote = '';
  const res = html.replace(/(<script(?![^>]*\bsrc=)(?![^>]*\btype=)[^>]*>)([\s\S]*?)(<\/script>)/g, (all, open, js, close) => {
    if (js.length < MIN_SCRIPT) return all;
    let min = null;
    if (!inline && !songsInline && !game) {   // the records set beside the script, if every step of that works; if one does not, none is moved
      try { const marked = markSongs(js);
        if (marked) { const cut = cutSongs(slim(marked.js).trim(), marked.go); min = cut.min; songs = cut.files;
          songNote = `; ${songs.length} records set beside it (${kb(songs.reduce((a, f) => a + f.text.length, 0))}, gzip ${kb(songs.reduce((a, f) => a + gz(f.text), 0))})` + (marked.stay.length ? `, ${marked.stay.length} kept in the script (${marked.stay.map(b => b.id + ': ' + b.stays).join(' | ').slice(0, 300)})` : ''); } }
      catch (e) { min = null; songs = null; console.log(`::warning::slim-page: the records stay in the script (${String(e && e.message || e).split('\n')[0].slice(0, 200)})`); }
    }
    if (min === null) min = slim(js).trim();
    new vm.Script(min, { filename: 'slimmed inline script' });                                    // it parses
    if (/<\/script/i.test(min)) throw new Error('the slimmed script would close its own tag');     // (esbuild escapes these; make sure)
    if (min.length > js.length || min.length < js.length * (songs ? 0.15 : 0.3)) throw new Error('the slimmed script is an unlikely size: ' + js.length + ' → ' + min.length);
    done++;
    if (inline || game) return open + '\n' + min + '\n' + close;   // (one script file: a second large script, if there ever is one, stays inline)
    // beside the page: the script, behind a guard that reloads once if this is not the script the page asked for
    const v = crypto.createHash('sha256').update(min).digest('hex').slice(0, 12);
    // (the guard cannot itself stop the game: any failure in it, such as storage refused by the browser, means "run")
    game = `if((function(){try{return(document.currentScript&&document.currentScript.src||"").indexOf("v=${v}")<0&&!sessionStorage.getItem("sr_v_${v}")&&(sessionStorage.setItem("sr_v_${v}","1"),true)}catch(e){return false}})()){location.reload()}else{\n${min}\n}\n`;
    new vm.Script(game, { filename: 'game.js' });
    return `<script src="game.js?v=${v}"></script>`;
  });
  if (!done) throw new Error('no inline script to slim');
  if (tags(res) !== tags(html)) throw new Error('the page\'s script tags changed: ' + tags(html) + ' → ' + tags(res));
  if (game && songs) { const d = path.join(path.dirname(out), 'songs'); fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
    for (const f of songs) fs.writeFileSync(path.join(path.dirname(out), f.name), f.text); }   // (the records first, then the script that names them)
  if (game) fs.writeFileSync(path.join(path.dirname(out), 'game.js'), game);   // (the script before the page: a page is never published asking for a file that is not there)
  fs.writeFileSync(out, res);
  console.log(`slim-page: ${done} script${done > 1 ? 's' : ''} slimmed${game ? ' and set beside the page as game.js' : ''}. ${src}: ${kb(html.length)} → ${kb(res.length)}${game ? ' + game.js ' + kb(game.length) : ''}; as served (gzip): ${kb(gz(html))} → ${kb(gz(res))}${game ? ' + ' + kb(gz(game)) : ''}${songNote}`);
} catch (e) {
  console.log(`::warning::slim-page: the page is published as written (${String(e && e.message || e).split('\n')[0].slice(0, 300)})`);
}
