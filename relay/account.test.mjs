import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  mergeProgress, normalizeEmail, sanitizeProgress, allowedNext, handleAccount, GHOST_MAX, DEFAULT_GAME_URL,
} from './account.js';

const GAME = DEFAULT_GAME_URL;

function memDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = db.prepare(sql);
          return {
            async run() {
              const info = stmt.run(...args);
              return { meta: { changes: info.changes } };
            },
            async first() { return stmt.get(...args) || null; },
            async all() { return { results: stmt.all(...args) }; },
          };
        },
      };
    },
  };
}

function ghost(course, time, d) {
  return { v: 1, n: 'You', ty: 'guido', c: course, t: time, hz: 5, cr: 0, at: 1, d: d || ('r' + 'abc'.repeat(10)) };
}

test('email addresses are normalized and junk is refused', () => {
  assert.equal(normalizeEmail('  Ada@Example.com '), 'ada@example.com');
  assert.equal(normalizeEmail('not an email'), '');
  assert.equal(normalizeEmail('a@b'), '');
  assert.equal(normalizeEmail('a@b.c'), '');
});

test('merge unions unlocks, keeps the further cup, and the faster ghost', () => {
  const local = sanitizeProgress({
    unlocks: ['voxel'], podiums: 2,
    cups: { c1: { place: 2, eggs: 3, pts: 20, diff: 'medium' } },
    runs: { c2: { v: 1, id: 'c2', name: 'Incubator Cup', courses: ['Nova', 'Eve'], idx: 1, lineup: ['guido', 'irish', 'king', 'kasi', 'outlaw', 'chad'], pts: [4, 2, 0, 0, 0, 0], eggs: [1, 0, 0, 0, 0, 0], last: null, diff: 'easy', t: 10 } },
    bests: { Nova: 80, Eve: 50 },
    ghosts: { Nova: ghost('Nova', 80), Eve: ghost('Eve', 70) },
    racer: 'tonyGuido', track: '3', diff: 'hard',
  });
  const remote = sanitizeProgress({
    unlocks: ['dough'], podiums: 1,
    cups: { c1: { place: 1, eggs: 4, pts: 24, diff: 'medium' } },
    runs: { c2: { v: 1, id: 'c2', name: 'Incubator Cup', courses: ['Nova', 'Eve'], idx: 0, lineup: ['guido', 'irish', 'king', 'kasi', 'outlaw', 'chad'], pts: [0, 0, 0, 0, 0, 0], eggs: [0, 0, 0, 0, 0, 0], last: null, diff: 'easy', t: 99 } },
    bests: { Nova: 90, Eve: 40 },
    ghosts: { Nova: ghost('Nova', 90, 'rslow'), Eve: ghost('Eve', 40, 'rfast') },
    racer: 'kingJr', track: '1', diff: 'easy',
  });
  const m = mergeProgress(local, remote);
  assert.deepEqual(m.unlocks.sort(), ['dough', 'voxel']);
  assert.equal(m.podiums, 2);
  assert.equal(m.cups.c1.place, 1);
  assert.equal(m.runs.c2.idx, 1);
  assert.equal(m.bests.Nova, 80);
  assert.equal(m.ghosts.Nova.d, local.ghosts.Nova.d);
  assert.equal(m.bests.Eve, 40);
  assert.equal(m.ghosts.Eve.d, 'rfast');
  assert.equal(m.racer, 'tonyGuido');
  assert.equal(m.track, '3');
  assert.equal(m.diff, 'hard');
});

test('a ghost that is not the faster time is dropped, and a huge ghost is refused', () => {
  const huge = 'r' + 'x'.repeat(GHOST_MAX);
  const m = mergeProgress(
    sanitizeProgress({ bests: { Nova: 10 }, ghosts: { Nova: ghost('Nova', 30) } }),
    sanitizeProgress({ bests: { Nova: 10 }, ghosts: { Nova: { ...ghost('Nova', 10), d: huge } } }),
  );
  assert.equal(m.bests.Nova, 10);
  assert.equal(m.ghosts.Nova, undefined);
});

test('the sign-in redirect stays on the game or on localhost', () => {
  assert.equal(allowedNext(GAME, 'https://evil.example/steal'), GAME.split('?')[0]);
  assert.equal(allowedNext(GAME, GAME), GAME);
  assert.equal(allowedNext(GAME, 'http://127.0.0.1:8765/index.html'), 'http://127.0.0.1:8765/index.html');
});

test('account routes say so when the database is not bound', async () => {
  const res = await handleAccount(new Request('https://relay.example/auth/request', { method: 'POST', body: '{"email":"a@b.co"}' }), {});
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /not set up/);
});

test('a magic link signs in, progress merges, and a second use fails', async () => {
  const db = memDb();
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response('{"id":"email"}', { status: 200 });
  };
  const env = { DB: db, RESEND_API_KEY: 'test-key', FROM_EMAIL: 'Race Wars <onboarding@resend.dev>', GAME_URL: GAME };
  try {
    const bad = await handleAccount(new Request('https://relay.example/auth/request', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"nope"}',
    }), env);
    assert.equal(bad.status, 400);

    const ask = await handleAccount(new Request('https://relay.example/auth/request', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ email: 'Ada@Example.com', next: GAME }),
    }), env);
    assert.equal(ask.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to[0], 'ada@example.com');
    const link = sent[0].text.match(/https:\/\/relay\.example\/auth\/verify\?\S+/)[0];
    const verify = await handleAccount(new Request(link), env);
    assert.equal(verify.status, 302);
    const loc = verify.headers.get('location');
    assert.ok(loc.startsWith(GAME + '#session='));
    const session = new URL(loc).hash.slice('#session='.length);

    const again = await handleAccount(new Request(link), env);
    assert.equal(again.status, 400);

    const auth = { authorization: 'Bearer ' + session };
    const me = await handleAccount(new Request('https://relay.example/auth/me', { headers: auth }), env);
    assert.equal((await me.json()).email, 'ada@example.com');

    const first = await handleAccount(new Request('https://relay.example/progress', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ unlocks: ['voxel'], podiums: 1, bests: { Nova: 90 }, ghosts: { Nova: ghost('Nova', 90, 'rold') }, racer: 'guido', diff: 'medium' }),
    }), env);
    assert.equal(first.status, 200);

    const second = await handleAccount(new Request('https://relay.example/progress', {
      method: 'PUT', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ unlocks: ['dough'], podiums: 2, bests: { Nova: 70 }, ghosts: { Nova: ghost('Nova', 70, 'rnew') }, racer: 'tonyGuido' }),
    }), env);
    const merged = await second.json();
    assert.deepEqual(merged.progress.unlocks.sort(), ['dough', 'voxel']);
    assert.equal(merged.progress.podiums, 2);
    assert.equal(merged.progress.bests.Nova, 70);
    assert.equal(merged.progress.ghosts.Nova, 70);
    assert.equal(merged.progress.racer, 'tonyGuido');

    const got = await handleAccount(new Request('https://relay.example/progress/ghost?course=Nova', { headers: auth }), env);
    assert.equal((await got.json()).ghost.d, 'rnew');

    const out = await handleAccount(new Request('https://relay.example/auth/logout', { method: 'POST', headers: auth }), env);
    assert.equal(out.status, 200);
    const gone = await handleAccount(new Request('https://relay.example/auth/me', { headers: auth }), env);
    assert.equal(gone.status, 401);
  } finally {
    globalThis.fetch = orig;
  }
});

test('missing Resend key does not throw and does not pretend to send', async () => {
  const env = { DB: memDb(), GAME_URL: GAME };
  const res = await handleAccount(new Request('https://relay.example/auth/request', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com' }),
  }), env);
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not set up/);
});

test('magic-link requests are limited per email', async () => {
  const env = { DB: memDb(), RESEND_API_KEY: 'k', GAME_URL: GAME };
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    for (let i = 0; i < 5; i++) {
      const res = await handleAccount(new Request('https://relay.example/auth/request', {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
        body: JSON.stringify({ email: 'ada@example.com' }),
      }), env);
      assert.equal(res.status, 200);
    }
    const blocked = await handleAccount(new Request('https://relay.example/auth/request', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '8.8.8.8' },
      body: JSON.stringify({ email: 'ada@example.com' }),
    }), env);
    assert.equal(blocked.status, 429);
  } finally {
    globalThis.fetch = orig;
  }
});
