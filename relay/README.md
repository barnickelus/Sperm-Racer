# Race Wars relay

A WebSocket fan-out for the game's `relay` transport: whatever JSON text a client sends to
`/room/<CODE>` is echoed to every other client in that room — plus the open-room registry
behind **Quick Race** (`GET /open`). One Cloudflare Worker, two Durable Object classes (a
`Room` per code, one `Lobby` for the registry). Rooms still have no accounts. Optional
progress accounts (magic-link sign-in, saved on this same Worker) are below. It fits the
free plan until the database is added, which is also on the free D1 allowance for a small game.

## Already deployed? Deploy again (one command)

The registry is new. A worker deployed before it answers `/open` with 404, and the game then
says *Open rooms need the updated relay (see relay/README.md)* and hosts an ordinary coded
room instead. To turn Quick Race on:

```sh
cd relay && wrangler deploy
```

That is all: `wrangler.toml` carries the `v2` migration that adds the `Lobby` class, and the
URL does not change.

Why bother, when the `peer` transport is free and serverless: the public PeerJS broker has
no uptime promise, roughly one network in ten (strict corporate / some mobile NAT) cannot
open a direct WebRTC channel at all, and open rooms need somewhere to be listed. A relay
sidesteps NAT entirely and the registry rides on it.

## Deploy (once, ~5 minutes)

```sh
npm install -g wrangler        # Cloudflare's CLI
cd relay
wrangler login                 # opens the browser, free Cloudflare account is enough
wrangler deploy                # prints  https://race-wars-relay.<your-subdomain>.workers.dev
```

Then point the game at it, near the top of the MULTIPLAYER block in `index.html`:

```js
const NET_RELAY_DEFAULT = 'wss://race-wars-relay.<your-subdomain>.workers.dev/room';
...
let netPick=(new URLSearchParams(location.search).get('net')||'relay');   // was 'peer'
```

(`wss://`, not `https://`, and the path ends in `/room` — the game appends `/<CODE>`.)
Commit, push, and GitHub Pages serves the build that uses it. `?net=peer` still works for
anyone who wants the old path, and the lobby's **Connection** button cycles through all three.

## Try it before deploying

```sh
cd relay && wrangler dev --port 8787
```

opens the worker locally; the game then runs against it with
`index.html?net=relay&relay=ws://localhost:8787/room`. The invite link a host copies carries
the same `&net=relay&relay=...`, so the second player needs nothing extra.

The automated test (`scratchpad/mp_relay_local.js`) does the same against a plain Node
WebSocket server that implements the identical contract in twenty lines — the worker above
is that server, written for Cloudflare.

## Contract

- `GET /room/<CODE>` with a WebSocket upgrade joins the room. Codes are 2–12 alphanumerics,
  case-insensitive.
- A text frame from one socket is sent, verbatim, to every other socket in the room.
  Binary frames and frames over 16 KB are dropped.
- A room holds at most 12 sockets (a race is six); the 13th gets `409`.
- There is no room state. A room "exists" while someone is connected to it and is gone the
  moment the last socket closes; the Durable Object hibernates between packets, so an idle
  lobby costs nothing.

### Open rooms (Quick Race)

- `GET /open` → `{"room":"ABCD","join":true}` names an open room that is still waiting: not
  started, fewer than six humans, refreshed within the last 45 s. The fullest room comes first,
  so people pool; the oldest of equals, so no room waits forever. With nothing open it answers
  `{"room":"WXYZ","join":false}`: a fresh four-letter code (the game's alphabet, no `I/O/0/1`)
  that the caller hosts.
- `POST /open/<CODE>` with JSON `{"humans":3,"started":false}` → `{"ok":true}`. The host sends
  it when it opens the room and every 5 s after; `started:true` (lights-out), `humans>=6` or
  `humans:0` take the room off the list, and 45 s without a POST expires it.
- Both answer with `Access-Control-Allow-Origin: *` (the game is on another origin) and
  `OPTIONS` with 204. The registry is advisory: a room is still only an echo room, and a joiner
  that finds it empty or already racing asks `/open` again.
- Anything else under `/open` is 404. `scratchpad/mp_relay_srv.js` (the Node stand-in used by
  the tests) implements the same endpoints with the identical `openRegistry()` function.

## Optional follow-up: a preview card for challenge links

A challenge link (`index.html?c=CODE.META[.GHOST]`, see MULTIPLAYER.md) needs nothing from the
relay: the room is an ordinary echo room and the rules travel in the link and the host's roster.
iMessage and WhatsApp show the page's generic title and icon for it, because GitHub Pages serves
one static `index.html` whose Open Graph tags cannot name the challenger or the course.

If a per-link card ("Chris challenges you · Best of 3 on Felicity") is ever wanted, it is a small
addition here, not in the game: a `GET /c/<CODE>.<META>` route on the worker that decodes `META`
and answers an HTML page with `og:title` / `og:description` / `og:image` built from it and an
immediate redirect (meta refresh or a script) to the game's URL with the same `?c=` query. The
sheet would then share `https://<relay>/c/…` instead of the page URL. Nothing else changes: the
game already accepts the query, and the relay still stores nothing.

## Accounts (optional)

Players can keep playing as guests. Nothing about a race room changes. Sign-in is an email
link, and the saved progress (unlocks, cups, best times, ghosts, and the last racer, course,
and difficulty) is stored in D1 on this Worker. The game page and the Worker are different
origins, so the session is a bearer token the page stores, not a cookie.

Ghosts are one D1 row per course, capped at 500 KB. A D1 row is limited to about 2 MB, and a
ghost is the only large value, so it does not share a row with the rest of the progress. That
is enough for the handful of course ghosts a player actually has. R2 is not required.

What you do once, before sign-in works:

1. Create a Resend account. Until a domain is verified, leave `FROM_EMAIL` as
   `Race Wars <onboarding@resend.dev>`. That test sender only delivers to the email address
   on the Resend account. After the domain is verified, change `FROM_EMAIL` in
   `wrangler.toml` to an address on that domain.
2. `cd relay`
3. `npx wrangler d1 create race-wars-progress` and paste the printed database id over
   `REPLACE_AFTER_CREATE` in `wrangler.toml`.
4. `npx wrangler d1 execute race-wars-progress --remote --file=schema.sql`
5. `npx wrangler secret put RESEND_API_KEY` and paste the Resend API key when asked.
6. `npx wrangler deploy`

If the API key or the database is missing, the game still loads and guest play is unchanged.
Sign-in then says that saving is not set up yet. `GAME_URL` in `wrangler.toml` is where the
link sends the player; change it if the game is not served from the GitHub Pages URL.

## Limits

- No authentication on a room: anyone with the code can join. The game's host is the authority
  over the race, not the relay. Progress accounts are separate and never gate a room.
- The Durable Object runs in one Cloudflare location per room; players far from it see the
  relay's round-trip on top of their own. For friends on the same continent that is tens of
  milliseconds.
- Free plan quotas (requests and DO duration) are generous for a friends-and-room-codes game,
  but a relay is a server: if it is ever abused, add a Cloudflare rate limit on `/room/*`.
