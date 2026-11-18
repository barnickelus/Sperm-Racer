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
import { execFileSync } from 'node:child_process';

const ESBUILD = 'esbuild@0.21.5';   // (pinned: the same printer for every deploy)
const MIN_SCRIPT = 20000;           // (the few small inline scripts are left as written)
const args = process.argv.slice(2), inline = args.includes('--inline');
const [src, out = src] = args.filter(a => !a.startsWith('--'));
const kb = n => (n / 1024).toFixed(0) + ' KB';
const gz = s => zlib.gzipSync(Buffer.from(s), { level: 6 }).length;

function slim(js) {
  return execFileSync('npx', ['--yes', ESBUILD, '--minify-whitespace', '--charset=utf8', '--legal-comments=none', '--line-limit=400', '--log-level=error'],
    { input: js, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'] });
}

try {
  if (!src) throw new Error('usage: node tools/slim-page.mjs <index.html> [out.html]');
  const html = fs.readFileSync(src, 'utf8');
  const tags = s => (s.match(/<script\b/gi) || []).length + ':' + (s.match(/<\/script>/gi) || []).length;
  let done = 0, game = null;
  const res = html.replace(/(<script(?![^>]*\bsrc=)(?![^>]*\btype=)[^>]*>)([\s\S]*?)(<\/script>)/g, (all, open, js, close) => {
    if (js.length < MIN_SCRIPT) return all;
    const min = slim(js).trim();
    new vm.Script(min, { filename: 'slimmed inline script' });                                    // it parses
    if (/<\/script/i.test(min)) throw new Error('the slimmed script would close its own tag');     // (esbuild escapes these; make sure)
    if (min.length > js.length || min.length < js.length * 0.3) throw new Error('the slimmed script is an unlikely size: ' + js.length + ' → ' + min.length);
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
  if (game) fs.writeFileSync(path.join(path.dirname(out), 'game.js'), game);   // (the script first: a page is never published asking for a file that is not there)
  fs.writeFileSync(out, res);
  console.log(`slim-page: ${done} script${done > 1 ? 's' : ''} slimmed${game ? ' and set beside the page as game.js' : ''}. ${src}: ${kb(html.length)} → ${kb(res.length)}${game ? ' + game.js ' + kb(game.length) : ''}; as served (gzip): ${kb(gz(html))} → ${kb(gz(res))}${game ? ' + ' + kb(gz(game)) : ''}`);
} catch (e) {
  console.log(`::warning::slim-page: the page is published as written (${String(e && e.message || e).split('\n')[0].slice(0, 300)})`);
}
