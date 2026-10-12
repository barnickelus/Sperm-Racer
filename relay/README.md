# Race Wars relay

A WebSocket fan-out for the game's `relay` transport: whatever JSON text a client sends to
`/room/<CODE>` is echoed to every other client in that room — plus the open-room registry
behind **Quick Race** (`GET /open`). One Cloudflare Worker, two Durable Object classes (a
`Room` per code, one `Lobby` for the registry), no accounts. It fits in the free plan.

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

## Limits

- No authentication: anyone with the code can join. The game's host is the authority over
  the race, not the relay.
- The Durable Object runs in one Cloudflare location per room; players far from it see the
  relay's round-trip on top of their own. For friends on the same continent that is tens of
  milliseconds.
- Free plan quotas (requests and DO duration) are generous for a friends-and-room-codes game,
  but a relay is a server: if it is ever abused, add a Cloudflare rate limit on `/room/*`.
