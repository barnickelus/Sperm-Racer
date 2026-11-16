#!/usr/bin/env node
// tools/slim-page.mjs <index.html> [out.html]
//
// THE PUBLISHED PAGE, SLIMMED. The game is one hand-written file, and most of its bytes are the comments and the spacing that make
// it readable. A browser has to download and read all of them before the page can start, on every visit that has no cached copy
// (and every push to main makes every cached copy stale). The deploy runs this over the copy it is about to publish: the page's
// inline scripts are re-printed without comments or spacing (esbuild, whitespace only: no name is changed and no code is
// rewritten). The source in the repository is never touched, and nothing else in the page is.
//
// It must never stand between a push and its deploy. Whatever goes wrong (no network for the tool, a script it cannot read, an
// output that does not parse, or is suspiciously small, or would close its own <script> tag), it says so, leaves the file exactly
// as it was and exits 0: the deploy then publishes the page as written.
//
//   node tools/slim-page.mjs index.html            the file, in place (what the deploy does)
//   node tools/slim-page.mjs index.html out.html   a slimmed copy, to try out locally
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ESBUILD = 'esbuild@0.21.5';   // (pinned: the same printer for every deploy)
const MIN_SCRIPT = 20000;           // (the few small inline scripts are left as written)
const [src, out = src] = process.argv.slice(2);
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
  let done = 0;
  const res = html.replace(/(<script(?![^>]*\bsrc=)(?![^>]*\btype=)[^>]*>)([\s\S]*?)(<\/script>)/g, (all, open, js, close) => {
    if (js.length < MIN_SCRIPT) return all;
    const min = slim(js).trim();
    new vm.Script(min, { filename: 'slimmed inline script' });                                    // it parses
    if (/<\/script/i.test(min)) throw new Error('the slimmed script would close its own tag');     // (esbuild escapes these; make sure)
    if (min.length > js.length || min.length < js.length * 0.3) throw new Error('the slimmed script is an unlikely size: ' + js.length + ' → ' + min.length);
    done++;
    return open + '\n' + min + '\n' + close;
  });
  if (!done) throw new Error('no inline script to slim');
  if (tags(res) !== tags(html)) throw new Error('the page\'s script tags changed: ' + tags(html) + ' → ' + tags(res));
  fs.writeFileSync(out, res);
  console.log(`slim-page: ${done} script${done > 1 ? 's' : ''} slimmed. ${src}: ${kb(html.length)} → ${kb(res.length)}; as served (gzip): ${kb(gz(html))} → ${kb(gz(res))}`);
} catch (e) {
  console.log(`::warning::slim-page: the page is published as written (${String(e && e.message || e).split('\n')[0].slice(0, 300)})`);
}
